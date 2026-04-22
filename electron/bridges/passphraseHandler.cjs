/**
 * Passphrase Handler - Handles passphrase requests for encrypted SSH keys
 * This module provides a mechanism to request passphrase input from the user
 * when encountering encrypted default SSH keys in ~/.ssh
 */

// Passphrase request pending map
// Map of requestId -> { resolveCallback, rejectCallback, webContentsId, keyPath, createdAt, timeoutId }
const { randomUUID } = require("node:crypto");

const passphraseRequests = new Map();

// TTL for abandoned requests (2 minutes)
const REQUEST_TTL_MS = 2 * 60 * 1000;

/**
 * Generate a unique request ID for passphrase requests
 */
function generateRequestId(prefix = 'pp') {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Request passphrase from user via IPC
 * @param {Object} sender - Electron webContents sender
 * @param {string} keyPath - Path to the encrypted key
 * @param {string} keyName - Name of the key (e.g., id_rsa)
 * @param {string} [hostname] - Optional hostname for context
 * @returns {Promise<{ passphrase?: string, cancelled?: boolean, skipped?: boolean } | null>}
 */
function requestPassphrase(sender, keyPath, keyName, hostname) {
  return new Promise((resolve) => {
    if (!sender || sender.isDestroyed()) {
      console.warn('[Passphrase] Sender is destroyed, cannot request passphrase');
      resolve(null);
      return;
    }
    
    const requestId = generateRequestId();
    
    // Set up TTL timeout to clean up abandoned requests
    const timeoutId = setTimeout(() => {
      const pending = passphraseRequests.get(requestId);
      if (pending) {
        console.warn(`[Passphrase] Request ${requestId} timed out after ${REQUEST_TTL_MS / 1000}s`);
        passphraseRequests.delete(requestId);
        
        // Notify renderer to close the modal
        try {
          if (!sender.isDestroyed()) {
            sender.send('netcatty:passphrase-timeout', { requestId });
          }
        } catch (err) {
          console.warn('[Passphrase] Failed to send timeout notification:', err.message);
        }
        
        resolve(null);
      }
    }, REQUEST_TTL_MS);
    
    passphraseRequests.set(requestId, {
      resolveCallback: resolve,
      webContentsId: sender.id,
      keyPath,
      keyName,
      createdAt: Date.now(),
      timeoutId,
    });
    
    console.log(`[Passphrase] Requesting passphrase for ${keyName} (${requestId})`);
    
    try {
      sender.send('netcatty:passphrase-request', {
        requestId,
        keyPath,
        keyName,
        hostname,
      });
    } catch (err) {
      console.error('[Passphrase] Failed to send passphrase request:', err);
      passphraseRequests.delete(requestId);
      clearTimeout(timeoutId);
      resolve(null);
    }
  });
}

/**
 * Handle passphrase response from renderer
 */
function handleResponse(_event, payload) {
  const { requestId, passphrase, cancelled, skipped } = payload;
  const pending = passphraseRequests.get(requestId);
  
  if (!pending) {
    console.warn(`[Passphrase] No pending request for ${requestId}`);
    return { success: false, error: 'Request not found' };
  }
  
  // Clear the TTL timeout
  if (pending.timeoutId) {
    clearTimeout(pending.timeoutId);
  }
  
  passphraseRequests.delete(requestId);
  
  if (cancelled) {
    // User clicked Cancel - stop the entire passphrase flow
    console.log(`[Passphrase] Request ${requestId} cancelled by user`);
    pending.resolveCallback({ cancelled: true });
  } else if (skipped) {
    // User clicked Skip - skip this key but continue with others
    console.log(`[Passphrase] Request ${requestId} skipped by user`);
    pending.resolveCallback({ skipped: true });
  } else {
    console.log(`[Passphrase] Received passphrase for ${requestId}`);
    pending.resolveCallback({ passphrase: passphrase || null });
  }
  
  return { success: true };
}

/**
 * Register IPC handler for passphrase responses
 */
function registerHandler(ipcMain) {
  ipcMain.handle('netcatty:passphrase:respond', handleResponse);
}

/**
 * Get pending requests (for debugging)
 */
function getRequests() {
  return passphraseRequests;
}

module.exports = {
  generateRequestId,
  requestPassphrase,
  handleResponse,
  registerHandler,
  getRequests,
};
