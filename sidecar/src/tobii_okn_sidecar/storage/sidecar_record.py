"""SidecarRecord — the tiny local-only annotation we keep next to each device
recording when (eventually) we cache them on disk. The device's recording.g3 is
the authoritative manifest; this file holds only what the device doesn't know:

  - downloaded_at: when we last pulled files locally (None if never).
  - subject_id, notes: free-form labels the experimenter adds.

For the v1.1 MVP we don't cache locally at all (browser plays directly from
the device through the /g3 proxy), so this module is also small. It's here
because Phase D (annotated export) will need to pull files to disk, and we
want a stable place to record what we know about them.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

FILENAME = "sidecar.json"


class SidecarRecord(BaseModel):
    """All local-only state for a recording. Lives at
    `<recordings_root>/<uuid>/sidecar.json` adjacent to the device's files."""

    downloaded_at: str | None = None
    """ISO-8601 UTC of the last successful pull-to-disk. None = not cached."""
    subject_id: str | None = None
    notes: dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def load_or_default(cls, dir_path: Path) -> SidecarRecord:
        """Read sidecar.json from `dir_path`. If missing or corrupt, return a
        fresh default — we never want a malformed annotation file to take a
        recording out of the listing."""
        p = dir_path / FILENAME
        if not p.is_file():
            return cls()
        try:
            return cls.model_validate_json(p.read_text(encoding="utf-8"))
        except Exception:
            logger.exception("sidecar.json at %s unreadable — using defaults", p)
            return cls()

    def save_atomic(self, dir_path: Path) -> None:
        """Atomic write via tmp + rename so a crash mid-write doesn't corrupt
        the existing sidecar.json."""
        dir_path.mkdir(parents=True, exist_ok=True)
        target = dir_path / FILENAME
        tmp = target.with_suffix(".json.tmp")
        tmp.write_text(self.model_dump_json(indent=2), encoding="utf-8")
        tmp.replace(target)
