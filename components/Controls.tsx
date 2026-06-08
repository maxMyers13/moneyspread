"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { download, recordedToCsv, useStore } from "@/lib/store";
import type { AdapterKind } from "@/lib/adapters/types";
import { G3_BASE, G3_DIRECT } from "@/lib/config";
import { probeGlasses, type ProbeResult } from "@/lib/glassesProbe";
import { formatForCopy, logger, type LogEntry } from "@/lib/logger";
import type { LocalIpExposureStatus } from "@/lib/exposeLocalIp";

function Btn({
  children,
  onClick,
  disabled,
  tone = "default",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "default" | "primary" | "alert";
}) {
  const base =
    "rounded border px-3 py-1.5 font-mono text-xs uppercase tracking-wider transition disabled:opacity-30 disabled:cursor-not-allowed";
  const tones = {
    default: "border-line text-text hover:border-signal hover:text-signal",
    primary: "border-signal bg-signal/10 text-signal hover:bg-signal/20",
    alert: "border-alert bg-alert/10 text-alert hover:bg-alert/20",
  };
  return (
    <button className={`${base} ${tones[tone]}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

function LogPanel() {
  const [entries, setEntries] = useState<LogEntry[]>(() => logger.snapshot());
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const scrollRef = useRef<HTMLPreElement>(null);

  useEffect(() => logger.subscribe(setEntries), []);

  // Auto-scroll to bottom when entries arrive and the panel is open.
  useEffect(() => {
    if (!open || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries, open]);

  const text = useMemo(() => formatForCopy(entries), [entries]);

  const errorCount = useMemo(
    () => entries.filter((e) => e.level === "error").length,
    [entries]
  );
  const warnCount = useMemo(
    () => entries.filter((e) => e.level === "warn").length,
    [entries]
  );

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for older / non-secure-context cases.
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("failed");
      setTimeout(() => setCopyState("idle"), 2000);
    }
  };

  const headerTone =
    errorCount > 0 ? "text-alert" : warnCount > 0 ? "text-warn" : "text-muted";

  return (
    <div className="space-y-2 border-t border-line/40 pt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between font-mono text-[10px] uppercase tracking-widest hover:text-signal"
      >
        <span className={headerTone}>
          logs · {entries.length}
          {errorCount > 0 && ` · ${errorCount} err`}
          {warnCount > 0 && ` · ${warnCount} warn`}
        </span>
        <span className="text-muted">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <>
          <div className="flex gap-2">
            <Btn onClick={copy}>
              {copyState === "copied"
                ? "✓ copied"
                : copyState === "failed"
                ? "copy failed"
                : "copy"}
            </Btn>
            <Btn onClick={() => logger.clear()}>clear</Btn>
          </div>
          <pre
            ref={scrollRef}
            className="max-h-72 overflow-auto whitespace-pre rounded border border-line/60 bg-bg/60 p-2 font-mono text-[10px] leading-snug text-text"
          >
            {text || "(no entries)"}
          </pre>
          <p className="font-mono text-[10px] text-muted">
            Tip: when something fails, hit <span className="text-text">copy</span>{" "}
            and paste the whole blob back.
          </p>
        </>
      )}
    </div>
  );
}

function IpExposureBlock({
  status,
  onRequest,
}: {
  status: LocalIpExposureStatus;
  onRequest: () => void;
}) {
  const tone =
    status === "granted"
      ? "text-signal"
      : status === "denied" || status === "unavailable"
      ? "text-alert"
      : "text-muted";
  const label =
    status === "granted"
      ? "real LAN IP exposed (mic granted)"
      : status === "denied"
      ? "mic denied — staying on mDNS"
      : status === "unavailable"
      ? "getUserMedia unavailable"
      : "mDNS anonymized (default)";
  const hint =
    status === "granted"
      ? "Future connections expose your real IP — the ~25s mDNS-stale drop should be gone."
      : status === "denied"
      ? "Reconnect needed if you change your mind."
      : "Chrome anonymizes your LAN IP in WebRTC. Granting mic permission (we don't use audio) unlocks real IPs.";
  return (
    <div className="space-y-1 rounded border border-line/60 bg-bg/40 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className={`font-mono text-[10px] uppercase tracking-widest ${tone}`}>
          {label}
        </span>
        {status !== "granted" && status !== "unavailable" && (
          <Btn onClick={onRequest}>grant mic</Btn>
        )}
      </div>
      <div className="font-mono text-[10px] text-muted">{hint}</div>
    </div>
  );
}

function ProbeReadout({ r }: { r: ProbeResult }) {
  const leg = (label: string, l: ProbeResult["proxy"]) => {
    if (!l) return null;
    const tone = l.ok ? "text-signal" : "text-alert";
    const statusTxt =
      l.status === 0 ? l.error ?? "no response" : `HTTP ${l.status}`;
    return (
      <div className="flex justify-between gap-2 font-mono text-[10px]">
        <span className="text-muted">{label}</span>
        <span className={`truncate ${tone}`} title={l.url}>
          {statusTxt} · {l.ms}ms
        </span>
      </div>
    );
  };
  const verdict = r.reachable
    ? `serial: ${r.serial ?? "?"}`
    : "unreachable — see legs below";
  const proxyHint =
    r.proxyNeeded === "needed"
      ? "proxy is required (direct blocked by CORS or unreachable)"
      : r.proxyNeeded === "not-needed"
      ? "direct works — proxy optional"
      : null;
  return (
    <div className="space-y-1 rounded border border-line/60 bg-bg/40 p-2">
      <div
        className={`font-mono text-[11px] ${
          r.reachable ? "text-signal" : "text-alert"
        }`}
      >
        {verdict}
      </div>
      {leg("proxy", r.proxy)}
      {leg("direct", r.direct)}
      {proxyHint && (
        <div className="font-mono text-[10px] text-muted">{proxyHint}</div>
      )}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <div className="flex justify-between font-mono text-[10px] uppercase tracking-widest text-muted">
        <span>{label}</span>
        <span className="text-text">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="mt-1 w-full accent-signal"
      />
    </label>
  );
}

export default function Controls({
  connected,
  recording,
  adapterKind,
  onConnect,
  onDisconnect,
  onCalibrate,
  onToggleRecord,
  onPickAdapter,
  autoReconnect,
  onToggleAutoReconnect,
  ipExposureStatus,
  onRequestIpExposure,
  disabledForReplay = false,
}: {
  connected: boolean;
  recording: boolean;
  adapterKind: AdapterKind;
  onConnect: () => void;
  onDisconnect: () => void;
  onCalibrate: () => void;
  onToggleRecord: () => void;
  onPickAdapter: (k: AdapterKind) => void;
  autoReconnect: boolean;
  onToggleAutoReconnect: (v: boolean) => void;
  ipExposureStatus: LocalIpExposureStatus;
  onRequestIpExposure: () => void;
  /** When true, all live-source controls are disabled — page is in replay
   * mode and shouldn't be juggling a live connection alongside. */
  disabledForReplay?: boolean;
}) {
  const cfg = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const [calibrating, setCalibrating] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  const doProbe = async () => {
    setProbing(true);
    setProbe(null);
    try {
      const r = await probeGlasses({ proxyBase: G3_BASE, directBase: G3_DIRECT });
      setProbe(r);
    } finally {
      setProbing(false);
    }
  };

  const doExport = (kind: "csv" | "json") => {
    const rows = useStore.getState().recorded;
    if (rows.length === 0) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    if (kind === "csv") {
      download(`okn-session-${ts}.csv`, recordedToCsv(rows), "text/csv");
    } else {
      download(
        `okn-session-${ts}.json`,
        JSON.stringify(rows, null, 2),
        "application/json"
      );
    }
  };

  return (
    <div className="space-y-4 rounded-md border border-line bg-panel p-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-signal">
        controls
      </div>

      {/* Source */}
      <div>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted">
          source
        </div>
        <div className="flex gap-2">
          {(["mock", "webrtc"] as AdapterKind[]).map((k) => (
            <button
              key={k}
              disabled={connected}
              onClick={() => onPickAdapter(k)}
              className={`flex-1 rounded border px-2 py-1 font-mono text-xs uppercase ${
                adapterKind === k
                  ? "border-signal bg-signal/10 text-signal"
                  : "border-line text-muted"
              } disabled:opacity-40`}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      {/* Reachability probe (webrtc only) */}
      {adapterKind === "webrtc" && (
        <div className="space-y-2 border-t border-line/40 pt-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
              reachability
            </span>
            <Btn disabled={probing} onClick={doProbe}>
              {probing ? "..." : "probe glasses"}
            </Btn>
          </div>
          {probe && <ProbeReadout r={probe} />}
        </div>
      )}

      {/* Stability — workarounds for the ~25s mDNS-stale disconnect */}
      {adapterKind === "webrtc" && (
        <div className="space-y-2 border-t border-line/40 pt-3">
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted">
            stability
          </div>
          <label className="flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-widest text-muted">
            <span>auto-reconnect on failure</span>
            <input
              type="checkbox"
              checked={autoReconnect}
              onChange={(e) => onToggleAutoReconnect(e.target.checked)}
              className="accent-signal"
            />
          </label>
          <IpExposureBlock
            status={ipExposureStatus}
            onRequest={onRequestIpExposure}
          />
        </div>
      )}

      {/* Connection + session */}
      <div className="flex flex-wrap gap-2">
        {!connected ? (
          <Btn tone="primary" onClick={onConnect} disabled={disabledForReplay}>
            connect
          </Btn>
        ) : (
          <Btn onClick={onDisconnect} disabled={disabledForReplay}>
            disconnect
          </Btn>
        )}
        <Btn
          disabled={!connected || calibrating || disabledForReplay}
          onClick={async () => {
            setCalibrating(true);
            await Promise.resolve(onCalibrate());
            setTimeout(() => setCalibrating(false), 700);
          }}
        >
          {calibrating ? "..." : "calibrate"}
        </Btn>
        <Btn
          tone={recording ? "alert" : "default"}
          disabled={!connected || disabledForReplay}
          onClick={onToggleRecord}
        >
          {recording ? "■ stop" : "● record"}
        </Btn>
      </div>

      {/* Overlay settings */}
      <div className="space-y-3 border-t border-line/40 pt-3">
        <label className="flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-muted">
          <span>reference line</span>
          <input
            type="checkbox"
            checked={cfg.showLine}
            onChange={(e) => setSetting("showLine", e.target.checked)}
            className="accent-signal"
          />
        </label>
        <Slider
          label="line y"
          value={+cfg.lineY.toFixed(3)}
          min={0}
          max={1}
          step={0.005}
          onChange={(v) => setSetting("lineY", v)}
        />
        <Slider
          label="smoothing α"
          value={cfg.smoothingAlpha}
          min={0.05}
          max={1}
          step={0.05}
          onChange={(v) => setSetting("smoothingAlpha", v)}
        />
        <Slider
          label="saccade thr (u/s)"
          value={cfg.saccadeThreshold}
          min={0.2}
          max={3}
          step={0.1}
          onChange={(v) => setSetting("saccadeThreshold", v)}
        />
        <label className="flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-muted">
          <span>gaze trail</span>
          <input
            type="checkbox"
            checked={cfg.showTrail}
            onChange={(e) => setSetting("showTrail", e.target.checked)}
            className="accent-signal"
          />
        </label>
      </div>

      {/* Export */}
      <div className="flex gap-2 border-t border-line/40 pt-3">
        <Btn onClick={() => doExport("csv")}>export csv</Btn>
        <Btn onClick={() => doExport("json")}>export json</Btn>
      </div>

      {/* Logs — always available for copy-paste diagnostics */}
      <LogPanel />
    </div>
  );
}
