/**
 * Passphrase Handler - Handles passphrase requests for encrypted SSH keys
 * This module provides a mechanism to request passphrase input from the user
 * when encountering encrypted default SSH keys in ~/.ssh
 */

const { createIpcPromptRegistry } = require("./ipcPromptRegistry.cjs");

// TTL for abandoned requests (2 minutes)
const REQUEST_TTL_MS = 2 * 60 * 1000;

const registry = createIpcPromptRegistry({
  prefix: "pp",
  ttlMs: REQUEST_TTL_MS,
  cancelChannel: "netcatty:passphrase-cancelled",
  logTag: "[Passphrase]",
  notifyBeforeResolve: true,
});

/**
 * Generate a unique request ID for passphrase requests
 */
function generateRequestId(prefix = "pp") {
  return registry.generateRequestId(prefix);
}

function cancelPassphraseRequest(requestId, reason = "cancelled") {
  const cancelled = registry.cancel(requestId, reason, { cancelled: true });
  if (cancelled) {
    console.log(`[Passphrase] Request ${requestId} cancelled by ${reason}`);
  }
  return cancelled;
}

function cancelPassphraseRequestsForSession(sessionId, reason = "session-closed", bootEpoch) {
  if (!sessionId) return 0;
  const requestedEpoch = Number.isFinite(bootEpoch) ? Number(bootEpoch) : undefined;
  return registry.cancelWhere(
    (pending) => {
      if (pending.sessionId !== sessionId) return false;
      // A stale close for an older boot must not cancel a newer reconnect's prompt.
      if (
        requestedEpoch !== undefined
        && Number.isFinite(pending.bootEpoch)
        && pending.bootEpoch > requestedEpoch
      ) {
        return false;
      }
      return true;
    },
    reason,
    { cancelled: true },
    { cancelEntry: cancelPassphraseRequest },
  );
}

/**
 * Request passphrase from user via IPC
 * @param {Object} sender - Electron webContents sender
 * @param {string} keyPath - Path to the encrypted key
 * @param {string} keyName - Name of the key (e.g., id_rsa)
 * @param {string} [hostname] - Optional hostname for context
 * @returns {Promise<{ passphrase?: string, cancelled?: boolean, skipped?: boolean } | null>}
 */
function requestPassphrase(sender, keyPath, keyName, hostname, passphraseInvalid, options = {}) {
  return new Promise((resolve) => {
    if (!sender || sender.isDestroyed()) {
      console.warn("[Passphrase] Sender is destroyed, cannot request passphrase");
      resolve(null);
      return;
    }

    const signal = options?.signal;
    if (signal?.aborted) {
      resolve({ cancelled: true });
      return;
    }

    const requestId = generateRequestId();

    registry.register(
      requestId,
      {
        resolveCallback: resolve,
        sender,
        webContentsId: sender.id,
        keyPath,
        keyName,
        sessionId: typeof options.sessionId === "string" ? options.sessionId : undefined,
        bootEpoch: Number.isFinite(options.bootEpoch) ? Number(options.bootEpoch) : undefined,
      },
      {
        onTimeout: (id) => {
          console.warn(`[Passphrase] Request ${id} timed out after ${REQUEST_TTL_MS / 1000}s`);
          registry.settle(id, null, { channel: "netcatty:passphrase-timeout" });
        },
        signal,
        onAbort: (id) => cancelPassphraseRequest(id, "external-cancel"),
        triggerIfAborted: false,
      },
    );

    console.log(`[Passphrase] Requesting passphrase for ${keyName} (${requestId})`);

    try {
      sender.send("netcatty:passphrase-request", {
        requestId,
        keyPath,
        keyName,
        hostname,
        passphraseInvalid: !!passphraseInvalid,
        ...(typeof options.sessionId === "string" ? { sessionId: options.sessionId } : {}),
        ...(Number.isFinite(options.bootEpoch) ? { bootEpoch: Number(options.bootEpoch) } : {}),
      });
    } catch (err) {
      console.error("[Passphrase] Failed to send passphrase request:", err);
      registry.settle(requestId, null);
    }
  });
}

/**
 * Handle passphrase response from renderer
 */
function handleResponse(_event, payload) {
  const { requestId, passphrase, cancelled, skipped } = payload;
  const verification = registry.verifySender(_event, requestId);

  if (!verification.ok) {
    if (verification.error === "Request not found") {
      console.warn(`[Passphrase] No pending request for ${requestId}`);
    } else {
      console.warn(`[Passphrase] Wrong sender for request ${requestId}`);
    }
    return { success: false, error: verification.error };
  }

  if (cancelled) {
    // User clicked Cancel - stop the entire passphrase flow
    console.log(`[Passphrase] Request ${requestId} cancelled by user`);
    registry.settle(requestId, { cancelled: true });
  } else if (skipped) {
    // User clicked Skip - skip this key but continue with others
    console.log(`[Passphrase] Request ${requestId} skipped by user`);
    registry.settle(requestId, { skipped: true });
  } else {
    console.log(`[Passphrase] Received passphrase for ${requestId}`);
    registry.settle(requestId, { passphrase: passphrase || null });
  }

  return { success: true };
}

/**
 * Register IPC handler for passphrase responses
 */
function registerHandler(ipcMain) {
  ipcMain.handle("netcatty:passphrase:respond", handleResponse);
}

/**
 * Get pending requests (for debugging)
 */
function getRequests() {
  return registry.getMap();
}

module.exports = {
  generateRequestId,
  requestPassphrase,
  cancelPassphraseRequest,
  cancelPassphraseRequestsForSession,
  handleResponse,
  registerHandler,
  getRequests,
};
