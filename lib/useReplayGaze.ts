"use client";

// Drive the store's gaze ingest from a paused/playing replay video.
//
// In live mode, GazeSamples flow from the adapter's onGaze callback. In
// replay mode, we have a pre-recorded gazedata.gz file on the device; this
// hook fetches it through the /g3 proxy, parses it into an in-memory sorted
// array, and feeds samples to the store as video.currentTime advances.
//
// The wire format is the Tobii recording's JSONL:
//   {"type":"gaze","timestamp":0.001,"data":{"gaze2d":[…],"gaze3d":[…],
//     "eyeleft":{"gazeorigin":[…],"gazedirection":[…],"pupildiameter":…},
//     "eyeright":{…}}}
// timestamps are video-relative (zero = first scene frame) so they line up
// 1:1 with video.currentTime — no offset math.
//
// Seek backward → we clear the store's trail/buffers and rewind our index;
// the next rAF tick will fast-forward to the new currentTime. Seek forward
// just advances the index naturally.

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import type { GazeSample } from "@/lib/adapters/types";
import { G3_BASE } from "@/lib/config";
import { logger } from "@/lib/logger";

interface RawGazeLine {
  type?: string;
  timestamp?: number;
  data?: {
    gaze2d?: [number, number] | null;
    gaze3d?: [number, number, number] | null;
    eyeleft?: {
      pupildiameter?: number;
      gazedirection?: [number, number, number];
    };
    eyeright?: {
      pupildiameter?: number;
      gazedirection?: [number, number, number];
    };
  };
}

function parseLine(line: string): GazeSample | null {
  if (!line) return null;
  let obj: RawGazeLine;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (obj.type !== "gaze" || typeof obj.timestamp !== "number") return null;
  const d = obj.data;
  if (!d) return null;
  const left = d.eyeleft;
  const right = d.eyeright;
  return {
    t: obj.timestamp,
    gaze2d:
      Array.isArray(d.gaze2d) && d.gaze2d.length === 2
        ? [d.gaze2d[0], d.gaze2d[1]]
        : null,
    gaze3d: Array.isArray(d.gaze3d)
      ? (d.gaze3d as [number, number, number])
      : null,
    pupilLeft:
      typeof left?.pupildiameter === "number" ? left.pupildiameter : null,
    pupilRight:
      typeof right?.pupildiameter === "number" ? right.pupildiameter : null,
    eyeLeftValid:
      left?.pupildiameter != null || Array.isArray(left?.gazedirection),
    eyeRightValid:
      right?.pupildiameter != null || Array.isArray(right?.gazedirection),
  };
}

export type ReplayLoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; samples: number }
  | { kind: "error"; message: string };

/**
 * Hook into a replay's gaze stream. Fetches gazedata.gz for the given uuid
 * and drives store.ingest off `video.currentTime` via requestAnimationFrame.
 *
 * Pass `uuid=null` to disable (live mode); pass a Ref whose .current is the
 * <video> element once mounted.
 */
export function useReplayGaze(
  uuid: string | null,
  videoRef: React.RefObject<HTMLVideoElement>
): ReplayLoadState {
  const ingest = useStore((s) => s.ingest);
  const clearBuffers = useStore((s) => s.clearBuffers);

  const [state, setState] = useState<ReplayLoadState>({ kind: "idle" });
  const [samples, setSamples] = useState<GazeSample[]>([]);

  // Fetch + parse on uuid change.
  useEffect(() => {
    if (!uuid) {
      setState({ kind: "idle" });
      setSamples([]);
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      const url = `${G3_BASE}/recordings/${encodeURIComponent(
        uuid
      )}/gazedata.gz?use-content-encoding=true`;
      const t0 = performance.now();
      try {
        const r = await fetch(url, {
          headers: { Accept: "text/plain, application/json" },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();
        const lines = text.split("\n");
        const parsed: GazeSample[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const s = parseLine(trimmed);
          if (s) parsed.push(s);
        }
        // Defensive sort (jsonl should already be monotonic per docs §6).
        parsed.sort((a, b) => a.t - b.t);
        if (cancelled) return;
        const ms = Math.round(performance.now() - t0);
        logger.info(
          "replay",
          `loaded gazedata.gz for ${uuid.slice(0, 8)}: ${parsed.length} samples in ${ms}ms`
        );
        setSamples(parsed);
        setState({ kind: "ready", samples: parsed.length });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        logger.error("replay", `gazedata load failed: ${msg}`, { url });
        setState({ kind: "error", message: msg });
        setSamples([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uuid]);

  // Drive ingest off currentTime via rAF.
  const indexRef = useRef(0);
  const lastTimeRef = useRef(-1);

  // Reset on samples change (new recording loaded).
  useEffect(() => {
    indexRef.current = 0;
    lastTimeRef.current = -1;
    clearBuffers();
  }, [samples, clearBuffers]);

  useEffect(() => {
    if (samples.length === 0) return;
    const v = videoRef.current;
    if (!v) return;

    let raf = 0;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      const t = v.currentTime;
      // Seek backward → reset trail/derived + index, then fast-forward.
      if (t + 0.05 < lastTimeRef.current) {
        clearBuffers();
        indexRef.current = 0;
      }
      lastTimeRef.current = t;
      const n = samples.length;
      let i = indexRef.current;
      while (i < n && samples[i].t <= t) {
        ingest(samples[i]);
        i++;
      }
      indexRef.current = i;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [samples, videoRef, ingest, clearBuffers]);

  return useMemo(() => state, [state]);
}
