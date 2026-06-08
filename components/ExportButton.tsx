"use client";

// Per-recording export control. Three visible states:
//   - idle/done: a small "export annotated" button (or "download" if cached)
//   - running: progress bar + "exporting: NN%"
//   - failed: red error text + retry button
//
// On mount we ping /jobs/by-recording/<uuid> so a reload mid-export
// reconnects to the in-flight progress without losing UX continuity.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  exportDownloadUrl,
  getJob,
  getLatestJobForRecording,
  SidecarError,
  startExport,
  type JobStatusResponse,
} from "@/lib/sidecarApi";
import { logger } from "@/lib/logger";

interface Props {
  recordingUuid: string;
}

const POLL_INTERVAL_MS = 1000;

export default function ExportButton({ recordingUuid }: Props) {
  const [job, setJob] = useState<JobStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);

  // Poll helper: fetch latest job state for THIS recording and schedule the
  // next poll if still running. Idempotent — safe to call repeatedly.
  const pollOnce = useCallback(async () => {
    if (stoppedRef.current) return;
    try {
      const j = await getLatestJobForRecording(recordingUuid);
      if (stoppedRef.current) return;
      setJob(j);
      setError(null);
      if (j && (j.status === "pending" || j.status === "running")) {
        pollTimer.current = setTimeout(pollOnce, POLL_INTERVAL_MS);
      }
    } catch (e) {
      if (stoppedRef.current) return;
      const msg =
        e instanceof SidecarError
          ? `sidecar: ${e.message}`
          : e instanceof Error
          ? e.message
          : String(e);
      setError(msg);
    }
  }, [recordingUuid]);

  // On mount: pick up any in-flight job for this recording.
  useEffect(() => {
    stoppedRef.current = false;
    void pollOnce();
    return () => {
      stoppedRef.current = true;
      if (pollTimer.current) {
        clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [pollOnce]);

  const onStart = useCallback(async () => {
    setError(null);
    try {
      const res = await startExport(recordingUuid);
      logger.info(
        "export",
        `started job ${res.job_id} for ${recordingUuid.slice(0, 8)}`
      );
      // Eagerly fetch the freshly-created job so we don't have to wait a poll.
      const j = await getJob(res.job_id);
      setJob(j);
      pollTimer.current = setTimeout(pollOnce, POLL_INTERVAL_MS);
    } catch (e) {
      const msg =
        e instanceof SidecarError
          ? `${e.status === 0 ? "unreachable" : `HTTP ${e.status}`}: ${e.message}`
          : e instanceof Error
          ? e.message
          : String(e);
      setError(msg);
    }
  }, [recordingUuid, pollOnce]);

  const status = job?.status;
  const inFlight = status === "pending" || status === "running";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        {inFlight ? (
          <span className="font-mono text-[10px] uppercase tracking-widest text-warn">
            exporting {(Math.round((job!.progress || 0) * 100))}%
          </span>
        ) : status === "done" && job?.download_url ? (
          <a
            href={exportDownloadUrl(recordingUuid)}
            target="_blank"
            rel="noreferrer"
            download
            className="rounded border border-signal bg-signal/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-signal hover:bg-signal/20"
          >
            ↓ download annotated
          </a>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void onStart();
            }}
            className="rounded border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-text hover:border-signal hover:text-signal"
          >
            export annotated
          </button>
        )}
        {status === "failed" && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void onStart();
            }}
            className="rounded border border-alert px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-alert hover:bg-alert/10"
          >
            retry
          </button>
        )}
      </div>

      {inFlight && (
        <div className="h-1 w-full overflow-hidden rounded bg-line">
          <div
            className="h-full bg-warn transition-all"
            style={{ width: `${(job?.progress ?? 0) * 100}%` }}
          />
        </div>
      )}

      {status === "failed" && job?.error && (
        <div className="font-mono text-[10px] text-alert">
          export failed: {job.error}
        </div>
      )}

      {error && (
        <div className="font-mono text-[10px] text-alert">{error}</div>
      )}
    </div>
  );
}
