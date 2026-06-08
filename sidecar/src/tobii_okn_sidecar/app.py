"""FastAPI entrypoint. Talks to the Tobii Pro Glasses 3 recording unit via
the G3ApiClient (WebSocket g3api protocol) for the control plane:

  POST /record/start              recorder!start, then read recorder.uuid
  POST /record/{uuid}/stop        recorder!stop
  GET  /recordings                list device recordings + hydrate manifests
  GET  /recordings/{uuid}         fetch one recording's manifest + sidecar notes

The browser plays back recordings *directly* from the device through the
Next.js /g3 reverse-proxy — we don't proxy media here. Device serves Range
natively (verified via spike), so <video> seek works and gazedata.gz is
fetchable with ?use-content-encoding=true for transparent gzip.

CORS is permissive on purpose: browser at http://localhost:3000 hits us at
http://localhost:8765, and we don't ship behind a reverse proxy.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import __version__
from .device import G3ApiClient, G3ApiError
from .export import JobRegistry, run_export
from .export.jobs import get_registry
from .storage import DeviceRecordingManifest, RecordingSummary, SidecarRecord

logger = logging.getLogger("tobii_okn_sidecar")


# ---------------------------------------------------------------------------
# Configuration. Env-var driven so the browser-side adapter can talk to a
# different unit without code changes.
# ---------------------------------------------------------------------------


def _device_host() -> str:
    """G3_HOST env var → hostname/IP of the recording unit (no scheme).
    Defaults to the test unit's mDNS name so dev works zero-config."""
    return os.environ.get("G3_HOST", "tg03b-080200012671.local")


def _recordings_root() -> Path:
    """Where adjacent sidecar.json annotations live. SIDECAR_RECORDINGS_DIR
    overrides; default `./recordings/` relative to the sidecar's cwd."""
    return Path(os.environ.get("SIDECAR_RECORDINGS_DIR", "recordings")).resolve()


