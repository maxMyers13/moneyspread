"use client";

import { useEffect, useRef } from "react";
import { useStore } from "@/lib/store";

export default function EyeCameraInset({
  stream,
}: {
  stream: MediaStream | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const blink = useStore((s) => s.derived.blink);

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
      {!stream && (
        <div className="absolute inset-0 grid place-items-center px-3 text-center text-[11px] leading-relaxed text-muted">
          eye camera unavailable in mock mode
          <br />
          (real glasses publish this stream)
        </div>
      )}
      <div className="absolute left-2 top-2 rounded bg-black/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-signal">
        eye cam
      </div>
      {blink && (
        <div className="absolute inset-0 ring-2 ring-warn" aria-hidden />
      )}
    </div>
  );
}
