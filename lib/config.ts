import type { AdapterKind } from "./adapters/types";

export const G3_BASE = process.env.NEXT_PUBLIC_G3_BASE ?? "/g3";

export const G3_DIRECT = process.env.NEXT_PUBLIC_G3_DIRECT ?? "";

// WebSocket base for the g3api sub-protocol. If unset, derive from G3_DIRECT
// by swapping http→ws. Returns "" if neither is configured.
export const G3_WS: string = (() => {
  const explicit = process.env.NEXT_PUBLIC_G3_WS;
  if (explicit) return explicit;
  if (!G3_DIRECT) return "";
  return G3_DIRECT.replace(/^http/i, "ws").replace(/\/$/, "") + "/websocket";
})();

export const START_ADAPTER: AdapterKind =
  (process.env.NEXT_PUBLIC_ADAPTER as AdapterKind) || "mock";
