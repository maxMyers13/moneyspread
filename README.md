# OKN Viewer — Tobii Pro Glasses 3

A local-first heads-up viewer for optokinetic nystagmus (OKN) sessions on Tobii
Pro Glasses 3. Scene video + real-time gaze marker, a draggable horizontal
reference line with below-line flagging, eye-camera inset, four-direction
movement, pursuit/saccade heuristic, blink/invalid detection, pupil metrics, and
CSV/JSON export.

This is a **research / visualization tool, not a diagnostic device.** Every
derived flag is heuristic until validated against a defined protocol.

---

## Run it

```bash
pnpm install      # or npm install
cp .env.local.example .env.local
pnpm dev          # http://localhost:3000
```

It boots in **mock mode** — a synthetic OKN signal (slow pursuit + saccadic
snap-back) drives the gaze marker over a scrolling-stripe scene, so the whole UI
is alive with no hardware. Drag the reference line, watch the below-line flag,
the direction/mode readout, the pupil trend, hit **record**, then **export csv**.

---

## Why it runs locally over http (and not on Vercel)

The glasses' control API lives on the **local network over plain `http`/`ws`**
(`http://<serial>.local`). A page served over **https** physically cannot call
an `http`/`ws` endpoint — the browser blocks it as mixed content. So a cloud-
hosted (https) frontend can't reach the glasses at all.

Serving over **`http://localhost`** is the sweet spot: localhost counts as a
secure context (so WebRTC / `getUserMedia` work), but because the page scheme is
http there's no mixed-content downgrade when it talks to the http glasses. The
browser that talks to the glasses must run **on a machine on the glasses' LAN**.

> Multi-machine note: `getUserMedia`/WebRTC require a secure context, and
> `http://<lan-ip>` (non-localhost) is *not* one. A second laptop viewing live
> over `http://192.168.x.x` will have WebRTC blocked. Live viewing from other
> machines is a sidecar-relay problem (see roadmap), not a v1 concern.

## CORS proxy

A browser at `localhost:3000` calling `http://<serial>.local` is cross-origin,
and the glasses may not send permissive CORS headers. `next.config.mjs` rewrites
`/g3/*` → the glasses, so signaling stays same-origin. Set `G3_HOST_INTERNAL` in
`.env.local` to your unit's hostname. WebRTC **media** flows browser↔glasses
directly and is not proxied.

---

## Architecture

Everything hangs off one interface: **`lib/adapters/types.ts → TobiiAdapter`**.
The UI only ever talks to that. Swapping data sources touches zero component
code.

```
app/page.tsx          owns adapter lifecycle; wires onGaze → store, onStatus → store
lib/adapters/
  types.ts            TobiiAdapter interface + GazeSample (the spine)
  mockAdapter.ts      synthetic OKN + fake scene MediaStream (current default)
  webrtcAdapter.ts    real-hardware path (skeleton — see TODOs below)
lib/store.ts          Zustand: settings, derived telemetry, trail + pupil buffers, export
lib/metrics.ts        pure fns: smoothing, direction, saccade/pursuit, pupil delta, below-line
components/
  SceneViewer + GazeOverlay   <video> + canvas reticle/line/trail (draggable line)
  EyeCameraInset              eye-cam panel (placeholder in mock)
  HudPanel                    dense telemetry readout
  PupilTrend                  uPlot mean-vs-baseline, 10 Hz refresh
  Controls                    connect/calibrate/record, sliders, export
```

**Stack:** Next.js 14 (App Router, run locally) · TypeScript (strict) ·
Tailwind · Zustand · uPlot. No app backend, no database.

---

## Wiring the real glasses

1. Put the glasses on the lab network; set `G3_HOST_INTERNAL` in `.env.local`
   and `NEXT_PUBLIC_ADAPTER=webrtc`.
2. Open the **on-device API browser** at `http://<serial>.local/browse.html`
   (and read the bundled example web client — it's the reference implementation
   for the WebRTC live-view handshake). Copy its signaling flow.
3. Fill in the four TODO helpers in `lib/adapters/webrtcAdapter.ts`:
   `createSession`, `exchangeSdp`, `sendIce`, `sendKeepAlive`, `deleteSession`.
   The PeerConnection, track handling, gaze-datachannel parsing, and the
   **keep-alive heartbeat (every 4 s — the glasses drop a session after 20 s of
   silence)** are already in place.

Gaze JSON is mapped to `GazeSample` using the documented fields (`gaze2d`,
`eyeleft.pupildiameter`, `eyeright.pupildiameter`); fields are simply absent when
tracking is invalid, and the parser handles that.

---

## Roadmap (matches the PRD)

- **v0 (done here):** live scene + gaze marker, normalized/pixel coords,
  draggable below-line flag — on mock data.
- **v1:** wire `webrtcAdapter`, eye-camera inset live, pupil HUD, blink +
  four-direction + pursuit/saccade, CSV/JSON export, calibration check.
- **v1.1 (Python sidecar):** FastAPI + `g3pylib` over **RTSP** for frame-accurate
  recording, scrubbable replay, and burned-in annotated video export (real
  ffmpeg). WebRTC can't seek on replay and in-browser video export is painful —
  this is the only reason the sidecar exists. Add it behind a `SidecarAdapter`.
- **v2:** OKN metrics — saccade frequency, pursuit direction consistency,
  below-line duration, trial summaries. After protocol validation.
