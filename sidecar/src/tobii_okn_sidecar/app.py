"""FastAPI entrypoint. Endpoints are stubbed in this first slice — the next
session wires them to g3pylib. For now this exists to:

  1. Prove the project layout, dependency graph, and uv tooling work end-to-end.
  2. Give the browser something to talk to so we can build the SidecarAdapter
     against a real (if no-op) API surface in parallel.

CORS is permissive on purpose: the browser at http://localhost:3000 will hit
us at http://localhost:8765, and we don't ship behind a reverse proxy.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import __version__
from .storage import RecordingsStore, RecordingSummary

logger = logging.getLogger("tobii_okn_sidecar")


def _recordings_root() -> Path:
    """SIDECAR_RECORDINGS_DIR overrides the default `./recordings/`. Stored
    relative to the sidecar's CWD; we don't try to be clever about user dirs
    because the viewer runs locally and the user controls cwd."""
    raw = os.environ.get("SIDECAR_RECORDINGS_DIR", "recordings")
    return Path(raw).resolve()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """One-shot startup: instantiate the recordings store and reconcile any
    sessions that were in flight when the sidecar last died."""
    store = RecordingsStore(_recordings_root())
    aborted = store.reconcile_aborted()
    if aborted:
        logger.warning("startup: marked %d recording(s) as aborted: %s", len(aborted), aborted)
    app.state.store = store
    logger.info("recordings dir: %s", store.root)
    yield

app = FastAPI(
    title="tobii-okn-sidecar",
    version=__version__,
    description="Companion service for the Tobii OKN viewer — recording, replay, export.",
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
# Response models. Frozen as dataclasses-with-validation so the browser-side
# adapter and this service stay in lockstep — change the shape here, update
# the TypeScript types there.
# ---------------------------------------------------------------------------


class HealthResponse(BaseModel):
    status: Literal["ok"]
    version: str
    time: str
    """ISO-8601 UTC timestamp; mostly for the browser to detect clock skew."""


class StartResponse(BaseModel):
    id: str
    started_at: str


# ---------------------------------------------------------------------------
# Endpoints. Each one returns a clear "not yet implemented" 501 so the
# browser-side adapter can spec against a real wire format from day one.
# ---------------------------------------------------------------------------


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        version=__version__,
        time=datetime.now(UTC).isoformat(),
    )


@app.get("/recordings", response_model=list[RecordingSummary])
async def list_recordings() -> list[RecordingSummary]:
    store: RecordingsStore = app.state.store
    return store.list_summaries()


@app.get("/recordings/{recording_id}", response_model=RecordingSummary)
async def get_recording(recording_id: str) -> RecordingSummary:
    store: RecordingsStore = app.state.store
    meta = store.load_meta(recording_id)
    if meta is None:
        raise HTTPException(status_code=404, detail=f"recording not found: {recording_id}")
    return RecordingSummary.from_meta(meta)


@app.post("/record/start", response_model=StartResponse, status_code=501)
async def record_start() -> StartResponse:
    raise HTTPException(
        status_code=501,
        detail="recording start handler lands in slice A3 — Recording.start() is ready",
    )


@app.post("/record/{recording_id}/stop", response_model=RecordingSummary, status_code=501)
async def record_stop(recording_id: str) -> RecordingSummary:
    raise HTTPException(
        status_code=501,
        detail=f"recording stop handler lands in slice A3 (id={recording_id})",
    )
