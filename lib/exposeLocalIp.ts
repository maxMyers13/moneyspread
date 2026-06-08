// Browser quirk workaround. Chrome (and other browsers using the WebRTC
// mDNS-anonymization privacy mitigation) wraps host ICE candidates as
// `<uuid>.local` hostnames instead of the real LAN IP. The Tobii recording
// unit's WebRTC stack resolves these via mDNS at ICE-pairing time, but the
// resolution goes stale ~25s later and consent-freshness checks then fail —
// disconnecting media even though the API/WebSocket layer is fine.
//
// Workaround: if the origin holds persistent getUserMedia permission for
// mic OR camera, Chrome considers the user has accepted some privacy loss
// and stops anonymizing local IPs. So we ask the user for mic permission
// once (we never read audio data — we stop the track immediately) and rely
// on Chrome to expose real IPs for all subsequent peer connections.
//
// This is per-origin / per-browser-profile and persists until the user
// revokes it. We remember the outcome in localStorage so we don't pester.

import { logger } from "./logger";

const STORAGE_KEY = "g3.localIpExposureRequested";

export type LocalIpExposureStatus =
  | "unknown" // never asked
  | "granted" // user accepted; mDNS bypassed
  | "denied" // user said no; mDNS still anonymizing
  | "unavailable"; // no mediaDevices.getUserMedia (e.g., insecure context)

export function getStoredExposureStatus(): LocalIpExposureStatus {
  if (typeof window === "undefined") return "unknown";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "granted" || v === "denied" || v === "unavailable") return v;
  } catch {
    /* localStorage may be blocked */
  }
  return "unknown";
}

function setStoredExposureStatus(s: LocalIpExposureStatus): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, s);
  } catch {
    /* ignore */
  }
}

/**
 * Trigger Chrome's "user-granted media permission" code path so subsequent
 * RTCPeerConnections expose real LAN IPs instead of mDNS hostnames. We open
 * the audio track for a single tick and immediately stop it — we never
 * actually consume audio.
 *
 * Returns the resulting status. Idempotent: if already granted, no prompt.
 */
export async function requestLocalIpExposure(): Promise<LocalIpExposureStatus> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    logger.warn("ip-exposure", "getUserMedia unavailable");
    setStoredExposureStatus("unavailable");
    return "unavailable";
  }
  logger.info("ip-exposure", "requesting mic permission to bypass WebRTC mDNS anonymization");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    // We don't need the audio — release the device immediately.
    for (const t of stream.getTracks()) t.stop();
    logger.info("ip-exposure", "permission granted — future ICE candidates will use real LAN IP");
    setStoredExposureStatus("granted");
    return "granted";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn("ip-exposure", `permission denied or failed: ${msg}`);
    setStoredExposureStatus("denied");
    return "denied";
  }
}
