"use client";

// HudPanel — the dense numerical telemetry card.
//
// Used to live in the right sidebar where ~340 px of width forced a tall
// vertical stack of label / value rows. Now sits in the main column below
// the eye cameras, which is much wider than tall — so each stat becomes a
// small tile (label on top, value below) arranged in a responsive grid
// that uses the full width. Easier to scan during a demo screen recording
// without scrolling.

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
      {/* Telemetry tiles — laid out left-to-right; wraps to fewer columns
          at small widths. Seven stats, so 7 columns at the largest tier
          (>= 1280 px); halves cleanly at smaller breakpoints. */}
      <SectionLabel>telemetry</SectionLabel>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
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

      {/* Pupil tiles — five stats; 5 columns at md and up so they all sit
          on one row alongside each other on a 16:9 demo crop. */}
      <SectionLabel>pupil (mm)</SectionLabel>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
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
