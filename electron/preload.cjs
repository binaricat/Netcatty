const { ipcRenderer, contextBridge, webUtils } = require("electron");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { createPreloadApi } = require("./preload/api.cjs");

const dataListeners = new Map();
const exitListeners = new Map();
const transferProgressListeners = new Map();
const transferCompleteListeners = new Map();
const transferErrorListeners = new Map();
const transferCancelledListeners = new Map();
const chainProgressListeners = new Map();
const zmodemListeners = new Map();
const zmodemOverwriteListeners = new Map(); // sessionId -> Set<cb>
const sftpConnectionProgressListeners = new Set();
const authFailedListeners = new Map();
const telnetAutoLoginCompleteListeners = new Map();
const telnetAutoLoginCancelledListeners = new Map();
const languageChangeListeners = new Set();
const fullscreenChangeListeners = new Set();
const keyboardInteractiveListeners = new Set();
const hostKeyVerificationListeners = new Set();
const passphraseListeners = new Set();
const passphraseTimeoutListeners = new Set();
const passphraseCancelledListeners = new Set();
const passphraseAuthFailedListeners = new Set();
const updateDownloadProgressListeners = new Set();
const updateDownloadedListeners = new Set();
const updateAvailableListeners = new Set();
const updateNotAvailableListeners = new Set();
const updateErrorListeners = new Set();

function cleanupTransferListeners(transferId) {
  transferProgressListeners.delete(transferId);
  transferCompleteListeners.delete(transferId);
  transferErrorListeners.delete(transferId);
  transferCancelledListeners.delete(transferId);
}

// ── MCP marker filter with per-session line buffering ──
// PTY data arrives in arbitrary chunks; the marker string (__NCMCP_) can be
// split across chunk boundaries so a simple data.includes() guard misses it.
// We buffer the trailing fragment of each chunk and prepend it to the next
// chunk, then filter complete lines that contain the marker.

const _mcpLineBufs = new Map(); // sessionId -> trailing fragment string
const _mcpFlushTimers = new Map(); // sessionId -> delayed-flush timer

// Returns true if `s` ends with a non-empty prefix of "__NCMCP_"
// (i.e. the next chunk might complete it into a marker-containing line).
function _endsWithMarkerPrefix(s) {
  const p = "__NCMCP_";
  for (let i = 1; i < p.length; i++) {
    if (s.endsWith(p.slice(0, i))) return true;
  }
  return false;
}

function filterMcpChunk(sessionId, chunk) {
  // Cancel any pending delayed flush — new data arrived
  const pendingTimer = _mcpFlushTimers.get(sessionId);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    _mcpFlushTimers.delete(sessionId);
  }

  // Prepend any buffered fragment from the previous chunk
  const held = _mcpLineBufs.get(sessionId) || "";
  const data = held + chunk;
  _mcpLineBufs.delete(sessionId);

  // Fast path: nothing suspicious in the combined data
  if (!data.includes("__NCMCP_") && !_endsWithMarkerPrefix(data)) {
    return data;
  }

  // Slow path: scan line by line
  let result = "";
  let droppedAny = false;
  let pos = 0;
  while (pos < data.length) {
    const nlIdx = data.indexOf("\n", pos);
    if (nlIdx === -1) {
      // Incomplete trailing line — no newline yet.
      // If we dropped any marker line in this chunk, or the tail itself
      // looks like it could contain a marker, buffer it.  Long command
      // echoes can wrap across PTY lines; wrapped fragments that don't
      // contain __NCMCP_ would otherwise leak through as garbage.
      const tail = data.slice(pos);
      if (droppedAny || tail.includes("__NCMCP_") || _endsWithMarkerPrefix(tail)) {
        _mcpLineBufs.set(sessionId, tail);
      } else {
        result += tail; // safe to display immediately
      }
      break;
    }
    const line = data.slice(pos, nlIdx + 1); // includes the \n
    if (!line.includes("__NCMCP_")) {
      result += line;
    } else {
      droppedAny = true;
    }
    pos = nlIdx + 1;
  }

  return result;
}

/**
 * Deliver data to session listeners.  Used both by the normal data path
 * and by the delayed-flush timer.
 */
