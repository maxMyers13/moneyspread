"use client";

import { useEffect, useRef } from "react";
import { useStore, type EyeLayout } from "@/lib/store";

// A crop rectangle in *source* (composite-frame) pixels, expressed as 0..1
// fractions so it's resolution-independent.
interface Crop {
  fx: number;
  fy: number;
  fw: number;
  fh: number;
  label: string;
}

// The G3 eye stream is a single composite of the 4 eye sensors. We don't have
// the documented tiling, so offer the plausible arrangements and let the user
// pick the one that lines up live. Panels are numbered in reading order.
function cropsFor(layout: EyeLayout): Crop[] {
  switch (layout) {
    case "row": // 1×4 — four tiles side by side
      return [0, 1, 2, 3].map((i) => ({
        fx: i / 4,
        fy: 0,
        fw: 1 / 4,
        fh: 1,
        label: `${i + 1}`,
      }));
    case "col": // 4×1 — four tiles stacked
      return [0, 1, 2, 3].map((i) => ({
        fx: 0,
        fy: i / 4,
        fw: 1,
        fh: 1 / 4,
        label: `${i + 1}`,
      }));
    case "full": // whole composite, single panel
      return [{ fx: 0, fy: 0, fw: 1, fh: 1, label: "composite" }];
    case "2x2": // 2×2 grid — default
    default:
      return [
        { fx: 0, fy: 0, fw: 0.5, fh: 0.5, label: "1" },
        { fx: 0.5, fy: 0, fw: 0.5, fh: 0.5, label: "2" },
        { fx: 0, fy: 0.5, fw: 0.5, fh: 0.5, label: "3" },
        { fx: 0.5, fy: 0.5, fw: 0.5, fh: 0.5, label: "4" },
      ];
  }
}

export default function EyeCameraGrid({
  stream = null,
  replaySrc = null,
}: {
  stream?: MediaStream | null;
  /** Replay-mode eye-video URL, or null when the recording has no eye video. */
  replaySrc?: string | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const layout = useStore((s) => s.settings.eyeLayout);
  const blink = useStore((s) => s.derived.blink);

  const crops = cropsFor(layout);
  const isEmpty = !stream && !replaySrc;

  // Bind the single composite into the (offscreen) source video.
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

  // One RAF loop draws every panel's crop from the same source video.
  useEffect(() => {
    let raf = 0;
    const render = () => {
      const v = videoRef.current;
      const ok = v && v.videoWidth > 0 && v.videoHeight > 0;
      const dpr = window.devicePixelRatio || 1;
      const current = cropsFor(useStore.getState().settings.eyeLayout);

      for (let i = 0; i < canvasRefs.current.length; i++) {
        const canvas = canvasRefs.current[i];
        if (!canvas) continue;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        const cssW = canvas.clientWidth;
        const cssH = canvas.clientHeight;
        if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
          canvas.width = cssW * dpr;
          canvas.height = cssH * dpr;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        const crop = current[i];
        if (!ok || !v || !crop) continue;
        const sx = crop.fx * v.videoWidth;
        const sy = crop.fy * v.videoHeight;
        const sw = crop.fw * v.videoWidth;
        const sh = crop.fh * v.videoHeight;
        // Contain-fit so no eye detail is cropped away.
        const scale = Math.min(cssW / sw, cssH / sh);
        const dw = sw * scale;
        const dh = sh * scale;
        ctx.drawImage(v, sx, sy, sw, sh, (cssW - dw) / 2, (cssH - dh) / 2, dw, dh);
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="rounded-md border border-line bg-panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-signal">
          eye cameras{" "}
          <span className="text-muted">· 2 angles × 2 eyes</span>
        </span>
        {blink && (
          <span className="font-mono text-[10px] uppercase tracking-widest text-warn">
            blink / invalid
          </span>
        )}
      </div>

      {/* Offscreen source: the single composite eye stream. Kept "rendered"
          (not display:none) so the browser keeps decoding frames. */}
      <video
        ref={videoRef}
        src={replaySrc ?? undefined}
        muted
        playsInline
        aria-hidden
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: "none",
        }}
      />

      {isEmpty ? (
        <div className="grid h-24 place-items-center rounded border border-line bg-black px-3 text-center text-[11px] leading-relaxed text-muted">
          eye camera unavailable
          <br />
          (most recordings don&apos;t capture eye video; live glasses do)
        </div>
      ) : (
        <div
          className={
            layout === "full"
              ? "grid grid-cols-1 gap-2"
              : layout === "row"
                ? "grid grid-cols-2 gap-2 sm:grid-cols-4"
                : layout === "col"
                  ? "grid grid-cols-1 gap-2"
                  : "grid grid-cols-2 gap-2"
          }
        >
          {crops.map((c, i) => (
            <div
              key={i}
              className={`relative aspect-video overflow-hidden rounded border bg-black ${
                blink ? "border-warn" : "border-line"
              }`}
            >
              <canvas
                ref={(el) => {
                  canvasRefs.current[i] = el;
                }}
                className="absolute inset-0 h-full w-full"
              />
              <div className="absolute left-1 top-1 rounded bg-black/50 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-signal">
                {c.label}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
