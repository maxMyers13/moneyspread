"""End-to-end export pipeline run as a background asyncio task.

Steps:
  1. Fetch recording.g3 to learn the manifest (video filename, resolution,
     gaze filename, duration).
  2. Pull scene.mp4 to recordings/<uuid>/export/scene.mp4 (skip if cached).
  3. Pull gazedata.gz to recordings/<uuid>/export/gazedata.gz (skip if cached).
  4. Decode the gaze JSONL and emit recordings/<uuid>/export/overlay.ass.
  5. ffmpeg -i scene.mp4 -vf subtitles=overlay.ass … → annotated.mp4
     using `-progress pipe:1` so we can update the job's progress field.

The output lives at recordings/<uuid>/export/annotated.mp4 so the
serve-export route can pass it through with FastAPI's FileResponse.
"""

from __future__ import annotations

import asyncio
import gzip
import logging
import re
import shutil
from pathlib import Path

import httpx

from ..storage import DeviceRecordingManifest
from .ass_overlay import parse_gazedata_jsonl, write_overlay
from .jobs import JobRegistry

logger = logging.getLogger(__name__)

PROGRESS_RE = re.compile(rb"out_time_us=(\d+)")


async def run_export(
    *,
    job_id: str,
    recording_uuid: str,
    device_host: str,
    recordings_root: Path,
    registry: JobRegistry,
    http_timeout_s: float = 30.0,
) -> None:
    """Background task body. Catches all errors and routes them through the
    registry so the route handler stays simple."""
    job = registry.get(job_id)
    if job is None:
        return  # registry race; nothing to do
    out_dir = recordings_root / recording_uuid / "export"
    out_dir.mkdir(parents=True, exist_ok=True)
    annotated_path = out_dir / "annotated.mp4"
    registry.mark_running(job_id)

    try:
        await _do_export(
            recording_uuid=recording_uuid,
            device_host=device_host,
            out_dir=out_dir,
            annotated_path=annotated_path,
            registry=registry,
            job_id=job_id,
            http_timeout_s=http_timeout_s,
        )
        registry.mark_done(job_id, annotated_path)
        logger.info("export %s done → %s", job_id, annotated_path)
    except asyncio.CancelledError:
        registry.mark_failed(job_id, "cancelled")
        raise
    except Exception as e:
        logger.exception("export %s failed", job_id)
        registry.mark_failed(job_id, f"{type(e).__name__}: {e}")


async def _do_export(
    *,
    recording_uuid: str,
    device_host: str,
    out_dir: Path,
    annotated_path: Path,
    registry: JobRegistry,
    job_id: str,
    http_timeout_s: float,
) -> None:
    base = f"http://{device_host}"

    # ---- 1. Manifest -----------------------------------------------------
    async with httpx.AsyncClient(timeout=http_timeout_s) as h:
        r = await h.get(f"{base}/recordings/{recording_uuid}")
        r.raise_for_status()
        manifest = DeviceRecordingManifest.model_validate(r.json())
    registry.update_progress(job_id, 0.05)

    duration_s = manifest.duration
    video_w, video_h = (
        manifest.scenecamera.camera_calibration.resolution[0],
        manifest.scenecamera.camera_calibration.resolution[1],
    )
    scene_filename = manifest.scenecamera.file or "scenevideo.mp4"
    gaze_filename = manifest.gaze.file or "gazedata.gz"
    scene_local = out_dir / "scene.mp4"
    gaze_local_gz = out_dir / "gazedata.gz"

    # ---- 2. Scene video --------------------------------------------------
    if not scene_local.is_file() or scene_local.stat().st_size == 0:
        logger.info("export %s: downloading scenevideo.mp4", job_id)
        async with httpx.AsyncClient(timeout=None) as h:
            async with h.stream(
                "GET", f"{base}/recordings/{recording_uuid}/{scene_filename}"
            ) as resp:
                resp.raise_for_status()
                tmp = scene_local.with_suffix(".mp4.tmp")
                with tmp.open("wb") as f:
                    async for chunk in resp.aiter_bytes(chunk_size=1 << 16):
                        f.write(chunk)
                tmp.replace(scene_local)
    registry.update_progress(job_id, 0.25)

    # ---- 3. Gaze data (gzip-as-served) -----------------------------------
    if not gaze_local_gz.is_file() or gaze_local_gz.stat().st_size == 0:
        logger.info("export %s: downloading gazedata.gz", job_id)
        async with httpx.AsyncClient(timeout=http_timeout_s) as h:
            r = await h.get(
                f"{base}/recordings/{recording_uuid}/{gaze_filename}"
            )
            r.raise_for_status()
            gaze_local_gz.write_bytes(r.content)
    registry.update_progress(job_id, 0.30)

    # ---- 4. Decode + render ASS overlay ----------------------------------
    text = gzip.decompress(gaze_local_gz.read_bytes()).decode("utf-8", "replace")
    samples = parse_gazedata_jsonl(text)
    overlay_ass = out_dir / "overlay.ass"
    write_overlay(
        overlay_ass,
        samples=samples,
        video_width=video_w,
        video_height=video_h,
        duration_s=duration_s,
        line_y_norm=0.62,  # viewer's default — keep them in sync
    )
    registry.update_progress(job_id, 0.35)

    # ---- 5. ffmpeg subprocess + progress scrape --------------------------
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not found on PATH")

    # `subtitles=` needs the path escaped for ffmpeg filter grammar. The ASS
    # file lives next to scene.mp4 in our temp dir, so a bare relative path
    # works if we cwd into out_dir. Simpler than escaping `:` in the filter
    # value.
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(scene_local.name),
        "-vf",
        f"subtitles={overlay_ass.name}",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "20",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        str(annotated_path.name),
    ]
    logger.info("export %s: ffmpeg %s", job_id, " ".join(cmd))
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=out_dir,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    async def _scrape_progress() -> None:
        # ffmpeg emits one block of key=value lines every ~250ms.
        # out_time_us is the running output timestamp in microseconds.
        # Progress = out_time / total_duration, scaled into our 0.35→0.99
        # range so we don't claim done until the process actually exits.
        assert proc.stdout is not None
        total_us = max(1, int(duration_s * 1_000_000))
        async for raw in proc.stdout:
            m = PROGRESS_RE.search(raw)
            if not m:
                continue
            try:
                out_us = int(m.group(1))
            except ValueError:
                continue
            frac = min(1.0, out_us / total_us)
            registry.update_progress(job_id, 0.35 + 0.64 * frac)

    progress_task = asyncio.create_task(_scrape_progress())
    code = await proc.wait()
    progress_task.cancel()
    stderr = (await proc.stderr.read()).decode("utf-8", "replace") if proc.stderr else ""
    if code != 0:
        raise RuntimeError(f"ffmpeg exit {code}: {stderr.strip()[:500]}")
    if not annotated_path.is_file() or annotated_path.stat().st_size == 0:
        raise RuntimeError("ffmpeg returned 0 but annotated.mp4 missing or empty")
    registry.update_progress(job_id, 0.99)
