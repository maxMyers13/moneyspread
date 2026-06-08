"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getHealth,
  listRecordings,
  SidecarError,
  type RecordingSummary,
  type SidecarHealth,
} from "@/lib/sidecarApi";

interface Props {
  /** uuid that's currently being device-recorded, if any. Highlighted in the
   * list while in flight. Provided by the parent because the record state
   * lives at the app level. */
  recordingUuid: string | null;
  /** Optional: parent gets notified when the user clicks a recording (Phase B3
   * will wire this to replay mode). For now, null = no handler. */
  onSelectRecording?: (rec: RecordingSummary) => void;
  /** Bump to force a refresh from the parent (e.g., right after stop). */
  refreshKey?: number;
}

export default function RecordingsList({
  recordingUuid,
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
            const isActive = r.uuid === recordingUuid;
            const clickable = !!onSelectRecording;
            return (
              <li
                key={r.uuid}
                className={`rounded border px-2 py-1.5 font-mono text-[10px] transition ${
                  isActive
                    ? "border-alert bg-alert/10 text-alert"
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
                {isActive && (
                  <div className="text-[10px] uppercase tracking-widest">
                    ● recording
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
