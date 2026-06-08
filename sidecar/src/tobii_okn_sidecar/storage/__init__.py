"""On-disk recording layout.

  recordings/
  ├── 2026-06-08T03-12-44Z-a3f1c2/
  │   ├── meta.json     # authoritative metadata for the recording
  │   ├── scene.mp4     # H.264 passthrough from RTSP scene camera
  │   ├── eye.mp4       # H.264 passthrough from RTSP eye-camera composite
  │   └── gaze.jsonl    # one JSON gaze sample per line, device timestamps
  └── ...

`Recording` is a single in-flight or completed recording. `RecordingsStore`
is the enumeration / read view over the whole directory.

We do NOT do partial-write recovery here. If the sidecar crashes mid-record,
gaze.jsonl is left as-is (jsonl is forgiving — incomplete final line) and
the meta.json will be missing `stopped_at`. On next startup, code in app.py
can flag those as `aborted`.
"""

from .recording import (
    Recording,
    RecordingMeta,
    RecordingsStore,
    RecordingSummary,
)

__all__ = [
    "Recording",
    "RecordingMeta",
    "RecordingSummary",
    "RecordingsStore",
]
