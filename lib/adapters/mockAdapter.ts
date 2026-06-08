import type {
  AdapterStatus,
  GazeSample,
  TobiiAdapter,
  Unsubscribe,
} from "./types";

// ---------------------------------------------------------------------------
// MockTobiiAdapter
// Produces a believable OKN signal so you can build and demo the entire viewer
// before the glasses are on the network:
//   - gaze2d.x = sawtooth: slow linear PURSUIT rightward, then fast SACCADE
//     snap-back leftward. (Classic optokinetic nystagmus.)
//   - gaze2d.y hovers near center with small noise.
//   - pupil oscillates slowly around a baseline (mm).
//   - periodic blinks: eyes go invalid, gaze2d/pupils null for ~120 ms.
//   - scene stream: an offscreen canvas of vertical stripes scrolling right
//     (the "barrel"), captured as a MediaStream. The gaze dot tracks it.
// ---------------------------------------------------------------------------

const SAMPLE_HZ = 60;
const PURSUIT_MS = 1500; // duration of one slow sweep
const SACCADE_MS = 60; // duration of the fast snap-back
const X_MIN = 0.15;
const X_MAX = 0.85;
const BLINK_EVERY_MS = 6000;
const BLINK_MS = 120;
const PUPIL_BASE = 3.6;

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

export class MockTobiiAdapter implements TobiiAdapter {
  readonly kind = "mock" as const;

  private gazeSubs = new Set<(s: GazeSample) => void>();
  private statusSubs = new Set<(s: AdapterStatus) => void>();

  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private rafId: number | null = null;
  private startMs = 0;

  private sceneCanvas: HTMLCanvasElement | null = null;
  private sceneStream: MediaStream | null = null;
  private eyeCanvas: HTMLCanvasElement | null = null;
  private eyeStream: MediaStream | null = null;

  async connect(): Promise<void> {
    this.emitStatus({ state: "connecting", message: "mock: spinning up" });
    this.startMs = performance.now();
    this.startSceneStream();
    this.sampleTimer = setInterval(() => this.tick(), 1000 / SAMPLE_HZ);
    this.emitStatus({ state: "connected", message: "mock OKN source live" });
  }

  async disconnect(): Promise<void> {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.sampleTimer = null;
    this.rafId = null;
    this.sceneStream?.getTracks().forEach((t) => t.stop());
    this.sceneStream = null;
    this.eyeStream?.getTracks().forEach((t) => t.stop());
    this.eyeStream = null;
    this.emitStatus({ state: "disconnected" });
  }

  getSceneStream(): MediaStream | null {
    return this.sceneStream;
  }

  // Synthetic 2×2 eye composite (mirrors the real G3's single composite of 4
  // eye sensors) so the eye-camera split is demoable without the glasses.
  getEyeStream(): MediaStream | null {
    return this.eyeStream;
  }

  onGaze(cb: (s: GazeSample) => void): Unsubscribe {
    this.gazeSubs.add(cb);
    return () => this.gazeSubs.delete(cb);
  }

  onStatus(cb: (s: AdapterStatus) => void): Unsubscribe {
    this.statusSubs.add(cb);
    return () => this.statusSubs.delete(cb);
  }

  async calibrate(): Promise<boolean> {
    await new Promise((r) => setTimeout(r, 600));
    return true;
  }

  async startRecording(): Promise<string> {
    return `mock-${Date.now()}`;
  }

  async stopRecording(): Promise<void> {
    /* no-op */
  }

  // -------------------------------------------------------------------------

  private emitStatus(s: AdapterStatus) {
    this.statusSubs.forEach((cb) => cb(s));
  }

  private tick() {
    const t = (performance.now() - this.startMs) / 1000;
    const ms = t * 1000;

    // Blink window?
    const blinkPhase = ms % BLINK_EVERY_MS;
    const blinking = blinkPhase < BLINK_MS;

    if (blinking) {
      this.emitGaze({
        t,
        gaze2d: null,
        pupilLeft: null,
        pupilRight: null,
        eyeLeftValid: false,
        eyeRightValid: false,
      });
      return;
    }

    // OKN sawtooth on x.
    const cycle = PURSUIT_MS + SACCADE_MS;
    const phase = ms % cycle;
    let x: number;
    if (phase < PURSUIT_MS) {
      // slow pursuit, left -> right
      const f = phase / PURSUIT_MS;
      x = X_MIN + (X_MAX - X_MIN) * f;
    } else {
      // fast saccade, right -> left
      const f = (phase - PURSUIT_MS) / SACCADE_MS;
      x = X_MAX - (X_MAX - X_MIN) * f;
    }
    x = clamp01(x + (Math.random() - 0.5) * 0.004);
    const y = clamp01(0.5 + Math.sin(t * 1.3) * 0.02 + (Math.random() - 0.5) * 0.006);

    const pupil = PUPIL_BASE + Math.sin(t * 0.5) * 0.35 + (Math.random() - 0.5) * 0.05;

    this.emitGaze({
      t,
      gaze2d: [x, y],
      gaze3d: null,
      pupilLeft: +(pupil - 0.05).toFixed(3),
      pupilRight: +(pupil + 0.05).toFixed(3),
      eyeLeftValid: true,
      eyeRightValid: true,
    });
  }

