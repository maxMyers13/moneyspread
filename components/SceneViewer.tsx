"use client";

import { useEffect, useRef } from "react";
import GazeOverlay from "./GazeOverlay";

export default function SceneViewer({
  stream,
}: {
  stream: MediaStream | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (stream && v.srcObject !== stream) {
      v.srcObject = stream;
      v.play().catch(() => {});
    }
    if (!stream) v.srcObject = null;
  }, [stream]);

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-md border border-line bg-black">
      <video
        ref={videoRef}
        muted
        playsInline
        className="absolute inset-0 h-full w-full object-cover"
      />
      <GazeOverlay videoRef={videoRef} />
      {!stream && (
        <div className="absolute inset-0 grid place-items-center text-sm text-muted">
          no scene stream — connect a source
        </div>
      )}
      <div className="absolute left-3 top-3 rounded bg-black/50 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-signal">
        scene · first-person
      </div>
    </div>
  );
}
