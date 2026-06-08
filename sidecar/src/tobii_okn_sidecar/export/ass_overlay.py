"""Generate an Advanced SubStation Alpha (.ass) overlay for ffmpeg's
`subtitles=` filter. The result is one event per decimated gaze sample,
positioned at the gaze pixel coordinates, plus one long-duration event for
the horizontal reference line (the "below-line" used in OKN flagging).

ASS was chosen over a PNG-per-frame approach because:
  - One file vs. N thousand images. Simpler to ship, easier to debug.
  - libass renders inside ffmpeg's filter graph natively — no extra
    subprocess, no pixel-format gymnastics.
  - We get smooth fade-out for the trail by stringing `\\fad(in_ms,out_ms)`
    tags onto each event.

Output sample volume: gaze runs at 100 Hz on this firmware but video is 25 fps
(scene camera default). One marker event per gaze sample would render
multiple markers per frame; we decimate down to GAZE_FPS so the file
size stays bounded for hour-long recordings.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

# How often to emit a marker event. Higher = smoother but bigger file.
GAZE_FPS = 30

# Trail length (number of past markers to keep visible at any moment),
# achieved via per-event fade times. Set to 0 to draw only the current marker.
TRAIL_DEPTH = 10
TRAIL_FADE_MS = 280

# Marker visual. ASS colors are &HBBGGRR& in BGR hex.
MARKER_GLYPH = "●"  # ● — solid circle
MARKER_FONTSIZE = 28
MARKER_COLOR = "&H0000FFFF&"  # opaque bright cyan in BGR (RR=00 GG=FF BB=FF → cyan)
MARKER_OUTLINE_COLOR = "&H00000000&"  # black

REFLINE_COLOR = "&H000099FF&"  # opaque amber
REFLINE_THICKNESS = 4  # px


@dataclass
class GazeSampleForAss:
    """Minimal sample shape needed for ASS rendering."""

    t: float  # seconds, video-relative
    x: float  # normalized 0-1
    y: float  # normalized 0-1


def parse_gazedata_jsonl(text: str) -> list[GazeSampleForAss]:
    """Parse the device's gazedata.gz (after gzip decode) into the shape we
    need. Skips lines without a 2D gaze (invalid / blink moments)."""
    out: list[GazeSampleForAss] = []
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") != "gaze":
            continue
        t = obj.get("timestamp")
        d = obj.get("data") or {}
        g2d = d.get("gaze2d")
        if (
            not isinstance(t, int | float)
            or not isinstance(g2d, list)
            or len(g2d) != 2
        ):
            continue
        out.append(GazeSampleForAss(t=float(t), x=float(g2d[0]), y=float(g2d[1])))
    out.sort(key=lambda s: s.t)
    return out


def _format_ass_time(seconds: float) -> str:
    """ASS uses H:MM:SS.CS (centiseconds, two digits)."""
    if seconds < 0:
        seconds = 0
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds - h * 3600 - m * 60
    return f"{h:d}:{m:02d}:{s:05.2f}"


def _decimate(samples: list[GazeSampleForAss], target_fps: int) -> list[GazeSampleForAss]:
    """Keep one sample per 1/target_fps window — first sample wins. Preserves
    monotonic timestamps so the rendered marker matches the video frame
    that's on screen at that moment."""
    if not samples:
        return []
    interval = 1.0 / target_fps
    out: list[GazeSampleForAss] = [samples[0]]
    last = samples[0].t
    for s in samples[1:]:
        if s.t - last >= interval:
            out.append(s)
            last = s.t
    return out


def write_overlay(
    out_path: Path,
    *,
    samples: Iterable[GazeSampleForAss] | list[GazeSampleForAss],
    video_width: int,
    video_height: int,
    duration_s: float,
    line_y_norm: float | None = 0.62,
) -> int:
    """Write the .ass file. Returns the event count (for logging).

    line_y_norm: if non-None, draw a horizontal reference line at this
    normalized vertical position (matches the viewer's default 0.62)."""
    samples_list = list(samples)
    samples_list = _decimate(samples_list, GAZE_FPS)

    lines: list[str] = []
    lines.append("[Script Info]")
    lines.append("Title: Tobii OKN Gaze Overlay")
    lines.append("ScriptType: v4.00+")
    lines.append(f"PlayResX: {video_width}")
    lines.append(f"PlayResY: {video_height}")
    lines.append("WrapStyle: 2")
    lines.append("ScaledBorderAndShadow: yes")
    lines.append("")
    lines.append("[V4+ Styles]")
    lines.append(
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding"
    )
    # Style: Marker — the moving gaze dot.
    lines.append(
        f"Style: Marker,Arial,{MARKER_FONTSIZE},{MARKER_COLOR},{MARKER_COLOR},"
        f"{MARKER_OUTLINE_COLOR},&H80000000&,0,0,0,0,100,100,0,0,1,2,0,5,0,0,0,1"
    )
    # Style: RefLine — horizontal below-line.
    lines.append(
        f"Style: RefLine,Arial,12,{REFLINE_COLOR},{REFLINE_COLOR},"
        f"{REFLINE_COLOR},&H00000000&,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1"
    )
    lines.append("")
    lines.append("[Events]")
    lines.append(
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
    )

    # Reference line — one persistent event for the whole video.
    if line_y_norm is not None and 0.0 < line_y_norm < 1.0:
        line_y_px = int(round(line_y_norm * video_height))
        end_x = video_width
        # ASS drawing: m moveto, l lineto, in pixel coords relative to \pos.
        # Anchor to top-left (\an7), position at (0, line_y_px), draw a
        # video-wide rectangle of REFLINE_THICKNESS height.
        draw = (
            f"{{\\an7\\pos(0,{line_y_px})\\p1\\bord0\\shad0}}"
            f"m 0 0 l {end_x} 0 l {end_x} {REFLINE_THICKNESS} "
            f"l 0 {REFLINE_THICKNESS}{{\\p0}}"
        )
        lines.append(
            f"Dialogue: 1,{_format_ass_time(0.0)},{_format_ass_time(duration_s + 1.0)},"
            f"RefLine,,0,0,0,,{draw}"
        )

    # Gaze markers. Each event lives from t to t+lifetime; we overlap them
    # via TRAIL_DEPTH so a smear of fading dots trails the current gaze.
    lifetime = TRAIL_DEPTH / GAZE_FPS
    n_marker_events = 0
    for s in samples_list:
        x = int(round(s.x * video_width))
        y = int(round(s.y * video_height))
        if not (0 <= x <= video_width and 0 <= y <= video_height):
            continue
        start = _format_ass_time(s.t)
        end = _format_ass_time(min(duration_s + 1.0, s.t + lifetime))
        # \an5 centers the glyph on \pos; \fad(in,out) ramps alpha for trail
        text = (
            f"{{\\an5\\pos({x},{y})\\fad(0,{TRAIL_FADE_MS})}}{MARKER_GLYPH}"
        )
        lines.append(
            f"Dialogue: 2,{start},{end},Marker,,0,0,0,,{text}"
        )
        n_marker_events += 1

    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    logger.info(
        "ass_overlay: wrote %s — %d marker events, refline=%s, %dx%d, %.1fs",
        out_path,
        n_marker_events,
        line_y_norm is not None,
        video_width,
        video_height,
        duration_s,
    )
    return n_marker_events + (1 if line_y_norm is not None else 0)
