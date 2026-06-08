"use client";

import { useState } from "react";
import {
  download,
  eventsToCsv,
  useStore,
  type EventKind,
  type SessionEvent,
} from "@/lib/store";

// Tailwind tone per event kind — kept loosely aligned with the canvas hex in
// Timeline.tsx so the two readouts agree at a glance.
const KIND_TONE: Record<EventKind, string> = {
  "stimulus-start": "text-signal",
  "stimulus-stop": "text-signal",
  "direction-change": "text-warn",
  trial: "text-muted",
  note: "text-text",
};

const KIND_LABEL: Record<EventKind, string> = {
  "stimulus-start": "stim ▸",
  "stimulus-stop": "stim ■",
  "direction-change": "dir ⇄",
  trial: "trial",
  note: "note",
};

function MarkBtn({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-text transition hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function EventRow({ e }: { e: SessionEvent }) {
  const removeEvent = useStore((s) => s.removeEvent);
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line/40 py-1 font-mono text-[10px]">
      <span className="tabular-nums text-muted">{e.t.toFixed(2)}s</span>
      <span className={`uppercase tracking-wider ${KIND_TONE[e.kind]}`}>
        {KIND_LABEL[e.kind]}
      </span>
      <span className="text-muted">t{e.trial}</span>
      <span className="flex-1 truncate text-text" title={e.note}>
        {e.note}
      </span>
      <button
        onClick={() => removeEvent(e.id)}
        className="text-muted hover:text-alert"
        title="remove marker"
      >
        ×
      </button>
    </div>
  );
}

export default function EventMarkers() {
  const events = useStore((s) => s.events);
  const trial = useStore((s) => s.trial);
  const markEvent = useStore((s) => s.markEvent);
  const nextTrial = useStore((s) => s.nextTrial);
  const setTrial = useStore((s) => s.setTrial);
  const [note, setNote] = useState("");

  const addNote = () => {
    const text = note.trim();
    if (!text) return;
    markEvent("note", text);
    setNote("");
  };

  const exportCsv = () => {
    if (events.length === 0) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    download(`okn-events-${ts}.csv`, eventsToCsv(events), "text/csv");
  };

  return (
    <div className="space-y-3 rounded-md border border-line bg-panel p-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-signal">
          event markers
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
          {events.length} tagged
        </span>
      </div>

      {/* Marker buttons */}
      <div className="grid grid-cols-2 gap-2">
        <MarkBtn onClick={() => markEvent("stimulus-start")}>stim start</MarkBtn>
        <MarkBtn onClick={() => markEvent("stimulus-stop")}>stim stop</MarkBtn>
        <MarkBtn onClick={() => markEvent("direction-change")}>dir change</MarkBtn>
        <MarkBtn onClick={nextTrial}>next trial ▸</MarkBtn>
      </div>

      {/* Trial control */}
      <label className="flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-widest text-muted">
        <span>trial</span>
        <input
          type="number"
          min={1}
          value={trial}
          onChange={(e) => setTrial(parseInt(e.target.value, 10))}
          className="w-16 rounded border border-line bg-bg/60 px-2 py-0.5 text-right font-mono text-xs text-text accent-signal"
        />
      </label>

      {/* Free-text note */}
      <div className="flex gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addNote();
          }}
          placeholder="note…"
          className="flex-1 rounded border border-line bg-bg/60 px-2 py-1 font-mono text-xs text-text placeholder:text-muted"
        />
        <MarkBtn onClick={addNote} disabled={!note.trim()}>
          add
        </MarkBtn>
      </div>

      {/* Event list (most recent first) */}
      {events.length > 0 && (
        <div className="max-h-44 space-y-0 overflow-auto border-t border-line/40 pt-1">
          {events
            .slice()
            .reverse()
            .map((e) => (
              <EventRow key={e.id} e={e} />
            ))}
        </div>
      )}

      <div className="border-t border-line/40 pt-2">
        <MarkBtn onClick={exportCsv} disabled={events.length === 0}>
          export events csv
        </MarkBtn>
      </div>
    </div>
  );
}
