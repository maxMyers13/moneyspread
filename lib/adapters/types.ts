// ---------------------------------------------------------------------------
// The spine. Every data source (mock, WebRTC, future sidecar) implements
// TobiiAdapter. The UI only ever talks to this interface, so swapping the
// source touches zero component code.
// ---------------------------------------------------------------------------

export type AdapterKind = "mock" | "webrtc" | "sidecar";

/** One eye-tracking sample as the app cares about it (normalized + mm). */
export interface GazeSample {
  /** Stream timestamp in seconds (monotonic within a session). */
  t: number;
  /** Normalized gaze in scene-camera space, [x, y] in 0..1. null = invalid. */
  gaze2d: [number, number] | null;
  /** Optional 3D vergence point relative to scene camera (mm). */
  gaze3d?: [number, number, number] | null;
  /** Pupil diameter in millimeters, or null when that eye is invalid. */
  pupilLeft: number | null;
  pupilRight: number | null;
  /** Per-eye validity from the tracker. */
  eyeLeftValid: boolean;
  eyeRightValid: boolean;
}

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface AdapterStatus {
  state: ConnectionState;
  message?: string;
}

/** Unsubscribe handle returned by event subscriptions. */
export type Unsubscribe = () => void;

export interface TobiiAdapter {
  readonly kind: AdapterKind;

  /** Establish control connection + media. Resolves once streams are live. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  /** Scene (first-person) camera stream — the "what they see" panel. */
  getSceneStream(): MediaStream | null;
  /** Eye-camera stream for blink / eye-position confirmation. May be null. */
  getEyeStream(): MediaStream | null;

  /** Subscribe to gaze + pupil samples. Returns an unsubscribe fn. */
  onGaze(cb: (s: GazeSample) => void): Unsubscribe;
  /** Subscribe to connection-state changes. */
  onStatus(cb: (s: AdapterStatus) => void): Unsubscribe;

  // --- Control plane (optional; stubbed by mock) ---------------------------
  calibrate?(): Promise<boolean>;
  startRecording?(): Promise<string>; // returns recording id/uuid
  stopRecording?(): Promise<void>;
}
