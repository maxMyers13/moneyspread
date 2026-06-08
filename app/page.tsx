"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import SceneViewer from "@/components/SceneViewer";
import EyeCameraInset from "@/components/EyeCameraInset";
import HudPanel from "@/components/HudPanel";
import PupilTrend from "@/components/PupilTrend";
import Controls from "@/components/Controls";
import { useStore } from "@/lib/store";
import { G3_BASE, G3_DIRECT, G3_WS, START_ADAPTER } from "@/lib/config";
import { MockTobiiAdapter } from "@/lib/adapters/mockAdapter";
import { WebRtcTobiiAdapter } from "@/lib/adapters/webrtcAdapter";
import type { AdapterKind, TobiiAdapter, Unsubscribe } from "@/lib/adapters/types";
import { installConsoleTap, logger } from "@/lib/logger";
import {
  getStoredExposureStatus,
  requestLocalIpExposure,
  type LocalIpExposureStatus,
} from "@/lib/exposeLocalIp";

const STATUS_COLOR: Record<string, string> = {
  connected: "bg-signal",
  connecting: "bg-warn",
  error: "bg-alert",
  disconnected: "bg-muted",
};

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
  const [ipExposure, setIpExposure] = useState<LocalIpExposureStatus>("unknown");
  useEffect(() => {
    setIpExposure(getStoredExposureStatus());
  }, []);

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
        // Webrtc mode + autoReconnect on + adapter went to error + user did
        // not click Disconnect → schedule a reconnect. This catches the ~25s
        // mDNS-stale drop until we find a real fix.
        if (
          a.kind === "webrtc" &&
          s.state === "error" &&
          autoReconnect &&
          !userDisconnectedRef.current
        ) {
          scheduleReconnectRef.current();
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

  const calibrate = useCallback(() => {
    void adapterRef.current?.calibrate?.();
  }, []);

  const toggleRecord = useCallback(() => {
    setRecording(!useStore.getState().recording);
  }, [setRecording]);

  const onRequestIpExposure = useCallback(async () => {
    const result = await requestLocalIpExposure();
    setIpExposure(result);
  }, []);

  const userDisconnect = useCallback(
    () => disconnect({ userInitiated: true }),
    [disconnect]
  );

  const connected = state === "connected" || state === "connecting";

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
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${STATUS_COLOR[state] ?? "bg-muted"}`}
          />
          <span className="font-mono text-xs text-muted">
            {state}
            {statusMessage ? ` · ${statusMessage}` : ""}
          </span>
        </div>
      </header>

      {/* Body: main + sidebar */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <SceneViewer stream={scene} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <EyeCameraInset stream={eye} />
            <PupilTrend />
          </div>
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
          />
          <HudPanel />
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
