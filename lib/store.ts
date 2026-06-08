import { create } from "zustand";
import type {
  AdapterStatus,
  ConnectionState,
  GazeSample,
} from "./adapters/types";
import {
  belowLine,
  emaPoint,
  gazeSpeed,
  isBlinkLike,
  movementDirection,
  movementMode,
  pupilMean,
  type Direction,
  type MovementMode,
} from "./metrics";

// FR-12 event markers. Tags the lab can drop during a trial; exported
// alongside the per-sample rows. Kinds map to the PRD's named tags
// (stimulus start/stop, direction change, trial number) plus a free note.
export type EventKind =
  | "stimulus-start"
  | "stimulus-stop"
  | "direction-change"
  | "trial"
  | "note";

export interface SessionEvent {
  id: string;
  t: number; // stream/replay time (s) when the marker was dropped
  recordedAt: number; // wall-clock ms
  kind: EventKind;
  trial: number; // trial active when the marker was dropped
  note: string; // free text (the label for "note" kind; optional otherwise)
}

// One downsampled point for the review timeline (§9). Always-on, independent
// of the local CSV capture flag, so the timeline works live and in replay.
export interface TimelinePoint {
  t: number;
  below: boolean;
  blink: boolean;
  mode: MovementMode;
}

export interface Settings {
  showLine: boolean;
  lineY: number; // normalized 0..1
  showTrail: boolean;
  smoothingAlpha: number; // 0..1 (higher = less smoothing)
  movementThreshold: number; // norm units per sample
  saccadeThreshold: number; // norm units per second
  idleThreshold: number; // norm units per second
  blinkMinMs: number;
  baselineWindowS: number;
  minCrossingMs: number;
}

export interface Derived {
  t: number;
  gazeRaw: [number, number] | null;
  gazeSmooth: [number, number] | null;
  pixel: [number, number] | null; // filled by the overlay using video dims
  direction: Direction;
  mode: MovementMode;
  below: boolean;
  belowStable: boolean; // below for >= minCrossingMs
  blink: boolean;
  pupilL: number | null;
  pupilR: number | null;
  pupilMeanVal: number | null;
  pupilBaseline: number | null;
  pupilDelta: number | null;
}

interface RecordedRow extends Derived {
  recordedAt: number; // wall clock ms
}

interface StoreState {
  // connection
  state: ConnectionState;
  statusMessage: string;
  adapterKind: string;

  settings: Settings;
  derived: Derived;

  // buffers
  trail: { x: number; y: number; t: number }[];
  pupilHistory: { t: number; mean: number }[];
  recording: boolean;
  recorded: RecordedRow[];

  // FR-12 + timeline
  events: SessionEvent[];
  trial: number;
  timeline: TimelinePoint[];

  // internals
  _prevSmooth: [number, number] | null;
  _prevT: number | null;
  _invalidSinceMs: number | null;
  _belowSinceMs: number | null;
  _lastTimelineT: number | null;

  // actions
  setStatus: (s: AdapterStatus, kind?: string) => void;
  setSetting: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  ingest: (s: GazeSample) => void;
  setPixel: (px: [number, number] | null) => void;
  setRecording: (on: boolean) => void;
  clearBuffers: () => void;

  // event markers
  markEvent: (kind: EventKind, note?: string) => void;
  nextTrial: () => void;
  setTrial: (n: number) => void;
  removeEvent: (id: string) => void;
}

const TRAIL_MAX = 140;
const PUPIL_MAX = 3600; // ~60s at 60Hz
const TIMELINE_MAX = 6000; // capped ring; ~300s at the 20Hz downsample below
const TIMELINE_MIN_DT = 0.05; // downsample timeline to ~20Hz to widen its span

let _eventSeq = 0;
function makeEventId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `evt-${Date.now()}-${_eventSeq++}`;
}

const defaultSettings: Settings = {
  showLine: true,
  lineY: 0.62,
  showTrail: true,
  smoothingAlpha: 0.35,
  movementThreshold: 0.0025,
  saccadeThreshold: 1.2,
  idleThreshold: 0.05,
  blinkMinMs: 80,
  baselineWindowS: 10,
  minCrossingMs: 150,
};

