import type {
  AdapterStatus,
  GazeSample,
  TobiiAdapter,
  Unsubscribe,
} from "./types";
import { logger, summarizeCandidate, summarizeSdp } from "../logger";

// ---------------------------------------------------------------------------
// WebRtcTobiiAdapter — real-hardware path for Tobii Pro Glasses 3.
//
// Signaling flow (docs §4.2.1, lines 553-617):
//   1. webrtc!create([])                       → uuid
//   2. subscribe webrtc/<uuid>:new-ice-candidate (over WebSocket — §3.6.1)
//   3. webrtc/<uuid>!setup([])                 → device SDP offer
//   4. pc.setRemoteDescription({type:"offer", sdp})
//   5. answer = pc.createAnswer(); pc.setLocalDescription(answer)
//   6. webrtc/<uuid>!start([answer.sdp])
//   7. trickle our local ICE: webrtc/<uuid>!add-ice-candidate([index, cand])
//   8. webrtc/<uuid>!keep-alive([]) every <5s (4s used here)
//   9. webrtc!delete([uuid]) on teardown
//
// IMPORTANT: the *glasses* are the offerer; the browser answers. The order
// looks inverted from the usual "browser-side createOffer" pattern.
// ---------------------------------------------------------------------------

const KEEPALIVE_MS = 4000; // < 5000, per docs

// A WebRTC peer can dip into "disconnected" on a transient packet-loss blip
// and recover on its own. Don't treat it as fatal until it's been down this
// long (or transitions to "failed", which is genuinely terminal). Tuned down
// from 8s: on the glasses' AP the disconnects we see have never recovered,
// they're deterministic ~25s media-path deaths, so faster fail = faster
// auto-reconnect.
const DISCONNECT_GRACE_MS = 3000;

// Stats sampling cadence. Lower → faster flatline detection, but more
// pc.getStats() churn (cheap on this scale).
const STATS_INTERVAL_MS = 1500;

// Force-fail after this many consecutive samples reporting either zero
// inbound video bytes OR no selected candidate pair, while ICE still thinks
// it's connected. Catches the "media path died, but ICE hasn't noticed yet"
// window — saves ~5s vs waiting for ICE itself to give up.
const FLATLINE_SAMPLES = 2;

// One missed keep-alive is harmless — the device only reaps the session after
// 20s of silence (docs §4.2.1). Tolerate a few consecutive misses (≈ this×4s)
// before surfacing an error so a single slow round-trip doesn't kill the UI.
const KEEPALIVE_MAX_MISSES = 3;

export interface WebRtcAdapterConfig {
  /** HTTP base for REST signaling, e.g. "/g3" or "http://<serial>.local". */
  http: string;
  /** WebSocket URL for the g3api signal channel, e.g. "ws://<serial>.local/websocket". */
  ws: string;
}

interface WsRequest {
  path: string;
  id: number;
  method: "GET" | "POST";
  body: unknown;
}

export class WebRtcTobiiAdapter implements TobiiAdapter {
  readonly kind = "webrtc" as const;

  private httpBase: string;
  private wsUrl: string;

  private pc: RTCPeerConnection | null = null;
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private keepAliveWorker: Worker | null = null;

  private sceneStream: MediaStream | null = null;
  private eyeStream: MediaStream | null = null;

  private gazeSubs = new Set<(s: GazeSample) => void>();
  private statusSubs = new Set<(s: AdapterStatus) => void>();

  // --- ICE state -----------------------------------------------------------
  private localIceIndex = 0;
  private iceSignalId: number | null = null;
  private earlyRemoteIce: Array<[number, string]> = []; // queued until pc has remote desc
  // Our own IP as the glasses sees it (via !remote-host). Used to rewrite the
  // anonymized mDNS *.local host candidates the browser emits, which the
  // glasses' WebRTC server often can't resolve (docs lines 632-642).
  private remoteHostIp: string | null = null;

  // --- Resilience bookkeeping ---------------------------------------------
  private keepAliveFailures = 0;
  private disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private cleaningUp = false;

  // --- Media-path diagnostics ---------------------------------------------
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private statsPrevBytes = 0;
  private statsPrevTs = 0;
  private statsFlatlineCount = 0;
  private statsHadSelectedPair = false;

  // --- Signal IDs we've subscribed to over the WS for gaze data -----------
  private gazeSignalIds = new Set<number>();
  // Diagnostics: log the first few raw gaze-signal payloads + any unexpected
  // signal so we can confirm the wire shape from a single dump. Reset per
  // session in cleanup().
  private gazeRawLogCount = 0;
  private gazeEmitCount = 0;
  private unknownSignalLogCount = 0;

  // --- WS request bookkeeping ---------------------------------------------
  private wsReqId = 0;
  private wsPending = new Map<number, (resp: any) => void>();
  private wsOpened: Promise<void> | null = null;

