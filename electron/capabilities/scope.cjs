"use strict";

/**
 * Scope helpers for capability execution boundaries.
 *
 * Concrete scope implementations (chat-scoped, public-exposure, global) will
 * live with their bridges. This module defines shared validation helpers.
 */

function createScopeError(code, message) {
  return { ok: false, code, error: message };
}

function validateSessionInList(sessionId, allowedSessionIds) {
  if (!sessionId) {
    return createScopeError("SESSION_REQUIRED", "sessionId is required.");
  }
  if (!Array.isArray(allowedSessionIds)) {
    return createScopeError("SCOPE_UNAVAILABLE", "Session scope is unavailable.");
  }
  if (allowedSessionIds.length === 0) {
    return createScopeError("SESSION_NOT_IN_SCOPE", "No sessions are available in the current scope.");
  }
  if (!allowedSessionIds.includes(sessionId)) {
    return createScopeError("SESSION_NOT_IN_SCOPE", `Session "${sessionId}" is not in the current scope.`);
  }
  return { ok: true };
}

function intersectSessionIds(primaryIds, secondaryIds) {
  if (!Array.isArray(primaryIds)) return Array.isArray(secondaryIds) ? [...secondaryIds] : null;
  if (!Array.isArray(secondaryIds)) return [...primaryIds];
  const secondary = new Set(secondaryIds);
  return primaryIds.filter((sessionId) => secondary.has(sessionId));
}

module.exports = {
  createScopeError,
  validateSessionInList,
  intersectSessionIds,
};
