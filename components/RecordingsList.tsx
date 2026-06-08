"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getHealth,
  listRecordings,
  SidecarError,
  type RecordingSummary,
  type SidecarHealth,
} from "@/lib/sidecarApi";
import ExportButton from "./ExportButton";

interface Props {
  /** uuid currently being device-recorded, if any. Shown as `● recording`. */
  recordingUuid: string | null;
  /** uuid currently loaded in replay mode, if any. Shown highlighted as the
   * active replay so the user knows what they're watching. */
  activeReplayUuid?: string | null;
  /** Click handler; parent typically enters replay mode with the selected
   * recording. Unset means rows aren't clickable. */
  onSelectRecording?: (rec: RecordingSummary) => void;
  /** Bump to force a refresh (e.g., right after stop). */
  refreshKey?: number;
}

export default function RecordingsList({
  recordingUuid,
  activeReplayUuid = null,
  onSelectRecording,
  refreshKey = 0,
}: Props) {
  const [health, setHealth] = useState<SidecarHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listRecordings();
      setRecordings(list);
    } catch (e) {
      const msg =
        e instanceof SidecarError
          ? `${e.status === 0 ? "unreachable" : `HTTP ${e.status}`}: ${e.message}`
          : e instanceof Error
          ? e.message
          : String(e);
      setError(msg);
      setRecordings([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Health on mount; refresh recordings on mount + whenever refreshKey bumps.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const h = await getHealth();
        if (!cancelled) {
          setHealth(h);
          setHealthError(null);
        }
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          setHealthError(msg);
          setHealth(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  return (
    <div className="space-y-3 rounded-md border border-line bg-panel p-3">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-signal">
          recordings
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted hover:border-signal hover:text-signal disabled:opacity-30"
        >
          {loading ? "…" : "refresh"}
        </button>
      </div>

      {/* Sidecar health pill — surfaces what host the sidecar is talking to */}
      <div className="font-mono text-[10px] text-muted">
        {health ? (
          <>
            sidecar {health.version} · device{" "}
            <span className="text-text">{health.device_host}</span>
          </>
        ) : healthError ? (
          <span className="text-alert">sidecar offline: {healthError}</span>
        ) : (
          "checking sidecar…"
        )}
      </div>

      {/* Error state — distinct from "empty" */}
      {error && (
        <div className="rounded border border-alert/50 bg-alert/10 p-2 font-mono text-[10px] text-alert">
          list failed: {error}
        </div>
      )}

      {/* Body */}
      {recordings.length === 0 ? (
        <div className="font-mono text-[10px] text-muted">
          {loading ? "loading…" : "no recordings on the device"}
        </div>
      ) : (
        <ul className="space-y-1">
          {recordings.map((r) => {
            const isRecording = r.uuid === recordingUuid;
            const isReplaying = r.uuid === activeReplayUuid;
            const clickable = !!onSelectRecording && !isRecording;
            return (
              <li
                key={r.uuid}
                className={`rounded border px-2 py-1.5 font-mono text-[10px] transition ${
                  isRecording
                    ? "border-alert bg-alert/10 text-alert"
                    : isReplaying
                    ? "border-signal bg-signal/10 text-signal cursor-pointer"
                    : clickable
                    ? "border-line text-text hover:border-signal hover:text-signal cursor-pointer"
                    : "border-line text-text"
                }`}
                onClick={() => clickable && onSelectRecording!(r)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{r.name}</span>
                  <span className="shrink-0 text-muted">
                    {r.duration_s.toFixed(1)}s
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 text-muted">
                  <span className="truncate">{r.uuid.slice(0, 8)}…</span>
                  <span>
                    {r.gaze_valid_samples}/{r.gaze_samples} gaze
                  </span>
                </div>
                {isRecording && (
                  <div className="text-[10px] uppercase tracking-widest">
                    ● recording
                  </div>
                )}
                {isReplaying && !isRecording && (
                  <div className="text-[10px] uppercase tracking-widest">
                    ▶ replaying
                  </div>
                )}
                {/* Export controls — disabled for the in-flight recording so we
                    don't try to pull files mid-write. */}
                {!isRecording && (
                  <div className="mt-1">
                    <ExportButton recordingUuid={r.uuid} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