const emptyDerived: Derived = {
  t: 0,
  gazeRaw: null,
  gazeSmooth: null,
  pixel: null,
  direction: null,
  mode: "idle",
  below: false,
  belowStable: false,
  blink: false,
  pupilL: null,
  pupilR: null,
  pupilMeanVal: null,
  pupilBaseline: null,
  pupilDelta: null,
};

export const useStore = create<StoreState>()((set, get) => ({
  state: "disconnected",
  statusMessage: "",
  adapterKind: "mock",
  settings: defaultSettings,
  derived: emptyDerived,
  trail: [],
  pupilHistory: [],
  recording: false,
  recorded: [],
  events: [],
  trial: 1,
  timeline: [],
  _prevSmooth: null,
  _prevT: null,
  _invalidSinceMs: null,
  _belowSinceMs: null,
  _lastTimelineT: null,

  setStatus: (s, kind) =>
    set((st) => ({
      state: s.state,
      statusMessage: s.message ?? st.statusMessage,
      adapterKind: kind ?? st.adapterKind,
    })),

  setSetting: (k, v) =>
    set((st) => ({ settings: { ...st.settings, [k]: v } })),

  setPixel: (px) =>
    set((st) => ({ derived: { ...st.derived, pixel: px } })),

  ingest: (s) => {
    const st = get();
    const cfg = st.settings;
    const nowMs = s.t * 1000;

    const blinkRaw = isBlinkLike(s);
    let invalidSince = st._invalidSinceMs;
    if (blinkRaw) {
      invalidSince = invalidSince ?? nowMs;
    } else {
      invalidSince = null;
    }
    const blink =
      invalidSince != null && nowMs - invalidSince >= cfg.blinkMinMs;

    // gaze + smoothing
    let gazeSmooth = st._prevSmooth;
    let direction: Direction = st.derived.direction;
    let mode: MovementMode = "idle";
    let below = false;
    let belowStable = false;
    let belowSince = st._belowSinceMs;

    if (s.gaze2d) {
      gazeSmooth = emaPoint(st._prevSmooth, s.gaze2d, cfg.smoothingAlpha);
      if (st._prevSmooth && st._prevT != null) {
        direction = movementDirection(
          st._prevSmooth,
          gazeSmooth,
          cfg.movementThreshold
        );
        const spd = gazeSpeed(st._prevSmooth, gazeSmooth, s.t - st._prevT);
        mode = movementMode(spd, cfg.saccadeThreshold, cfg.idleThreshold);
      }
      below = cfg.showLine && belowLine(gazeSmooth[1], cfg.lineY);
      if (below) {
        belowSince = belowSince ?? nowMs;
        belowStable = nowMs - belowSince >= cfg.minCrossingMs;
      } else {
        belowSince = null;
      }
    }

    const meanVal = pupilMean(s);

    // rolling baseline over baselineWindowS
    const pupilHistory = st.pupilHistory.slice();
    if (meanVal != null) {
      pupilHistory.push({ t: s.t, mean: meanVal });
      if (pupilHistory.length > PUPIL_MAX) pupilHistory.shift();
    }
    const windowStart = s.t - cfg.baselineWindowS;
    let baseSum = 0;
    let baseN = 0;
    for (let i = pupilHistory.length - 1; i >= 0; i--) {
      if (pupilHistory[i].t < windowStart) break;
      baseSum += pupilHistory[i].mean;
      baseN++;
    }
    const baseline = baseN > 0 ? baseSum / baseN : null;
    const delta = meanVal != null && baseline != null ? meanVal - baseline : null;

    // trail
    const trail = st.trail.slice();
    if (gazeSmooth && s.gaze2d) {
      trail.push({ x: gazeSmooth[0], y: gazeSmooth[1], t: s.t });
      if (trail.length > TRAIL_MAX) trail.shift();
    }

    // review timeline — downsampled, always-on (not gated by recording).
    let timeline = st.timeline;
    let lastTimelineT = st._lastTimelineT;
    if (lastTimelineT == null || s.t - lastTimelineT >= TIMELINE_MIN_DT) {
      timeline = st.timeline.slice();
      timeline.push({
        t: s.t,
        below: belowStable,
        blink,
        mode: blink ? "idle" : mode,
      });
      if (timeline.length > TIMELINE_MAX) timeline.shift();
      lastTimelineT = s.t;
    }

    const derived: Derived = {
      t: s.t,
      gazeRaw: s.gaze2d,
      gazeSmooth,
      pixel: st.derived.pixel,
      direction: blink ? null : direction,
      mode: blink ? "idle" : mode,
      below,
      belowStable,
      blink,
      pupilL: s.pupilLeft,
      pupilR: s.pupilRight,
      pupilMeanVal: meanVal,
      pupilBaseline: baseline,
      pupilDelta: delta,
    };

    const patch: Partial<StoreState> = {
      derived,
      trail,
      pupilHistory,
      timeline,
      _prevSmooth: gazeSmooth,
      _prevT: s.t,
      _invalidSinceMs: invalidSince,
      _belowSinceMs: belowSince,
      _lastTimelineT: lastTimelineT,
    };

    if (st.recording) {
      const recorded = st.recorded;
      recorded.push({ ...derived, recordedAt: Date.now() });
      patch.recorded = recorded;
    }

    set(patch);
  },

  setRecording: (on) =>
    set((st) => ({
      recording: on,
      recorded: on ? [] : st.recorded, // fresh buffer on start
    })),

  clearBuffers: () =>
    set({
      trail: [],
      pupilHistory: [],
      recorded: [],
      events: [],
      trial: 1,
      timeline: [],
      _prevSmooth: null,
      _prevT: null,
      _invalidSinceMs: null,
      _belowSinceMs: null,
      _lastTimelineT: null,
      derived: emptyDerived,
    }),

  markEvent: (kind, note = "") =>
    set((st) => ({
      events: [
        ...st.events,
        {
          id: makeEventId(),
          t: st.derived.t,
          recordedAt: Date.now(),
          kind,
          trial: st.trial,
          note,
        },
      ],
    })),

  // Advance the trial counter and drop a "trial" marker at the current time so
  // the boundary is recoverable from the exported events alone.
  nextTrial: () =>
    set((st) => {
      const trial = st.trial + 1;
      return {
        trial,
        events: [
          ...st.events,
          {
            id: makeEventId(),
            t: st.derived.t,
            recordedAt: Date.now(),
            kind: "trial" as EventKind,
            trial,
            note: `trial ${trial}`,
          },
        ],
      };
    }),

  setTrial: (n) => set({ trial: Math.max(1, Math.floor(n) || 1) }),

  removeEvent: (id) =>
    set((st) => ({ events: st.events.filter((e) => e.id !== id) })),
}));

