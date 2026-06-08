"""Tobii Pro Glasses 3 OKN viewer sidecar.

Companion to the Next.js viewer. WebRTC handles live view from the browser
directly; this service exists for the things WebRTC can't do well:

  - frame-accurate recording (RTSP via g3pylib while live view streams over WebRTC)
  - scrubbable replay (RTSP can rewind, WebRTC can't)
  - burned-in annotated video export (ffmpeg pipeline)

The browser talks to this service over plain HTTP on localhost. No cloud,
no auth, no shared state — same local-first posture as the viewer.
"""

__version__ = "0.1.0"
