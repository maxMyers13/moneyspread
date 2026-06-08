"use client";

import { useStore } from "@/lib/store";

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "signal" | "warn" | "alert" | "muted";
}) {
  const toneClass =
    tone === "alert"
      ? "text-alert"
      : tone === "warn"
        ? "text-warn"
        : tone === "signal"
          ? "text-signal"
          : "text-text";
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/40 py-1">
      <span className="text-[10px] uppercase tracking-widest text-muted">
        {label}
      </span>
      <span className={`font-mono text-sm tabular-nums ${toneClass}`}>
        {value}
      </span>
    </div>
  );
}

const fmt = (n: number | null, d = 3) => (n == null ? "—" : n.toFixed(d));

export default function HudPanel() {
  const d = useStore((s) => s.derived);

  return (
    <div className="rounded-md border border-line bg-panel p-3">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-signal">
        telemetry
      </div>
      <Row label="t (s)" value={fmt(d.t, 2)} />
      <Row
        label="gaze x / y"
        value={d.gazeRaw ? `${fmt(d.gazeRaw[0])}  ${fmt(d.gazeRaw[1])}` : "—"}
      />
      <Row
        label="pixel x / y"
        value={d.pixel ? `${d.pixel[0]}  ${d.pixel[1]}` : "—"}
      />
      <Row
        label="below line"
        value={d.belowStable ? "YES" : d.below ? "yes*" : "no"}
        tone={d.belowStable ? "alert" : d.below ? "warn" : "muted"}
      />
      <Row
        label="direction"
        value={(d.direction ?? "—").toUpperCase()}
        tone="signal"
      />
      <Row
        label="mode"
        value={d.mode.toUpperCase()}
        tone={d.mode === "saccade" ? "warn" : "signal"}
      />
      <Row
        label="eye state"
        value={d.blink ? "BLINK / INVALID" : "tracking"}
        tone={d.blink ? "warn" : "signal"}
      />

      <div className="mt-3 mb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-signal">
        pupil (mm)
      </div>
      <Row label="left" value={fmt(d.pupilL)} />
      <Row label="right" value={fmt(d.pupilR)} />
      <Row label="mean" value={fmt(d.pupilMeanVal)} tone="signal" />
      <Row label="baseline" value={fmt(d.pupilBaseline)} tone="muted" />
      <Row
        label="delta"
        value={d.pupilDelta == null ? "—" : (d.pupilDelta >= 0 ? "+" : "") + fmt(d.pupilDelta)}
        tone={
          d.pupilDelta == null
            ? "muted"
            : Math.abs(d.pupilDelta) > 0.3
              ? "warn"
              : "signal"
        }
      />
    </div>
  );
}
