"""Recording lifecycle + persistence.

A Recording owns a single `recordings/<id>/` directory. The id is
`<iso-utc-timestamp>-<6-hex>` so directory listings sort chronologically by
default and ids stay collision-free without coordination.

The gaze writer flushes to disk every N samples so a sidecar crash mid-record
loses at most ~N samples (~50ms at 100Hz with N=5).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

GAZE_FLUSH_EVERY = 5
"""fsync gaze.jsonl after this many appended samples. At 100Hz that's 50ms
worth of data lost in the worst case — well under one OKN saccade."""


# ---------------------------------------------------------------------------
# Pydantic models. These are the wire format for the HTTP API too — keep them
# in sync with the response_model declarations in app.py.
# ---------------------------------------------------------------------------


class RecordingMeta(BaseModel):
    """Full metadata stored in meta.json. The authoritative record."""

    id: str
    """Directory name and stable identifier."""
    started_at: str
    """ISO-8601 UTC, when /record/start was called."""
    stopped_at: str | None = None
    """ISO-8601 UTC, when /record/stop completed. None if still in flight or aborted."""
    duration_s: float | None = None
    """Wall-clock duration (stopped_at - started_at). None for in-flight."""
    status: Literal["recording", "completed", "aborted"] = "recording"
    """`recording` while in flight, `completed` after a clean stop,
    `aborted` if the sidecar restarted before stop fired."""

    # Device-side context. May be missing if we couldn't read them at start time.
    device_serial: str | None = None
    gaze_hz: int | None = None

    # Counters captured at stop time; useful for debugging dropouts.
    gaze_samples: int | None = None
    """Total samples written to gaze.jsonl."""
    scene_bytes: int | None = None
    """Final size of scene.mp4 on disk. None if recording is in flight or scene didn't capture."""
    eye_bytes: int | None = None

    # Free-form metadata supplied by clients (e.g., subject id, session label).
    notes: dict[str, Any] = Field(default_factory=dict)


class RecordingSummary(BaseModel):
    """Trimmed view returned by GET /recordings (list view).
    Mirrors a subset of RecordingMeta — the fields the browser actually
    renders in the recordings sidebar."""

    id: str
    started_at: str
    stopped_at: str | None
    duration_s: float | None
    status: Literal["recording", "completed", "aborted"]
    device_serial: str | None
    gaze_samples: int | None

    @classmethod
    def from_meta(cls, meta: RecordingMeta) -> RecordingSummary:
        return cls(
            id=meta.id,
            started_at=meta.started_at,
            stopped_at=meta.stopped_at,
            duration_s=meta.duration_s,
            status=meta.status,
            device_serial=meta.device_serial,
            gaze_samples=meta.gaze_samples,
        )


# ---------------------------------------------------------------------------
# Recording: a single in-flight or completed session
# ---------------------------------------------------------------------------


def _mint_id(now: datetime | None = None) -> str:
    """Filesystem-safe sortable id. Colons in ISO timestamps confuse some tools,
    so we use hyphens. Suffix is a short random hex to avoid same-second
    collisions and to make ids feel like ids rather than timestamps."""
    if now is None:
        now = datetime.now(UTC)
    stamp = now.strftime("%Y-%m-%dT%H-%M-%SZ")
    suffix = secrets.token_hex(3)
    return f"{stamp}-{suffix}"


