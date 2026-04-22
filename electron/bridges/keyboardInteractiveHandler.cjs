/**
 * Keyboard Interactive Handler - Shared state for keyboard-interactive authentication
 * This module provides a centralized storage for keyboard-interactive auth requests
 * used by SSH, SFTP, and Port Forwarding bridges.
 */

// Keyboard-interactive authentication pending requests
// Map of requestId -> { finishCallback, webContentsId, sessionId, createdAt, timeoutId }
const { randomUUID } = require("node:crypto");

const keyboardInteractiveRequests = new Map();

// TTL for abandoned requests (5 minutes)
const REQUEST_TTL_MS = 5 * 60 * 1000;

/**
 * Generate a unique request ID for keyboard-interactive requests
 */
function generateRequestId(prefix = 'ki') {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Store a keyboard-interactive request with TTL cleanup
 */
function storeRequest(requestId, finishCallback, webContentsId, sessionId) {
  // Set up TTL timeout to clean up abandoned requests
  const timeoutId = setTimeout(() => {
    const pending = keyboardInteractiveRequests.get(requestId);
    if (pending) {
      console.warn(`[KeyboardInteractive] Request ${requestId} timed out after ${REQUEST_TTL_MS / 1000}s, cleaning up`);
      keyboardInteractiveRequests.delete(requestId);
      // Call finish with empty responses to abort the authentication
      try {
        pending.finishCallback([]);
      } catch (err) {
        console.warn(`[KeyboardInteractive] Failed to call finishCallback for timed out request:`, err.message);
      }
    }
  }, REQUEST_TTL_MS);

  keyboardInteractiveRequests.set(requestId, {
    finishCallback,
    webContentsId,
    sessionId,
    createdAt: Date.now(),
    timeoutId,
  });
}

/**
 * Handle keyboard-interactive authentication response from renderer
 */
function handleResponse(_event, payload) {
  console.log(`[KeyboardInteractive] handleResponse called with payload:`, JSON.stringify(payload));

  const { requestId, responses, cancelled } = payload;
  const pending = keyboardInteractiveRequests.get(requestId);

  console.log(`[KeyboardInteractive] Looking for request ${requestId}, found:`, !!pending);
  console.log(`[KeyboardInteractive] Current pending requests:`, Array.from(keyboardInteractiveRequests.keys()));

  if (!pending) {
    console.warn(`[KeyboardInteractive] No pending request for ${requestId}`);
    return { success: false, error: 'Request not found' };
  }

  // Clear the TTL timeout since we received a response
  if (pending.timeoutId) {
    clearTimeout(pending.timeoutId);
  }

  keyboardInteractiveRequests.delete(requestId);

  if (cancelled) {
    console.log(`[KeyboardInteractive] Auth cancelled for ${requestId}`);
    pending.finishCallback([]); // Empty responses to cancel
  } else {
    console.log(`[KeyboardInteractive] Auth response received for ${requestId}, responses count:`, responses?.length);
    pending.finishCallback(responses);
  }

  return { success: true };
}

/**
 * Get the requests map (for debugging/testing)
 */
function getRequests() {
  return keyboardInteractiveRequests;
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
  getRequests,
  registerHandler,
};
