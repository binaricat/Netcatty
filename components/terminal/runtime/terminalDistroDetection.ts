import { detectVendorFromSshVersion } from "../../../domain/host";
import { logger } from "../../../lib/logger";
import type { TerminalSessionStartersContext } from "./createTerminalSessionStarters.types";

/**
 * Per-connection token for stale-timer detection. The renderer reuses the
 * same sessionId across reconnects within a tab, so comparing sessionIds
 * cannot distinguish "the current attempt" from "a previous attempt on
 * the same slot". We assign each startSSH call a fresh token object and
 * store it in this module-local map, keyed by sessionId. A timer that
 * was scheduled under an older token will see a different value here and
 * bail out. The map entry for a sessionId is overwritten on each new
 * connect and stays around until the app exits — since there is only one
 * entry per active session, the memory cost is negligible.
 */
const connectionTokensBySessionId = new Map<string, object>();

export const isConnectionTokenCurrent = (sessionId: string, token: object): boolean =>
  connectionTokensBySessionId.get(sessionId) === token;



export const registerConnectionToken = (sessionId: string): object => {
  const connectionToken = {};
  connectionTokensBySessionId.set(sessionId, connectionToken);
  return connectionToken;
};

export const clearConnectionToken = (sessionId: string): void => {
  connectionTokensBySessionId.delete(sessionId);
};

export const runDistroDetection = async (
  ctx: TerminalSessionStartersContext,
  sessionId: string,
  connectionToken: object,
) => {
  // Stale-session guard: the renderer reuses ctx.sessionId across
  // reconnects in the same tab, so comparing sessionIds is not enough.
  // We compare against a per-connection token instead; if a newer
  // connect attempt has run, it will have replaced the token in the
  // module-level map and this check will fail. Repeated after every
  // await because the session can change during an async call.
  const isStillCurrent = () => isConnectionTokenCurrent(sessionId, connectionToken);

  if (!isStillCurrent()) return;

  // Step 1: try to classify from the SSH server identification string
  // captured at handshake time. This is free (no extra channel) and
  // reliably identifies most network-device vendors (Cisco IOS, Huawei
  // VRP, HPE Comware, MikroTik, Fortinet, etc.) so we can skip the
  // POSIX-shell probe entirely for those hosts — which otherwise fails
  // and, on devices like Cisco / Juniper with AAA logging, generates an
  // extra session log entry per connect.
  try {
    if (ctx.terminalBackend.getSessionRemoteInfo && sessionId) {
      const info = await ctx.terminalBackend.getSessionRemoteInfo(sessionId);
      if (!isStillCurrent()) return;
      const vendor = detectVendorFromSshVersion(info?.remoteSshVersion);
      if (vendor) {
        ctx.onOsDetected?.(ctx.host.id, vendor);
        return;
      }
    }
  } catch (err) {
    logger.warn("SSH banner vendor detection failed", err);
  }

  if (!isStillCurrent()) return;

  // Step 2: unknown or generic OpenSSH/Dropbear — fall back to the
  // /etc/os-release probe to pick a distro-specific icon. We deliberately
  // use `getSessionDistroInfo` which runs the probe on the *existing*
  // SSH connection's exec channel instead of spinning up a brand new
  // SSH client the way `execCommand` would. That saves a full handshake
  // round-trip on every connect, and on OpenSSH-fronted network devices
  // that we couldn't identify from the banner (JUNOS, NX-OS, EOS) it
  // avoids one extra AAA session log entry per connect.
  try {
    if (ctx.terminalBackend.getSessionDistroInfo && sessionId) {
      const res = await ctx.terminalBackend.getSessionDistroInfo(sessionId);
      if (!isStillCurrent()) return;
      if (!res?.success) return;
      const data = `${res.stdout || ""}\n${res.stderr || ""}`;
      const idMatch = data.match(/^ID="?([\w-]+)"?$/im);
      const distro = idMatch
        ? idMatch[1]
        : (data.split(/\s+/)[0] || "").toLowerCase();
      if (distro) ctx.onOsDetected?.(ctx.host.id, distro);
    }
  } catch (err) {
    logger.warn("OS probe failed", err);
  }
};