// ---- export helpers --------------------------------------------------------

export function recordedToCsv(rows: RecordedRow[]): string {
  const header = [
    "t",
    "gaze_x",
    "gaze_y",
    "gaze_x_smooth",
    "gaze_y_smooth",
    "below_line",
    "below_stable",
    "direction",
    "mode",
    "blink",
    "pupil_l_mm",
    "pupil_r_mm",
    "pupil_mean_mm",
    "pupil_baseline_mm",
    "pupil_delta_mm",
  ];
  const lines = rows.map((r) =>
    [
      r.t.toFixed(4),
      r.gazeRaw?.[0]?.toFixed(5) ?? "",
      r.gazeRaw?.[1]?.toFixed(5) ?? "",
      r.gazeSmooth?.[0]?.toFixed(5) ?? "",
      r.gazeSmooth?.[1]?.toFixed(5) ?? "",
      r.below ? "1" : "0",
      r.belowStable ? "1" : "0",
      r.direction ?? "",
      r.mode,
      r.blink ? "1" : "0",
      r.pupilL?.toFixed(3) ?? "",
      r.pupilR?.toFixed(3) ?? "",
      r.pupilMeanVal?.toFixed(3) ?? "",
      r.pupilBaseline?.toFixed(3) ?? "",
      r.pupilDelta?.toFixed(3) ?? "",
    ].join(",")
  );
  return [header.join(","), ...lines].join("\n");
}

export function eventsToCsv(events: SessionEvent[]): string {
  const header = ["t", "kind", "trial", "note", "recorded_at"];
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = events.map((e) =>
    [
      e.t.toFixed(4),
      e.kind,
      String(e.trial),
      esc(e.note),
      new Date(e.recordedAt).toISOString(),
    ].join(",")
  );
  return [header.join(","), ...lines].join("\n");
}

export function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
