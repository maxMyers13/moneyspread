"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import SceneViewer from "@/components/SceneViewer";
import EyeCameraGrid from "@/components/EyeCameraGrid";
import HudPanel from "@/components/HudPanel";
import PupilTrend from "@/components/PupilTrend";
import Controls from "@/components/Controls";
import { useStore } from "@/lib/store";
import { G3_BASE, G3_DIRECT, G3_WS, START_ADAPTER } from "@/lib/config";
import { MockTobiiAdapter } from "@/lib/adapters/mockAdapter";
import { WebRtcTobiiAdapter } from "@/lib/adapters/webrtcAdapter";
import type { AdapterKind, TobiiAdapter, Unsubscribe } from "@/lib/adapters/types";
import RecordingsList from "@/components/RecordingsList";
import EventMarkers from "@/components/EventMarkers";
import Timeline from "@/components/Timeline";
import { installConsoleTap, logger } from "@/lib/logger";
import {
  getStoredExposureStatus,
  requestLocalIpExposure,
  type LocalIpExposureStatus,
} from "@/lib/exposeLocalIp";
import {
  SidecarError,
  startRecording as sidecarStart,
  stopRecording as sidecarStop,
  type RecordingSummary,
} from "@/lib/sidecarApi";
import { useReplayGaze } from "@/lib/useReplayGaze";
import { useTheme } from "@/lib/useTheme";
import type { SceneViewerHandle } from "@/components/SceneViewer";

const STATUS_COLOR: Record<string, string> = {
  connected: "bg-signal",
  connecting: "bg-warn",
  error: "bg-alert",
  disconnected: "bg-muted",
};

/** Header pill that toggles between dark and light palette. Renders a sun
 * glyph when we're in dark mode (showing what you'd switch to) and a moon
 * when we're in light. Persists across reloads via localStorage. */
function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      onClick={toggle}
      aria-label={`switch to ${next} mode`}
      title={`switch to ${next} mode`}
      className="flex h-6 w-6 items-center justify-center rounded border border-line text-muted transition hover:border-signal hover:text-signal"
    >
      {theme === "dark" ? (
        // Sun
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5" strokeLinecap="round" />
        </svg>
      ) : (
        // Moon
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
        </svg>
      )}
    </button>
  );
}