  private emitGaze(s: GazeSample) {
    this.gazeSubs.forEach((cb) => cb(s));
  }

  // Scrolling vertical stripes -> MediaStream, simulating the OKN stimulus.
  private startSceneStream() {
    const w = 1280;
    const h = 720;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    this.sceneCanvas = canvas;

    const stripeW = 80;
    const draw = () => {
      const t = (performance.now() - this.startMs) / 1000;
      const offset = (t * 90) % (stripeW * 2); // px/s scroll
      for (let i = -1; i * stripeW < w + stripeW * 2; i++) {
        const sx = i * stripeW * 2 + offset;
        ctx.fillStyle = "#0b0e0c";
        ctx.fillRect(sx, 0, stripeW, h);
        ctx.fillStyle = "#1c241e";
        ctx.fillRect(sx + stripeW, 0, stripeW, h);
      }
      this.drawEye();
      this.rafId = requestAnimationFrame(draw);
    };
    draw();

    // 30 fps capture is plenty for a mock backdrop.
    this.sceneStream = canvas.captureStream(30);

    // Synthetic eye composite: 2×2 grid of IR-style eye tiles, drawn each
    // frame inside the same RAF as the scene.
    const eye = document.createElement("canvas");
    eye.width = 640;
    eye.height = 480;
    this.eyeCanvas = eye;
    this.eyeStream = eye.captureStream(30);
  }

  // Current OKN x-phase, reused by the eye composite so the irises track the
  // same sawtooth the gaze samples follow.
  private currentGazeX(ms: number): number {
    const cycle = PURSUIT_MS + SACCADE_MS;
    const phase = ms % cycle;
    if (phase < PURSUIT_MS) {
      return X_MIN + (X_MAX - X_MIN) * (phase / PURSUIT_MS);
    }
    return X_MAX - (X_MAX - X_MIN) * ((phase - PURSUIT_MS) / SACCADE_MS);
  }

  private drawEye() {
    const ctx = this.eyeCanvas?.getContext("2d");
    if (!ctx || !this.eyeCanvas) return;
    const ms = performance.now() - this.startMs;
    const blinking = ms % BLINK_EVERY_MS < BLINK_MS;
    const gx = this.currentGazeX(ms);
    const tw = this.eyeCanvas.width / 2;
    const th = this.eyeCanvas.height / 2;
    // variant offsets the iris a touch so the two tiles per eye read as two
    // distinct angles rather than identical copies.
    this.drawEyeTile(ctx, 0, 0, tw, th, gx, blinking, 0);
    this.drawEyeTile(ctx, tw, 0, tw, th, gx, blinking, 1);
    this.drawEyeTile(ctx, 0, th, tw, th, gx, blinking, 0);
    this.drawEyeTile(ctx, tw, th, tw, th, gx, blinking, 1);
  }

  private drawEyeTile(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    gx: number,
    blinking: boolean,
    variant: 0 | 1
  ) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = "#262626";
    ctx.fillRect(x, y, w, h);

    const cx = x + w / 2;
    const cy = y + h / 2;
    if (blinking) {
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#555";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x + w * 0.18, cy);
      ctx.lineTo(x + w * 0.82, cy);
      ctx.stroke();
      ctx.restore();
      return;
    }

    // sclera
    ctx.fillStyle = "#9c9c9c";
    ctx.beginPath();
    ctx.ellipse(cx, cy, w * 0.34, h * 0.26, 0, 0, Math.PI * 2);
    ctx.fill();

    const irisX = cx + (gx - 0.5) * w * 0.3 + (variant ? 7 : -7);
    ctx.fillStyle = "#3a3a3a";
    ctx.beginPath();
    ctx.arc(irisX, cy, h * 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0e0e0e";
    ctx.beginPath();
    ctx.arc(irisX, cy, h * 0.09, 0, Math.PI * 2);
    ctx.fill();

    // IR glints
    ctx.fillStyle = "#fff";
    for (const [dx, dy] of [
      [-6, -4],
      [6, -4],
      [-4, 6],
      [5, 6],
    ]) {
      ctx.beginPath();
      ctx.arc(irisX + dx, cy + dy, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
