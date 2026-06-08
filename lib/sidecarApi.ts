// TypeScript client for the local sidecar HTTP API. Shapes mirror the
// Pydantic models in sidecar/src/tobii_okn_sidecar/storage/ and app.py — if
// you change one side, change the other. We don't generate from OpenAPI for
// v1.1 because there are five endpoints and they barely change.

import { logger } from "./logger";

export interface SidecarHealth {
  status: "ok";
  version: string;
  time: string;
  device_host: string;
}

export interface RecordingSummary {
  uuid: string;
  name: string;
  created: string;
  duration_s: number;
  timezone: string;
  gaze_samples: number;
  gaze_valid_samples: number;
  has_eye_video: boolean;
  has_events: boolean;
  has_imu: boolean;
  downloaded_locally: boolean;
  subject_id: string | null;
}

export interface StartResponse {
  uuid: string;
  started_at: string;
}

export interface StopResponse {
  uuid: string;
  stopped_at: string;
}

export type JobStatus = "pending" | "running" | "done" | "failed";

export interface ExportStartResponse {
  job_id: string;
  recording_uuid: string;
}

export interface JobStatusResponse {
  id: string;
  recording_uuid: string;
  status: JobStatus;
  progress: number;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  download_url: string | null;
}

export class SidecarError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string
  ) {
    super(message);
    this.name = "SidecarError";
  }
}

// ---------------------------------------------------------------------------
// Client surface
// ---------------------------------------------------------------------------

const SIDECAR_BASE =
  process.env.NEXT_PUBLIC_SIDECAR_BASE ?? "http://127.0.0.1:8765";

async function call<T>(
  path: string,
  init: RequestInit = {},
  opts: { tag: string }
): Promise<T> {
  const url = `${SIDECAR_BASE}${path}`;
  const t0 = performance.now();
  let r: Response;
  try {
    r = await fetch(url, {
      ...init,
      headers: { Accept: "application/json", ...(init.headers ?? {}) },
    });
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("sidecar", `${opts.tag}: fetch threw after ${ms}ms`, {
      url,
      error: msg,
    });
    throw new SidecarError(`sidecar unreachable: ${msg}`, 0);
  }
  const text = await r.text();
  const ms = Math.round(performance.now() - t0);
  if (!r.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.detail === "string") detail = parsed.detail;
    } catch {
      /* keep raw text */
    }
    logger.error("sidecar", `${opts.tag}: HTTP ${r.status} in ${ms}ms`, {
      url,
      detail,
    });
    throw new SidecarError(detail, r.status, detail);
  }
  logger.info("sidecar", `${opts.tag}: HTTP ${r.status} in ${ms}ms`);
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export function getHealth(): Promise<SidecarHealth> {
  return call<SidecarHealth>("/health", { method: "GET" }, { tag: "health" });
}

export function listRecordings(): Promise<RecordingSummary[]> {
  return call<RecordingSummary[]>(
    "/recordings",
    { method: "GET" },
    { tag: "listRecordings" }
  );
}

export function getRecording(uuid: string): Promise<RecordingSummary> {
  return call<RecordingSummary>(
    `/recordings/${encodeURIComponent(uuid)}`,
    { method: "GET" },
    { tag: `getRecording(${uuid.slice(0, 8)})` }
  );
}

export function startRecording(): Promise<StartResponse> {
  return call<StartResponse>(
    "/record/start",
    { method: "POST" },
    { tag: "startRecording" }
  );
}

export function stopRecording(uuid: string): Promise<StopResponse> {
  return call<StopResponse>(
    `/record/${encodeURIComponent(uuid)}/stop`,
    { method: "POST" },
    { tag: `stopRecording(${uuid.slice(0, 8)})` }
  );
}

export function startExport(uuid: string): Promise<ExportStartResponse> {
  return call<ExportStartResponse>(
    `/recordings/${encodeURIComponent(uuid)}/export`,
    { method: "POST" },
    { tag: `startExport(${uuid.slice(0, 8)})` }
  );
}

export function getJob(jobId: string): Promise<JobStatusResponse> {
  return call<JobStatusResponse>(
    `/jobs/${encodeURIComponent(jobId)}`,
    { method: "GET" },
    { tag: `getJob(${jobId})` }
  );
}

export function getLatestJobForRecording(
  uuid: string
): Promise<JobStatusResponse | null> {
  return call<JobStatusResponse | null>(
    `/jobs/by-recording/${encodeURIComponent(uuid)}`,
    { method: "GET" },
    { tag: `getLatestJob(${uuid.slice(0, 8)})` }
  );
}

/** Absolute URL the browser can hit to download a finished export. */
export function exportDownloadUrl(uuid: string): string {
  return `${SIDECAR_BASE}/recordings/${encodeURIComponent(uuid)}/export.mp4`;
}

export const SIDECAR_BASE_URL = SIDECAR_BASE;
