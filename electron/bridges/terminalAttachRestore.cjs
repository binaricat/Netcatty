"use strict";

/**
 * Tiny registry so the terminal popup window can restore output routing after
 * an AI observe/attach popup is closed or destroyed, without creating a
 * windowManager <-> terminalBridge require cycle.
 */

let restoreImpl = null;
let attachHomeLookup = null;
let fanoutExitImpl = null;

function setRestoreAttachedSessionOutput(fn) {
  restoreImpl = typeof fn === "function" ? fn : null;
}

function restoreAttachedSessionOutput(sessionId) {
  if (!sessionId || typeof restoreImpl !== "function") {
    return { success: false, restored: false };
  }
  try {
    return restoreImpl(sessionId) || { success: true, restored: false };
  } catch (err) {
    return { success: false, restored: false, error: err?.message || String(err) };
  }
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

function fanoutSessionExit(sessionId, primaryWebContentsId, payload) {
  if (typeof fanoutExitImpl === "function") {
    try {
      fanoutExitImpl(sessionId, primaryWebContentsId, payload);
      return;
    } catch {
      // fall through
    }
  }
  // Best-effort: at least primary if fanout not wired yet.
  // Callers that only have a contents object should keep using contents.send.
}

module.exports = {
  setRestoreAttachedSessionOutput,
  restoreAttachedSessionOutput,
  setAttachHomeLookup,
  getAttachHomeWebContentsId,
  setFanoutSessionExit,
  fanoutSessionExit,
};
