import type { GazeSample } from "./adapters/types";

export type Direction = "left" | "right" | "up" | "down" | null;
export type MovementMode = "pursuit" | "saccade" | "idle";

// Exponential moving average on a normalized gaze point. alpha in (0,1];
// higher = less smoothing.
export function emaPoint(
  prev: [number, number] | null,
  next: [number, number],
  alpha: number
): [number, number] {
  if (!prev) return next;
  return [
    prev[0] + alpha * (next[0] - prev[0]),
    prev[1] + alpha * (next[1] - prev[1]),
  ];
}

// Largest-axis-above-threshold movement direction.
export function movementDirection(
  prev: [number, number],
  cur: [number, number],
  threshold: number
): Direction {
  const dx = cur[0] - prev[0];
  const dy = cur[1] - prev[1];
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (Math.max(adx, ady) < threshold) return null;
  if (adx >= ady) return dx > 0 ? "right" : "left";
  // remember: y grows downward (0 = top), so positive dy = "down"
  return dy > 0 ? "down" : "up";
}

// Speed in normalized units per second between two timed samples.
export function gazeSpeed(
  prev: [number, number],
  cur: [number, number],
  dt: number
): number {
  if (dt <= 0) return 0;
  const dx = cur[0] - prev[0];
  const dy = cur[1] - prev[1];
  return Math.hypot(dx, dy) / dt;
}

// Heuristic movement mode. Labels are visualization-grade until validated.
export function movementMode(
  speed: number,
  saccadeThreshold: number,
  idleThreshold: number
): MovementMode {
  if (speed >= saccadeThreshold) return "saccade";
  if (speed <= idleThreshold) return "idle";
  return "pursuit";
}

export function belowLine(gaze2dY: number, lineY: number): boolean {
  // y grows downward; "below" the line means a larger y value.
  return gaze2dY > lineY;
}

export function pupilMean(s: GazeSample): number | null {
  const vals = [s.pupilLeft, s.pupilRight].filter(
    (v): v is number => typeof v === "number"
  );
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function isBlinkLike(s: GazeSample): boolean {
  const bothInvalid = !s.eyeLeftValid && !s.eyeRightValid;
  const noPupil = s.pupilLeft == null && s.pupilRight == null;
  const noGaze = s.gaze2d == null;
  return bothInvalid || (noPupil && noGaze);
}
