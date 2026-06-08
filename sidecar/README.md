# tobii-okn-sidecar

Companion HTTP service for the [OKN viewer](..). The browser already does the
live view directly over WebRTC; this exists for the three things WebRTC can't
do well on Tobii Pro Glasses 3:

- **Recording** — orchestrates the device's own `recorder!start` / `!stop`
  over the g3api WebSocket. Recordings land on the device's SD card with
  perfect in-device gaze/video sync; the browser plays them back directly
  through the Next.js `/g3` proxy (the device serves HTTP Range natively).
- **Scrubbable replay** — the recorded files seek; the live WebRTC stream
  can't.
- **Annotated export** — an `ffmpeg` + ASS-subtitle pipeline that burns the
  gaze marker straight into the output video.

Same local-first posture as the rest of the project: localhost only, no
auth, no cloud.

> **Why device recording instead of RTSP via `g3pylib`?** Authoring our own
> `scene.mp4` + `gaze.jsonl` from RTSP gave ~10-100 ms gaze-to-video skew
> (separate transports, separate clocks). Letting the device record to its
> SD card gives perfect in-device sync, and `g3pylib`'s pinned `av==10.0.0`
> won't build against ffmpeg 8 anyway. See the project README's "Recording /
> replay / export pivot" section for the full rationale.

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

| env var                  | default                      | what                                          |
|--------------------------|------------------------------|-----------------------------------------------|
| `SIDECAR_HOST`           | `127.0.0.1`                  | bind address (don't expose publicly)          |
| `SIDECAR_PORT`           | `8765`                       | port                                          |
| `SIDECAR_RELOAD`         | unset                        | set to `1` for uvicorn `--reload` in dev      |
| `G3_HOST`                | `tg03b-080200012671.local`   | hostname/IP of the recording unit (no scheme) |
| `SIDECAR_RECORDINGS_DIR` | `./recordings`               | where adjacent `sidecar.json` notes + export artifacts live |
| `SIDECAR_HTTP_TIMEOUT_S` | `8.0`                        | per-request timeout when talking to the device |

## API surface

All endpoints are implemented. OpenAPI: <http://127.0.0.1:8765/docs>

| method | path                              | what                                                        |
|--------|-----------------------------------|-------------------------------------------------------------|
| GET    | `/health`                         | liveness + the configured `device_host`                     |
| POST   | `/record/start`                   | `recorder!start`; returns the device-assigned `uuid`        |
| POST   | `/record/{uuid}/stop`             | `recorder!stop`                                             |
| GET    | `/recordings`                     | enumerate device recordings, hydrated with manifest + notes |
| GET    | `/recordings/{uuid}`              | one recording's joined manifest + local `sidecar.json`      |
| POST   | `/recordings/{uuid}/export`       | kick off an annotated-MP4 export; returns a `job_id`        |
| GET    | `/jobs/{job_id}`                  | export job status + progress                                |
| GET    | `/jobs/by-recording/{uuid}`       | latest export job for a recording (survives browser reload) |
| GET    | `/recordings/{uuid}/export.mp4`   | stream the cached annotated MP4 (Range-capable)             |

Media itself is **not** proxied here — the browser plays recordings straight
from the device through the viewer's `/g3` reverse-proxy.

## Why a sidecar at all

Quoting the project README's v1.1 plan:

> WebRTC can't seek on replay and in-browser video export is painful — this
> is the only reason the sidecar exists.

Browser ffmpeg.wasm exists but is slow, memory-hungry, and a poor fit for
half-hour OKN sessions. A native Python service that pulls the finished
recording off the device and shells out to system `ffmpeg` is dramatically
simpler.

## How export works

`POST /recordings/{uuid}/export` runs a background asyncio task
(`export/pipeline.py`) that:

1. Fetches `recording.g3` to read the manifest (video/gaze filenames,
   resolution, duration).
2. Pulls `scene.mp4` and `gazedata.gz` into
   `recordings/<uuid>/export/` (cached — re-export is cheap).
3. Decodes the gaze JSONL into an ASS subtitle overlay (`export/ass_overlay.py`).
4. Shells out to `ffmpeg -vf subtitles=overlay.ass …`, parsing
   `-progress pipe:1` to update the job's `progress` field.

The result lands at `recordings/<uuid>/export/annotated.mp4`, served back
through `/recordings/{uuid}/export.mp4`. Needs a system `ffmpeg` on `PATH`.

## Python version

Pinned to 3.12 via `.python-version` — `uv sync` fetches and uses 3.12 even
if your default `python3` is newer (3.14 isn't supported by every dependency
yet). `g3pylib` is intentionally **not** a dependency; the ~250-line g3api
client in `device/client.py` covers the small slice of the protocol we use.
