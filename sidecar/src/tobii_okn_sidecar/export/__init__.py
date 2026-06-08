"""Annotated-video export pipeline.

Burns a gaze marker (and a configurable below-line) into a copy of the
device's scenevideo.mp4 via ffmpeg's `subtitles=` filter with an ASS
(Advanced SubStation Alpha) overlay we generate ourselves from gazedata.gz.

Layout:
    ass_overlay.py   builds the .ass file from a list of gaze samples
    jobs.py          in-memory job registry (id → status / progress / output)
    pipeline.py      async orchestrator: download files → render ASS → ffmpeg
"""

from .jobs import ExportJob, JobRegistry, JobStatus
from .pipeline import run_export

__all__ = ["ExportJob", "JobRegistry", "JobStatus", "run_export"]
