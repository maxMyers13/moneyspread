"""10-minute validation spike for the device-recording pivot.

Does the following against a live unit:
  1. Connect via G3ApiClient.
  2. recorder!start, read recorder.uuid, sleep ~5s, recorder!stop.
  3. Resolve recordings/<uuid>.http-path.
  4. GET <http-path>           → dump recording.g3
  5. GET <http-path>/gazedata.gz?use-content-encoding=true → first 5 jsonl lines
  6. HEAD <http-path>/scenevideo.mp4 → headers; then a Range probe.

Run with:
  uv run python scripts/spike_recorder.py [HOST]

HOST defaults to tg03b-080200012671.local. Anything you want the script to
hand back as cleanup state if it fails mid-run is wrapped in try/finally —
worst case is one ~5-second recording sitting on the SD card.

Prints a single self-contained block to stdout. No external deps beyond the
sidecar package itself.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

import httpx

# The script lives in sidecar/scripts/; import the package from sidecar/src/.
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1] / "src"))
from tobii_okn_sidecar.device import G3ApiClient, G3ApiError  # noqa: E402

DEFAULT_HOST = "tg03b-080200012671.local"
RECORD_SECONDS = 5.0


def banner(title: str) -> None:
    print(f"\n=== {title} ===")


async def main(host: str) -> int:
    print(f"# spike_recorder.py against {host}")
    base = f"http://{host}"

    try:
        async with G3ApiClient(host) as client:
            # Sanity: read serial. Cheap and confirms WS is alive before recording.
            banner("system.recording-unit-serial")
            serial = await client.read_property("system.recording-unit-serial")
            print(serial)

            banner("recorder.uuid (before start)")
            uuid_before = await client.read_property("recorder.uuid")
            print(repr(uuid_before))

            # Start
            banner("recorder!start")
            started = await client.call_action("recorder!start", [])
            print(f"returned: {started!r}")
            if started is not True:
                print("ABORT: recorder!start did not return true — recording did not begin")
                return 2

            # Read the uuid that we're now recording into. Per docs §4.4.6, it
            # may be undefined until !start has fully completed; we just got
            # confirmation it returned true, so the read here should succeed.
            banner("recorder.uuid (during)")
            uuid = await client.read_property("recorder.uuid")
            print(repr(uuid))
            if not isinstance(uuid, str) or len(uuid) < 8:
                print(f"ABORT: recorder.uuid not a usable string: {uuid!r}")
                await client.call_action("recorder!stop", [])
                return 2

            print(f"\nrecording for {RECORD_SECONDS}s…")
            await asyncio.sleep(RECORD_SECONDS)

            # Stop
            banner("recorder!stop")
            stopped = await client.call_action("recorder!stop", [])
            print(f"returned: {stopped!r}")

            # Resolve http-path
            banner(f"recordings/{uuid}.http-path")
            http_path = await client.read_property(f"recordings/{uuid}.http-path")
            print(repr(http_path))
            if not isinstance(http_path, str) or not http_path.startswith("/"):
                print(f"ABORT: http-path lookup returned {http_path!r}")
                return 2

        # WS no longer needed past here — switch to plain HTTP.
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as h:
            # 4. recording.g3 (returned by GET on the http-path itself)
            banner(f"GET {http_path}  (recording.g3)")
            r = await h.get(f"{base}{http_path}")
            print(f"HTTP {r.status_code}  {len(r.content)} bytes")
            print("--- response headers ---")
            for k, v in r.headers.items():
                print(f"  {k}: {v}")
            try:
                manifest: dict[str, Any] = r.json()
                print("--- recording.g3 (pretty) ---")
                print(json.dumps(manifest, indent=2, sort_keys=False))
            except json.JSONDecodeError:
                manifest = {}
                print("--- raw body (first 800 chars) ---")
                print(r.text[:800])

            # 5. gazedata.gz?use-content-encoding=true — first 5 jsonl lines
            banner(f"GET {http_path}/gazedata.gz?use-content-encoding=true  (first 5 lines)")
            r = await h.get(
                f"{base}{http_path}/gazedata.gz",
                params={"use-content-encoding": "true"},
            )
            print(f"HTTP {r.status_code}  content-encoding={r.headers.get('content-encoding')}")
            print(f"content-type={r.headers.get('content-type')}")
            lines = r.text.splitlines()
            print(f"total lines: {len(lines)}")
            for i, line in enumerate(lines[:5]):
                print(f"  [{i}] {line}")
            # Spot-check: are timestamps video-relative (start near 0, monotonic)?
            if lines:
                ts = []
                for line in lines[:50]:
                    try:
                        rec = json.loads(line)
                        if isinstance(rec.get("timestamp"), int | float):
                            ts.append(rec["timestamp"])
                    except json.JSONDecodeError:
                        pass
                if ts:
                    print(
                        f"  timestamp stats over first {len(ts)} samples: "
                        f"min={min(ts):.3f}s  max={max(ts):.3f}s  "
                        f"monotonic={all(b >= a for a, b in zip(ts, ts[1:]))}"
                    )

            # 6. scenevideo.mp4 — Range support probe
            banner(f"HEAD {http_path}/scenevideo.mp4")
            r = await h.head(f"{base}{http_path}/scenevideo.mp4")
            print(f"HTTP {r.status_code}")
            for k, v in r.headers.items():
                print(f"  {k}: {v}")

            banner(f"GET {http_path}/scenevideo.mp4  Range: bytes=0-99")
            r = await h.get(
                f"{base}{http_path}/scenevideo.mp4",
                headers={"Range": "bytes=0-99"},
            )
            print(f"HTTP {r.status_code}  bytes={len(r.content)}")
            for k, v in r.headers.items():
                print(f"  {k}: {v}")
            if r.status_code == 206:
                print("  → Range supported (206 Partial Content). Browser <video> seek will work directly.")
            elif r.status_code == 200 and len(r.content) > 100:
                print("  → Server returned full body, ignoring Range. Sidecar must re-serve with Range support.")
            else:
                print("  → Unexpected: read the headers above to decide.")

    except (G3ApiError, httpx.HTTPError, OSError) as e:
        print(f"\nERROR: {type(e).__name__}: {e}")
        return 1

    print("\n=== spike complete ===")
    return 0


if __name__ == "__main__":
    host = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_HOST
    raise SystemExit(asyncio.run(main(host)))