export default function Page() {
  const [scene, setScene] = useState<MediaStream | null>(null);
  const [eye, setEye] = useState<MediaStream | null>(null);
  const [kind, setKind] = useState<AdapterKind>(START_ADAPTER);

  const adapterRef = useRef<TobiiAdapter | null>(null);
  const unsubsRef = useRef<Unsubscribe[]>([]);

  // Auto-reconnect bookkeeping. We don't reconnect when the user manually
  // disconnects, and we rate-limit retries so a broken environment doesn't
  // hammer the device with create/setup/start cycles.
  const userDisconnectedRef = useRef(false);
  const reconnectAttemptsRef = useRef<number[]>([]); // timestamps of recent attempts
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoReconnect, setAutoReconnect] = useState(true);
  // Set when the adapter reports the deterministic ~25s mDNS-stale media
  // death. Reconnecting just loops back into the same doomed path, so instead
  // of auto-retrying we surface a banner prompting the user to enable real-IP
  // mode (grant mic) or disable Chrome's mDNS anonymization, then reconnect.
  const [mdnsStalled, setMdnsStalled] = useState(false);
  const [ipExposure, setIpExposure] = useState<LocalIpExposureStatus>("unknown");
  useEffect(() => {
    setIpExposure(getStoredExposureStatus());
  }, []);

  // Device recording state (sidecar). Distinct from store.recording, which is
  // the *local* CSV capture flag — the two now move together when both succeed,
  // but if the sidecar is offline we still want local capture to work.
  const [deviceRecordingUuid, setDeviceRecordingUuid] = useState<string | null>(null);
  const [recordingsRefresh, setRecordingsRefresh] = useState(0);

  // Replay mode. When `replayRecording` is non-null, the scene viewer points
  // at a recorded scenevideo.mp4 instead of a live MediaStream, and the
  // useReplayGaze hook drives the store's ingest off video currentTime.
  const [replayRecording, setReplayRecording] = useState<RecordingSummary | null>(null);
  const mode: "live" | "replay" = replayRecording ? "replay" : "live";
  const sceneViewerRef = useRef<SceneViewerHandle | null>(null);
  const sceneVideoRef = useRef<HTMLVideoElement | null>(null);

  // One-time session-start banner so the first log dump is self-contained.
  // useRef guard avoids the React 18 Strict Mode dev-only double-fire.
  const mountedOnce = useRef(false);
  useEffect(() => {
    if (mountedOnce.current) return;
    mountedOnce.current = true;
    installConsoleTap();
    logger.info("session", "viewer mounted", {
      adapter: START_ADAPTER,
      g3Base: G3_BASE,
      g3Direct: G3_DIRECT || "(unset)",
      g3Ws: G3_WS || "(unset)",
      origin: typeof location !== "undefined" ? location.origin : "?",
      ua: typeof navigator !== "undefined" ? navigator.userAgent : "?",
    });

    // Page Visibility — correlate disconnects with tab blur/focus. Logs only,
    // no behavioural effect. The keep-alive runs in a Worker so it shouldn't
    // care, but this makes it provable from a single dump.
    const onVis = () =>
      logger.info(
        "session",
        `visibility=${document.visibilityState}`,
        { hidden: document.hidden }
      );
    document.addEventListener("visibilitychange", onVis);
    const onFocus = () => logger.info("session", "window focus");
    const onBlur = () => logger.info("session", "window blur");
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const state = useStore((s) => s.state);
  const statusMessage = useStore((s) => s.statusMessage);
  const recording = useStore((s) => s.recording);
  const setStatus = useStore((s) => s.setStatus);
  const ingest = useStore((s) => s.ingest);
  const setRecording = useStore((s) => s.setRecording);
  const clearBuffers = useStore((s) => s.clearBuffers);

  const disconnect = useCallback(
    async (opts?: { userInitiated?: boolean }) => {
      if (opts?.userInitiated) userDisconnectedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      unsubsRef.current.forEach((u) => u());
      unsubsRef.current = [];
      const prev = adapterRef.current;
      adapterRef.current = null;
      setScene(null);
      setEye(null);
      if (prev) {
        logger.info("session", "disconnecting previous adapter", {
          userInitiated: !!opts?.userInitiated,
        });
        try {
          await prev.disconnect();
        } catch (e) {
          logger.warn("session", "previous adapter disconnect threw", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    },
    []
  );

  // Defined as a ref so the status subscription can call it without re-binding
  // the adapter every time `connect` changes identity.
  const scheduleReconnectRef = useRef<() => void>(() => {});

  const connect = useCallback(async () => {
    // Always tear down any previous adapter first — otherwise its keep-alive
    // worker and ws keep firing against a dead session and pollute logs.
    if (adapterRef.current) await disconnect();
    userDisconnectedRef.current = false;
    clearBuffers();
    const a: TobiiAdapter =
      kind === "webrtc"
        ? new WebRtcTobiiAdapter({ http: G3_BASE, ws: G3_WS })
        : new MockTobiiAdapter();
    adapterRef.current = a;
    unsubsRef.current.push(
      a.onStatus((s) => {
        setStatus(s, a.kind);
        // A healthy (re)connection clears any lingering stale-loop banner.
        if (s.state === "connected" || s.state === "connecting") {
          setMdnsStalled(false);
        }
        if (
          a.kind === "webrtc" &&
          s.state === "error" &&
          !userDisconnectedRef.current
        ) {
          // Deterministic mDNS-stale death: auto-reconnecting would just loop
          // back into the same ~25s drop. Halt the loop and prompt the user
          // for the real fix (real-IP mode) instead.
          if (s.reason === "mdns-stale") {
            setMdnsStalled(true);
            return;
          }
          // Genuinely transient error → reconnect if the user allows it.
          if (autoReconnect) {
            scheduleReconnectRef.current();
          }
        }
      })
    );
    unsubsRef.current.push(a.onGaze(ingest));
    try {
      await a.connect();
      setScene(a.getSceneStream());
      setEye(a.getEyeStream());
    } catch {
      // status already set to "error" by the adapter
    }
  }, [kind, clearBuffers, ingest, setStatus, disconnect, autoReconnect]);

  // Wire the reconnect scheduler now that `connect` exists.
  useEffect(() => {
    scheduleReconnectRef.current = () => {
      if (reconnectTimerRef.current) return; // already scheduled
      const now = Date.now();
      const recent = reconnectAttemptsRef.current.filter((t) => now - t < 60000);
      reconnectAttemptsRef.current = recent;
      if (recent.length >= 5) {
        logger.warn(
          "session",
          "auto-reconnect rate-limited (5 attempts in 60s) — staying error"
        );
        return;
      }
      const delay = recent.length === 0 ? 1500 : 3000;
      logger.info("session", `auto-reconnect scheduled in ${delay}ms`, {
        recentAttempts: recent.length,
      });
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        reconnectAttemptsRef.current.push(Date.now());
        void connect();
      }, delay);
    };
  }, [connect]);

  const calibrate = useCallback(async (): Promise<boolean> => {
    const fn = adapterRef.current?.calibrate;
    if (!fn) {
      logger.warn(
        "session",
        "calibrate: adapter has no calibrate() (mock or stub adapter)"
      );
      return false;
    }
    const ok = await fn.call(adapterRef.current!);
    return ok;
  }, []);

  // Click "record": flip both the device recording (via sidecar) and the
  // local CSV capture. Sidecar failures don't block local capture — we want
  // gaze exports to still work even without the sidecar running.
  const toggleRecord = useCallback(async () => {
    const local = useStore.getState().recording;
    const onDevice = deviceRecordingUuid !== null;

    // Starting (neither active): try sidecar first, always set local.
    if (!local && !onDevice) {
      try {
        const r = await sidecarStart();
        setDeviceRecordingUuid(r.uuid);
        logger.info("session", `device recording started: ${r.uuid}`);
      } catch (e) {
        const msg =
          e instanceof SidecarError
            ? `sidecar: ${e.message}`
            : e instanceof Error
            ? e.message
            : String(e);
        logger.warn(
          "session",
          `device recording NOT started (local CSV still on): ${msg}`
        );
      }
      setRecording(true);
      return;
    }

    // Stopping: send !stop if we know a uuid; always clear local + refresh list.
    if (onDevice) {
      const uuid = deviceRecordingUuid;
      try {
        await sidecarStop(uuid!);
        logger.info("session", `device recording stopped: ${uuid}`);
      } catch (e) {
        const msg =
          e instanceof SidecarError
            ? `sidecar: ${e.message}`
            : e instanceof Error
            ? e.message
            : String(e);
        logger.warn("session", `recorder!stop failed (continuing): ${msg}`);
      }
      setDeviceRecordingUuid(null);
      setRecordingsRefresh((n) => n + 1);
    }
    setRecording(false);
  }, [deviceRecordingUuid, setRecording]);

  const onRequestIpExposure = useCallback(async () => {
    const result = await requestLocalIpExposure();
    setIpExposure(result);
  }, []);

  const userDisconnect = useCallback(
    () => disconnect({ userInitiated: true }),
    [disconnect]
  );

  // Entering replay tears down any live connection — we don't need both, and
  // the WebRTC keep-alive would keep firing if we didn't.
  const enterReplay = useCallback(
    (rec: RecordingSummary) => {
      if (adapterRef.current) void disconnect({ userInitiated: true });
      clearBuffers();
      setReplayRecording(rec);
      logger.info("session", `entered replay: ${rec.uuid} (${rec.name})`);
    },
    [disconnect, clearBuffers]
  );

  const exitReplay = useCallback(() => {
    if (replayRecording) {
      logger.info("session", `exited replay: ${replayRecording.uuid}`);
    }
    setReplayRecording(null);
    clearBuffers();
  }, [replayRecording, clearBuffers]);

  // Capture the <video> element ref from SceneViewer so the gaze hook can
  // observe its currentTime.
  const setSceneViewerRef = useCallback((h: SceneViewerHandle | null) => {
    sceneViewerRef.current = h;
    sceneVideoRef.current = h?.video ?? null;
  }, []);

  const replaySceneSrc =
    replayRecording &&
    `${G3_BASE}/recordings/${encodeURIComponent(replayRecording.uuid)}/scenevideo.mp4`;
  const replayEyeSrc =
    replayRecording && replayRecording.has_eye_video
      ? `${G3_BASE}/recordings/${encodeURIComponent(replayRecording.uuid)}/eyecameras.mp4`
      : null;

  useReplayGaze(replayRecording?.uuid ?? null, sceneVideoRef);

  const connected = state === "connected" || state === "connecting";
  const inReplay = mode === "replay";

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-5">
      {/* Header */}
      <header className="mb-5 flex items-center justify-between border-b border-line pb-3">
        <div>
          <h1 className="font-mono text-lg font-medium tracking-tight text-text">
            OKN<span className="text-signal"> // </span>Viewer
          </h1>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
            Tobii Pro Glasses 3 · optokinetic nystagmus
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <span
            className={`h-2 w-2 rounded-full ${STATUS_COLOR[state] ?? "bg-muted"}`}
          />
          <span className="font-mono text-xs text-muted">
            {state}
            {statusMessage ? ` · ${statusMessage}` : ""}
          </span>
        </div>
      </header>

      {/* Mode banner — shown only in replay so it's obvious you're not live */}
      {inReplay && replayRecording && (
        <div className="mb-3 flex items-center justify-between rounded border border-warn/60 bg-warn/10 px-3 py-2 font-mono text-[11px]">
          <span className="text-warn">
            REPLAY · {replayRecording.name} · {replayRecording.duration_s.toFixed(1)}s ·{" "}
            {replayRecording.uuid.slice(0, 8)}…
          </span>
          <button
            onClick={exitReplay}
            className="rounded border border-warn px-2 py-0.5 text-warn hover:bg-warn/20"
          >
            exit replay
          </button>
        </div>
      )}

      {/* mDNS-stale stall banner — the connection kept dying at ~25s because
          Chrome's anonymized mDNS ICE candidates lapse and the glasses lose
          the route back. We stopped the reconnect loop; the user needs to
          enable real-IP mode (or disable Chrome's mDNS flag) and reconnect. */}
      {mdnsStalled && (
        <div className="mb-3 rounded border border-alert/60 bg-alert/10 px-3 py-2 font-mono text-[11px]">
          <div className="text-alert">
            STREAM STALLED · media died at ~25s on anonymized mDNS candidates —
            the glasses can&apos;t keep resolving this client&apos;s address, so
            auto-reconnect was halted to avoid looping.
          </div>
          <div className="mt-1 text-muted">
            Fix: expose your real LAN IP, then reconnect. Either grant mic
            permission below (Chrome stops anonymizing once a media device is
            granted) or set{" "}
            <span className="text-text">
              chrome://flags/#enable-webrtc-hide-local-ips-with-mdns
            </span>{" "}
            to Disabled.
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {ipExposure !== "granted" && ipExposure !== "unavailable" && (
              <button
                onClick={onRequestIpExposure}
                className="rounded border border-signal px-2 py-0.5 text-signal hover:bg-signal/20"
              >
                grant mic (real-IP mode)
              </button>
            )}
            <button
              onClick={connect}
              className="rounded border border-alert px-2 py-0.5 text-alert hover:bg-alert/20"
            >
              reconnect
            </button>
          </div>
        </div>
      )}

      {/* Body: telemetry rail + main + controls sidebar. The TELEMETRY card
          lives in its own left column so every per-frame readout stays in
          frame during a screen recording without scrolling. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr_340px]">
        <aside className="space-y-4">
          <HudPanel />
        </aside>

        <div className="space-y-4">
          <SceneViewer
            ref={setSceneViewerRef}
            stream={inReplay ? null : scene}
            replaySrc={replaySceneSrc}
          />
          {/* Center column for the demo screen recording: scene viewer, then
              the eye cameras, the rolling pupil chart, and the timeline. */}
          <EyeCameraGrid
            stream={inReplay ? null : eye}
            replaySrc={replayEyeSrc}
          />
          <PupilTrend />
          <Timeline />
        </div>

        <aside className="space-y-4">
          <Controls
            connected={connected}
            recording={recording}
            adapterKind={kind}
            onConnect={connect}
            onDisconnect={userDisconnect}
            onCalibrate={calibrate}
            onToggleRecord={toggleRecord}
            onPickAdapter={setKind}
            autoReconnect={autoReconnect}
            onToggleAutoReconnect={setAutoReconnect}
            ipExposureStatus={ipExposure}
            onRequestIpExposure={onRequestIpExposure}
            disabledForReplay={inReplay}
          />
          <EventMarkers />
          <RecordingsList
            recordingUuid={deviceRecordingUuid}
            refreshKey={recordingsRefresh}
            onSelectRecording={enterReplay}
            activeReplayUuid={replayRecording?.uuid ?? null}
          />
        </aside>
      </div>

      <footer className="mt-6 border-t border-line pt-3 font-mono text-[10px] leading-relaxed text-muted">
        Visualization / heuristic tool — not a diagnostic device. Derived flags
        (below-line, blink, direction, mode) are unvalidated until checked
        against a defined protocol.
      </footer>
    </main>
  );
}
