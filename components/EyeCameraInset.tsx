"use client";

import { useEffect, useRef } from "react";
import { useStore } from "@/lib/store";

export default function EyeCameraInset({
  stream = null,
  replaySrc = null,
}: {
  stream?: MediaStream | null;
  /** Replay-mode eye-video URL. Set to null when the recording's manifest
   * has eyecameras=null (most recordings don't capture eye video). */
  replaySrc?: string | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const blink = useStore((s) => s.derived.blink);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (replaySrc) {
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

  const isEmpty = !stream && !replaySrc;

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-md border border-line bg-black">
      <video
        ref={videoRef}
        src={replaySrc ?? undefined}
        muted
        playsInline
        className="absolute inset-0 h-full w-full object-cover"
      />
      {isEmpty && (
        <div className="absolute inset-0 grid place-items-center px-3 text-center text-[11px] leading-relaxed text-muted">
          eye camera unavailable
          <br />
          (most recordings don't capture eye video; live glasses do)
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
