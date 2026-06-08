"use client";

import { useEffect, useRef } from "react";
import { useStore, type EventKind } from "@/lib/store";

// Phosphor palette (kept in sync with GazeOverlay / globals.css tokens).
const C = {
  signal: "#5ff29a",
  saccade: "#ffd166",
  below: "#ff5d6c",
  line: "#3a4a40",
  track: "#141a16",
  muted: "#6b7a8f",
  text: "#c8d0d8",
};

const EVENT_COLOR: Record<EventKind, string> = {
  "stimulus-start": C.signal,
  "stimulus-stop": C.signal,
  "direction-change": C.saccade,
  trial: C.muted,
  note: C.text,
};

const H = 76; // css px

export default function Timeline() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;

    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const cssH = H;
      if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const st = useStore.getState();
      const tl = st.timeline;
      const events = st.events;
      const now = st.derived.t;

      // Track background.
      ctx.fillStyle = C.track;
      ctx.fillRect(0, 0, cssW, cssH);

      if (tl.length < 2) {
        ctx.fillStyle = C.muted;
        ctx.font = "11px ui-monospace, monospace";
        ctx.fillText("timeline — waiting for samples…", 8, cssH / 2 + 4);
        raf = requestAnimationFrame(render);
        return;
      }

      const tStart = tl[0].t;
      const tEnd = Math.max(tl[tl.length - 1].t, now);
      const span = tEnd - tStart || 1;
      const x = (t: number) => ((t - tStart) / span) * cssW;

      // Row geometry.
      const modeY = 10;
      const modeH = 16;
      const belowY = 32;
      const belowH = 16;
      const blinkY = 54;
      const blinkH = 10;

      // Mode strip (pursuit / saccade / idle) + below strip + blink ticks.
      for (let i = 1; i < tl.length; i++) {
        const a = tl[i - 1];
        const b = tl[i];
        const x0 = x(a.t);
        const w = Math.max(1, x(b.t) - x0);

        ctx.fillStyle =
          a.mode === "saccade" ? C.saccade : a.mode === "pursuit" ? C.signal : C.line;
        ctx.fillRect(x0, modeY, w, modeH);

        if (a.below) {
          ctx.fillStyle = C.below;
          ctx.fillRect(x0, belowY, w, belowH);
        }
        if (a.blink) {
          ctx.fillStyle = C.saccade;
          ctx.fillRect(x0, blinkY, Math.max(1, w), blinkH);
        }
      }

      // Row labels.
      ctx.font = "9px ui-monospace, monospace";
      ctx.fillStyle = C.muted;
      ctx.fillText("mode", 4, modeY - 2);
      ctx.fillText("below", 4, belowY - 2);
      ctx.fillText("blink", 4, blinkY - 2);

      // Event markers — full-height lines with a cap triangle.
      for (const e of events) {
        if (e.t < tStart) continue;
        const ex = x(e.t);
        ctx.strokeStyle = EVENT_COLOR[e.kind];
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(ex, 6);
        ctx.lineTo(ex, cssH - 2);
        ctx.stroke();
        ctx.fillStyle = EVENT_COLOR[e.kind];
        ctx.beginPath();
        ctx.moveTo(ex - 3, 0);
        ctx.lineTo(ex + 3, 0);
        ctx.lineTo(ex, 5);
        ctx.closePath();
        ctx.fill();
      }

      // Playhead.
      const px = x(now);
      ctx.strokeStyle = C.signal;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, cssH);
      ctx.stroke();

      // Time bounds.
      ctx.fillStyle = C.muted;
      ctx.font = "9px ui-monospace, monospace";
      ctx.fillText(`${tStart.toFixed(1)}s`, 4, cssH - 2);
      const endLbl = `${tEnd.toFixed(1)}s`;
      ctx.fillText(endLbl, cssW - ctx.measureText(endLbl).width - 4, cssH - 2);

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="rounded-md border border-line bg-panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-signal">
          timeline
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
          below · blink · pursuit/saccade · events
        </span>
      </div>
      <canvas ref={canvasRef} className="w-full" style={{ height: H }} />
    </div>
  );
}
