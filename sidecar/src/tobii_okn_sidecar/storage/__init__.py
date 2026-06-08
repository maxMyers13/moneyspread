"""Storage models for the v1.1 sidecar.

The device's `recording.g3` (DeviceRecordingManifest) is the authoritative
metadata for every recording. We *don't* author our own. SidecarRecord holds the
2-3 local-only fields the device doesn't know about (subject id, notes, cache
state). RecordingSummary joins them into the flat view we hand to the browser.
"""

from __future__ import annotations

from pydantic import BaseModel

from .manifest import DeviceRecordingManifest
from .sidecar_record import SidecarRecord


class RecordingSummary(BaseModel):
    """Joined view for `GET /recordings` and `GET /recordings/{uuid}`. Flatter
    than the manifest — the browser shouldn't need to walk nested objects to
    render the recordings sidebar."""

    uuid: str
    name: str
    """Device-assigned label (e.g. `20260608T081008Z`)."""
    created: str
    """Wall-clock ISO timestamp in the device's timezone."""
    duration_s: float
    timezone: str

    # Stream presence — quick checks for the browser UI.
    gaze_samples: int
    gaze_valid_samples: int
    has_eye_video: bool
    has_events: bool
    has_imu: bool

    # Local-only annotations.
    downloaded_locally: bool
    subject_id: str | None = None

    @classmethod
    def from_manifest(
        cls,
        manifest: DeviceRecordingManifest,
        sidecar: SidecarRecord,
    ) -> RecordingSummary:
        return cls(
            uuid=manifest.uuid,
            name=manifest.name,
            created=manifest.created,
            duration_s=manifest.duration,
            timezone=manifest.timezone,
            gaze_samples=manifest.gaze.samples,
            gaze_valid_samples=manifest.gaze.valid_samples,
            has_eye_video=manifest.has_eye_video,
            has_events=bool(manifest.events.file),
            has_imu=bool(manifest.imu.file),
            downloaded_locally=sidecar.downloaded_at is not None,
            subject_id=sidecar.subject_id,
        )


__all__ = [
    "DeviceRecordingManifest",
    "RecordingSummary",
    "SidecarRecord",
]