class Recording:
    """Owns a single recordings/<id>/ directory. One Recording per in-flight
    session.

    Typical use:
        rec = await Recording.start(store, device_serial="TG03B-...", gaze_hz=100)
        await rec.append_gaze({"t": 0.123, "gaze2d": [0.5, 0.5], ...})
        ...
        await rec.finalize(scene_bytes=12345, eye_bytes=6789)
    """

    def __init__(self, store: RecordingsStore, meta: RecordingMeta) -> None:
        self.store = store
        self.meta = meta
        self.dir: Path = store.root / meta.id
        self._gaze_file: Any | None = None
        self._gaze_count = 0
        self._gaze_since_flush = 0
        self._gaze_lock = asyncio.Lock()
        self._finalized = False

    # File paths -------------------------------------------------------------

    @property
    def scene_path(self) -> Path:
        return self.dir / "scene.mp4"

    @property
    def eye_path(self) -> Path:
        return self.dir / "eye.mp4"

    @property
    def gaze_path(self) -> Path:
        return self.dir / "gaze.jsonl"

    @property
    def meta_path(self) -> Path:
        return self.dir / "meta.json"

    # Lifecycle --------------------------------------------------------------

    @classmethod
    async def start(
        cls,
        store: RecordingsStore,
        *,
        device_serial: str | None = None,
        gaze_hz: int | None = None,
        notes: dict[str, Any] | None = None,
    ) -> Recording:
        now = datetime.now(UTC)
        meta = RecordingMeta(
            id=_mint_id(now),
            started_at=now.isoformat(),
            status="recording",
            device_serial=device_serial,
            gaze_hz=gaze_hz,
            notes=notes or {},
        )
        rec = cls(store, meta)
        rec.dir.mkdir(parents=True, exist_ok=True)
        rec._write_meta()
        rec._gaze_file = rec.gaze_path.open("a", encoding="utf-8")
        logger.info("recording %s started at %s", meta.id, meta.started_at)
        return rec

    async def append_gaze(self, sample: dict[str, Any]) -> None:
        """Append one gaze sample to gaze.jsonl. Fsync every GAZE_FLUSH_EVERY
        samples to bound data loss on crash."""
        if self._gaze_file is None:
            raise RuntimeError(f"recording {self.meta.id}: gaze file not open")
        async with self._gaze_lock:
            line = json.dumps(sample, separators=(",", ":"))
            self._gaze_file.write(line + "\n")
            self._gaze_count += 1
            self._gaze_since_flush += 1
            if self._gaze_since_flush >= GAZE_FLUSH_EVERY:
                self._gaze_file.flush()
                os.fsync(self._gaze_file.fileno())
                self._gaze_since_flush = 0

    async def finalize(
        self,
        *,
        scene_bytes: int | None = None,
        eye_bytes: int | None = None,
        status: Literal["completed", "aborted"] = "completed",
    ) -> RecordingMeta:
        """Close the gaze file, compute duration, write final meta.json."""
        if self._finalized:
            return self.meta
        self._finalized = True

        async with self._gaze_lock:
            if self._gaze_file is not None:
                self._gaze_file.flush()
                try:
                    os.fsync(self._gaze_file.fileno())
                except OSError:
                    pass
                self._gaze_file.close()
                self._gaze_file = None

        now = datetime.now(UTC)
        started = datetime.fromisoformat(self.meta.started_at)
        self.meta = self.meta.model_copy(
            update={
                "stopped_at": now.isoformat(),
                "duration_s": (now - started).total_seconds(),
                "status": status,
                "gaze_samples": self._gaze_count,
                "scene_bytes": scene_bytes
                if scene_bytes is not None
                else _safe_size(self.scene_path),
                "eye_bytes": eye_bytes
                if eye_bytes is not None
                else _safe_size(self.eye_path),
            }
        )
        self._write_meta()
        logger.info(
            "recording %s finalized (%.1fs, %d gaze samples, status=%s)",
            self.meta.id,
            self.meta.duration_s or 0.0,
            self._gaze_count,
            status,
        )
        return self.meta

    # Internals --------------------------------------------------------------

    def _write_meta(self) -> None:
        # Write to a temp file + rename so a crash mid-write doesn't corrupt
        # the existing meta.json (atomic on POSIX).
        tmp = self.meta_path.with_suffix(".json.tmp")
        tmp.write_text(self.meta.model_dump_json(indent=2), encoding="utf-8")
        tmp.replace(self.meta_path)


# ---------------------------------------------------------------------------
# RecordingsStore: enumeration + read access over the whole `recordings/` tree
# ---------------------------------------------------------------------------


class RecordingsStore:
    """Read-side wrapper around the recordings directory.

    For writes, instantiate a Recording via `Recording.start(store, ...)`.
    For reads (listing, reading meta, checking files), use this class.
    """

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def list_summaries(self) -> list[RecordingSummary]:
        """Newest first. Skips directories that lack a parseable meta.json —
        we tolerate junk on disk (other tools, manual experiments) instead of
        crashing the API."""
        out: list[RecordingSummary] = []
        for d in sorted(self.root.iterdir(), reverse=True):
            if not d.is_dir():
                continue
            meta = self._load_meta_safely(d)
            if meta is not None:
                out.append(RecordingSummary.from_meta(meta))
        return out

    def load_meta(self, recording_id: str) -> RecordingMeta | None:
        d = self.root / recording_id
        if not d.is_dir():
            return None
        return self._load_meta_safely(d)

    def reconcile_aborted(self) -> list[str]:
        """Sweep the directory for recordings whose meta.json still says
        `recording` — those were in flight when the sidecar crashed or was
        killed. Flag them as `aborted` so the browser doesn't show stale
        "still recording" entries. Returns the list of ids touched."""
        touched: list[str] = []
        for d in self.root.iterdir():
            if not d.is_dir():
                continue
            meta = self._load_meta_safely(d)
            if meta is None or meta.status != "recording":
                continue
            # File mtime as a rough finalize-time fallback.
            try:
                stat = d.stat()
                finalized = datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat()
            except OSError:
                finalized = datetime.now(UTC).isoformat()
            updated = meta.model_copy(
                update={"status": "aborted", "stopped_at": finalized}
            )
            tmp = (d / "meta.json").with_suffix(".json.tmp")
            tmp.write_text(updated.model_dump_json(indent=2), encoding="utf-8")
            tmp.replace(d / "meta.json")
            touched.append(meta.id)
        if touched:
            logger.warning("reconciled %d aborted recording(s): %s", len(touched), touched)
        return touched

    def _load_meta_safely(self, d: Path) -> RecordingMeta | None:
        meta_path = d / "meta.json"
        if not meta_path.is_file():
            return None
        try:
            raw = meta_path.read_text(encoding="utf-8")
            return RecordingMeta.model_validate_json(raw)
        except Exception:
            logger.exception("failed to read %s — skipping", meta_path)
            return None


def _safe_size(p: Path) -> int | None:
    try:
        return p.stat().st_size
    except OSError:
        return None
