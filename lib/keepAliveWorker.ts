// Tick generator for the WebRTC keep-alive heartbeat. Lives in a Worker so
// the timer isn't subject to Chrome's background-tab throttling (which
// otherwise pushes the 4 s heartbeat past the glasses' 5 s timeout — docs
// §4.2.1). The worker emits ticks; the main thread is responsible for the
// actual transport (g3api WebSocket, see WebRtcTobiiAdapter).
//
// Earlier revision did the fetch from inside the worker. That consistently
// got HTTP 400 from the device (every other action through the same proxy
// worked), so we moved the send back to the main thread over the already-
// open WebSocket, keeping only the timer here.

interface StartMsg {
  type: "start";
  intervalMs: number;
}
interface StopMsg {
  type: "stop";
}
type InMsg = StartMsg | StopMsg;

export interface TickMsg {
  type: "tick";
  /** Counter that increments every tick — useful for correlating in logs. */
  n: number;
}

export interface WorkerErrorMsg {
  type: "workerError";
  source: "onerror" | "unhandledrejection";
  message: string;
  stack?: string;
}

let timer: ReturnType<typeof setInterval> | null = null;
let counter = 0;

self.addEventListener("message", (e: MessageEvent<InMsg>) => {
  if (e.data.type === "start") {
    if (timer) clearInterval(timer);
    counter = 0;
    const tick = () => {
      counter += 1;
      const msg: TickMsg = { type: "tick", n: counter };
      (self as unknown as Worker).postMessage(msg);
    };
    // Fire one immediately so the first heartbeat doesn't wait an interval.
    tick();
    timer = setInterval(tick, e.data.intervalMs);
  } else if (e.data.type === "stop") {
    if (timer) clearInterval(timer);
    timer = null;
  }
});

self.addEventListener("error", (e) => {
  const msg: WorkerErrorMsg = {
    type: "workerError",
    source: "onerror",
    message: e.message,
    stack: e.error instanceof Error ? e.error.stack : undefined,
  };
  (self as unknown as Worker).postMessage(msg);
});
self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  const reason = e.reason;
  const msg: WorkerErrorMsg = {
    type: "workerError",
    source: "unhandledrejection",
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  };
  (self as unknown as Worker).postMessage(msg);
});

export {};
