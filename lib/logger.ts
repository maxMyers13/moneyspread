// Tiny in-memory ring-buffer logger. Every entry is mirrored to console (so
// devtools sees it live) and pushed into a fixed-size buffer the UI can render
// and copy verbatim. Designed for one purpose: when something fails on the
// glasses, the user can hit "copy logs" and paste a single blob that contains
// every signaling step, state transition, and error needed to diagnose it.

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  /** ms since page load (performance.now). */
  t: number;
  /** wall-clock ISO string at time of emit; useful when correlating with the device. */
  iso: string;
  level: LogLevel;
  /** Short tag like "probe" / "adapter" / "ws" / "pc" / "ice". */
  tag: string;
  msg: string;
  /** Anything JSON-serializable. Stored as-is so the console pretty-prints it. */
  data?: unknown;
}

const MAX_ENTRIES = 800;

class Logger {
  private buf: LogEntry[] = [];
  private listeners = new Set<(entries: LogEntry[]) => void>();
  private notifyScheduled = false;

  emit(level: LogLevel, tag: string, msg: string, data?: unknown): void {
    const entry: LogEntry = {
      t: typeof performance !== "undefined" ? performance.now() : 0,
      iso: new Date().toISOString(),
      level,
      tag,
      msg,
      data,
    };
    this.buf.push(entry);
    if (this.buf.length > MAX_ENTRIES) this.buf.shift();

    const prefix = `[g3:${tag}]`;
    if (typeof console !== "undefined") {
      const fn =
        level === "error"
          ? console.error
          : level === "warn"
          ? console.warn
          : console.log;
      if (data !== undefined) fn.call(console, prefix, msg, data);
      else fn.call(console, prefix, msg);
    }

    // Coalesce notifications so high-frequency logs don't thrash React, AND
    // hand subscribers a fresh array reference so React doesn't bail on
    // identity-equal state (this.buf is mutated in place).
    if (!this.notifyScheduled && typeof queueMicrotask === "function") {
      this.notifyScheduled = true;
      queueMicrotask(() => {
        this.notifyScheduled = false;
        const snap = this.buf.slice();
        this.listeners.forEach((l) => l(snap));
      });
    } else if (!this.notifyScheduled) {
      const snap = this.buf.slice();
      this.listeners.forEach((l) => l(snap));
    }
  }

  info(tag: string, msg: string, data?: unknown) {
    this.emit("info", tag, msg, data);
  }
  warn(tag: string, msg: string, data?: unknown) {
    this.emit("warn", tag, msg, data);
  }
  error(tag: string, msg: string, data?: unknown) {
    this.emit("error", tag, msg, data);
  }

  subscribe(fn: (entries: LogEntry[]) => void): () => void {
    this.listeners.add(fn);
    fn(this.buf.slice());
    return () => {
      this.listeners.delete(fn);
    };
  }

  snapshot(): LogEntry[] {
    return this.buf.slice();
  }

  clear(): void {
    this.buf = [];
    const snap: LogEntry[] = [];
    this.listeners.forEach((l) => l(snap));
  }
}

export const logger = new Logger();

// ---------------------------------------------------------------------------
// Global console tap — mirrors browser/React/Next/third-party output into the
// panel so the copy-blob is the single source of truth. We install once per
// page load and guard so the tap can't infinitely recurse with our own emits.
// ---------------------------------------------------------------------------

let consoleTapped = false;
let suppressTap = false;

export function installConsoleTap(): void {
  if (consoleTapped || typeof window === "undefined") return;
  consoleTapped = true;

  const methods: Array<{ name: "log" | "info" | "warn" | "error"; level: LogLevel }> = [
    { name: "log", level: "info" },
    { name: "info", level: "info" },
    { name: "warn", level: "warn" },
    { name: "error", level: "error" },
  ];

  for (const { name, level } of methods) {
    const original = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      original(...args);
      if (suppressTap) return;
      // Don't double-record entries we just emitted ourselves: our prefix
      // starts with "[g3:". Those already landed in the buffer.
      if (typeof args[0] === "string" && args[0].startsWith("[g3:")) return;
      suppressTap = true;
      try {
        const msg = args
          .map((a) => {
            if (typeof a === "string") return a;
            try {
              return JSON.stringify(a);
            } catch {
              return String(a);
            }
          })
          .join(" ")
          .slice(0, 1000);
        logger.emit(level, "console", msg);
      } finally {
        suppressTap = false;
      }
    };
  }

  // Uncaught errors and unhandled rejections — these don't always go through
  // console.error depending on the browser, so hook them directly.
  window.addEventListener("error", (e) => {
    logger.error("window", `uncaught error: ${e.message}`, {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error instanceof Error ? e.error.stack : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    logger.error("window", `unhandled rejection`, {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}

/** Render entries as a single copy-pasteable text blob. */
export function formatForCopy(entries: LogEntry[]): string {
  const header = [
    `# g3 viewer log dump`,
    `# generated: ${new Date().toISOString()}`,
    `# entries: ${entries.length}`,
    typeof navigator !== "undefined" ? `# ua: ${navigator.userAgent}` : "",
    typeof location !== "undefined" ? `# origin: ${location.origin}` : "",
    "",
  ]
    .filter(Boolean)
    .join("\n");

  const lines = entries.map((e) => {
    const ts = (e.t / 1000).toFixed(3).padStart(9, " ");
    const lvl = e.level.toUpperCase().padEnd(5);
    const tag = `[${e.tag}]`.padEnd(10);
    let data = "";
    if (e.data !== undefined && e.data !== null && e.data !== "") {
      try {
        data =
          " " +
          (typeof e.data === "string"
            ? e.data
            : JSON.stringify(e.data, replaceUnserializable));
      } catch {
        data = " [unserializable]";
      }
    }
    return `${ts}s ${lvl} ${tag} ${e.msg}${data}`;
  });

  return header + "\n" + lines.join("\n") + "\n";
}

// Errors and DOM types don't serialize natively — flatten the useful bits.
function replaceUnserializable(_k: string, v: unknown): unknown {
  if (v instanceof Error) {
    return { name: v.name, message: v.message, stack: v.stack };
  }
  return v;
}

/** Compact summary of an ICE candidate SDP string for log output. */
export function summarizeCandidate(candidate: string): string {
  if (!candidate) return "(end-of-candidates)";
  // candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> ...
  const parts = candidate.split(/\s+/);
  const proto = parts[2]?.toLowerCase() ?? "?";
  const address = parts[4] ?? "?";
  const port = parts[5] ?? "?";
  const typIdx = parts.indexOf("typ");
  const typ = typIdx >= 0 ? parts[typIdx + 1] : "?";
  return `${typ} ${proto} ${address}:${port}`;
}

/** Compact summary of an SDP — number of m-lines and their kinds. */
export function summarizeSdp(sdp: string): {
  length: number;
  mlines: Array<{ kind: string; mid: string | null }>;
} {
  const mlines: Array<{ kind: string; mid: string | null }> = [];
  let pendingKind: string | null = null;
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith("m=")) {
      if (pendingKind) mlines.push({ kind: pendingKind, mid: null });
      pendingKind = line.slice(2).split(" ")[0] ?? "?";
    } else if (line.startsWith("a=mid:") && pendingKind) {
      mlines.push({ kind: pendingKind, mid: line.slice(6).trim() });
      pendingKind = null;
    }
  }
  if (pendingKind) mlines.push({ kind: pendingKind, mid: null });
  return { length: sdp.length, mlines };
}
