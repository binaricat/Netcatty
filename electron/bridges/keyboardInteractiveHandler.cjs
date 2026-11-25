/**
 * Keyboard Interactive Handler - Shared state for keyboard-interactive authentication
 * This module provides a centralized storage for keyboard-interactive auth requests
 * used by SSH, SFTP, and Port Forwarding bridges.
 */

const { createIpcPromptRegistry } = require("./ipcPromptRegistry.cjs");

// TTL for abandoned requests (5 minutes)
const REQUEST_TTL_MS = 5 * 60 * 1000;
const CANCEL_CHANNEL = "netcatty:keyboard-interactive-cancelled";

const registry = createIpcPromptRegistry({
  prefix: "ki",
  ttlMs: REQUEST_TTL_MS,
  cancelChannel: CANCEL_CHANNEL,
  logTag: "[KeyboardInteractive]",
  notifyBeforeResolve: false,
  buildCancelPayload: (pending, _requestId, reason) => ({
    sessionId: pending.sessionId,
    reason,
  }),
});

/**
 * Generate a unique request ID for keyboard-interactive requests
 */
function generateRequestId(prefix = "ki") {
  return registry.generateRequestId(prefix);
}

/**
 * Store a keyboard-interactive request with TTL cleanup
 */
function storeRequest(requestId, finishCallback, webContentsId, sessionId, sender) {
  registry.register(
    requestId,
    {
      finishCallback,
      resolveCallback: finishCallback,
      webContentsId,
      sessionId,
      sender,
    },
    {
      onTimeout: (id) => {
        console.warn(`[KeyboardInteractive] Request ${id} timed out after ${REQUEST_TTL_MS / 1000}s, cleaning up`);
        // Call finish with empty responses to abort the authentication before notifying renderer.
        registry.cancel(id, "timeout", [], {
          catchResolveError: true,
          resolveErrorMessage: "Failed to call finishCallback for timed out request:",
        });
      },
    },
  );
}

/**
 * Handle keyboard-interactive authentication response from renderer
 */
function handleResponse(_event, payload) {
  console.log("[KeyboardInteractive] handleResponse called", {
    requestId: payload?.requestId,
    cancelled: Boolean(payload?.cancelled),
    responsesCount: Array.isArray(payload?.responses) ? payload.responses.length : 0,
  });

  const { requestId, responses, cancelled } = payload;
  const requests = registry.getMap();
  const verification = registry.verifySender(_event, requestId);

  console.log(`[KeyboardInteractive] Looking for request ${requestId}, found:`, requests.has(requestId));
  console.log("[KeyboardInteractive] Current pending requests:", Array.from(requests.keys()));

  if (!verification.ok) {
    if (verification.error === "Request not found") {
      console.warn(`[KeyboardInteractive] No pending request for ${requestId}`);
    } else {
      console.warn(`[KeyboardInteractive] Wrong sender for request ${requestId}`);
    }
    return { success: false, error: verification.error };
  }

  const pending = registry.removeEntry(requestId);

  try {
    if (cancelled) {
      console.log(`[KeyboardInteractive] Auth cancelled for ${requestId}`);
      pending.finishCallback([]); // Empty responses to cancel
    } else {
      console.log(`[KeyboardInteractive] Auth response received for ${requestId}, responses count:`, responses?.length);
      pending.finishCallback(responses);
    }
  } catch (err) {
    console.warn(`[KeyboardInteractive] Failed to deliver response for ${requestId}:`, err?.message);
    registry.sendNotification(pending, requestId, {
      channel: CANCEL_CHANNEL,
      payload: {
        sessionId: pending.sessionId,
        reason: "delivery-failed",
      },
    });
    return { success: false, error: "Failed to deliver response" };
  }

  return { success: true };
}

/**
 * Cancel every pending request owned by a session or external operation.
 */
function cancelRequestsForSession(sessionId, reason = "cancelled") {
  return registry.cancelWhere(
    (pending) => pending.sessionId === sessionId,
    reason,
    [],
    {
      catchResolveError: true,
      resolveErrorMessage: "Failed to cancel request:",
    },
  );
}

/**
 * Get the requests map (for debugging/testing)
 */
function getRequests() {
  return registry.getMap();
}

/**
 * Register IPC handler for keyboard-interactive responses
 */
function registerHandler(ipcMain) {
  ipcMain.handle("netcatty:keyboard-interactive:respond", handleResponse);
}

module.exports = {
  generateRequestId,
  storeRequest,
  handleResponse,
  cancelRequestsForSession,
  getRequests,
  registerHandler,
};
