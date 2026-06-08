"""Tiny in-memory job registry. One global instance per sidecar process — we
don't persist across restarts (the export files themselves are persisted as
recordings/<uuid>/export/annotated.mp4, so a restart just means the
client has to re-trigger an unfinished job)."""

from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

JobStatus = Literal["pending", "running", "done", "failed"]


@dataclass
class ExportJob:
    """Lifecycle of one export run."""

    id: str
    recording_uuid: str
    status: JobStatus = "pending"
    progress: float = 0.0
    """0.0 → 1.0. Best-effort: scrape ffmpeg `-progress pipe:1` output."""
    output_path: Path | None = None
    """Set when status='done'. Where annotated.mp4 lives on disk."""
    error: str | None = None
    started_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    completed_at: str | None = None
    task: asyncio.Task | None = field(default=None, repr=False)
    """Background asyncio task; kept so we could cancel a running export later."""


class JobRegistry:
    def __init__(self) -> None:
        self._jobs: dict[str, ExportJob] = {}
        self._lock = asyncio.Lock()

    async def create(self, recording_uuid: str) -> ExportJob:
        async with self._lock:
            job_id = f"exp_{secrets.token_hex(6)}"
            job = ExportJob(id=job_id, recording_uuid=recording_uuid)
            self._jobs[job_id] = job
            return job

    def get(self, job_id: str) -> ExportJob | None:
        return self._jobs.get(job_id)

    def latest_for_recording(self, recording_uuid: str) -> ExportJob | None:
        """Most recent job for a given recording, regardless of status. Useful
        for the browser to find an in-flight export to subscribe to without
        having to remember the job id across reloads."""
        candidates = [j for j in self._jobs.values() if j.recording_uuid == recording_uuid]
        if not candidates:
            return None
        return max(candidates, key=lambda j: j.started_at)

    def mark_running(self, job_id: str) -> None:
        if (j := self._jobs.get(job_id)) is not None:
            j.status = "running"

    def update_progress(self, job_id: str, p: float) -> None:
        if (j := self._jobs.get(job_id)) is not None:
            j.progress = max(0.0, min(1.0, p))

    def mark_done(self, job_id: str, output_path: Path) -> None:
        if (j := self._jobs.get(job_id)) is not None:
            j.status = "done"
            j.progress = 1.0
            j.output_path = output_path
            j.completed_at = datetime.now(UTC).isoformat()

    def mark_failed(self, job_id: str, error: str) -> None:
        if (j := self._jobs.get(job_id)) is not None:
            j.status = "failed"
            j.error = error
            j.completed_at = datetime.now(UTC).isoformat()


# Module-level singleton — app.state.jobs holds a reference; routes use it.
_REGISTRY: JobRegistry | None = None


def get_registry() -> JobRegistry:
    global _REGISTRY
    if _REGISTRY is None:
        _REGISTRY = JobRegistry()
    return _REGISTRY
