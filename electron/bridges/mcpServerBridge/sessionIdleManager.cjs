"use strict";

// 24h (the normalize clamp maximum). AI/agent-opened sessions are long-lived,
// stateful surfaces (prod DB operations, deployments); a 30-minute silent
// close destroyed more in-flight work than it saved. Users can still set a
// shorter window in Settings → AI.
const DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES = 1440;
const MIN_SESSION_IDLE_TIMEOUT_MINUTES = 1;
const MAX_SESSION_IDLE_TIMEOUT_MINUTES = 24 * 60;

function normalizeSessionIdleTimeoutMinutes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES;
  return Math.min(
    MAX_SESSION_IDLE_TIMEOUT_MINUTES,
    Math.max(MIN_SESSION_IDLE_TIMEOUT_MINUTES, Math.round(parsed)),
  );
}

function createSessionIdleManager(options = {}) {
  const DateImpl = options.Date || Date;
  const setTimeoutImpl = options.setTimeout || setTimeout;
  const clearTimeoutImpl = options.clearTimeout || clearTimeout;
  const onIdle = typeof options.onIdle === "function" ? options.onIdle : async () => {};
  const entries = new Map();
  let timeoutMinutes = normalizeSessionIdleTimeoutMinutes(options.timeoutMinutes);

  function clearTimer(entry) {
    if (entry.timer == null) return;
    clearTimeoutImpl(entry.timer);
    entry.timer = null;
  }

  function schedule(entry) {
    clearTimer(entry);
    if (entry.activeCount > 0 || entry.checking || entry.closing) return;
    const expiresAt = entry.lastActivityAt + timeoutMinutes * 60 * 1000;
    const delay = Math.max(0, expiresAt - DateImpl.now());
    entry.timer = setTimeoutImpl(() => {
      entry.timer = null;
      const current = entries.get(entry.sessionId);
      if (current !== entry || entry.activeCount > 0 || entry.checking || entry.closing) return;
      const latestExpiresAt = entry.lastActivityAt + timeoutMinutes * 60 * 1000;
      if (DateImpl.now() < latestExpiresAt) {
        schedule(entry);
        return;
      }
      entry.checking = true;
      const activityVersion = entry.activityVersion;
      Promise.resolve(onIdle({
        chatSessionId: entry.chatSessionId,
        sessionId: entry.sessionId,
      }, activityVersion)).catch(() => {
        resume(entry.sessionId);
      });
    }, delay);
    entry.timer?.unref?.();
  }

  function track(chatSessionId, sessionId) {
    if (!chatSessionId || !sessionId) return false;
    const existing = entries.get(sessionId);
    if (existing) clearTimer(existing);
    const entry = {
      chatSessionId,
      sessionId,
      lastActivityAt: DateImpl.now(),
      activityVersion: 0,
      activeCount: 0,
      checking: false,
      closing: false,
      timer: null,
    };
    entries.set(sessionId, entry);
    schedule(entry);
    return true;
  }

  function touch(chatSessionId, sessionId) {
    const entry = entries.get(sessionId);
    if (!entry || entry.closing) return false;
    entry.checking = false;
    entry.activityVersion += 1;
    entry.lastActivityAt = DateImpl.now();
    // Keep an existing timer instead of recreating it for every output chunk.
    // Its callback rechecks lastActivityAt and extends the deadline as needed.
    if (entry.timer == null) schedule(entry);
    return true;
  }

  function beginActivity(chatSessionId, sessionId) {
    const entry = entries.get(sessionId);
    if (!entry || entry.closing) return false;
    entry.checking = false;
    entry.activityVersion += 1;
    entry.activeCount += 1;
    entry.lastActivityAt = DateImpl.now();
    clearTimer(entry);
    return true;
  }

  function endActivity(chatSessionId, sessionId) {
    const entry = entries.get(sessionId);
    if (!entry || entry.closing) return false;
    entry.activityVersion += 1;
    entry.activeCount = Math.max(0, entry.activeCount - 1);
    entry.lastActivityAt = DateImpl.now();
    schedule(entry);
    return true;
  }

  function beginClose(sessionId) {
    const entry = entries.get(sessionId);
    if (!entry || entry.closing) return false;
    entry.checking = false;
    entry.closing = true;
    clearTimer(entry);
    return true;
  }

  function beginIdleClose(sessionId, activityVersion) {
    if (!isIdleCheckCurrent(sessionId, activityVersion)) return false;
    return beginClose(sessionId);
  }

  function isIdleCheckCurrent(sessionId, activityVersion) {
    const entry = entries.get(sessionId);
    return Boolean(
      entry
      && entry.checking
      && !entry.closing
      && entry.activeCount === 0
      && entry.activityVersion === activityVersion
    );
  }

  function resume(sessionId) {
    const entry = entries.get(sessionId);
    if (!entry) return false;
    entry.closing = false;
    entry.checking = false;
    entry.activityVersion += 1;
    entry.activeCount = 0;
    entry.lastActivityAt = DateImpl.now();
    schedule(entry);
    return true;
  }

  function forgetSession(sessionId) {
    const entry = entries.get(sessionId);
    if (!entry) return false;
    clearTimer(entry);
    entries.delete(sessionId);
    return true;
  }

  function setTimeoutMinutes(value) {
    timeoutMinutes = normalizeSessionIdleTimeoutMinutes(value);
    for (const entry of entries.values()) schedule(entry);
    return timeoutMinutes;
  }

  function clearAll() {
    for (const entry of entries.values()) clearTimer(entry);
    entries.clear();
  }

  function scopeCleared() {
    // Intentionally keep timers alive. A deleted/interrupted AI scope is one of
    // the cases where the idle fallback is needed most.
  }

  return {
    track,
    touch,
    beginActivity,
    endActivity,
    beginClose,
    beginIdleClose,
    resume,
    forgetSession,
    isTracked: (sessionId) => entries.has(sessionId),
    hasActivity: (sessionId) => Boolean(entries.get(sessionId)?.activeCount),
    isIdleCheckCurrent,
    isClosing: (sessionId) => Boolean(entries.get(sessionId)?.closing),
    setTimeoutMinutes,
    getTimeoutMinutes: () => timeoutMinutes,
    clearAll,
    scopeCleared,
  };
}

module.exports = {
  DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES,
  MIN_SESSION_IDLE_TIMEOUT_MINUTES,
  MAX_SESSION_IDLE_TIMEOUT_MINUTES,
  normalizeSessionIdleTimeoutMinutes,
  createSessionIdleManager,
};
