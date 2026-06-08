"""Device-facing layer. Speaks the Tobii Pro Glasses 3 g3api protocol
(WebSocket + REST) directly — no g3pylib dependency.

We rolled our own thin client instead of pulling g3pylib because:
  - g3pylib pins PyAV 10.0.0, which won't compile against ffmpeg 8 (Cython
    errors against the modern libavcodec API).
  - Our use of g3pylib would have been ~5% of its surface (just WS actions
    and signal subscriptions); we already implement the same protocol in
    the browser-side adapter and know it works.
  - RTSP capture goes through an ffmpeg subprocess, so we don't need
    g3pylib's RTSP demuxer at all.

If a later phase needs PTS-aligned gaze (we currently rely on device-clock
timestamps with a per-recording offset), that's the moment to revisit
g3pylib or build our own RTP demuxer.
"""

from .client import G3ApiClient, G3ApiError

__all__ = ["G3ApiClient", "G3ApiError"]
