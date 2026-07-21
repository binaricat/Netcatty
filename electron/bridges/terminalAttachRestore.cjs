"use strict";

/**
 * Tiny registry so the terminal popup window can restore output routing after
 * an AI observe/attach popup is closed or destroyed, without creating a
 * windowManager <-> terminalBridge require cycle.
 */

let restoreImpl = null;

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

module.exports = {
  setRestoreAttachedSessionOutput,
  restoreAttachedSessionOutput,
};