def _http_timeout_s() -> float:
    return float(os.environ.get("SIDECAR_HTTP_TIMEOUT_S", "8.0"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    root = _recordings_root()
    root.mkdir(parents=True, exist_ok=True)
    logger.info(
        "sidecar starting: device=%s  recordings_dir=%s",
        _device_host(),
        root,
    )
    yield


# ---------------------------------------------------------------------------
# App + middleware
# ---------------------------------------------------------------------------


app = FastAPI(
    title="tobii-okn-sidecar",
    version=__version__,
    description=(
        "Companion service for the Tobii OKN viewer — device-recording "
        "orchestrator, replay metadata, future annotated export."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Response models specific to control-plane actions (not the joined recording
# summary, which lives in storage/).
# ---------------------------------------------------------------------------


class HealthResponse(BaseModel):
    status: Literal["ok"]
    version: str
    time: str
    device_host: str
    """The G3_HOST the sidecar is configured to talk to. Browser surfaces it
    so users can see they're pointed at the right unit."""


class StartResponse(BaseModel):
    uuid: str
    """Device-assigned recording uuid; same id used in /recordings/<uuid> paths."""
    started_at: str
    """Wall-clock UTC on the *sidecar*. The device's recording.g3 has its own
    `created` timestamp in the device's timezone — that's authoritative for
    the data; this one is just for sidecar-side bookkeeping."""


class StopResponse(BaseModel):
    uuid: str
    stopped_at: str


class ExportStartResponse(BaseModel):
    job_id: str
    recording_uuid: str


class JobStatusResponse(BaseModel):
    id: str
    recording_uuid: str
    status: Literal["pending", "running", "done", "failed"]
    progress: float
    error: str | None = None
    started_at: str
    completed_at: str | None = None
    download_url: str | None = None
    """Set on `done` — relative URL the browser can hit to fetch the .mp4."""


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        version=__version__,
        time=datetime.now(UTC).isoformat(),
        device_host=_device_host(),
    )


@app.post("/record/start", response_model=StartResponse)
async def record_start() -> StartResponse:
    host = _device_host()
    try:
        async with G3ApiClient(host) as c:
            started = await c.call_action("recorder!start", [])
            if started is not True:
                raise HTTPException(
                    status_code=502,
                    detail=f"recorder!start returned {started!r} (expected true)",
                )
            uuid = await c.read_property("recorder.uuid")
    except G3ApiError as e:
        raise HTTPException(status_code=502, detail=f"device error: {e}") from e
    except OSError as e:
        raise HTTPException(
            status_code=503, detail=f"device unreachable at {host}: {e}"
        ) from e

    if not isinstance(uuid, str) or len(uuid) < 8:
        raise HTTPException(
            status_code=502,
            detail=f"recorder.uuid not a usable string: {uuid!r}",
        )
    return StartResponse(uuid=uuid, started_at=datetime.now(UTC).isoformat())


@app.post("/record/{uuid}/stop", response_model=StopResponse)
async def record_stop(uuid: str) -> StopResponse:
    host = _device_host()
    try:
        async with G3ApiClient(host) as c:
            stopped = await c.call_action("recorder!stop", [])
            if stopped is not True:
                raise HTTPException(
                    status_code=502,
                    detail=f"recorder!stop returned {stopped!r} (expected true)",
                )
    except G3ApiError as e:
        raise HTTPException(status_code=502, detail=f"device error: {e}") from e
    except OSError as e:
        raise HTTPException(
            status_code=503, detail=f"device unreachable at {host}: {e}"
        ) from e
    return StopResponse(uuid=uuid, stopped_at=datetime.now(UTC).isoformat())


@app.get("/recordings", response_model=list[RecordingSummary])
async def list_recordings() -> list[RecordingSummary]:
    """Enumerate the device's recordings and hydrate each one's manifest +
    local sidecar notes. Best-effort: a failure to fetch any single recording
    is logged and skipped, not fatal — the recordings sidebar should show
    what's available, not 500."""
    host = _device_host()
    try:
        async with G3ApiClient(host) as c:
            children = await c.read_property("recordings.children")
    except (G3ApiError, OSError) as e:
        logger.warning("recordings.children unavailable: %s", e)
        return []

    if not isinstance(children, list):
        logger.warning(
            "recordings.children returned non-list (%s) — returning empty",
            type(children).__name__,
        )
        return []

    summaries: list[RecordingSummary] = []
    root = _recordings_root()
    async with httpx.AsyncClient(
        base_url=f"http://{host}", timeout=_http_timeout_s()
    ) as h:
        for entry in children:
            # Children can be bare uuid strings or {uuid, ...} dicts depending
            # on which read shape the firmware uses for this property. Cover
            # both; skip anything we can't recognise.
            if isinstance(entry, str):
                uuid = entry
            elif isinstance(entry, dict) and isinstance(entry.get("uuid"), str):
                uuid = entry["uuid"]
            else:
                logger.warning("skipping unrecognized recordings child: %r", entry)
                continue
            try:
                r = await h.get(f"/recordings/{uuid}")
                r.raise_for_status()
                manifest = DeviceRecordingManifest.model_validate(r.json())
            except (httpx.HTTPError, ValueError) as e:
                logger.warning("manifest fetch failed for %s: %s", uuid, e)
                continue
            sidecar = SidecarRecord.load_or_default(root / uuid)
            summaries.append(RecordingSummary.from_manifest(manifest, sidecar))
    return summaries


@app.get("/recordings/{uuid}", response_model=RecordingSummary)
async def get_recording(uuid: str) -> RecordingSummary:
    """Fetch a single recording's joined manifest + sidecar. Manifest comes
    fresh from the device; sidecar.json is read from local disk if present."""
    host = _device_host()
    async with httpx.AsyncClient(
        base_url=f"http://{host}", timeout=_http_timeout_s()
    ) as h:
        try:
            r = await h.get(f"/recordings/{uuid}")
        except httpx.HTTPError as e:
            raise HTTPException(
                status_code=503,
                detail=f"device unreachable at {host}: {e}",
            ) from e
        if r.status_code == 404:
            raise HTTPException(status_code=404, detail=f"recording {uuid} not on device")
        if not r.is_success:
            raise HTTPException(
                status_code=502,
                detail=f"device returned HTTP {r.status_code} for /recordings/{uuid}",
            )
        try:
            manifest = DeviceRecordingManifest.model_validate(r.json())
        except ValueError as e:
            raise HTTPException(
                status_code=502,
                detail=f"recording.g3 unparseable: {e}",
            ) from e
    sidecar = SidecarRecord.load_or_default(_recordings_root() / uuid)
    return RecordingSummary.from_manifest(manifest, sidecar)


# ---------------------------------------------------------------------------
# Export — annotated MP4 via ffmpeg + ASS subtitle overlay
# ---------------------------------------------------------------------------


def _jobs() -> JobRegistry:
    return get_registry()


def _job_to_response(job_id: str) -> JobStatusResponse:
    j = _jobs().get(job_id)
    if j is None:
        raise HTTPException(status_code=404, detail=f"job {job_id} not found")
    download_url = (
        f"/recordings/{j.recording_uuid}/export.mp4" if j.status == "done" else None
    )
    return JobStatusResponse(
        id=j.id,
        recording_uuid=j.recording_uuid,
        status=j.status,
        progress=j.progress,
        error=j.error,
        started_at=j.started_at,
        completed_at=j.completed_at,
        download_url=download_url,
    )


@app.post("/recordings/{uuid}/export", response_model=ExportStartResponse)
async def start_export(uuid: str) -> ExportStartResponse:
    """Kick off an annotated-MP4 export for the given recording. Returns
    immediately with a job_id; client polls /jobs/{job_id} for progress.

    Multiple invocations on the same uuid create distinct jobs — the
    caller can use /jobs/by-recording/{uuid} to find the latest if they
    lost the id (e.g. across a browser reload)."""
    job = await _jobs().create(uuid)
    job.task = asyncio.create_task(
        run_export(
            job_id=job.id,
            recording_uuid=uuid,
            device_host=_device_host(),
            recordings_root=_recordings_root(),
            registry=_jobs(),
            http_timeout_s=_http_timeout_s(),
        ),
        name=f"export-{job.id}",
    )
    logger.info("export queued: job=%s recording=%s", job.id, uuid)
    return ExportStartResponse(job_id=job.id, recording_uuid=uuid)


@app.get("/jobs/{job_id}", response_model=JobStatusResponse)
async def get_job(job_id: str) -> JobStatusResponse:
    return _job_to_response(job_id)


@app.get("/jobs/by-recording/{uuid}", response_model=JobStatusResponse | None)
async def get_job_by_recording(uuid: str) -> JobStatusResponse | None:
    """Find the latest export job for a recording. Useful for surviving
    browser reloads — the client can reconnect to an in-flight job
    without having tracked its id."""
    j = _jobs().latest_for_recording(uuid)
    if j is None:
        return None
    return _job_to_response(j.id)


@app.get("/recordings/{uuid}/export.mp4")
async def download_export(uuid: str) -> FileResponse:
    """Stream the cached annotated.mp4. Supports HTTP Range natively via
    FastAPI's FileResponse, so the browser <video> can seek if you point
    it at this URL."""
    path = _recordings_root() / uuid / "export" / "annotated.mp4"
    if not path.is_file():
        raise HTTPException(
            status_code=404,
            detail="annotated export not built yet — POST /recordings/<uuid>/export first",
        )
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=f"{uuid}-annotated.mp4",
    )