function _deliverToListeners(sessionId, data) {
  const set = dataListeners.get(sessionId);
  if (!set || !data) return;
  set.forEach((cb) => {
    try { cb(data); } catch (err) { console.error("Data callback failed", err); }
  });
}

// ZMODEM file transfer events
ipcRenderer.on("netcatty:zmodem:detect", (_event, payload) => {
  const set = zmodemListeners.get(payload.sessionId);
  if (!set) return;
  set.forEach((cb) => { try { cb({ type: "detect", ...payload }); } catch {} });
});
ipcRenderer.on("netcatty:zmodem:progress", (_event, payload) => {
  const set = zmodemListeners.get(payload.sessionId);
  if (!set) return;
  set.forEach((cb) => { try { cb({ type: "progress", ...payload }); } catch {} });
});
ipcRenderer.on("netcatty:zmodem:complete", (_event, payload) => {
  const set = zmodemListeners.get(payload.sessionId);
  if (!set) return;
  set.forEach((cb) => { try { cb({ type: "complete", ...payload }); } catch {} });
});
ipcRenderer.on("netcatty:zmodem:error", (_event, payload) => {
  const set = zmodemListeners.get(payload.sessionId);
  if (!set) return;
  set.forEach((cb) => { try { cb({ type: "error", ...payload }); } catch {} });
});
ipcRenderer.on("netcatty:zmodem:overwrite-request", (_event, payload) => {
  const set = zmodemOverwriteListeners.get(payload.sessionId);
  if (set) set.forEach((cb) => cb(payload));
});

ipcRenderer.on("netcatty:data", (_event, payload) => {
  const set = dataListeners.get(payload.sessionId);
  if (!set) return;
  if (payload?.syntheticEcho) {
    _deliverToListeners(payload.sessionId, payload.data);
    return;
  }
  const data = filterMcpChunk(payload.sessionId, payload.data);
  if (data) {
    set.forEach((cb) => {
      try {
        cb(data);
      } catch (err) {
        console.error("Data callback failed", err);
      }
    });
  }
  // If there is buffered content waiting for more data (e.g. a prompt
  // right after a dropped marker line), schedule a delayed flush so it
  // appears after a short pause instead of staying hidden forever.
  if (_mcpLineBufs.has(payload.sessionId)) {
    const sid = payload.sessionId;
    _mcpFlushTimers.set(sid, setTimeout(() => {
      const held = _mcpLineBufs.get(sid);
      _mcpLineBufs.delete(sid);
      _mcpFlushTimers.delete(sid);
      if (held) _deliverToListeners(sid, held);
    }, 80));
  }
});

ipcRenderer.on("netcatty:exit", (_event, payload) => {
  const set = exitListeners.get(payload.sessionId);
  if (set) {
    set.forEach((cb) => {
      try {
        cb(payload);
      } catch (err) {
        console.error("Exit callback failed", err);
      }
    });
  }
  dataListeners.delete(payload.sessionId);
  exitListeners.delete(payload.sessionId);
  telnetAutoLoginCompleteListeners.delete(payload.sessionId);
  telnetAutoLoginCancelledListeners.delete(payload.sessionId);
  zmodemListeners.delete(payload.sessionId);
  zmodemOverwriteListeners.delete(payload.sessionId);
  const pendingTimer = _mcpFlushTimers.get(payload.sessionId);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    _mcpFlushTimers.delete(payload.sessionId);
  }
  _mcpLineBufs.delete(payload.sessionId); // clean up any held fragment
});

// Chain progress events (for jump host connections)
ipcRenderer.on("netcatty:chain:progress", (_event, payload) => {
  const { sessionId, hop, total, label, status, error } = payload;
  // Notify all registered chain progress listeners
  chainProgressListeners.forEach((cb) => {
    try {
      cb(sessionId, hop, total, label, status, error);
    } catch (err) {
      console.error("Chain progress callback failed", err);
    }
  });
});

