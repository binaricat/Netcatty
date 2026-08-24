"use strict";

/**
 * Policy for parking an authenticated SSH transport after the last shell
 * closes (ControlPersist-style reuse).
 *
 * Some bastions bind the TCP/SSH connection to the first interactive session.
 * After that session ends they still accept a new session channel, then
 * immediately EOF / exit 0. Netcatty used to treat that as a clean user exit
 * and close the tab (issue #2923, 齐治 TERM-SSHD).
 */

/** How long an idle-park reconnect may wait for a reused shell to stay open. */
const DEFAULT_REUSED_SHELL_LIVENESS_MS = 350;

function normalizeRemoteSshVersion(remoteSshVersion) {
  return String(remoteSshVersion || "").trim().replace(/^SSH-(?:2\.0|1\.99)-/i, "");
}

/**
 * Whether this daemon can host a new interactive shell on a parked transport.
 * Unknown banners return true; those go through a post-open liveness check.
 */
function remoteAllowsIdleParkedShellReuse(remoteSshVersion) {
  const software = normalizeRemoteSshVersion(remoteSshVersion);
  // 齐治 / QiZhi TERM-SSHD: second shell on a parked conn exits in ~130–170ms.
  if (/TERM-SSHD/i.test(software)) return false;
  return true;
}

/**
 * Idle-park reconnects to unknown banners wait briefly to see if the new
 * shell dies immediately. OpenSSH / Dropbear multiplex cleanly and skip it.
 */
function remoteNeedsReusedShellLivenessCheck(remoteSshVersion) {
  if (!remoteAllowsIdleParkedShellReuse(remoteSshVersion)) return true;
  const software = normalizeRemoteSshVersion(remoteSshVersion);
  if (!software) return true;
  if (/^OpenSSH[_-]/i.test(software)) return false;
  if (/^dropbear/i.test(software)) return false;
  return true;
}

/**
 * Idle park is not the only "last shell already left" state. An SFTP or
 * forward lease can keep the transport `live` after the interactive shell
 * returns; `pendingShellReconnectRisk` is recorded in that case. Those
 * reconnects need the same settle check as a parked transport.
 */
function shouldConfirmReusedShellLiveness({
  state,
  pendingShellReconnectRisk,
  remoteSshVersion,
} = {}) {
  if (!remoteNeedsReusedShellLivenessCheck(remoteSshVersion)) return false;
  return state === "idle" || Boolean(pendingShellReconnectRisk);
}

function resolveReusedShellLivenessMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_REUSED_SHELL_LIVENESS_MS;
  return Math.min(5_000, Math.round(n));
}

/**
 * Watch a just-opened reused shell. Resolves `{ alive: false }` if the channel
 * exits/closes before `settleMs`. Buffers stdout so the caller can replay it
 * after wiring the real session handlers.
 */
function waitForReusedShellLiveness(stream, opts = {}) {
  const settleMs = resolveReusedShellLivenessMs(
    opts.settleMs === undefined ? DEFAULT_REUSED_SHELL_LIVENESS_MS : opts.settleMs,
  );
  const schedule = typeof opts.setTimeout === "function" ? opts.setTimeout : setTimeout;
  const cancel = typeof opts.clearTimeout === "function" ? opts.clearTimeout : clearTimeout;

  return new Promise((resolve) => {
    if (!stream || stream.destroyed || stream.closed) {
      resolve({ alive: false, reason: "already-closed", buffered: [] });
      return;
    }

    let settled = false;
    const buffered = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ...result, buffered });
    };

    const onData = (chunk) => {
      buffered.push(chunk);
    };
    const onExit = (code, signal) => {
      finish({ alive: false, reason: "exit", code, signal });
    };
    const onClose = () => {
      finish({ alive: false, reason: "close" });
    };
    const onError = (error) => {
      finish({ alive: false, reason: "error", error });
    };

    stream.on("data", onData);
    stream.on("exit", onExit);
    stream.on("close", onClose);
    stream.on("error", onError);

    const timer = schedule(() => {
      finish({ alive: true, reason: "settle" });
    }, settleMs);

    function cleanup() {
      cancel(timer);
      stream.removeListener("data", onData);
      stream.removeListener("exit", onExit);
      stream.removeListener("close", onClose);
      stream.removeListener("error", onError);
    }
  });
}

module.exports = {
  DEFAULT_REUSED_SHELL_LIVENESS_MS,
  remoteAllowsIdleParkedShellReuse,
  remoteNeedsReusedShellLivenessCheck,
  shouldConfirmReusedShellLiveness,
  resolveReusedShellLivenessMs,
  waitForReusedShellLiveness,
};
