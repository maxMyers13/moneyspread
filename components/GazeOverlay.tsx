"use client";

import { useEffect, useRef } from "react";
import { useStore } from "@/lib/store";

// Phosphor palette (kept in sync with globals.css tokens).
const C = {
  signal: "#5ff29a",
  saccade: "#ffd166",
  below: "#ff5d6c",
  line: "#3a4a40",
  lineActive: "#5ff29a",
  trail: "#5ff29a",
};

export default function GazeOverlay({
  videoRef,
}: {
  videoRef: React.RefObject<HTMLVideoElement>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef(false);

  // Drag the reference line.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const yFromEvent = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    };
    const down = (e: PointerEvent) => {
      if (!useStore.getState().settings.showLine) return;
      draggingRef.current = true;
      canvas.setPointerCapture(e.pointerId);
      useStore.getState().setSetting("lineY", yFromEvent(e));
    };
    const move = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      useStore.getState().setSetting("lineY", yFromEvent(e));
    };
    const up = () => {
      draggingRef.current = false;
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  // Draw loop (imperative; does not re-render React).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;

    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const st = useStore.getState();
      const { settings: cfg, derived: d, trail } = st;

      // Reference line.
      if (cfg.showLine) {
        const ly = cfg.lineY * cssH;
        ctx.strokeStyle = d.belowStable ? C.below : draggingRef.current ? C.lineActive : C.line;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.moveTo(0, ly);
        ctx.lineTo(cssW, ly);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = d.belowStable ? C.below : C.line;
        ctx.font = "11px ui-monospace, monospace";
        ctx.fillText(`y=${cfg.lineY.toFixed(3)}`, 8, ly - 6);
      }

      // Trail.
      if (cfg.showTrail && trail.length > 1) {
        for (let i = 1; i < trail.length; i++) {
          const a = trail[i - 1];
          const b = trail[i];
          const alpha = i / trail.length;
          ctx.strokeStyle = `rgba(95,242,154,${alpha * 0.5})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(a.x * cssW, a.y * cssH);
          ctx.lineTo(b.x * cssW, b.y * cssH);
          ctx.stroke();
        }
      }

      // Gaze marker.
      const g = d.gazeSmooth;
      if (g && !d.blink) {
        const px = g[0] * cssW;
        const py = g[1] * cssH;
        const color = d.below ? C.below : d.mode === "saccade" ? C.saccade : C.signal;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        // reticle
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(px, py, 13, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(px - 20, py);
        ctx.lineTo(px - 16, py);
        ctx.moveTo(px + 16, py);
        ctx.lineTo(px + 20, py);
        ctx.moveTo(px, py - 20);
        ctx.lineTo(px, py - 16);
        ctx.moveTo(px, py + 16);
        ctx.lineTo(px, py + 20);
        ctx.stroke();

        // Feed true scene-pixel coords to the HUD.
        const v = videoRef.current;
        if (v && v.videoWidth) {
          st.setPixel([
            Math.round(g[0] * v.videoWidth),
            Math.round(g[1] * v.videoHeight),
          ]);
        }
      } else if (d.blink) {
        ctx.fillStyle = "rgba(255,209,102,0.85)";
        ctx.font = "13px ui-monospace, monospace";
        ctx.fillText("— blink / invalid —", cssW / 2 - 70, cssH / 2);
      }

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [videoRef]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full cursor-crosshair"
    />
  );
}
