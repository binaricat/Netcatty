"use strict";

/**
 * Tiny registry so the terminal popup window can restore output routing after
 * an AI observe/attach popup is closed or destroyed, without creating a
 * windowManager <-> terminalBridge require cycle.
 */

let restoreImpl = null;
let attachHomeLookup = null;
let fanoutExitImpl = null;
const attachPopupAuthorizations = new Map();
const pendingAttachRestores = new Set();

function registerAttachPopupAuthorization(token, sessionId, webContentsId) {
  if (!token || !sessionId || typeof webContentsId !== "number") return false;
  attachPopupAuthorizations.set(token, {
    sessionId,
    webContentsId,
    closePrepared: false,
  });
  return true;
}

function validateAttachPopupAuthorization(token, sessionId, webContentsId) {
  if (!token || !sessionId || typeof webContentsId !== "number") return false;
  const grant = attachPopupAuthorizations.get(token);
  return Boolean(
    grant
    && grant.sessionId === sessionId
    && grant.webContentsId === webContentsId,
  );
}

function markAttachPopupClosePrepared(token, sessionId, webContentsId) {
  if (!validateAttachPopupAuthorization(token, sessionId, webContentsId)) return false;
  attachPopupAuthorizations.get(token).closePrepared = true;
  return true;
}

function isAttachPopupClosePrepared(token) {
  return attachPopupAuthorizations.get(token)?.closePrepared === true;
}

function releaseAttachPopupAuthorization(token) {
  if (token) attachPopupAuthorizations.delete(token);
}

function setRestoreAttachedSessionOutput(fn) {
  restoreImpl = typeof fn === "function" ? fn : null;
}

function restoreAttachedSessionOutput(sessionId, preferredHomeWebContentsId = null) {
  if (!sessionId || typeof restoreImpl !== "function") {
    return { success: false, restored: false };
  }
  try {
    const result = restoreImpl(sessionId, preferredHomeWebContentsId) || { success: true, restored: false };
    if (result.success) pendingAttachRestores.delete(sessionId);
    else pendingAttachRestores.add(sessionId);
    return result;
  } catch (err) {
    pendingAttachRestores.add(sessionId);
    return { success: false, restored: false, error: err?.message || String(err) };
  }
}

function retryPendingAttachedSessionOutputs() {
  for (const sessionId of Array.from(pendingAttachRestores)) {
    restoreAttachedSessionOutput(sessionId);
  }
}

function retryPendingAttachedSessionOutput(sessionId, preferredHomeWebContentsId = null) {
  if (!pendingAttachRestores.has(sessionId)) return { success: true, restored: false };
  return restoreAttachedSessionOutput(sessionId, preferredHomeWebContentsId);
}

function setAttachHomeLookup(fn) {
  attachHomeLookup = typeof fn === "function" ? fn : null;
}

function getAttachHomeWebContentsId(sessionId) {
  if (!sessionId || typeof attachHomeLookup !== "function") return null;
  try {
    const id = attachHomeLookup(sessionId);
    return typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

function setFanoutSessionExit(fn) {
  fanoutExitImpl = typeof fn === "function" ? fn : null;
}

function fanoutSessionExit(sessionId, primaryContents, payload) {
  const primaryWebContentsId = typeof primaryContents === "number"
    ? primaryContents
    : primaryContents?.id;
  if (typeof fanoutExitImpl === "function") {
    try {
      fanoutExitImpl(sessionId, primaryWebContentsId, payload);
      return true;
    } catch {
      // fall through
    }
  }
  // Session implementations can run before terminalBridge wires the shared
  // registry. Preserve the original primary-renderer notification then.
  try {
    primaryContents?.send?.("netcatty:exit", payload);
    return typeof primaryContents?.send === "function";
  } catch {
    return false;
  }
}

module.exports = {
  registerAttachPopupAuthorization,
  validateAttachPopupAuthorization,
  markAttachPopupClosePrepared,
  isAttachPopupClosePrepared,
  releaseAttachPopupAuthorization,
  setRestoreAttachedSessionOutput,
  restoreAttachedSessionOutput,
  retryPendingAttachedSessionOutputs,
  retryPendingAttachedSessionOutput,
  setAttachHomeLookup,
  getAttachHomeWebContentsId,
  setFanoutSessionExit,
  fanoutSessionExit,
};
