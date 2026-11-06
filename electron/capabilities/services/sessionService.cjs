"use strict";
const { createSessionRecoveryService } = require("./sessionRecoveryService.cjs");

function createSessionService(ctx = {}) {
  const { invokeSessionAgent, validateClose, beforeClose, afterClose, onClosed } = ctx;
  const incidents = new Map();
  const reconnecting = new Set();
  const now = ctx.now || Date.now;
  const recovery = createSessionRecoveryService({ now, sleep: ctx.sleep,
    validate: ctx.validateReconnect, inspect: ctx.inspectRecovery, reconnect });

  async function reconnect(params = {}, executionContext = {}) {
    if (typeof params.sessionId !== "string" || !params.sessionId.trim()) {
      return { ok: false, error: "sessionId is required." };
    }
    if (typeof ctx.validateReconnect !== "function" || typeof invokeSessionAgent !== "function") {
      return { ok: false, error: "Scoped session reconnect is unavailable." };
    }
    const validation = ctx.validateReconnect(params);
    if (validation?.ok !== true) return validation || { ok: false, error: "Reconnect not authorized." };
    executionContext.beforeExecute?.();
    const timeoutMs = Math.min(5000, (executionContext.deadlineAt ?? now() + 5000) - now());
    if (timeoutMs <= 0) return { ok: false, started: false, code: "RECONNECT_EXPIRED", error: "Reconnect dispatch deadline expired." };
    const id = params.sessionId;
    if (validation.connected === true) {
      incidents.delete(id);
      return { ok: true, sessionId: id, status: "connected", started: false, shellReady: false };
    }
    if (reconnecting.has(id)) return { ok: true, sessionId: id, status: "reconnecting", started: false };
    const time = now();
    const incident = incidents.get(id);
    if (incident && (incident.attempts >= 3 || time - incident.startedAt >= 120000)) {
      return { ok: false, code: "RECONNECT_LIMIT", error: "Recovery budget exhausted. Inspect the session or request user assistance; do not open repeated replacement tabs." };
    }
    if (incident && time < incident.nextAt) {
      return { ok: false, code: "RECONNECT_BACKOFF", retryAfterMs: incident.nextAt - time, error: "Wait before retrying this session." };
    }
    reconnecting.add(id);
    // Reserve before dispatch: a lost reply may still have started a connection.
    const next = { startedAt: incident?.startedAt ?? time, attempts: (incident?.attempts || 0) + 1, nextAt: time + (incident ? 5000 : 2000) };
    incidents.set(id, next);
    try {
      const result = await invokeSessionAgent("session.reconnect", { sessionId: id, expiresAt: now() + timeoutMs }, { timeoutMs });
      const current = ctx.validateReconnect(params);
      if (current?.ok !== true) return current || { ok: false, error: "Reconnect scope was revoked." };
      executionContext.beforeExecute?.();
      if (result?.status === "connected") incidents.delete(id);
      else if (incidents.get(id) === next && result?.started !== true) {
        // Explicit non-dispatch acknowledgement is safe; unknown replies consume an attempt.
        if (result?.started === false) {
          if (incident) incidents.set(id, incident);
          else incidents.delete(id);
        }
      }
      return result;
    } finally {
      reconnecting.delete(id);
    }
  }

  async function close(params = {}, options = {}) {
    if (!params.sessionId || typeof params.sessionId !== "string") {
      return { ok: false, error: "sessionId is required." };
    }
    if (!options.skipValidation && typeof validateClose === "function") {
      const validation = validateClose(params);
      if (validation && validation.ok === false) return validation;
    }
    if (typeof invokeSessionAgent !== "function") {
      return { ok: false, error: "Session close bridge is unavailable." };
    }

    let result;
    let closed = false;
    try {
      await beforeClose?.(params);
      options.beforeExecute?.();
      result = await invokeSessionAgent("session.close", { sessionId: params.sessionId });
      if (result?.ok !== false) {
        await onClosed?.(params.sessionId);
        closed = true;
      }
      return result;
    } finally {
      await afterClose?.(params, {
        closed,
        notFound: /\bwas not found\b/i.test(result?.error || ""),
        result,
      });
    }
  }

  return {
    reconnect,
    recover: recovery.recover,
    forgetRecovery: recovery.forget,
    forgetReconnect: (sessionId) => incidents.delete(sessionId),
    close: (params = {}, executionContext = {}) => close(params, {
      beforeExecute: executionContext.beforeExecute,
    }),
    closeTracked: (params = {}) => close(params, { skipValidation: true }),
  };
}

module.exports = { createSessionService };
