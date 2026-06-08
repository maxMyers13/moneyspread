"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import GazeOverlay from "./GazeOverlay";

/**
 * SceneViewer renders the scene camera, in one of two modes:
 *   - live:  receives a MediaStream (WebRTC or mock), no scrub
 *   - replay: receives a video URL, browser-native <video controls> for seek
 *
 * Provide ONE of `stream` or `replaySrc`. Internal <video> ref is forwarded
 * so the replay-gaze hook can attach to currentTime / play / pause.
 */

export interface SceneViewerHandle {
  /** The underlying <video> element. Stable across renders. */
  video: HTMLVideoElement | null;
}

interface Props {
  stream?: MediaStream | null;
  replaySrc?: string | null;
}

const SceneViewer = forwardRef<SceneViewerHandle, Props>(function SceneViewer(
  { stream = null, replaySrc = null },
  forwardedRef
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useImperativeHandle(forwardedRef, () => ({ video: videoRef.current }), []);

  // Live mode: wire MediaStream. Replay mode: detach srcObject so the
  // `src` attribute (set declaratively below) takes effect.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (replaySrc) {
      // browser uses the `src` attribute on the element; clear srcObject
      v.srcObject = null;
      return;
    }
    if (stream && v.srcObject !== stream) {
      v.srcObject = stream;
      v.play().catch(() => {});
      return;
    }
    if (!stream) v.srcObject = null;
  }, [stream, replaySrc]);

  const isReplay = !!replaySrc;
  const isEmpty = !stream && !replaySrc;

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-md border border-line bg-black">
      <video
        ref={videoRef}
        src={replaySrc ?? undefined}
        muted
        playsInline
        controls={isReplay}
        className="absolute inset-0 h-full w-full object-cover"
      />
      <GazeOverlay videoRef={videoRef} />
      {isEmpty && (
        <div className="absolute inset-0 grid place-items-center text-sm text-muted">
          no scene stream — connect a source or pick a recording
        </div>
      )}
      <div className="absolute left-3 top-3 rounded bg-black/50 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-signal">
        scene · {isReplay ? "replay" : "first-person"}
      </div>
    </div>
  );
});

export default SceneViewer;
