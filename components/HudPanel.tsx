"use client";

// HudPanel — the dense numerical telemetry card.
//
// Lives in its own narrow left column so every per-frame readout stays in
// frame during a demo screen recording without scrolling. Each stat is a
// small tile (label on top, value below); at the narrow column width they
// pack two-up, and collapse to a denser grid at small viewports where the
// column spans the full width.

import { useStore } from "@/lib/store";

type Tone = "signal" | "warn" | "alert" | "muted";

function toneClass(tone?: Tone): string {
  switch (tone) {
    case "alert":
      return "text-alert";
    case "warn":
      return "text-warn";
    case "signal":
      return "text-signal";
    case "muted":
      return "text-muted";
    default:
      return "text-text";
  }
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: Tone;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded border border-line/40 bg-bg/30 px-2 py-1.5">
      <span className="truncate font-mono text-[9px] uppercase tracking-widest text-muted">
        {label}
      </span>
      <span
        className={`truncate whitespace-nowrap font-mono text-sm tabular-nums ${toneClass(
          tone
        )}`}
      >
        {value}
      </span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-signal">
      {children}
    </div>
  );
}

const fmt = (n: number | null, d = 3) => (n == null ? "—" : n.toFixed(d));

export default function HudPanel() {
  const d = useStore((s) => s.derived);

  return (
    <div className="space-y-3 rounded-md border border-line bg-panel p-3">
      {/* Telemetry tiles — pack three-up on small/wide viewports where the
          column stretches full width, then settle to two-up once the layout
          breaks into the narrow left rail at lg. */}
      <SectionLabel>telemetry</SectionLabel>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-2">
        <Stat label="t (s)" value={fmt(d.t, 2)} />
        <Stat
          label="gaze x / y"
          value={
            d.gazeRaw ? `${fmt(d.gazeRaw[0])} ${fmt(d.gazeRaw[1])}` : "—"
          }
        />
        <Stat
          label="pixel x / y"
          value={d.pixel ? `${d.pixel[0]} ${d.pixel[1]}` : "—"}
        />
        <Stat
          label="below line"
          value={d.belowStable ? "YES" : d.below ? "yes*" : "no"}
          tone={d.belowStable ? "alert" : d.below ? "warn" : "muted"}
        />
        <Stat
          label="direction"
          value={(d.direction ?? "—").toUpperCase()}
          tone="signal"
        />
        <Stat
          label="mode"
          value={d.mode.toUpperCase()}
          tone={d.mode === "saccade" ? "warn" : "signal"}
        />
        <Stat
          label="eye state"
          value={d.blink ? "BLINK" : "tracking"}
          tone={d.blink ? "warn" : "signal"}
        />
      </div>

      {/* Pupil tiles — match the telemetry grid: three-up when full width,
          two-up in the narrow left rail at lg. */}
      <SectionLabel>pupil (mm)</SectionLabel>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-2">
        <Stat label="left" value={fmt(d.pupilL)} />
        <Stat label="right" value={fmt(d.pupilR)} />
        <Stat label="mean" value={fmt(d.pupilMeanVal)} tone="signal" />
        <Stat label="baseline" value={fmt(d.pupilBaseline)} tone="muted" />
        <Stat
          label="delta"
          value={
            d.pupilDelta == null
              ? "—"
              : (d.pupilDelta >= 0 ? "+" : "") + fmt(d.pupilDelta)
          }
          tone={
            d.pupilDelta == null
              ? "muted"
              : Math.abs(d.pupilDelta) > 0.3
                ? "warn"
                : "signal"
          }
        />
      </div>
    </div>
  );
}
