/**
 * Correlate overlapping terminal starts that share one UI sessionId.
 * A higher bootEpoch owns the registry slot; mismatched closes are no-ops.
 */

const pendingBootAborts = new Map();
const latestBootEpochs = new Map();

function normalizeBootEpoch(bootEpoch) {
  if (!Number.isFinite(bootEpoch)) return undefined;
  return Number(bootEpoch);
}

function attachBootEpoch(session, bootEpoch) {
  const normalized = normalizeBootEpoch(bootEpoch);
  if (normalized === undefined || !session || typeof session !== "object") return session;
  session.bootEpoch = normalized;
  return session;
}

/**
 * Register an AbortController for an in-flight start that has not yet claimed
 * the sessions registry (e.g. SSH passphrase prompts before shell open).
 * A newer register for the same sessionId aborts the older controller.
 */
function registerPendingBootAbort(sessionId, bootEpoch) {
  if (!sessionId) return new AbortController();
  const existing = pendingBootAborts.get(sessionId);
  if (existing) {
    try { existing.controller.abort(); } catch { /* ignore */ }
  }
  const controller = new AbortController();
  const normalized = normalizeBootEpoch(bootEpoch);
  if (normalized !== undefined) {
    latestBootEpochs.set(sessionId, Math.max(latestBootEpochs.get(sessionId) ?? normalized, normalized));
  }
  pendingBootAborts.set(sessionId, {
    controller,
    bootEpoch: normalized,
  });
  return controller;
}

/**
 * Abort a pending boot. When bootEpoch is provided, only abort if the pending
 * entry is not newer than that epoch (so a stale close cannot kill a reconnect).
 */
function abortPendingBoot(sessionId, bootEpoch) {
  if (!sessionId) return false;
  const pending = pendingBootAborts.get(sessionId);
  if (!pending) return false;
  const requested = normalizeBootEpoch(bootEpoch);
  if (
    requested !== undefined
    && pending.bootEpoch !== undefined
    && pending.bootEpoch > requested
  ) {
    return false;
  }
  try { pending.controller.abort(); } catch { /* ignore */ }
  if (pendingBootAborts.get(sessionId) === pending) {
    pendingBootAborts.delete(sessionId);
  }
  return true;
}

function hasPendingBootAfter(sessionId, bootEpoch) {
  if (!sessionId) return false;
  const pending = pendingBootAborts.get(sessionId);
  const requested = normalizeBootEpoch(bootEpoch);
  return Boolean(
    pending
    && requested !== undefined
    && pending.bootEpoch !== undefined
    && pending.bootEpoch > requested
  );
}

function hasNewerBootEpoch(sessionId, bootEpoch) {
  if (!sessionId) return false;
  const requested = normalizeBootEpoch(bootEpoch);
  const latest = latestBootEpochs.get(sessionId);
  return requested !== undefined && latest !== undefined && latest > requested;
}

function forgetBootEpoch(sessionId, bootEpoch) {
  if (!sessionId) return;
  const requested = normalizeBootEpoch(bootEpoch);
  const latest = latestBootEpochs.get(sessionId);
  if (requested === undefined || latest === undefined || latest <= requested) {
    latestBootEpochs.delete(sessionId);
  }
}

function clearPendingBootAbort(sessionId, controller) {
  if (!sessionId || !controller) return;
  const pending = pendingBootAborts.get(sessionId);
  if (pending?.controller === controller) {
    pendingBootAborts.delete(sessionId);
  }
}

/**
 * Best-effort teardown for a session object that lost its registry slot to a
 * newer bootEpoch. Must not look the session up by ID (the map already points
 * at the replacement).
 *
 * @param {object} session
 * @param {string} [sessionId] Registry key the displaced session previously owned.
 */