  constructor(cfg: WebRtcAdapterConfig | string) {
    // Back-compat: a bare string is treated as the HTTP base; WS must be set
    // via constructor or it'll throw at connect time.
    if (typeof cfg === "string") {
      this.httpBase = cfg.replace(/\/$/, "");
      this.wsUrl = "";
    } else {
      this.httpBase = cfg.http.replace(/\/$/, "");
      this.wsUrl = cfg.ws;
    }
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    this.emitStatus({ state: "connecting", message: "negotiating WebRTC" });
    logger.info("adapter", "connect() starting", {
      httpBase: this.httpBase || "(unset)",
      wsUrl: this.wsUrl || "(unset)",
      ua: typeof navigator !== "undefined" ? navigator.userAgent : "(server)",
    });

    try {
      if (!this.wsUrl) {
        throw new Error(
          "WebSocket URL missing — set NEXT_PUBLIC_G3_DIRECT or NEXT_PUBLIC_G3_WS."
        );
      }

      const pc = new RTCPeerConnection({ iceServers: [] });
      this.pc = pc;
      logger.info("pc", "RTCPeerConnection created", { iceServers: [] });

      this.sceneStream = new MediaStream();
      this.eyeStream = new MediaStream();

      pc.ontrack = (e) => this.routeIncomingTrack(e);
      pc.ondatachannel = (e) => {
        logger.info("pc", "ondatachannel", {
          label: e.channel.label,
          ordered: e.channel.ordered,
          maxRetransmits: e.channel.maxRetransmits,
          readyState: e.channel.readyState,
        });
        let msgCount = 0;
        e.channel.onopen = () => {
          logger.info("pc", `data channel "${e.channel.label}" open`);
          // The device may only push gaze samples after we explicitly
          // subscribe. Try a handful of likely paths over the g3api WS
          // (same protocol as ICE subscription). Whichever returns a signal
          // id is the right one; the rest fail silently.
          if (e.channel.label === "api" && this.sessionId) {
            void this.subscribeGazeChannel(this.sessionId);
          }
        };
        e.channel.onclose = () =>
          logger.info("pc", `data channel "${e.channel.label}" closed`);
        e.channel.onerror = (ev) =>
          logger.error("pc", `data channel "${e.channel.label}" error`, {
            type: (ev as Event).type,
          });
        e.channel.onmessage = (msg) => {
          msgCount += 1;
          // Log first 10 raw messages so we can SEE the data shape, then
          // sample 1-per-100 to avoid flooding (gaze runs at 50/100 Hz).
          if (msgCount <= 10 || msgCount % 200 === 0) {
            const raw =
              typeof msg.data === "string"
                ? msg.data.slice(0, 400)
                : `[binary ${(msg.data as ArrayBuffer)?.byteLength ?? "?"}b]`;
            logger.info("dc", `${e.channel.label} #${msgCount}: ${raw}`);
          }
          this.handleGazeMessage(msg.data);
        };
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          logger.info("ice", `local: ${summarizeCandidate(e.candidate.candidate)}`, {
            mid: e.candidate.sdpMid,
            mLineIndex: e.candidate.sdpMLineIndex,
          });
          void this.sendIce(e.candidate);
        } else {
          logger.info("ice", "local: end-of-candidates");
        }
      };
      pc.onicegatheringstatechange = () =>
        logger.info("pc", `iceGatheringState=${pc.iceGatheringState}`);
      pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        const fn = s === "failed" ? logger.error : s === "disconnected" ? logger.warn : logger.info;
        fn.call(logger, "pc", `iceConnectionState=${s}`);
      };
      pc.onsignalingstatechange = () =>
        logger.info("pc", `signalingState=${pc.signalingState}`);
      pc.onconnectionstatechange = () => {
        if (!this.pc) return;
        const s = this.pc.connectionState;
        const fn = s === "failed" ? logger.error : s === "disconnected" ? logger.warn : logger.info;
        fn.call(logger, "pc", `connectionState=${s}`);
        if (s === "failed") {
          // Terminal — ICE has given up. Surface the error.
          this.clearDisconnectGrace();
          this.emitStatus({ state: "error", message: "peer failed" });
        } else if (s === "disconnected") {
          // Possibly transient. Give it a grace window to self-heal before
          // we declare an error; "disconnected" frequently flips back to
          // "connected" without any intervention.
          if (!this.disconnectGraceTimer) {
            this.emitStatus({
              state: "connecting",
              message: "peer disconnected — recovering",
            });
            this.disconnectGraceTimer = setTimeout(() => {
              this.disconnectGraceTimer = null;
              if (this.pc && this.pc.connectionState === "disconnected") {
                this.emitStatus({
                  state: "error",
                  message: "peer disconnected (no recovery)",
                });
              }
            }, DISCONNECT_GRACE_MS);
          }
        } else if (s === "connected") {
          // Recovered (or first connect). Clear any pending grace timer.
          this.clearDisconnectGrace();
          this.emitStatus({ state: "connected", message: "WebRTC live" });
        }
      };

      // 1. create session
      logger.info("adapter", "step 1/6: webrtc!create");
      this.sessionId = await this.createSession();

      // 1b. Ask the glasses what IP it sees us as, so we can de-anonymize the
      //     browser's mDNS *.local host candidates before trickling them. The
      //     device's WebRTC server frequently can't resolve *.local (docs
      //     lines 632-642). Best-effort: if it fails, we fall back to sending
      //     candidates verbatim. Must complete before ICE starts flowing
      //     (which happens at setLocalDescription, step 4).
      await this.fetchRemoteHost(this.sessionId);

