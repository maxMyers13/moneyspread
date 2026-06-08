"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useStore } from "@/lib/store";

const WINDOW_S = 30;

export default function PupilTrend() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const opts: uPlot.Options = {
      width: wrap.clientWidth,
      height: 150,
      padding: [8, 8, 0, 0],
      cursor: { show: false },
      legend: { show: false },
      scales: { x: { time: false }, y: { range: [2, 6] } },
      axes: [
        {
          stroke: "#5a6b60",
          grid: { stroke: "rgba(90,107,96,0.15)" },
          ticks: { stroke: "rgba(90,107,96,0.2)" },
          font: "10px ui-monospace, monospace",
        },
        {
          stroke: "#5a6b60",
          grid: { stroke: "rgba(90,107,96,0.15)" },
          ticks: { stroke: "rgba(90,107,96,0.2)" },
          font: "10px ui-monospace, monospace",
          size: 36,
        },
      ],
      series: [
        {},
        { stroke: "#5ff29a", width: 1.5, label: "mean" },
        { stroke: "#5a6b60", width: 1, dash: [4, 4], label: "baseline" },
      ],
    };

    const u = new uPlot(opts, [[], [], []], wrap);
    plotRef.current = u;

    const ro = new ResizeObserver(() => u.setSize({ width: wrap.clientWidth, height: 150 }));
    ro.observe(wrap);

    const id = setInterval(() => {
      const hist = useStore.getState().pupilHistory;
      if (hist.length === 0) return;
      const tEnd = hist[hist.length - 1].t;
      const tStart = tEnd - WINDOW_S;
      const baseline = useStore.getState().derived.pupilBaseline;
      const xs: number[] = [];
      const ys: number[] = [];
      const bs: number[] = [];
      for (const p of hist) {
        if (p.t < tStart) continue;
        xs.push(p.t);
        ys.push(p.mean);
        bs.push(baseline ?? p.mean);
      }
      u.setData([xs, ys, bs]);
    }, 100);

    return () => {
      clearInterval(id);
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
    };
  }, []);

  return (
    <div className="rounded-md border border-line bg-panel p-3">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-signal">
        pupil trend · mean vs baseline (mm)
      </div>
      <div ref={wrapRef} className="w-full" />
    </div>
  );
}