function disposeDisplacedSessionResources(session, sessionId) {
  if (!session || session._displacedDisposed) return;
  session._displacedDisposed = true;
  try { session.zmodemSentry?.cancel?.(); } catch { /* ignore */ }
  // A displaced auto-login detector's expiry timer must not fire: its
  // onIncomplete callback would otherwise report against the replacement
  // session that now owns the registry slot.
  try { session.autoLogin?.cancel?.(); } catch { /* ignore */ }
  try { session.discardPendingData?.(); } catch { /* ignore */ }
  try { session.releaseTelnetGeneration?.(); } catch { /* ignore */ }
  // Exit handlers for Mosh/ET/serial bail out once the registry no longer
  // points at them, so they never stop their own log stream. Stop it here
  // before a replacement (possibly without logging) keeps appendData-ing
  // into the displaced file. Claim runs before the replacement starts its
  // own stream, so a token-less stop still targets this boot's entry.
  if (sessionId) {
    try {
      const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");
      const logToken = session.logStreamToken ?? session._logStreamToken;
      void sessionLogStreamManager.stopStream(sessionId, logToken);
    } catch { /* ignore */ }
  }
  try {
    if (session.stream) {
      try { session.stream.close(); } catch { /* ignore */ }
      if (session.connRef) {
        try {
          const { releaseConnectionRef } = require("./sshConnectionPool.cjs");
          releaseConnectionRef(session);
        } catch {
          try { session.conn?.end?.(); } catch { /* ignore */ }
        }
      } else {
        try { session.conn?.end?.(); } catch { /* ignore */ }
        for (const hop of session.chainConnections || []) {
          try { hop.end?.(); } catch { /* ignore */ }
        }
      }
    } else if (session.proc) {
      try { session.proc.kill(); } catch { /* ignore */ }
      try { session.moshStatsConn?.end?.(); } catch { /* ignore */ }
      try { session.etStatsConn?.end?.(); } catch { /* ignore */ }
      // ET stores private HOME/key/askpass paths on the session; normal close
      // and owning-exit handlers clean them, but displaced owners skip those
      // paths once the registry slot is overwritten.
      if (Array.isArray(session.externalAuthArtifacts) && !session.externalAuthArtifactsCleaned) {
        session.externalAuthArtifactsCleaned = true;
        const fs = require("node:fs");
        for (const artifactPath of session.externalAuthArtifacts) {
          try {
            fs.rmSync(artifactPath, { recursive: true, force: true });
          } catch {
            // ignore cleanup failures
          }
        }
      }
    } else if (session.socket) {
      try { session.socket.destroy(); } catch { /* ignore */ }
    } else if (session.serialPort) {
      try { session.serialPort.close(); } catch { /* ignore */ }
    } else if (session.chainConnections) {
      for (const hop of session.chainConnections) {
        try { hop.end?.(); } catch { /* ignore */ }
      }
    }
  } catch {
    // Best effort only.
  }
}

/**
 * @returns {{ ok: true, displaced?: object } | { ok: false, reason: "superseded" }}
 */
function claimSessionSlot(sessions, sessionId, session, bootEpoch) {
  if (!sessions || typeof sessions.get !== "function" || typeof sessions.set !== "function") {
    return { ok: true };
  }
  const normalized = normalizeBootEpoch(bootEpoch);
  const existing = sessions.get(sessionId);
  if (
    existing
    && existing !== session
    && Number.isFinite(existing.bootEpoch)
    && normalized !== undefined
    && normalized < existing.bootEpoch
  ) {
    return { ok: false, reason: "superseded" };
  }
  if (normalized !== undefined) {
    session.bootEpoch = normalized;
    latestBootEpochs.set(sessionId, Math.max(latestBootEpochs.get(sessionId) ?? normalized, normalized));
  }
  let displaced;
  // When a newer boot replaces an older registry entry, mark and return the
  // old object so the caller can tear down its transport without touching the
  // replacement slot.
  if (
    existing
    && existing !== session
    && Number.isFinite(existing.bootEpoch)
    && normalized !== undefined
    && normalized > existing.bootEpoch
  ) {
    existing.supersededByBootEpoch = normalized;
    existing.closed = true;
    displaced = existing;
  }
  sessions.set(sessionId, session);
  if (displaced) {
    disposeDisplacedSessionResources(displaced, sessionId);
  }
  return displaced ? { ok: true, displaced } : { ok: true };
}

function sessionMatchesBootEpoch(session, bootEpoch) {
  const normalized = normalizeBootEpoch(bootEpoch);
  if (normalized === undefined) return true;
  if (!session || !Number.isFinite(session.bootEpoch)) return true;
  return session.bootEpoch === normalized;
}

module.exports = {
  abortPendingBoot,
  attachBootEpoch,
  claimSessionSlot,
  clearPendingBootAbort,
  disposeDisplacedSessionResources,
  forgetBootEpoch,
  hasPendingBootAfter,
  hasNewerBootEpoch,
  normalizeBootEpoch,
  registerPendingBootAbort,
  sessionMatchesBootEpoch,
};
