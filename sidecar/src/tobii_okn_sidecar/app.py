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
from datetime import datetime, timezone
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import __version__

logger = logging.getLogger("tobii_okn_sidecar")

app = FastAPI(
    title="tobii-okn-sidecar",
    version=__version__,
    description="Companion service for the Tobii OKN viewer — recording, replay, export.",
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


class RecordingSummary(BaseModel):
    id: str
    """UUID assigned at start-of-recording."""
    started_at: str
    stopped_at: str | None
    duration_s: float | None
    """None while the recording is in progress."""


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
        time=datetime.now(timezone.utc).isoformat(),
    )


@app.get("/recordings", response_model=list[RecordingSummary])
async def list_recordings() -> list[RecordingSummary]:
    # TODO(next session): enumerate ./recordings/*.json (or the storage layout
    # we pick) and return parsed metadata. For now: empty list so the browser
    # can render the "no recordings yet" state.
    return []


@app.post("/record/start", response_model=StartResponse, status_code=501)
async def record_start() -> StartResponse:
    raise HTTPException(
        status_code=501,
        detail="recording not yet implemented — wire g3pylib in the next slice",
    )


@app.post("/record/{recording_id}/stop", response_model=RecordingSummary, status_code=501)
async def record_stop(recording_id: str) -> RecordingSummary:
    raise HTTPException(
        status_code=501,
        detail=f"recording not yet implemented (id={recording_id})",
    )


@app.get("/recordings/{recording_id}", response_model=RecordingSummary, status_code=501)
async def get_recording(recording_id: str) -> RecordingSummary:
    raise HTTPException(
        status_code=501,
        detail=f"replay metadata not yet implemented (id={recording_id})",
    )
