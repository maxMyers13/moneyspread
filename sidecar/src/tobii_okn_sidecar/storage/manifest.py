"""DeviceRecordingManifest — Pydantic schema mirroring the device's `recording.g3`
manifest exactly (docs §4.5.1 + Appendix A, confirmed against firmware via the
spike at sidecar/scripts/spike_recorder.py).

We don't author this — the device does. We just parse it, hold it, and round-trip
it to the browser. Field aliases handle the device's kebab-case JSON keys
(`meta-folder`, `gaze-overlay`, `valid-samples`, `focal-length`, etc.) so Python
identifiers stay snake_case.

The wire shape is the source of truth. If a future firmware adds a field we
don't model, we'll see it as `model_extra` (Pydantic v2 lets extras through
under `extra="allow"`); old code keeps working.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


def _to_kebab(name: str) -> str:
    """Pydantic alias generator: snake_case → kebab-case."""
    return name.replace("_", "-")


class _Base(BaseModel):
    """Shared config. populate_by_name lets us pass kwargs by Python name *or*
    by JSON alias; alias_generator covers kebab-case JSON keys we never have to
    enumerate by hand. extra='allow' tolerates new firmware fields."""

    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=_to_kebab,
        extra="allow",
    )


# ---------------------------------------------------------------------------
# Scene camera substructure
# ---------------------------------------------------------------------------


class Snapshot(_Base):
    file: str
    time: float
    """Seconds from start-of-recording (video time, not wall clock)."""


class CameraCalibration(_Base):
    """Intrinsic + extrinsic calibration. Useful for the v2 OKN metrics work
    when we need to back-project gaze to world coordinates. Kept as plain lists
    instead of numpy/dataclass to round-trip JSON cleanly."""

    position: list[float]
    focal_length: list[float]
    rotation: list[list[float]]
    skew: float
    principal_point: list[float]
    radial_distortion: list[float]
    tangential_distortion: list[float]
    resolution: list[int]


class SceneCamera(_Base):
    file: str
    """Relative to the recording's HTTP path or directory — e.g., `scenevideo.mp4`."""
    snapshots: list[Snapshot] = []
    """Per-recording stills, currently one near the start. Captured by the device."""
    camera_calibration: CameraCalibration
    gaze_overlay: bool
    """True iff the device burned a gaze marker into scenevideo.mp4 (a device-side
    rendering option, see docs §4.9.2). Default is false; we recommend keeping it
    false so the viewer can draw its own overlay."""


# ---------------------------------------------------------------------------
# Optional data-stream descriptors. Each has a `file` plus stream-specific
# counters. The device may set the top-level field to null (e.g., eyecameras was
# null in the spike), so we keep these strictly optional.
# ---------------------------------------------------------------------------


class GazeStream(_Base):
    file: str
    """Currently `gazedata.gz` — fetch with ?use-content-encoding=true for
    on-the-fly gzip decode (docs §4.5.1)."""
    samples: int
    valid_samples: int


class EventsStream(_Base):
    file: str
    """Currently `eventdata.gz`. Includes any marks injected via recorder!send-event."""


class ImuStream(_Base):
    file: str
    """Currently `imudata.gz` — accelerometer + gyroscope + magnetometer."""


class EyeCameras(_Base):
    """Shape unobserved (spike returned null). Allowing arbitrary fields via
    extra='allow' from _Base so we can hold whatever the firmware reports here.
    Refine the schema once we capture a recording with eye-cam enabled."""

    file: str | None = None


# ---------------------------------------------------------------------------
# Top-level manifest
# ---------------------------------------------------------------------------


class DeviceRecordingManifest(_Base):
    """The `recording.g3` JSON document, as served by GET <http-path>.

    All times are video-relative (zero at first scene-camera frame). `duration`
    is in seconds. `created` is wall-clock ISO-8601 in the device's configured
    timezone.
    """

    uuid: str
    name: str
    """Device-assigned human-readable label, default form is `YYYYMMDDTHHMMSSZ`."""
    meta_folder: str
    """Subfolder name on the device that holds per-frame metadata. Currently
    'meta'. We don't fetch this folder in v1.1."""
    version: int
    """Manifest schema version. Spike returned 2."""
    duration: float
    created: str
    timezone: str
    """IANA tz name, e.g. `America/New_York`."""

    scenecamera: SceneCamera
    eyecameras: EyeCameras | None
    gaze: GazeStream
    events: EventsStream
    imu: ImuStream

    # Helpers --------------------------------------------------------------

    def gaze_url_path(self) -> str:
        """Path component for fetching gaze (no leading slash, no query)."""
        return self.gaze.file

    def scene_url_path(self) -> str:
        return self.scenecamera.file

    @property
    def has_eye_video(self) -> bool:
        return self.eyecameras is not None and bool(self.eyecameras.file)