      // 2. subscribe to remote ICE BEFORE asking for the offer — otherwise we
      //    can miss early candidates the device emits as its peer comes up.
      logger.info("adapter", "step 2/6: open g3api ws + subscribe to remote ICE");
      await this.openWsAndSubscribeIce(this.sessionId);

      // 3. fetch the device's SDP offer
      logger.info("adapter", "step 3/6: webrtc/<uuid>!setup (fetch offer)");
      const offerSdp = await this.fetchOffer(this.sessionId);
      logger.info("adapter", "applying remote offer", summarizeSdp(offerSdp));
      await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
      logger.info("pc", "setRemoteDescription(offer) ok");

      // Flush any remote ICE that arrived before setRemoteDescription.
      if (this.earlyRemoteIce.length) {
        logger.info(
          "ice",
          `flushing ${this.earlyRemoteIce.length} early remote candidates`
        );
        for (const [idx, cand] of this.earlyRemoteIce) {
          await this.acceptRemoteIce(idx, cand);
        }
        this.earlyRemoteIce = [];
      }

      // 4. answer
      logger.info("adapter", "step 4/6: createAnswer + setLocalDescription");
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      logger.info(
        "adapter",
        "local answer set",
        summarizeSdp(answer.sdp ?? "")
      );

      // 5. send our answer to the device
      logger.info("adapter", "step 5/6: webrtc/<uuid>!start (send answer)");
      await this.sendAnswer(this.sessionId, answer.sdp ?? "");

      // 6. keep-alive heartbeat — runs in a worker so tab backgrounding
      //    doesn't throttle it past the 5 s timeout (docs §4.2.1).
      logger.info("adapter", `step 6/6: start keep-alive worker (${KEEPALIVE_MS}ms)`);
      this.startKeepAliveWorker(this.sessionId);

      // Watch the actual media transport so we can see exactly when/why it
      // drops (the ~25s ICE failure is independent of the healthy signaling).
      this.startStatsMonitor();

