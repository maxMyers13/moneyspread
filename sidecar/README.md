# tobii-okn-sidecar

Companion HTTP service for the [OKN viewer](..). The browser already does the
live view directly over WebRTC; this exists for the three things WebRTC can't
do well on Tobii Pro Glasses 3:

- **Recording** — RTSP via `g3pylib` while the browser keeps streaming over
  WebRTC. Recordings live on this Mac, not the device's SD card.
- **Scrubbable replay** — RTSP can rewind, WebRTC can't.
- **Annotated export** — `ffmpeg` pipeline that burns the gaze marker / line
  / trail straight into the output video.

Same local-first posture as the rest of the project: localhost only, no
auth, no cloud.

## Quickstart

```bash
cd sidecar
uv sync               # creates .venv and installs deps using .python-version
uv run sidecar        # starts on http://127.0.0.1:8765
```

Sanity check:

```bash
curl -s http://127.0.0.1:8765/health | jq .
# { "status": "ok", "version": "0.1.0", "time": "2026-..." }
```

### Optional knobs

| env var          | default     | what                                    |
|------------------|-------------|-----------------------------------------|
| `SIDECAR_HOST`   | `127.0.0.1` | bind address (don't expose publicly)    |
| `SIDECAR_PORT`   | `8765`      | port                                     |
| `SIDECAR_RELOAD` | unset       | set to `1` for uvicorn `--reload` in dev |

## API surface (current)

`/health` works; everything else returns `501 Not Implemented` for now. The
shapes are stable so the browser-side `SidecarAdapter` can be built against
them in parallel.

| method | path                          | status |
|--------|-------------------------------|--------|
| GET    | `/health`                     | ✅ ok |
| GET    | `/recordings`                 | ✅ returns `[]` until wired |
| POST   | `/record/start`               | 501 (next slice) |
| POST   | `/record/{id}/stop`           | 501 (next slice) |
| GET    | `/recordings/{id}`            | 501 (next slice) |

OpenAPI: <http://127.0.0.1:8765/docs>

## Why a sidecar at all

Quoting the project README's v1.1 plan:

> WebRTC can't seek on replay and in-browser video export is painful — this
> is the only reason the sidecar exists.

Browser ffmpeg.wasm exists but is slow, memory-hungry, and a poor fit for
half-hour OKN sessions. A native Python service that holds RTSP open, writes
to disk, and shells out to system `ffmpeg` is dramatically simpler.

## What's next

- Wire `g3pylib` and implement `/record/start` against the live RTSP stream.
- Define the on-disk storage layout (one folder per recording — `scene.mp4`,
  `eye.mp4`, `gaze.jsonl`, `meta.json`).
- Implement `/recordings/{id}/scrub?t=…` for browser-driven replay.
- Implement `/recordings/{id}/export` to produce burned-in annotated video.

Python 3.14 isn't supported yet by every dependency we'll pull in (g3pylib in
particular). The project is pinned to 3.12 via `.python-version` — `uv sync`
will fetch and use 3.12 even if your default `python3` is newer.
