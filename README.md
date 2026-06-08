# moneyspread - eye-tracking viewer for Tobii Pro Glasses 3

[![status: research tool](https://img.shields.io/badge/status-research--tool-blue)]() [![platform: macOS · Windows](https://img.shields.io/badge/platform-macOS%20·%20Windows-lightgrey)]()

A desktop app that talks to **Tobii Pro Glasses 3** eye-tracking hardware and shows you, in real time:

- the live view from the scene camera (what the wearer sees),
- a dot painted on top of that video at the spot the wearer is looking,
- a small picture-in-picture of the wearer's eye,
- numerical readouts (pupil size, gaze direction, blink detection, etc.),
- and an optional draggable horizontal line you can use to flag whenever the wearer's gaze drops below a chosen threshold (useful for optokinetic-nystagmus experiments).

You can **record** a session straight to the glasses' SD card, **replay** it later with the gaze dot still painted on top, and **export** an annotated MP4 you can share or analyse later.

> ⚠️ This is a research / visualization tool. Nothing here is a medical diagnostic device.

---

## Table of contents

- [Before you start](#before-you-start)
- **Part 1 - One-time setup** - [macOS](#part-1macos--one-time-setup) · [Windows](#part-1windows--one-time-setup)
- [Part 2 - Configure the project](#part-2--configure-the-project)
- [Part 3 - Daily use](#part-3--daily-use)
- [Part 4 - Using the viewer](#part-4--using-the-viewer)
- [Troubleshooting](#troubleshooting)
- [For developers](#for-developers)

---

## Before you start

You will need:

1. **A laptop**: either a Mac (Apple Silicon or Intel, macOS 13+) **or** a Windows PC (Windows 10 build 17763+ / Windows 11). Both work.
2. **Tobii Pro Glasses 3** with the recording unit and a charged battery.
3. **The serial number** printed on the back of the recording unit. It looks like `TG03B-080200012671`.
4. **About 30 minutes** for first-time setup. After that, opening the app each day takes ~1 minute.

You do **not** need:

- Anything paid. All the tools we install are free.
- Any prior coding experience. We're just going to copy-paste a few commands.
- An internet connection while *using* the glasses (you do need internet during the one-time setup).

### A note on networks (important)

The glasses broadcast their own Wi-Fi network. To use the live view, your Mac has to connect to **that** Wi-Fi - which means, while you're using the app, **your Mac will not have internet access**. That's normal. Reconnect to your regular Wi-Fi when you're done.

---

## Part 1 (macOS) - One-time setup

> On Windows? Skip ahead to **[Part 1 (Windows) - One-time setup](#part-1windows--one-time-setup)**.

### Step 1.1 - Open the Terminal

Press `⌘ + Space` to open Spotlight, type `Terminal`, press Return. A black-or-white window opens with a blinking cursor. This is where you'll paste the commands below. **Every command in a grey box should be copy-pasted and run with Return.**

### Step 1.2 - Install Homebrew (a tool that installs other tools)

Homebrew is the standard "package manager" for macOS - think of it as an app store for command-line tools. We'll use it to install everything else.

Paste this into Terminal and press Return:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

It will ask for your Mac password. **Type it (you won't see anything appear as you type - that's normal)** and press Return. The whole thing takes 5–10 minutes. When it finishes, follow any "Next steps" instructions it prints (usually one or two lines you also paste and run).

To check it worked, run:

```bash
brew --version
```

You should see something like `Homebrew 4.x.x`. If you see "command not found", restart Terminal and try again.

### Step 1.3 - Install the project's dependencies

We need four things: **Node.js** (runs the browser app), **pnpm** (downloads the browser app's parts), **Python** (runs the recording/replay helper), and **ffmpeg** (turns recordings into video files). One command does all of it:

```bash
brew install node pnpm uv ffmpeg
```

This takes another 3–5 minutes. When it's done, verify with:

```bash
node --version && pnpm --version && uv --version && ffmpeg -version | head -1
```

You should see four lines, each starting with a version number. If any are missing, re-run the `brew install` command.

### Step 1.4 - Download the project

Pick a folder for it. The Documents folder is fine. Paste:

```bash
cd ~/Documents
git clone https://github.com/maxMyers13/moneyspread.git
cd moneyspread
```

`git clone` downloads a copy of the project. `cd moneyspread` moves you inside that folder. **From now on, all the commands assume you're in this folder.** If you close Terminal and re-open it, run `cd ~/Documents/moneyspread` to get back.

### Step 1.5 - Install the browser app's dependencies

```bash
pnpm install
```

This downloads a few hundred small libraries the app needs. It takes 1–3 minutes.

### Step 1.6 - Install the recording helper's dependencies

```bash
cd sidecar
uv sync
cd ..
```

`uv sync` sets up Python and downloads the helper's libraries. The `cd ..` at the end takes you back out of the `sidecar` folder.

You're done installing things. ✅ Skip ahead to **[Part 2 - Configure the project](#part-2--configure-the-project)**.

---

## Part 1 (Windows) - One-time setup

> On macOS? Use **[Part 1 (macOS)](#part-1macos--one-time-setup)** instead.

### Step 1.1 - Open PowerShell

Press `Win` and type `powershell`. In the search results, click **Windows PowerShell**. A blue (or black) window opens with a `PS C:\Users\You>` prompt. This is where you'll paste the commands below. **Every command in a grey box should be copy-pasted and run with Enter.**

> A faster, nicer alternative is [Windows Terminal](https://aka.ms/terminal) from the Microsoft Store - same idea, prettier and easier to read. Either works for everything below.

### Step 1.2 - Make sure winget is available

`winget` is Windows' built-in app installer (think of it as a free app store for command-line tools). It ships with Windows 10 (Aug 2021 update or later) and Windows 11. Check it's there:

```powershell
winget --version
```

If you see a version number (e.g. `v1.7.x`), you're good. If you see "command not found" or "not recognized", install **App Installer** from the Microsoft Store and try again.

### Step 1.3 - Install everything we need

We need five things: **Git** (downloads the project), **Node.js** (runs the browser app), **Python 3.12** + **uv** (runs the recording helper), and **ffmpeg** (turns recordings into video files). One command does it all:

```powershell
winget install --id Git.Git -e ; winget install --id OpenJS.NodeJS.LTS -e ; winget install --id Python.Python.3.12 -e ; winget install --id astral-sh.uv -e ; winget install --id Gyan.FFmpeg -e
```

Windows will prompt with a UAC dialog ("Do you want to allow this app to make changes?") for some installs. Click **Yes** each time. The whole thing takes 5–10 minutes.

> If `winget` complains about source agreements the first time, type `Y` and Enter to accept, then re-run the line above.

**Important: close PowerShell and open a new window** after the install finishes. The new tools won't be visible to your current PowerShell session - Windows only picks them up in newly-launched terminals.

In the new PowerShell window, verify with:

```powershell
git --version ; node --version ; python --version ; uv --version ; ffmpeg -version | Select-Object -First 1
```

You should see five lines, each with a version number. If any are missing, re-run the corresponding `winget install` line.

### Step 1.4 - Install pnpm

`pnpm` is the helper that downloads the browser app's parts. It rides on top of Node, which you just installed:

```powershell
npm install -g pnpm
```

Verify:

```powershell
pnpm --version
```

### Step 1.5 - Install Bonjour (lets your PC find the glasses)

Windows doesn't natively resolve `.local` hostnames the way Macs do. The glasses identify themselves with a `.local` name (e.g. `tg03b-080200099999.local`), so without this you can't reach them by name. The fix is Apple's free **Bonjour Print Services**:

1. Download Bonjour Print Services from <https://support.apple.com/kb/DL999>
2. Run the installer. Click through the defaults; reboot if it asks.

Bonjour is harmless: it's a tiny background service that resolves `.local` names on your local network. Many PCs already have it (any iTunes install brings it).

### Step 1.6 - Download the project

```powershell
cd $HOME\Documents
git clone https://github.com/maxMyers13/moneyspread.git
cd moneyspread
```

`git clone` downloads a copy of the project. `cd moneyspread` moves you inside that folder. **From now on, all the commands assume you're in this folder.** If you close PowerShell and re-open it, run `cd $HOME\Documents\moneyspread` to get back.

### Step 1.7 - Install the browser app's dependencies

```powershell
pnpm install
```

1–3 minutes. If you see a warning about "scripts" needing approval, type `a` (approve all) and Enter.

### Step 1.8 - Install the recording helper's dependencies

```powershell
cd sidecar
uv sync
cd ..
```

You're done installing things. ✅

---

## Part 2 - Configure the project

We need to tell the app which Tobii unit to talk to. **Find your glasses' serial number** (the `TG03B-080200012671`-style sticker on the recording unit).

In your terminal, still inside the `moneyspread` folder:

**macOS:**
```bash
cp .env.local.example .env.local
open -e .env.local
```

**Windows:**
```powershell
Copy-Item .env.local.example .env.local
notepad .env.local
```

The file opens in TextEdit (macOS) or Notepad (Windows). Find the two lines that reference `tg03b-080200012671.local`. **Replace them with your unit's serial, in lowercase, followed by `.local`**.

For example, if the sticker says `TG03B-080200099999`, your two lines become:

```
G3_HOST_INTERNAL=http://tg03b-080200099999.local
NEXT_PUBLIC_G3_DIRECT=http://tg03b-080200099999.local
```

Save (`⌘ + S` on Mac, `Ctrl + S` on Windows) and close the editor.

That's all the configuration. The recording helper picks up the same hostname from the same file.

---

## Part 3 - Daily use

Each time you want to use the glasses, do this:

### Step 3.1 - Power on the glasses

Hold the recording unit's power button until the LED comes on. Wait ~30 seconds for it to fully boot.

### Step 3.2 - Connect your computer to the glasses' Wi-Fi

- **macOS**: click the Wi-Fi icon in the menu bar.
- **Windows**: click the network icon in the system tray (bottom-right).

Look for a network named after the serial (e.g., `TG03B-080200099999`). Connect to it. **The password is `TobiiGlasses`** (capital T and G).

> You'll lose internet for the duration. That's expected.

### Step 3.3 - Start the app

Open your terminal (Terminal on Mac, PowerShell on Windows):

**macOS:**
```bash
cd ~/Documents/moneyspread
pnpm dev
```

**Windows:**
```powershell
cd $HOME\Documents\moneyspread
pnpm dev
```

You'll see a few lines, ending with:

```
- Local:        http://localhost:3000
✓ Ready in 1.2s
```

Leave that terminal window open.

### Step 3.4 - (Optional) Start the recording helper

If you want to record sessions, replay them, or export annotated videos, **open a second terminal window** (`⌘ + N` in Terminal on Mac; right-click the PowerShell icon in your taskbar → "Windows PowerShell" on Windows) and run:

**macOS:**
```bash
cd ~/Documents/moneyspread/sidecar
uv run sidecar
```

**Windows:**
```powershell
cd $HOME\Documents\moneyspread\sidecar
uv run sidecar
```

You'll see:

```
sidecar starting: device=tg03b-...local  recordings_dir=...
INFO:     Uvicorn running on http://127.0.0.1:8765
```

Leave this terminal open too.

If you only want to watch live (no recording/replay/export), you can skip this step. The app degrades gracefully - the "RECORDINGS" panel will say "sidecar offline" but everything else works.

### Step 3.5 - Open the viewer

Open a web browser (Chrome works best). Go to:

```
http://localhost:3000
```

You should see the OKN Viewer interface.

### Step 3.6 - Connect to the live glasses view

In the right-hand panel, under **CONTROLS**, the `WEBRTC` source should already be highlighted. Click **CONNECT**. Within ~5 seconds you should see:

- the scene camera (what the wearer is seeing) in the big top panel
- the eye camera (small, black-and-white - that's normal, it's an infrared sensor) bottom-left
- a small dot moving over the scene video, tracking the wearer's gaze

If something goes wrong, click **PROBE GLASSES** first - it'll tell you whether your computer can reach the glasses at all and explain why if not.

### Step 3.7 - When you're done

- Click **DISCONNECT** in the viewer.
- Close terminal windows (`⌘ + Q` on Mac, click the X on Windows).
- Reconnect your computer to your regular Wi-Fi.
- Turn off the glasses (hold the power button for 4 seconds, release on first LED blink).

---

## Part 4 - Using the viewer

The interface has four parts:

### Scene panel (top, large)
What the wearer sees, plus the gaze dot on top, plus the optional horizontal reference line. You can drag the line up and down - when the wearer's gaze crosses below it, the "BELOW LINE" telemetry flips to `yes`.

### Eye camera (bottom-left)
The wearer's eyes, captured by an infrared sensor in the glasses. Black-and-white is normal. Useful for confirming the glasses aren't slipping or that the wearer is blinking when the gaze data goes weird.

### Pupil trend chart (bottom-right)
A rolling chart of pupil size over the last few seconds, compared to a baseline. Big spikes can indicate cognitive load or surprise.

### Controls + telemetry (right sidebar)
- **CONNECT / DISCONNECT** - start/stop the live view.
- **CALIBRATE** - runs Tobii's built-in calibration routine. Have the wearer follow the dot the glasses display.
- **● RECORD / ■ STOP** - start/stop a recording on the glasses' SD card. Also captures a local CSV backup. Each recording shows up in the **RECORDINGS** panel below.
- **REFERENCE LINE** - toggles the horizontal line on/off; the **LINE Y** slider sets its vertical position.
- **EXPORT CSV / JSON** - saves the *local* (browser-captured) gaze samples to disk.
- **GAZE TRAIL** - toggles the fading-trail effect behind the gaze dot.
- The **HUD** below shows live numerical readouts.

### RECORDINGS panel (bottom of sidebar)
After you record a session, it appears here.

- **Click a recording row** → enters "replay mode". The scene panel becomes a normal video player with a scrubber. The gaze dot tracks what was recorded.
- **Export annotated** (button inside each row) → asks the recording helper to render an MP4 with the gaze dot and reference line burned into the video. Takes ~30–60s per minute of recording. When it's done the button becomes **↓ download annotated**.

---

## Troubleshooting

### "Cannot resolve `tg03b-...local`" or `PROBE GLASSES` says unreachable

- Are you connected to the glasses' Wi-Fi network (not your regular Wi-Fi)?
- Are the glasses powered on with a charged battery?
- Did you put your exact serial in `.env.local` (lowercase, with `.local` at the end)?
- Restart `pnpm dev` after changing `.env.local`.
- **Windows only**: did you install Bonjour Print Services (Step 1.5)? Without it, Windows can't resolve `.local` hostnames. Reboot after installing if you forgot.

### Connection works but drops every ~25 seconds

This is a known limitation of the glasses' built-in Wi-Fi access point - it's not strong enough to sustain WebRTC for very long. The app handles it automatically: you'll see a brief flicker, then it reconnects. You can ignore it for short recordings; for longer sessions, recordings go to the SD card and aren't affected.

### `pnpm: command not found` / `uv: command not found` / `'winget' is not recognized`

Close the terminal window and open a brand-new one. The tools were installed but the existing window doesn't know about them yet - Windows and macOS both only show newly-installed tools in newly-launched terminals.

If `winget` itself is missing even in a fresh window, you're on a Windows version older than the 2021 update. Install **App Installer** from the Microsoft Store and try again.

### Windows says PowerShell scripts are disabled

If you see "running scripts is disabled on this system" when running `pnpm` or `uv`, paste this once into PowerShell and answer `Y`:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

This is a one-time per-user setting that lets locally-installed tools run.

### Eye cam looks weird / black and white

That's the infrared camera. It's supposed to look like that.

### The export takes forever

That's normal - `ffmpeg` is re-encoding the entire video. Expect roughly real-time (a 5-minute recording takes ~5 minutes to export). The progress bar will update as it goes.

### The viewer opens but nothing happens

Open the LOGS section in the right sidebar (click "LOGS"). It shows every step of what's happening with timestamps. If something failed, it's in there. You can hit **copy** and paste the whole thing somewhere to ask for help.

### Battery dying mid-session

The glasses' battery lasts ~1h 45min of recording on a full charge. The HUD doesn't show battery yet (planned feature). Use Tobii's official Controller app on a separate device if you need to monitor it during a long recording.

---

## For developers

The rest of this document is a brief architectural reference for collaborators. Skip if you only want to use the app.

### Stack
- **Frontend**: Next.js 14 (App Router, run locally), TypeScript strict, Tailwind, Zustand, uPlot.
- **Sidecar**: Python 3.12 + FastAPI + uvicorn + httpx + websockets, packaged with uv.
- **Video pipeline**: ffmpeg (system binary) with `subtitles=` filter for ASS overlay burn-in.
- No cloud, no database.

### Architecture spine
The viewer talks to data sources through a single TypeScript interface, `lib/adapters/types.ts → TobiiAdapter`. Swapping sources touches zero component code.

```
app/page.tsx                  owns adapter + replay mode state
lib/adapters/
  types.ts                    TobiiAdapter interface + GazeSample
  mockAdapter.ts              synthetic OKN signal (no hardware)
  webrtcAdapter.ts            real glasses via WebRTC + g3api WebSocket
lib/store.ts                  Zustand store: settings, derived telemetry, buffers, export
lib/metrics.ts                pure functions: smoothing, direction, saccade/pursuit, etc.
lib/useReplayGaze.ts          drives the store from a recording's gazedata.gz
lib/sidecarApi.ts             TS client mirroring the sidecar's HTTP surface
components/
  SceneViewer + GazeOverlay   <video> + canvas reticle/line/trail
  EyeCameraInset              IR eye camera
  HudPanel                    dense telemetry readout
  PupilTrend                  uPlot mean-vs-baseline chart
  Controls                    connect/calibrate/record/sliders/export buttons
  RecordingsList              device recordings sidebar + replay entrypoint
  ExportButton                per-recording export controls

sidecar/src/tobii_okn_sidecar/
  app.py                      FastAPI app
  device/client.py            g3api WebSocket + REST client (no g3pylib)
  storage/                    DeviceRecordingManifest + SidecarRecord
  export/                     ASS overlay generator + ffmpeg pipeline + job registry
```

### Why localhost and not Vercel
The glasses' control API is plain `http://<serial>.local`. A page served over `https` can't call `http`/`ws` endpoints (mixed content). Serving over `http://localhost` is the sweet spot - `localhost` is a secure context (so WebRTC and `getUserMedia` work) but the page itself is `http`, avoiding the downgrade.

### WebRTC signaling flow
Per Tobii's Developer Guide §4.2.1, the **glasses** are the offerer:

```
1. webrtc!create([])                          → uuid
2. WebSocket subscribe webrtc/<uuid>:new-ice-candidate
3. webrtc/<uuid>!setup([])                    → device SDP offer
4. pc.setRemoteDescription({type:"offer", sdp})
5. answer = pc.createAnswer(); pc.setLocalDescription
6. webrtc/<uuid>!start([answer.sdp])
7. webrtc/<uuid>!add-ice-candidate([idx, c])  (trickle local ICE)
8. webrtc/<uuid>!keep-alive([])               every <5s, over the WS (HTTP path 400s)
9. webrtc!delete([uuid])                      on teardown
```

Gaze samples arrive over the g3api WebSocket subscribed to `webrtc/<uuid>:gaze`, not the WebRTC data channel.

### Recording / replay / export pivot
Phase A2 of the v1.1 sidecar originally pulled RTSP and authored its own `gaze.jsonl` + `scene.mp4`. That gives ~10-100ms gaze-to-video skew because gaze and video arrive over different transports on different clocks. The current implementation uses the device's own `recorder!start` (docs §4.4) which writes to the SD card with perfect in-device sync (docs §6: all streams begin at 0 = first scene-camera frame); we just pull the finished files via the device's own HTTP endpoints (`/recordings/<uuid>/...`). The device serves Range natively, so browser `<video>` seek works through the existing `/g3` proxy without any sidecar caching layer.

### Why no `g3pylib`
Tobii's official Python SDK pins `av==10.0.0` (PyAV), which won't build against `ffmpeg` 8 (Cython errors against the modern libavcodec ABI). We use ~5% of g3pylib's surface anyway - just the g3api WebSocket protocol - so we re-implement it in `sidecar/src/tobii_okn_sidecar/device/client.py` (~250 lines).

### Known limitations
- **~25-second WebRTC media drops** on the glasses' built-in 2.4 GHz access point. Likely Wi-Fi power-save or buffer saturation on the device side. The auto-reconnect path keeps the viewer usable (~78% uptime). Recordings go to the SD card and aren't affected. Ethernet end-to-end would eliminate it.
- **`!remote-host` action** returns 400 on this firmware at every path we've tried. Doesn't impact anything since real-IP candidates work fine.
- **Eye-camera video** isn't captured to the SD card by default (manifest reports `eyecameras: null`). The live eye-camera view still works.

### Roadmap
- **v1 (done):** live scene + gaze marker, eye-camera inset, pupil HUD, blink/direction/pursuit/saccade heuristics, CSV/JSON export.
- **v1.1 (done):** Python sidecar - device-driven recording, scrubbable replay, annotated video export.
- **v2:** OKN metrics - saccade frequency, pursuit direction consistency, below-line duration, trial summaries. After protocol validation.

---

## Credits

Built against [Tobii Pro Glasses 3 Developer Guide](https://developer.tobiipro.com/) v1, FW 1.x. Not affiliated with Tobii AB.