      this.emitStatus({ state: "connected", message: "WebRTC live" });
      logger.info("adapter", "connect() complete — WebRTC live");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "connect failed";
      logger.error("adapter", `connect() failed: ${msg}`, err);
      this.emitStatus({ state: "error", message: msg });
      await this.cleanup();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    await this.cleanup();
    this.emitStatus({ state: "disconnected" });
  }

  private async cleanup(): Promise<void> {
    // Idempotent: closing the ws below triggers ws.onclose, which also calls
    // cleanup(). Guard against the re-entrant second pass doing real work.
    if (this.cleaningUp) return;
    this.cleaningUp = true;
    this.clearDisconnectGrace();
    this.stopStatsMonitor();
    this.keepAliveFailures = 0;
    this.remoteHostIp = null;
    this.gazeRawLogCount = 0;
    this.gazeEmitCount = 0;
    this.unknownSignalLogCount = 0;
    if (this.keepAliveWorker) {
      try {
        this.keepAliveWorker.postMessage({ type: "stop" });
      } catch {
        /* ignore */
      }
      this.keepAliveWorker.terminate();
      this.keepAliveWorker = null;
    }
    const uuid = this.sessionId;
    this.sessionId = null;
    // Fire-and-forget: the teardown action can hang for 5s and 500 on this
    // firmware (and the session is reaped server-side after 20s regardless),
    // so don't let it block teardown/reconnect.
    if (uuid) void this.deleteSession(uuid);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.wsPending.clear();
    this.wsOpened = null;
    this.iceSignalId = null;
    this.gazeSignalIds.clear();
    this.earlyRemoteIce = [];
    this.localIceIndex = 0;
    this.pc?.close();
    this.pc = null;
    this.sceneStream = null;
    this.eyeStream = null;
    this.cleaningUp = false;
  }

  // -------------------------------------------------------------------------
  // Stream + subscription API
  // -------------------------------------------------------------------------

  getSceneStream(): MediaStream | null {
    return this.sceneStream;
  }
  getEyeStream(): MediaStream | null {
    return this.eyeStream;
  }

  onGaze(cb: (s: GazeSample) => void): Unsubscribe {
    this.gazeSubs.add(cb);
    return () => this.gazeSubs.delete(cb);
  }
  onStatus(cb: (s: AdapterStatus) => void): Unsubscribe {
    this.statusSubs.add(cb);
    return () => this.statusSubs.delete(cb);
  }

  // -------------------------------------------------------------------------
  // Track routing — scene vs eye
  // -------------------------------------------------------------------------
  //
  // The device sends two video m-lines: scene camera and eye camera. The docs
  // don't pin down ordering or labels, so we use the m-line index (transceiver
  // mid) when present and fall back to arrival order. The example client also
  // uses arrival order; refine this once we observe a real SDP.

  private routeIncomingTrack(e: RTCTrackEvent): void {
    const mid = e.transceiver?.mid ?? null;
    const streamIds = e.streams.map((s) => s.id);
    const trackLabel = e.track.label ?? "";
    logger.info("pc", "ontrack", {
      kind: e.track.kind,
      id: e.track.id,
      label: trackLabel,
      mid,
      streamIds,
      muted: e.track.muted,
    });
    if (e.track.kind !== "video") {
      logger.info("pc", `ignoring non-video track (kind=${e.track.kind})`);
      return;
    }

    // Tobii's WebRTC offer uses semantic names ("scene", "eyes") in mids,
    // stream IDs, or track labels — not numeric positions. Probe all three
    // case-insensitively for the eye keyword before falling back to the
    // arrival-order heuristic.
    const eyeHints = ["eye", "eyes", "eyecam", "eye-cam"];
    const sceneHints = ["scene", "world", "front"];
    const haystack = [mid ?? "", ...streamIds, trackLabel]
      .join(" ")
      .toLowerCase();

    let target: MediaStream | null;
    let route: string;
    if (eyeHints.some((h) => haystack.includes(h))) {
      target = this.eyeStream;
      route = "eye (by name match)";
    } else if (sceneHints.some((h) => haystack.includes(h))) {
      target = this.sceneStream;
      route = "scene (by name match)";
    } else if (
      this.sceneStream != null &&
      this.sceneStream.getTracks().length === 0
    ) {
      target = this.sceneStream;
      route = "scene (first video, fallback)";
    } else {
      target = this.eyeStream;
      route = "eye (fallback, scene already has a track)";
    }
    target?.addTrack(e.track);
    logger.info("pc", `routed track → ${route}`, { haystack });
  }

  // -------------------------------------------------------------------------
  // Gaze JSON → GazeSample (unchanged from skeleton; fields per docs A3.1)
  // -------------------------------------------------------------------------

  private handleGazeMessage(raw: unknown) {
    let obj: any;
    try {
      obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return;
    }

    // A pushed signal wraps its payload in a `body` array, and per the G3
    // signal convention (docs §3.6, cf. the event-signal example
    // `{signal, body:[<timestamp>, <payload>]}`) the TIMESTAMP comes first and
    // the payload object second — the opposite of what we assumed before.
    // Over the data channel the device may also push a bare sample object.
    // Rather than hard-code a position, scan every plausible container for a
    // gaze-shaped object so we're robust to either ordering/nesting.
    const search: any[] = [obj];
    if (obj && typeof obj === "object") {
      if (obj.data) search.push(obj.data);
      if (Array.isArray(obj.body)) {
        for (const el of obj.body) {
          search.push(el);
          if (el && typeof el === "object" && el.data) search.push(el.data);
        }
      }
    }

    const looksLikeGaze = (x: any): boolean =>
      !!x &&
      typeof x === "object" &&
      (x.gaze2d != null ||
        x.gaze3d != null ||
        x.eyeleft != null ||
        x.eyeright != null);

    const d = search.find(looksLikeGaze);
    // Not a gaze frame (events / IMU / syncport share the channel) — drop.
    if (!d) return;

    // Timestamp: explicit field on the wrapper or sample, else the first
    // numeric in the signal body (the convention slot), else local clock.
    const numericInBody = Array.isArray(obj?.body)
      ? obj.body.find((x: unknown) => typeof x === "number")
      : undefined;
    const tsHolder = search.find(
      (x) => x && typeof x === "object" && typeof x.timestamp === "number"
    );
    const t =
      typeof obj?.timestamp === "number"
        ? obj.timestamp
        : typeof tsHolder?.timestamp === "number"
        ? tsHolder.timestamp
        : typeof numericInBody === "number"
        ? numericInBody
        : performance.now() / 1000;

    const g2d = d.gaze2d;
    const left = d.eyeleft;
    const right = d.eyeright;
    const sample: GazeSample = {
      t,
      gaze2d: Array.isArray(g2d) && g2d.length === 2 ? [g2d[0], g2d[1]] : null,
      gaze3d: Array.isArray(d.gaze3d)
        ? (d.gaze3d as [number, number, number])
        : null,
      pupilLeft:
        typeof left?.pupildiameter === "number" ? left.pupildiameter : null,
      pupilRight:
        typeof right?.pupildiameter === "number" ? right.pupildiameter : null,
      eyeLeftValid:
        left?.pupildiameter != null || Array.isArray(left?.gazedirection),
      eyeRightValid:
        right?.pupildiameter != null || Array.isArray(right?.gazedirection),
    };
    if (this.gazeEmitCount < 3) {
      this.gazeEmitCount += 1;
      logger.info("gaze", `emitted sample #${this.gazeEmitCount}`, {
        t: sample.t,
        gaze2d: sample.gaze2d,
        pupilLeft: sample.pupilLeft,
        pupilRight: sample.pupilRight,
      });
    }
    this.gazeSubs.forEach((cb) => cb(sample));
  }

  private lastStatusState: AdapterStatus["state"] | null = null;
  private emitStatus(s: AdapterStatus) {
    if (s.state !== this.lastStatusState) {
      const fn = s.state === "error" ? logger.error : logger.info;
      fn.call(logger, "adapter", `state ${this.lastStatusState ?? "(initial)"} → ${s.state}`, {
        message: s.message,
      });
      this.lastStatusState = s.state;
    }
    this.statusSubs.forEach((cb) => cb(s));
  }

  // -------------------------------------------------------------------------
  // REST helpers — actions are POSTs with a JSON array body (docs §3.5).
  // Failures may surface as either non-2xx OR 200 with body `false` plus an
  // X-g3-action-error header.
  // -------------------------------------------------------------------------

  private async restAction<T>(
    path: string,
    body: unknown[],
    opts?: { quiet?: boolean }
  ): Promise<T> {
    // `quiet` downgrades failure logs to WARN — used for actions we expect
    // may be unsupported on this firmware (!remote-host, teardown) and handle
    // gracefully, so they don't masquerade as hard errors in the dump.
    const failLog = opts?.quiet ? logger.warn : logger.error;
    const url = `${this.httpBase}/rest/${path}`;
    const t0 = performance.now();
    let r: Response;
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      failLog.call(logger, "http", `POST ${path} fetch threw after ${ms}ms`, {
        url,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
    const text = await r.text();
    const ms = Math.round(performance.now() - t0);
    const errInfo = r.headers.get("X-g3-action-error");
    if (!r.ok) {
      failLog.call(logger, "http", `POST ${path} → HTTP ${r.status} in ${ms}ms`, {
        url,
        body: text.slice(0, 300),
        errInfo,
      });
      throw new Error(`${path} → HTTP ${r.status} ${text.slice(0, 200)}`);
    }
    let parsed: unknown;
    try {
      parsed = text.length ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (errInfo) {
      logger.error("http", `POST ${path} → action error in ${ms}ms`, {
        errInfo,
        body: text.slice(0, 300),
      });
      throw new Error(`${path} → action error ${errInfo}`);
    }
    logger.info("http", `POST ${path} → ok in ${ms}ms`, {
      result: typeof parsed === "string" ? parsed.slice(0, 80) : parsed,
    });
    return parsed as T;
  }

  // -------------------------------------------------------------------------
  // Signaling helpers
  // -------------------------------------------------------------------------

  private async createSession(): Promise<string> {
    const uuid = await this.restAction<string>("webrtc!create", []);
    if (typeof uuid !== "string" || uuid.length === 0) {
      throw new Error(`webrtc!create returned unexpected ${JSON.stringify(uuid)}`);
    }
    logger.info("adapter", `session uuid=${uuid}`);
    return uuid;
  }

  /**
   * Query the glasses for the IP it sees this client at so we can rewrite
   * anonymized mDNS host candidates (docs lines 638-642). The docs name the
   * action `!remote-host` but don't pin down its parent object, and the
   * per-session path 400s on this firmware. Probe a handful of plausible
   * paths and use the first that returns an IPv4-shaped string.
   *
   * Best-effort: any failure leaves remoteHostIp null and we send candidates
   * verbatim (which is what causes the ~25s mDNS-stale disconnects).
   */
  private async fetchRemoteHost(uuid: string): Promise<void> {
    const candidates = [
      `webrtc!remote-host`,           // parent object (no session id)
      `webrtc/${uuid}!remote-host`,   // session-scoped (original guess)
      `system!remote-host`,           // common Tobii namespacing
      `network!remote-host`,          // alternative parent
      `rudimentary!remote-host`,      // dev/test surface
    ];
    for (const path of candidates) {
      try {
        const res = await this.restAction<unknown>(path, [], { quiet: true });
        const ip =
          typeof res === "string"
            ? res
            : res && typeof res === "object" && "ip" in res
            ? String((res as { ip: unknown }).ip)
            : null;
        if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
          this.remoteHostIp = ip;
          logger.info("ice", `remote-host: ${path} → ${ip}`);
          return;
        }
        logger.warn("ice", `${path} returned no usable IP`, { res });
      } catch (e) {
        // Quiet — most of these will 400. Only surface the last failure.
      }
    }
    logger.warn(
      "ice",
      "no !remote-host action found on any path — falling back to mDNS candidates (expect ~25s mDNS-stale disconnect)"
    );
  }

  /**
   * Replace an anonymized mDNS `*.local` connection-address in a host
   * candidate with the explicit IP the glasses reported via !remote-host.
   * Leaves non-.local candidates (srflx/relay, or already-numeric) untouched.
   *
   * Candidate grammar (RFC 5245):
   *   candidate:<foundation> <component> <transport> <priority> <addr> <port> typ <type> ...
   */
  private resolveLocalCandidate(cand: string): string {
    if (!this.remoteHostIp || !/\.local\b/i.test(cand)) return cand;
    const rewritten = cand.replace(
      /^(candidate:\S+ \d+ \S+ \d+ )(\S+\.local)( \d+ typ )/i,
      (_m, pre: string, _host: string, post: string) =>
        `${pre}${this.remoteHostIp}${post}`
    );
    if (rewritten !== cand) {
      logger.info("ice", "rewrote mDNS candidate → explicit IP", {
        ip: this.remoteHostIp,
      });
    }
    return rewritten;
  }

  private clearDisconnectGrace(): void {
    if (this.disconnectGraceTimer) {
      clearTimeout(this.disconnectGraceTimer);
      this.disconnectGraceTimer = null;
    }
  }

  // Poll getStats() to expose the media transport health: inbound video
  // throughput and the selected ICE pair's consent counters. When the ~25s
  // drop hits, kbps falls to 0 and requestsSent keeps climbing while
  // responsesReceived stalls — the signature of the peer no longer answering
  // STUN (i.e. the glasses lost the route back to our mDNS candidate).
  private startStatsMonitor(): void {
    this.stopStatsMonitor();
    this.statsPrevBytes = 0;
    this.statsPrevTs = 0;
    this.statsFlatlineCount = 0;
    this.statsHadSelectedPair = false;
    this.statsTimer = setInterval(
      () => void this.sampleStats(),
      STATS_INTERVAL_MS
    );
  }

  private stopStatsMonitor(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private async sampleStats(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    let stats: RTCStatsReport;
    try {
      stats = await pc.getStats();
    } catch {
      return;
    }
    let videoBytes = 0;
    let videoPackets = 0;
    let framesDecoded = 0;
    let selected: any = null;
    const locals = new Map<string, any>();
    const remotes = new Map<string, any>();
    const pairs: any[] = [];
    stats.forEach((r: any) => {
      if (r.type === "inbound-rtp" && r.kind === "video") {
        videoBytes += r.bytesReceived ?? 0;
        videoPackets += r.packetsReceived ?? 0;
        framesDecoded += r.framesDecoded ?? 0;
      } else if (r.type === "candidate-pair") {
        pairs.push(r);
        if (r.nominated && r.state === "succeeded") selected = r;
      } else if (r.type === "local-candidate") {
        locals.set(r.id, r);
      } else if (r.type === "remote-candidate") {
        remotes.set(r.id, r);
      }
    });
    if (!selected) selected = pairs.find((p) => p.state === "succeeded") ?? null;

    const now = performance.now();
    const dt = this.statsPrevTs ? (now - this.statsPrevTs) / 1000 : 0;
    const kbps =
      dt > 0
        ? Math.round(((videoBytes - this.statsPrevBytes) * 8) / dt / 1000)
        : 0;
    this.statsPrevBytes = videoBytes;
    this.statsPrevTs = now;

    const fmt = (c: any) =>
      c
        ? `${c.candidateType} ${c.protocol} ${c.address ?? c.ip ?? "?"}:${c.port ?? "?"}`
        : "?";

    logger.info("stats", `media inbound ${kbps} kbps`, {
      conn: pc.connectionState,
      ice: pc.iceConnectionState,
      videoBytes,
      videoPackets,
      framesDecoded,
      pair: selected
        ? {
            local: fmt(locals.get(selected.localCandidateId)),
            remote: fmt(remotes.get(selected.remoteCandidateId)),
            rttMs:
              typeof selected.currentRoundTripTime === "number"
                ? Math.round(selected.currentRoundTripTime * 1000)
                : null,
            requestsSent: selected.requestsSent,
            responsesReceived: selected.responsesReceived,
            consentRequestsSent: selected.consentRequestsSent,
          }
        : "none",
    });

    // Flatline detector. Fires faster than ICE's own ~25s consent-freshness
    // timeout — when we see the canonical death pattern (was healthy, now
    // either no media flowing OR no selected pair) for N consecutive samples,
    // force-fail so the page's auto-reconnect kicks in immediately.
    const iceConnected =
      pc.iceConnectionState === "connected" ||
      pc.iceConnectionState === "completed";
    if (selected) this.statsHadSelectedPair = true;

    const looksDead = iceConnected && this.statsHadSelectedPair && (
      kbps === 0 ||
      !selected
    );
    // Skip the very first sample after connect — `dt` is small and `kbps`
    // can read 0 just because the prev-bytes baseline hasn't filled yet.
    const isFirstSample = dt === 0;

    if (looksDead && !isFirstSample) {
      this.statsFlatlineCount += 1;
      if (this.statsFlatlineCount >= FLATLINE_SAMPLES) {
        logger.error(
          "stats",
          `media flatlined for ${this.statsFlatlineCount} samples — forcing fail`,
          { kbps, hadPair: !!selected }
        );
        this.clearDisconnectGrace();
        this.statsFlatlineCount = 0; // arm for any future session
        this.emitStatus({
          state: "error",
          message: "media flatlined (kbps=0, pair lost)",
        });
      }
    } else if (kbps > 0 && selected) {
      this.statsFlatlineCount = 0;
    }
  }

  private async fetchOffer(uuid: string): Promise<string> {
    const offer = await this.restAction<unknown>(
      `webrtc/${uuid}!setup`,
      []
    );
    // The action returns the offer. Two observed shapes in Tobii API land:
    //   - plain SDP string
    //   - { type:"offer", sdp:"..." } object
    if (typeof offer === "string") return offer;
    if (offer && typeof offer === "object" && "sdp" in offer) {
      const sdp = (offer as { sdp: unknown }).sdp;
      if (typeof sdp === "string") return sdp;
    }
    throw new Error(
      `webrtc/${uuid}!setup returned unrecognized offer shape: ${JSON.stringify(offer).slice(0, 200)}`
    );
  }

  private async sendAnswer(uuid: string, sdp: string): Promise<void> {
    // Doc pseudo-code: webrtc/<uuid>!start([answer]). By symmetry with !setup
    // (which returns the SDP string), we pass the SDP string. If the device
    // wants the full description object, the action-error header will say so.
    await this.restAction<boolean>(`webrtc/${uuid}!start`, [sdp]);
  }

  private async sendIce(candidate: RTCIceCandidate): Promise<void> {
    if (!this.sessionId) return;
    const idx = candidate.sdpMLineIndex ?? this.localIceIndex++;
    const wire = this.resolveLocalCandidate(candidate.candidate);
    try {
      await this.restAction<boolean>(
        `webrtc/${this.sessionId}!add-ice-candidate`,
        [idx, wire]
      );
    } catch (e) {
      // ICE trickle is best-effort; log via status but don't tear down.
      this.emitStatus({
        state: "connected",
        message: `ice send failed: ${e instanceof Error ? e.message : e}`,
      });
    }
  }

  private startKeepAliveWorker(uuid: string): void {
    this.keepAliveFailures = 0;
    const w = new Worker(new URL("../keepAliveWorker.ts", import.meta.url));
    this.keepAliveWorker = w;
    w.onerror = (e) => {
      logger.error("ka", "worker error", {
        message: e.message,
        filename: e.filename,
        lineno: e.lineno,
      });
    };
    w.onmessage = async (e: MessageEvent<{
      type: string;
      n?: number;
      source?: string;
      message?: string;
      stack?: string;
    }>) => {
      const m = e.data;
      if (m?.type === "workerError") {
        logger.error("ka", `worker ${m.source}: ${m.message}`, { stack: m.stack });
        return;
      }
      if (m?.type !== "tick") return;

      // Send keep-alive over the already-open g3api WebSocket — bypasses the
      // proxy entirely (worker fetch consistently gets HTTP 400 from Servd
      // for this endpoint; the WS path works the same as everything else).
      const tickN = m.n ?? -1;
      const t0 = performance.now();
      try {
        const result = await this.wsRequest<unknown>({
          path: `webrtc/${uuid}!keep-alive`,
          id: ++this.wsReqId,
          method: "POST",
          body: [],
        });
        const ms = Math.round(performance.now() - t0);
        // The action returns no body on success; ws layer surfaces that as
        // `undefined`. Treat undefined/null/true all as ok.
        if (result === true || result === undefined || result === null) {
          if (this.keepAliveFailures > 0) {
            logger.info("ka", `keep-alive recovered after ${this.keepAliveFailures} miss(es)`);
          }
          this.keepAliveFailures = 0;
          logger.info("ka", `keep-alive #${tickN} ok in ${ms}ms (ws)`);
        } else {
          logger.warn(
            "ka",
            `keep-alive #${tickN} returned ${JSON.stringify(result)} in ${ms}ms (ws)`
          );
        }
      } catch (err) {
        const ms = Math.round(performance.now() - t0);
        const msg = err instanceof Error ? err.message : String(err);
        this.keepAliveFailures += 1;
        // A single slow/failed beat is well inside the device's 20s reap
        // window — only surface an error once we've missed several in a row.
        if (this.keepAliveFailures >= KEEPALIVE_MAX_MISSES) {
          logger.error(
            "ka",
            `keep-alive #${tickN} failed in ${ms}ms (ws) — ${this.keepAliveFailures} consecutive`,
            { error: msg }
          );
          this.emitStatus({
            state: "error",
            message: `keep-alive failed ${this.keepAliveFailures}× (ws): ${msg}`,
          });
        } else {
          logger.warn(
            "ka",
            `keep-alive #${tickN} miss ${this.keepAliveFailures}/${KEEPALIVE_MAX_MISSES} in ${ms}ms (ws)`,
            { error: msg }
          );
        }
      }
    };
    w.postMessage({ type: "start", intervalMs: KEEPALIVE_MS });
    logger.info("ka", `worker started (ws transport, ${KEEPALIVE_MS}ms)`);
  }

  private async deleteSession(uuid: string): Promise<void> {
    // Doc lists webrtc!create but not the teardown action explicitly. The
    // conventional pattern is parent-deletes-child. Try !delete; ignore 404s
    // so we don't mask the real disconnect reason. The 20s server-side
    // timeout reaps abandoned sessions anyway.
    try {
      await this.restAction<boolean>("webrtc!delete", [uuid], { quiet: true });
    } catch {
      /* swallow — session will time out server-side */
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket — used only for the remote-ICE signal (docs §3.6: HTTP signal
  // subscriptions only deliver one message and are not safe).
  // -------------------------------------------------------------------------

  private openWsAndSubscribeIce(uuid: string): Promise<void> {
    if (this.wsOpened) return this.wsOpened;
    logger.info("ws", `opening g3api ws → ${this.wsUrl}`);
    this.wsOpened = new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.wsUrl, "g3api");
      } catch (e) {
        logger.error("ws", "WebSocket constructor threw", {
          error: e instanceof Error ? e.message : String(e),
        });
        reject(e);
        return;
      }
      this.ws = ws;
      ws.onopen = async () => {
        logger.info("ws", "ws open", {
          protocol: ws.protocol,
          extensions: ws.extensions,
        });
        try {
          const subPath = `webrtc/${uuid}:new-ice-candidate`;
          logger.info("ws", `subscribing ${subPath}`);
          const signalId = await this.wsRequest<number>({
            path: subPath,
            id: ++this.wsReqId,
            method: "POST",
            body: null,
          });
          this.iceSignalId = signalId;
          logger.info("ws", `subscribed; remote-ice signalId=${signalId}`);
          resolve();
        } catch (e) {
          logger.error("ws", "ice subscription failed", {
            error: e instanceof Error ? e.message : String(e),
          });
          reject(e);
        }
      };
      ws.onerror = (ev) => {
        logger.error("ws", "ws error event", { type: ev.type });
        reject(new Error("g3api WebSocket error"));
      };
      ws.onclose = (e) => {
        const fn = this.sessionId ? logger.error : logger.info;
        fn.call(logger, "ws", `ws closed`, {
          code: e.code,
          reason: e.reason,
          wasClean: e.wasClean,
          duringSession: !!this.sessionId,
        });
        if (this.sessionId) {
          this.emitStatus({
            state: "error",
            message: `g3api ws closed (${e.code}) — device likely went away`,
          });
          // The session is dead and there's no recovery — tear everything
          // down so the keep-alive worker stops firing into the void and
          // the user can cleanly reconnect.
          void this.cleanup();
        }
      };
      ws.onmessage = (m) => this.handleWsMessage(m.data);
    });
    return this.wsOpened;
  }

  private wsRequest<T>(req: WsRequest): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("g3api ws not open"));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.wsPending.delete(req.id);
        reject(new Error(`g3api ws timeout on ${req.path}`));
      }, 8000);
      this.wsPending.set(req.id, (resp) => {
        clearTimeout(timer);
        resolve(resp as T);
      });
      this.ws!.send(JSON.stringify(req));
    });
  }

  private handleWsMessage(raw: unknown) {
    let msg: any;
    try {
      msg = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (typeof msg?.id === "number") {
      const cb = this.wsPending.get(msg.id);
      if (cb) {
        this.wsPending.delete(msg.id);
        cb(msg.body);
      }
      return;
    }
    if (typeof msg?.signal !== "number") return;

    if (msg.signal === this.iceSignalId && Array.isArray(msg.body)) {
      const [index, candidate] = msg.body as [number, string];
      if (typeof candidate !== "string") return;
      if (!this.pc?.remoteDescription) {
        this.earlyRemoteIce.push([index, candidate]);
        return;
      }
      void this.acceptRemoteIce(index, candidate);
      return;
    }

    if (this.gazeSignalIds.has(msg.signal)) {
      // Log the first few raw payloads so the actual wire shape is provable
      // from a single dump (then handleGazeMessage scans for the gaze object).
      if (this.gazeRawLogCount < 5) {
        this.gazeRawLogCount += 1;
        logger.info(
          "gaze",
          `raw signal #${this.gazeRawLogCount} (signal=${msg.signal})`,
          { raw: JSON.stringify(msg).slice(0, 600) }
        );
      }
      this.handleGazeMessage(msg);
      return;
    }

    // An unexpected signal id — maybe gaze arrives on a different id than the
    // subscription returned. Surface the first few so we can correlate.
    if (this.unknownSignalLogCount < 5) {
      this.unknownSignalLogCount += 1;
      logger.warn(
        "ws",
        `unhandled signal=${msg.signal} (#${this.unknownSignalLogCount})`,
        { raw: JSON.stringify(msg).slice(0, 300) }
      );
    }
  }

  /**
   * Subscribe to gaze over the g3api WS. Pushed samples come back over the
   * same WS as `{signal: <id>, body: [<sample>, <timestamp>]}`. We try paths
   * sequentially and stop at the first that returns a numeric signal id —
   * avoids duplicate streams burning bandwidth, and per docs §6 the webrtc-
   * scoped signal has session-correct timestamps.
   */
  private async subscribeGazeChannel(uuid: string): Promise<void> {
    const candidates = [
      `webrtc/${uuid}:gaze`,
      `rudimentary:gaze`,
      `webrtc/${uuid}:gaze-sample`,
      `rudimentary:gaze-sample`,
    ];
    logger.info("sub", `attempting gaze subscription`);
    for (const path of candidates) {
      try {
        const result = await this.wsRequest<unknown>({
          path,
          id: ++this.wsReqId,
          method: "POST",
          body: null,
        });
        if (typeof result === "number") {
          this.gazeSignalIds.add(result);
          logger.info("sub", `subscribed: ${path} → signalId=${result}`);
          return;
        }
        logger.warn("sub", `${path} replied non-number`, { result });
      } catch (e) {
        logger.warn("sub", `${path} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    logger.error("sub", "no gaze subscription path worked");
  }

  private async acceptRemoteIce(index: number, candidate: string): Promise<void> {
    if (!this.pc) return;
    logger.info("ice", `remote: ${summarizeCandidate(candidate)}`, {
      mLineIndex: index,
    });
    try {
      // Empty candidate string is the end-of-candidates marker per WebRTC.
      if (candidate.length === 0) {
        await this.pc.addIceCandidate();
      } else {
        await this.pc.addIceCandidate(
          new RTCIceCandidate({ candidate, sdpMLineIndex: index })
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn("ice", `remote candidate rejected: ${msg}`, {
        candidate: candidate.slice(0, 200),
        mLineIndex: index,
      });
    }
  }
}