// SFTP connection progress events (auth method logs)
ipcRenderer.on("netcatty:sftp:connection-progress", (_event, payload) => {
  sftpConnectionProgressListeners.forEach((cb) => {
    try {
      cb(payload.sessionId, payload.label, payload.status, payload.detail);
    } catch (err) {
      console.error("SFTP connection progress callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:languageChanged", (_event, language) => {
  languageChangeListeners.forEach((cb) => {
    try {
      cb(language);
    } catch (err) {
      console.error("Language changed callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:window:fullscreen-changed", (_event, isFullscreen) => {
  fullscreenChangeListeners.forEach((cb) => {
    try {
      cb(isFullscreen);
    } catch (err) {
      console.error("Fullscreen changed callback failed", err);
    }
  });
});



// Authentication failed events
ipcRenderer.on("netcatty:auth:failed", (_event, payload) => {
  const set = authFailedListeners.get(payload.sessionId);
  if (set) {
    set.forEach((cb) => {
      try {
        cb(payload);
      } catch (err) {
        console.error("Auth failed callback failed", err);
      }
    });
  }
});

ipcRenderer.on("netcatty:telnet:auto-login-complete", (_event, payload) => {
  const set = telnetAutoLoginCompleteListeners.get(payload.sessionId);
  if (!set) return;
  set.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Telnet auto-login callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:telnet:auto-login-cancelled", (_event, payload) => {
  const set = telnetAutoLoginCancelledListeners.get(payload.sessionId);
  if (!set) return;
  set.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Telnet auto-login cancellation callback failed", err);
    }
  });
});

// Keyboard-interactive authentication events (2FA/MFA)
ipcRenderer.on("netcatty:keyboard-interactive", (_event, payload) => {
  keyboardInteractiveListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Keyboard-interactive callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:host-key:verify", (_event, payload) => {
  hostKeyVerificationListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Host key verification callback failed", err);
    }
  });
});

// Passphrase request events for encrypted SSH keys
ipcRenderer.on("netcatty:passphrase-request", (_event, payload) => {
  passphraseListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Passphrase request callback failed", err);
    }
  });
});

// Passphrase timeout events (request expired)
ipcRenderer.on("netcatty:passphrase-timeout", (_event, payload) => {
  passphraseTimeoutListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Passphrase timeout callback failed", err);
    }
  });
});

// Passphrase cancelled events (request ended because the owning operation stopped)
ipcRenderer.on("netcatty:passphrase-cancelled", (_event, payload) => {
  passphraseCancelledListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Passphrase cancelled callback failed", err);
    }
  });
});

// Passphrase auth failed events (saved passphrase was wrong)
ipcRenderer.on("netcatty:passphrase-auth-failed", (_event, payload) => {
  passphraseAuthFailedListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Passphrase auth-failed callback failed", err);
    }
  });
});

