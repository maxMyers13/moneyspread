// One-shot reachability check. Hits a documented read-only property
// (system.recording-unit-serial, docs §3.4.1) so a 200 + JSON-string body
// confirms the glasses are alive, the proxy works, and (if direct is set)
// whether the browser can reach the device without going through the proxy.

import { logger } from "./logger";

export interface ProbeLeg {
  url: string;
  ok: boolean;
  status: number; // 0 == network/CORS/DNS failure before we got a response
  body: string;
  ms: number;
  error?: string;
}

export interface ProbeResult {
  proxy: ProbeLeg | null;
  direct: ProbeLeg | null;
  serial: string | null;
  /** True iff at least one leg returned 200 with a non-empty body. */
  reachable: boolean;
  /** Inferred from the legs. "needed" if proxy ok and direct failed. */
  proxyNeeded: "needed" | "not-needed" | "unknown";
}

async function fetchSerial(label: string, url: string): Promise<ProbeLeg> {
  const t0 = performance.now();
  const fullUrl = `${url.replace(/\/$/, "")}/rest/system.recording-unit-serial`;
  logger.info("probe", `${label}: GET ${fullUrl}`);
  try {
    const r = await fetch(fullUrl, {
      method: "GET",
      headers: { Accept: "application/json, text/plain, */*" },
      cache: "no-store",
    });
    const body = await r.text();
    const ms = Math.round(performance.now() - t0);
    const ok = r.ok && body.trim().length > 0;
    const leg: ProbeLeg = { url: fullUrl, ok, status: r.status, body: body.trim(), ms };
    (ok ? logger.info : logger.warn).call(
      logger,
      "probe",
      `${label}: HTTP ${r.status} in ${ms}ms`,
      { body: body.trim().slice(0, 200) }
    );
    return leg;
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    const error = e instanceof Error ? e.message : String(e);
    logger.error("probe", `${label}: fetch threw after ${ms}ms`, {
      error,
      kind:
        error.includes("CORS") || error.includes("opaque")
          ? "likely-cors"
          : error.includes("Failed to fetch") || error.includes("NetworkError")
          ? "likely-network-or-dns"
          : "other",
    });
    return { url: fullUrl, ok: false, status: 0, body: "", ms, error };
  }
}

/** Probe via both the proxied base and (if configured) the direct hostname. */
export async function probeGlasses(opts: {
  proxyBase: string;
  directBase: string;
}): Promise<ProbeResult> {
  logger.info("probe", "starting reachability probe", {
    proxyBase: opts.proxyBase || "(unset)",
    directBase: opts.directBase || "(unset)",
  });
  const [proxy, direct] = await Promise.all([
    opts.proxyBase ? fetchSerial("proxy", opts.proxyBase) : Promise.resolve(null),
    opts.directBase ? fetchSerial("direct", opts.directBase) : Promise.resolve(null),
  ]);

  const serial =
    (proxy?.ok ? stripQuotes(proxy.body) : null) ??
    (direct?.ok ? stripQuotes(direct.body) : null);

  let proxyNeeded: ProbeResult["proxyNeeded"] = "unknown";
  if (proxy && direct) {
    if (proxy.ok && !direct.ok) proxyNeeded = "needed";
    else if (direct.ok) proxyNeeded = "not-needed";
  }

  const result: ProbeResult = {
    proxy,
    direct,
    serial,
    reachable: !!serial,
    proxyNeeded,
  };
  (result.reachable ? logger.info : logger.error).call(
    logger,
    "probe",
    result.reachable
      ? `glasses reachable — serial ${result.serial}`
      : "glasses NOT reachable",
    { proxyNeeded: result.proxyNeeded }
  );
  return result;
}

function stripQuotes(s: string): string {
  // The REST API returns the property value as a JSON string, e.g. "TG03B-...".
  // Strip surrounding double-quotes if present; tolerate raw strings too.
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}