// Auto-update events
ipcRenderer.on("netcatty:update:update-available", (_event, payload) => {
  updateAvailableListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("onUpdateAvailable callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:update:update-not-available", () => {
  updateNotAvailableListeners.forEach((cb) => {
    try {
      cb();
    } catch (err) {
      console.error("onUpdateNotAvailable callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:update:download-progress", (_event, payload) => {
  updateDownloadProgressListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Update download-progress callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:update:downloaded", () => {
  updateDownloadedListeners.forEach((cb) => {
    try {
      cb();
    } catch (err) {
      console.error("Update downloaded callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:update:error", (_event, payload) => {
  updateErrorListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Update error callback failed", err);
    }
  });
});

// Transfer progress events
ipcRenderer.on("netcatty:transfer:progress", (_event, payload) => {
  const cb = transferProgressListeners.get(payload.transferId);
  if (cb) {
    try {
      cb(payload.transferred, payload.totalBytes, payload.speed);
    } catch (err) {
      console.error("Transfer progress callback failed", err);
    }
  }
});

ipcRenderer.on("netcatty:transfer:complete", (_event, payload) => {
  const cb = transferCompleteListeners.get(payload.transferId);
  if (cb) {
    try {
      cb();
    } catch (err) {
      console.error("Transfer complete callback failed", err);
    }
  }
  cleanupTransferListeners(payload.transferId);
});

ipcRenderer.on("netcatty:transfer:error", (_event, payload) => {
  const cb = transferErrorListeners.get(payload.transferId);
  if (cb) {
    try {
      cb(payload.error);
    } catch (err) {
      console.error("Transfer error callback failed", err);
    }
  }
  cleanupTransferListeners(payload.transferId);
});

ipcRenderer.on("netcatty:transfer:cancelled", (_event, payload) => {
  const cb = transferCancelledListeners.get(payload.transferId);
  if (cb) {
    try { cb(); } catch { }
  }
  cleanupTransferListeners(payload.transferId);
});

// Upload with progress listeners
const uploadProgressListeners = new Map();
const uploadCompleteListeners = new Map();
const uploadErrorListeners = new Map();

// Compress upload listeners
const compressProgressListeners = new Map();
const compressCompleteListeners = new Map();
const compressErrorListeners = new Map();

ipcRenderer.on("netcatty:upload:progress", (_event, payload) => {
  const cb = uploadProgressListeners.get(payload.transferId);
  if (cb) {
    try {
      cb(payload.transferred, payload.totalBytes, payload.speed);
    } catch (err) {
      console.error("Upload progress callback failed", err);
    }
  }
});

ipcRenderer.on("netcatty:upload:complete", (_event, payload) => {
  const cb = uploadCompleteListeners.get(payload.transferId);
  if (cb) {
    try {
      cb();
    } catch (err) {
      console.error("Upload complete callback failed", err);
    }
  }
  // Cleanup listeners
  uploadProgressListeners.delete(payload.transferId);
  uploadCompleteListeners.delete(payload.transferId);
  uploadErrorListeners.delete(payload.transferId);
});

ipcRenderer.on("netcatty:upload:error", (_event, payload) => {
  const cb = uploadErrorListeners.get(payload.transferId);
  if (cb) {
    try {
      cb(payload.error);
    } catch (err) {
      console.error("Upload error callback failed", err);
    }
  }
  // Cleanup listeners
  uploadProgressListeners.delete(payload.transferId);
  uploadCompleteListeners.delete(payload.transferId);
  uploadErrorListeners.delete(payload.transferId);
});

// Compress upload events
ipcRenderer.on("netcatty:compress:progress", (_event, payload) => {
  const cb = compressProgressListeners.get(payload.compressionId);
  if (cb) {
    try {
      cb(payload.phase, payload.transferred, payload.total);
    } catch (err) {
      console.error("Compress progress callback failed", err);
    }
  }
});

ipcRenderer.on("netcatty:compress:complete", (_event, payload) => {
  const cb = compressCompleteListeners.get(payload.compressionId);
  if (cb) {
    try {
      cb();
    } catch (err) {
      console.error("Compress complete callback failed", err);
    }
  }
  // Cleanup listeners
  compressProgressListeners.delete(payload.compressionId);
  compressCompleteListeners.delete(payload.compressionId);
  compressErrorListeners.delete(payload.compressionId);
});

ipcRenderer.on("netcatty:compress:error", (_event, payload) => {
  const cb = compressErrorListeners.get(payload.compressionId);
  if (cb) {
    try {
      cb(payload.error);
    } catch (err) {
      console.error("Compress error callback failed", err);
    }
  }
  // Cleanup listeners
  compressProgressListeners.delete(payload.compressionId);
  compressCompleteListeners.delete(payload.compressionId);
  compressErrorListeners.delete(payload.compressionId);
});

ipcRenderer.on("netcatty:compress:cancelled", (_event, payload) => {
  // Just cleanup listeners, the UI already knows it's cancelled
  compressProgressListeners.delete(payload.compressionId);
  compressCompleteListeners.delete(payload.compressionId);
  compressErrorListeners.delete(payload.compressionId);
});

// Port forwarding status listeners
const portForwardStatusListeners = new Map();

ipcRenderer.on("netcatty:portforward:status", (_event, payload) => {
  const { tunnelId, status, error } = payload;
  const callbacks = portForwardStatusListeners.get(tunnelId);
  if (callbacks) {
    callbacks.forEach((cb) => {
      try {
        cb(status, error);
      } catch (err) {
        console.error("Port forward status callback failed", err);
      }
    });
  }
});

// File watcher listeners (for auto-sync feature)
const fileWatchSyncedListeners = new Set();
const fileWatchErrorListeners = new Set();

ipcRenderer.on("netcatty:filewatch:synced", (_event, payload) => {
  fileWatchSyncedListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("File watch synced callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:filewatch:error", (_event, payload) => {
  fileWatchErrorListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("File watch error callback failed", err);
    }
  });
});

// Buffer the latest tray menu data so it can be replayed when the React
// component subscribes after lazy-mount (avoiding the first-open race).
let _lastTrayMenuData = null;
ipcRenderer.on("netcatty:trayPanel:setMenuData", (_event, data) => {
  _lastTrayMenuData = data;
});

const api = createPreloadApi({
  ipcRenderer,
  os,
  webUtils,
  randomUUID,
  dataListeners,
  exitListeners,
  transferProgressListeners,
  transferCompleteListeners,
  transferErrorListeners,
  transferCancelledListeners,
  chainProgressListeners,
  zmodemListeners,
  zmodemOverwriteListeners,
  sftpConnectionProgressListeners,
  authFailedListeners,
  telnetAutoLoginCompleteListeners,
  telnetAutoLoginCancelledListeners,
  languageChangeListeners,
  fullscreenChangeListeners,
  keyboardInteractiveListeners,
  hostKeyVerificationListeners,
  passphraseListeners,
  passphraseTimeoutListeners,
  passphraseCancelledListeners,
  passphraseAuthFailedListeners,
  updateDownloadProgressListeners,
  updateDownloadedListeners,
  updateAvailableListeners,
  updateNotAvailableListeners,
  updateErrorListeners,
  uploadProgressListeners,
  uploadCompleteListeners,
  uploadErrorListeners,
  compressProgressListeners,
  compressCompleteListeners,
  compressErrorListeners,
  portForwardStatusListeners,
  fileWatchSyncedListeners,
  fileWatchErrorListeners,
  cleanupTransferListeners,
  get _lastTrayMenuData() { return _lastTrayMenuData; },
  set _lastTrayMenuData(value) { _lastTrayMenuData = value; },
});

// Fig autocomplete spec loading via main process
const figSpecApi = {
  listFigSpecs: () => ipcRenderer.invoke("netcatty:figspec:list"),
  loadFigSpec: (commandName) => ipcRenderer.invoke("netcatty:figspec:load", commandName),
  listAutocompleteRemoteDir: (sessionId, dirPath, foldersOnly, filterPrefix, limit) => ipcRenderer.invoke("netcatty:ssh:listdir", {
    sessionId,
    path: dirPath,
    foldersOnly,
    filterPrefix,
    limit,
  }),
  listAutocompleteLocalDir: (dirPath, foldersOnly, filterPrefix, limit) => ipcRenderer.invoke("netcatty:local:listdir", {
    path: dirPath,
    foldersOnly,
    filterPrefix,
    limit,
  }),
};

// Merge with existing netcatty (if any) to avoid stale objects on hot reload
const existing = (typeof window !== "undefined" && window.netcatty) ? window.netcatty : {};

function getAllowedRendererOrigins() {
  const origins = new Set(["app://netcatty"]);
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (typeof devServerUrl === "string" && devServerUrl.length > 0) {
    try {
      const u = new URL(devServerUrl);
      origins.add(u.origin);
      // Vite often binds to 0.0.0.0, but Chromium navigates via localhost.
      if (
        u.hostname === "0.0.0.0" ||
        u.hostname === "127.0.0.1" ||
        u.hostname === "::1" ||
        u.hostname === "[::1]" ||
        u.hostname === "::" ||
        u.hostname === "[::]"
      ) {
        u.hostname = "localhost";
        origins.add(u.origin);
      }
    } catch {
      // ignore invalid dev URL
    }
  }
  return origins;
}

function isTrustedRendererLocation(allowedOrigins) {
  try {
    const origin = window?.location?.origin;
    return typeof origin === "string" && allowedOrigins.has(origin);
  } catch {
    return false;
  }
}

const allowedOrigins = getAllowedRendererOrigins();
if (isTrustedRendererLocation(allowedOrigins)) {
  contextBridge.exposeInMainWorld("netcatty", { ...existing, ...api, ...figSpecApi });
} else {
  // If a window navigates to an untrusted origin, do NOT expose the bridge.
  try {
    console.warn("[Preload] Refusing to expose netcatty bridge to untrusted origin:", window?.location?.origin);
  } catch {
    // ignore
  }
}
