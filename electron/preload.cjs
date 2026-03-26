const { ipcRenderer, contextBridge, webUtils } = require("electron");
const os = require("node:os");

const dataListeners = new Map();
const exitListeners = new Map();
const transferProgressListeners = new Map();
const transferCompleteListeners = new Map();
const transferErrorListeners = new Map();
const transferCancelledListeners = new Map();
const chainProgressListeners = new Map();
const sftpConnectionProgressListeners = new Set();
const authFailedListeners = new Map();
const languageChangeListeners = new Set();
const fullscreenChangeListeners = new Set();
const keyboardInteractiveListeners = new Set();
const passphraseListeners = new Set();
const passphraseTimeoutListeners = new Set();
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

ipcRenderer.on("netcatty:data", (_event, payload) => {
  const set = dataListeners.get(payload.sessionId);
  if (!set) return;
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

const api = {
  getWindowsPtyInfo: () => {
    if (process.platform !== "win32") {
      return null;
    }

    const releaseParts = os.release().split(".");
    const buildNumber = Number.parseInt(releaseParts[2] || "", 10);
    const hasBuildNumber = Number.isFinite(buildNumber);
    const backend =
      hasBuildNumber && buildNumber < 18309 ? "winpty" : "conpty";

    return hasBuildNumber ? { backend, buildNumber } : { backend };
  },
  startSSHSession: async (options) => {
    const result = await ipcRenderer.invoke("netcatty:start", options);
    return result.sessionId;
  },
  startTelnetSession: async (options) => {
    const result = await ipcRenderer.invoke("netcatty:telnet:start", options);
    return result.sessionId;
  },
  startMoshSession: async (options) => {
    const result = await ipcRenderer.invoke("netcatty:mosh:start", options);
    return result.sessionId;
  },
  startLocalSession: async (options) => {
    const result = await ipcRenderer.invoke("netcatty:local:start", options || {});
    return result.sessionId;
  },
  startSerialSession: async (options) => {
    const result = await ipcRenderer.invoke("netcatty:serial:start", options);
    return result.sessionId;
  },
  listSerialPorts: async () => {
    return ipcRenderer.invoke("netcatty:serial:list");
  },
  getDefaultShell: async () => {
    return ipcRenderer.invoke("netcatty:local:defaultShell");
  },
  validatePath: async (path, type) => {
    return ipcRenderer.invoke("netcatty:local:validatePath", { path, type });
  },
  writeToSession: (sessionId, data) => {
    ipcRenderer.send("netcatty:write", { sessionId, data });
  },
  execCommand: async (options) => {
    return ipcRenderer.invoke("netcatty:ssh:exec", options);
  },
  getSessionPwd: async (sessionId) => {
    return ipcRenderer.invoke("netcatty:ssh:pwd", { sessionId });
  },
  getServerStats: async (sessionId) => {
    return ipcRenderer.invoke("netcatty:ssh:stats", { sessionId });
  },
  generateKeyPair: async (options) => {
    return ipcRenderer.invoke("netcatty:key:generate", options);
  },
  checkSshAgent: async () => {
    return ipcRenderer.invoke("netcatty:ssh:check-agent");
  },
  getDefaultKeys: async () => {
    return ipcRenderer.invoke("netcatty:ssh:get-default-keys");
  },
  resizeSession: (sessionId, cols, rows) => {
    ipcRenderer.send("netcatty:resize", { sessionId, cols, rows });
  },
  closeSession: (sessionId) => {
    ipcRenderer.send("netcatty:close", { sessionId });
  },
  setSessionEncoding: (sessionId, encoding) =>
    ipcRenderer.invoke("netcatty:ssh:setEncoding", { sessionId, encoding }),
  onSessionData: (sessionId, cb) => {
    if (!dataListeners.has(sessionId)) dataListeners.set(sessionId, new Set());
    dataListeners.get(sessionId).add(cb);
    return () => dataListeners.get(sessionId)?.delete(cb);
  },
  onSessionExit: (sessionId, cb) => {
    if (!exitListeners.has(sessionId)) exitListeners.set(sessionId, new Set());
    exitListeners.get(sessionId).add(cb);
    return () => exitListeners.get(sessionId)?.delete(cb);
  },
  onAuthFailed: (sessionId, cb) => {
    if (!authFailedListeners.has(sessionId)) authFailedListeners.set(sessionId, new Set());
    authFailedListeners.get(sessionId).add(cb);
    return () => authFailedListeners.get(sessionId)?.delete(cb);
  },
  // Keyboard-interactive authentication (2FA/MFA)
  onKeyboardInteractive: (cb) => {
    keyboardInteractiveListeners.add(cb);
    return () => keyboardInteractiveListeners.delete(cb);
  },
  respondKeyboardInteractive: async (requestId, responses, cancelled = false) => {
    return ipcRenderer.invoke("netcatty:keyboard-interactive:respond", {
      requestId,
      responses,
      cancelled,
    });
  },
  // Passphrase request for encrypted SSH keys
  onPassphraseRequest: (cb) => {
    passphraseListeners.add(cb);
    return () => passphraseListeners.delete(cb);
  },
  respondPassphrase: async (requestId, passphrase, cancelled = false) => {
    return ipcRenderer.invoke("netcatty:passphrase:respond", {
      requestId,
      passphrase,
      cancelled,
    });
  },
  respondPassphraseSkip: async (requestId) => {
    return ipcRenderer.invoke("netcatty:passphrase:respond", {
      requestId,
      passphrase: '',
      skipped: true,
    });
  },
  onPassphraseTimeout: (cb) => {
    passphraseTimeoutListeners.add(cb);
    return () => passphraseTimeoutListeners.delete(cb);
  },
  openSftp: async (options) => {
    const result = await ipcRenderer.invoke("netcatty:sftp:open", options);
    return result.sftpId;
  },
  listSftp: async (sftpId, path, encoding) => {
    return ipcRenderer.invoke("netcatty:sftp:list", { sftpId, path, encoding });
  },
  readSftp: async (sftpId, path, encoding) => {
    return ipcRenderer.invoke("netcatty:sftp:read", { sftpId, path, encoding });
  },
  readSftpBinary: async (sftpId, path, encoding) => {
    return ipcRenderer.invoke("netcatty:sftp:readBinary", { sftpId, path, encoding });
  },
  writeSftp: async (sftpId, path, content, encoding) => {
    return ipcRenderer.invoke("netcatty:sftp:write", { sftpId, path, content, encoding });
  },
  writeSftpBinary: async (sftpId, path, content, encoding) => {
    return ipcRenderer.invoke("netcatty:sftp:writeBinary", { sftpId, path, content, encoding });
  },
  closeSftp: async (sftpId) => {
    return ipcRenderer.invoke("netcatty:sftp:close", { sftpId });
  },
  mkdirSftp: async (sftpId, path, encoding) => {
    return ipcRenderer.invoke("netcatty:sftp:mkdir", { sftpId, path, encoding });
  },
  deleteSftp: async (sftpId, path, encoding) => {
    return ipcRenderer.invoke("netcatty:sftp:delete", { sftpId, path, encoding });
  },
  renameSftp: async (sftpId, oldPath, newPath, encoding) => {
    return ipcRenderer.invoke("netcatty:sftp:rename", { sftpId, oldPath, newPath, encoding });
  },
  statSftp: async (sftpId, path, encoding) => {
    return ipcRenderer.invoke("netcatty:sftp:stat", { sftpId, path, encoding });
  },
  chmodSftp: async (sftpId, path, mode, encoding) => {
    return ipcRenderer.invoke("netcatty:sftp:chmod", { sftpId, path, mode, encoding });
  },
  getSftpHomeDir: async (sftpId) => {
    return ipcRenderer.invoke("netcatty:sftp:homeDir", { sftpId });
  },
  // Write binary with real-time progress callback
  writeSftpBinaryWithProgress: async (sftpId, path, content, transferId, encoding, onProgress, onComplete, onError) => {
    // Register callbacks
    if (onProgress) uploadProgressListeners.set(transferId, onProgress);
    if (onComplete) uploadCompleteListeners.set(transferId, onComplete);
    if (onError) uploadErrorListeners.set(transferId, onError);
    
    return ipcRenderer.invoke("netcatty:sftp:writeBinaryWithProgress", { 
      sftpId, 
      path, 
      content, 
      transferId,
      encoding,
    });
  },
  // Cancel an in-progress SFTP upload
  cancelSftpUpload: async (transferId) => {
    // Cleanup listeners
    uploadProgressListeners.delete(transferId);
    uploadCompleteListeners.delete(transferId);
    uploadErrorListeners.delete(transferId);
    return ipcRenderer.invoke("netcatty:sftp:cancelUpload", { transferId });
  },
  // Local filesystem operations
  listLocalDir: async (path) => {
    return ipcRenderer.invoke("netcatty:local:list", { path });
  },
  readLocalFile: async (path) => {
    return ipcRenderer.invoke("netcatty:local:read", { path });
  },
  writeLocalFile: async (path, content) => {
    return ipcRenderer.invoke("netcatty:local:write", { path, content });
  },
  deleteLocalFile: async (path) => {
    return ipcRenderer.invoke("netcatty:local:delete", { path });
  },
  renameLocalFile: async (oldPath, newPath) => {
    return ipcRenderer.invoke("netcatty:local:rename", { oldPath, newPath });
  },
  mkdirLocal: async (path) => {
    return ipcRenderer.invoke("netcatty:local:mkdir", { path });
  },
  statLocal: async (path) => {
    return ipcRenderer.invoke("netcatty:local:stat", { path });
  },
  getHomeDir: async () => {
    return ipcRenderer.invoke("netcatty:local:homedir");
  },
  getSystemInfo: async () => {
    return ipcRenderer.invoke("netcatty:system:info");
  },
  // Read system known_hosts file
  readKnownHosts: async () => {
    return ipcRenderer.invoke("netcatty:known-hosts:read");
  },
  setTheme: async (theme) => {
    return ipcRenderer.invoke("netcatty:setTheme", theme);
  },
  setBackgroundColor: async (color) => {
    return ipcRenderer.invoke("netcatty:setBackgroundColor", color);
  },
  setLanguage: async (language) => {
    return ipcRenderer.invoke("netcatty:setLanguage", language);
  },
  onLanguageChanged: (cb) => {
    languageChangeListeners.add(cb);
    return () => languageChangeListeners.delete(cb);
  },
  // Streaming transfer with real progress
  startStreamTransfer: async (options, onProgress, onComplete, onError) => {
    const { transferId } = options;
    // Register callbacks
    if (onProgress) transferProgressListeners.set(transferId, onProgress);
    if (onComplete) transferCompleteListeners.set(transferId, onComplete);
    if (onError) transferErrorListeners.set(transferId, onError);
    
    return ipcRenderer.invoke("netcatty:transfer:start", options);
  },
  cancelTransfer: async (transferId) => {
    cleanupTransferListeners(transferId);
    return ipcRenderer.invoke("netcatty:transfer:cancel", { transferId });
  },
  // Compressed folder upload
  startCompressedUpload: async (options, onProgress, onComplete, onError) => {
    const { compressionId } = options;
    // Register callbacks
    if (onProgress) compressProgressListeners.set(compressionId, onProgress);
    if (onComplete) compressCompleteListeners.set(compressionId, onComplete);
    if (onError) compressErrorListeners.set(compressionId, onError);
    
    return ipcRenderer.invoke("netcatty:compress:start", options);
  },
  cancelCompressedUpload: async (compressionId) => {
    // Cleanup listeners
    compressProgressListeners.delete(compressionId);
    compressCompleteListeners.delete(compressionId);
    compressErrorListeners.delete(compressionId);
    return ipcRenderer.invoke("netcatty:compress:cancel", { compressionId });
  },
  checkCompressedUploadSupport: async (sftpId) => {
    return ipcRenderer.invoke("netcatty:compress:checkSupport", { sftpId });
  },
  // Window controls for custom title bar
  windowMinimize: () => ipcRenderer.invoke("netcatty:window:minimize"),
  windowMaximize: () => ipcRenderer.invoke("netcatty:window:maximize"),
  windowClose: () => ipcRenderer.invoke("netcatty:window:close"),
  windowIsMaximized: () => ipcRenderer.invoke("netcatty:window:isMaximized"),
  windowIsFullscreen: () => ipcRenderer.invoke("netcatty:window:isFullscreen"),
  onWindowFullScreenChanged: (cb) => {
    fullscreenChangeListeners.add(cb);
    return () => fullscreenChangeListeners.delete(cb);
  },
  
  // Settings window
  openSettingsWindow: () => ipcRenderer.invoke("netcatty:settings:open"),
  closeSettingsWindow: () => ipcRenderer.invoke("netcatty:settings:close"),

  // Cross-window settings sync
  notifySettingsChanged: (payload) => ipcRenderer.send("netcatty:settings:changed", payload),
  onSettingsChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("netcatty:settings:changed", handler);
    return () => ipcRenderer.removeListener("netcatty:settings:changed", handler);
  },

  // Cloud sync session (in-memory only, shared across windows)
  cloudSyncSetSessionPassword: (password) =>
    ipcRenderer.invoke("netcatty:cloudSync:session:setPassword", password),
  cloudSyncGetSessionPassword: () =>
    ipcRenderer.invoke("netcatty:cloudSync:session:getPassword"),
  cloudSyncClearSessionPassword: () =>
    ipcRenderer.invoke("netcatty:cloudSync:session:clearPassword"),

  // Cloud sync network operations (proxied via main process)
  cloudSyncWebdavInitialize: (config) =>
    ipcRenderer.invoke("netcatty:cloudSync:webdav:initialize", { config }),
  cloudSyncWebdavUpload: (config, syncedFile) =>
    ipcRenderer.invoke("netcatty:cloudSync:webdav:upload", { config, syncedFile }),
  cloudSyncWebdavDownload: (config) =>
    ipcRenderer.invoke("netcatty:cloudSync:webdav:download", { config }),
  cloudSyncWebdavDelete: (config) =>
    ipcRenderer.invoke("netcatty:cloudSync:webdav:delete", { config }),

  cloudSyncS3Initialize: (config) =>
    ipcRenderer.invoke("netcatty:cloudSync:s3:initialize", { config }),
  cloudSyncS3Upload: (config, syncedFile) =>
    ipcRenderer.invoke("netcatty:cloudSync:s3:upload", { config, syncedFile }),
  cloudSyncS3Download: (config) =>
    ipcRenderer.invoke("netcatty:cloudSync:s3:download", { config }),
  cloudSyncS3Delete: (config) =>
    ipcRenderer.invoke("netcatty:cloudSync:s3:delete", { config }),
  
  // Open URL in default browser
  openExternal: (url) => ipcRenderer.invoke("netcatty:openExternal", url),

  // App info
  getAppInfo: () => ipcRenderer.invoke("netcatty:app:getInfo"),

  // Tell main process the renderer has mounted/painted (used to avoid initial blank screen).
  rendererReady: () => ipcRenderer.send("netcatty:renderer:ready"),
  
  // Port Forwarding API
  startPortForward: async (options) => {
    return ipcRenderer.invoke("netcatty:portforward:start", options);
  },
  stopPortForward: async (tunnelId) => {
    return ipcRenderer.invoke("netcatty:portforward:stop", { tunnelId });
  },
  getPortForwardStatus: async (tunnelId) => {
    return ipcRenderer.invoke("netcatty:portforward:status", { tunnelId });
  },
  listPortForwards: async () => {
    return ipcRenderer.invoke("netcatty:portforward:list");
  },
  stopAllPortForwards: async () => {
    return ipcRenderer.invoke("netcatty:portforward:stopAll");
  },
  stopPortForwardByRuleId: async (ruleId) => {
    return ipcRenderer.invoke("netcatty:portforward:stopByRuleId", { ruleId });
  },
  onPortForwardStatus: (tunnelId, cb) => {
    if (!portForwardStatusListeners.has(tunnelId)) {
      portForwardStatusListeners.set(tunnelId, new Set());
    }
    portForwardStatusListeners.get(tunnelId).add(cb);
    return () => {
      portForwardStatusListeners.get(tunnelId)?.delete(cb);
      if (portForwardStatusListeners.get(tunnelId)?.size === 0) {
        portForwardStatusListeners.delete(tunnelId);
      }
    };
  },
  // Chain progress listener for jump host connections
  onChainProgress: (cb) => {
    const id = Date.now().toString() + Math.random().toString(16).slice(2);
    chainProgressListeners.set(id, cb);
    return () => {
      chainProgressListeners.delete(id);
    };
  },
  // SFTP connection progress listener (auth method logs)
  onSftpConnectionProgress: (cb) => {
    sftpConnectionProgressListeners.add(cb);
    return () => {
      sftpConnectionProgressListeners.delete(cb);
    };
  },

  // OAuth callback server
  startOAuthCallback: (expectedState) => ipcRenderer.invoke("oauth:startCallback", expectedState),
  cancelOAuthCallback: () => ipcRenderer.invoke("oauth:cancelCallback"),

  // GitHub Device Flow (proxied via main process to avoid CORS)
  githubStartDeviceFlow: (options) => ipcRenderer.invoke("netcatty:github:deviceFlow:start", options),
  githubPollDeviceFlowToken: (options) => ipcRenderer.invoke("netcatty:github:deviceFlow:poll", options),

  // Google OAuth (proxied via main process to avoid CORS)
  googleExchangeCodeForTokens: (options) =>
    ipcRenderer.invoke("netcatty:google:oauth:exchange", options),
  googleRefreshAccessToken: (options) =>
    ipcRenderer.invoke("netcatty:google:oauth:refresh", options),
  googleGetUserInfo: (options) =>
    ipcRenderer.invoke("netcatty:google:oauth:userinfo", options),

  // Google Drive API (proxied via main process to avoid CORS/COEP issues in renderer)
  googleDriveFindSyncFile: (options) =>
    ipcRenderer.invoke("netcatty:google:drive:findSyncFile", options),
  googleDriveCreateSyncFile: (options) =>
    ipcRenderer.invoke("netcatty:google:drive:createSyncFile", options),
  googleDriveUpdateSyncFile: (options) =>
    ipcRenderer.invoke("netcatty:google:drive:updateSyncFile", options),
  googleDriveDownloadSyncFile: (options) =>
    ipcRenderer.invoke("netcatty:google:drive:downloadSyncFile", options),
  googleDriveDeleteSyncFile: (options) =>
    ipcRenderer.invoke("netcatty:google:drive:deleteSyncFile", options),

  // OneDrive OAuth + Graph (proxied via main process to avoid CORS)
  onedriveExchangeCodeForTokens: (options) =>
    ipcRenderer.invoke("netcatty:onedrive:oauth:exchange", options),
  onedriveRefreshAccessToken: (options) =>
    ipcRenderer.invoke("netcatty:onedrive:oauth:refresh", options),
  onedriveGetUserInfo: (options) =>
    ipcRenderer.invoke("netcatty:onedrive:oauth:userinfo", options),
  onedriveFindSyncFile: (options) =>
    ipcRenderer.invoke("netcatty:onedrive:drive:findSyncFile", options),
  onedriveUploadSyncFile: (options) =>
    ipcRenderer.invoke("netcatty:onedrive:drive:uploadSyncFile", options),
  onedriveDownloadSyncFile: (options) =>
    ipcRenderer.invoke("netcatty:onedrive:drive:downloadSyncFile", options),
  onedriveDeleteSyncFile: (options) =>
    ipcRenderer.invoke("netcatty:onedrive:drive:deleteSyncFile", options),

  // File opener helpers (for "Open With" feature)
  selectApplication: () =>
    ipcRenderer.invoke("netcatty:selectApplication"),
  openWithApplication: (filePath, appPath) =>
    ipcRenderer.invoke("netcatty:openWithApplication", { filePath, appPath }),
  downloadSftpToTemp: (sftpId, remotePath, fileName, encoding) =>
    ipcRenderer.invoke("netcatty:sftp:downloadToTemp", { sftpId, remotePath, fileName, encoding }),
  downloadSftpToTempWithProgress: (sftpId, remotePath, fileName, encoding, transferId, onProgress, onComplete, onError, onCancelled) => {
    if (onProgress) transferProgressListeners.set(transferId, onProgress);
    if (onComplete) transferCompleteListeners.set(transferId, onComplete);
    if (onError) transferErrorListeners.set(transferId, onError);
    if (onCancelled) transferCancelledListeners.set(transferId, onCancelled);
    return ipcRenderer
      .invoke("netcatty:sftp:downloadToTempWithProgress", { sftpId, remotePath, fileName, encoding, transferId })
      .catch((err) => {
        cleanupTransferListeners(transferId);
        throw err;
      });
  },

  // Save dialog for file downloads
  showSaveDialog: (defaultPath, filters) =>
    ipcRenderer.invoke("netcatty:showSaveDialog", { defaultPath, filters }),
  selectDirectory: (title, defaultPath) =>
    ipcRenderer.invoke("netcatty:selectDirectory", { title, defaultPath }),
  selectFile: (title, defaultPath, filters) =>
    ipcRenderer.invoke("netcatty:selectFile", { title, defaultPath, filters }),

  // File watcher for auto-sync feature
  startFileWatch: (localPath, remotePath, sftpId, encoding) =>
    ipcRenderer.invoke("netcatty:filewatch:start", { localPath, remotePath, sftpId, encoding }),
  stopFileWatch: (watchId, cleanupTempFile = false) =>
    ipcRenderer.invoke("netcatty:filewatch:stop", { watchId, cleanupTempFile }),
  listFileWatches: () =>
    ipcRenderer.invoke("netcatty:filewatch:list"),
  registerTempFile: (sftpId, localPath) =>
    ipcRenderer.invoke("netcatty:filewatch:registerTempFile", { sftpId, localPath }),
  onFileWatchSynced: (cb) => {
    fileWatchSyncedListeners.add(cb);
    return () => fileWatchSyncedListeners.delete(cb);
  },
  onFileWatchError: (cb) => {
    fileWatchErrorListeners.add(cb);
    return () => fileWatchErrorListeners.delete(cb);
  },
  
  // Temp file cleanup
  deleteTempFile: (filePath) =>
    ipcRenderer.invoke("netcatty:deleteTempFile", { filePath }),
  
  // Temp directory management
  getTempDirInfo: () =>
    ipcRenderer.invoke("netcatty:tempdir:getInfo"),
  clearTempDir: () =>
    ipcRenderer.invoke("netcatty:tempdir:clear"),
  getTempDirPath: () =>
    ipcRenderer.invoke("netcatty:tempdir:getPath"),
  openTempDir: () =>
    ipcRenderer.invoke("netcatty:tempdir:open"),

  // Session Logs
  exportSessionLog: (payload) =>
    ipcRenderer.invoke("netcatty:sessionLogs:export", payload),
  selectSessionLogsDir: () =>
    ipcRenderer.invoke("netcatty:sessionLogs:selectDir"),
  autoSaveSessionLog: (payload) =>
    ipcRenderer.invoke("netcatty:sessionLogs:autoSave", payload),
  openSessionLogsDir: (directory) =>
    ipcRenderer.invoke("netcatty:sessionLogs:openDir", { directory }),

  // Crash Logs
  getCrashLogs: () =>
    ipcRenderer.invoke("netcatty:crashLogs:list"),
  readCrashLog: (fileName) =>
    ipcRenderer.invoke("netcatty:crashLogs:read", { fileName }),
  clearCrashLogs: () =>
    ipcRenderer.invoke("netcatty:crashLogs:clear"),
  openCrashLogsDir: () =>
    ipcRenderer.invoke("netcatty:crashLogs:openDir"),

  // Global Toggle Hotkey (Quake Mode)
  registerGlobalHotkey: (hotkey) =>
    ipcRenderer.invoke("netcatty:globalHotkey:register", { hotkey }),
  unregisterGlobalHotkey: () =>
    ipcRenderer.invoke("netcatty:globalHotkey:unregister"),
  getGlobalHotkeyStatus: () =>
    ipcRenderer.invoke("netcatty:globalHotkey:status"),

  // System Tray / Close to Tray
  setCloseToTray: (enabled) =>
    ipcRenderer.invoke("netcatty:tray:setCloseToTray", { enabled }),
  isCloseToTray: () =>
    ipcRenderer.invoke("netcatty:tray:isCloseToTray"),
  updateTrayMenuData: (data) =>
    ipcRenderer.invoke("netcatty:tray:updateMenuData", data),
  // Listen for tray menu actions
  onTrayFocusSession: (callback) => {
    const handler = (_event, sessionId) => callback(sessionId);
    ipcRenderer.on("netcatty:tray:focusSession", handler);
    return () => ipcRenderer.removeListener("netcatty:tray:focusSession", handler);
  },
  onTrayTogglePortForward: (callback) => {
    const handler = (_event, ruleId, start) => callback(ruleId, start);
    ipcRenderer.on("netcatty:tray:togglePortForward", handler);
    return () => ipcRenderer.removeListener("netcatty:tray:togglePortForward", handler);
  },

  // Tray panel actions forwarded to main window
  onTrayPanelJumpToSession: (callback) => {
    const handler = (_event, sessionId) => callback(sessionId);
    ipcRenderer.on("netcatty:trayPanel:jumpToSession", handler);
    return () => ipcRenderer.removeListener("netcatty:trayPanel:jumpToSession", handler);
  },
  onTrayPanelConnectToHost: (callback) => {
    const handler = (_event, hostId) => callback(hostId);
    ipcRenderer.on("netcatty:trayPanel:connectToHost", handler);
    return () => ipcRenderer.removeListener("netcatty:trayPanel:connectToHost", handler);
  },

  // Tray panel window
  hideTrayPanel: () => ipcRenderer.invoke("netcatty:trayPanel:hide"),
  openMainWindow: () => ipcRenderer.invoke("netcatty:trayPanel:openMainWindow"),
  quitApp: () => ipcRenderer.invoke("netcatty:trayPanel:quitApp"),
  jumpToSessionFromTrayPanel: (sessionId) =>
    ipcRenderer.invoke("netcatty:trayPanel:jumpToSession", sessionId),
  connectToHostFromTrayPanel: (hostId) =>
    ipcRenderer.invoke("netcatty:trayPanel:connectToHost", hostId),
  onTrayPanelCloseRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("netcatty:trayPanel:closeRequest", handler);
    return () => ipcRenderer.removeListener("netcatty:trayPanel:closeRequest", handler);
  },

  onTrayPanelRefresh: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("netcatty:trayPanel:refresh", handler);
    return () => ipcRenderer.removeListener("netcatty:trayPanel:refresh", handler);
  },

  onTrayPanelMenuData: (callback) => {
    // Replay buffered data so late subscribers (e.g. after React lazy-mount) don't miss
    // the initial payload that was sent before the useEffect listener was registered.
    if (_lastTrayMenuData) {
      queueMicrotask(() => callback(_lastTrayMenuData));
    }
    const handler = (_event, data) => {
      _lastTrayMenuData = data;
      callback(data);
    };
    ipcRenderer.on("netcatty:trayPanel:setMenuData", handler);
    return () => ipcRenderer.removeListener("netcatty:trayPanel:setMenuData", handler);
  },

  // Get file path from File object (for drag-and-drop)
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return undefined;
    }
  },

  // Clipboard fallback helpers
  readClipboardText: async () => {
    return ipcRenderer.invoke("netcatty:clipboard:readText");
  },

  // Credential encryption (field-level safeStorage)
  credentialsAvailable: () => ipcRenderer.invoke("netcatty:credentials:available"),
  credentialsEncrypt: (plaintext) => ipcRenderer.invoke("netcatty:credentials:encrypt", plaintext),
  credentialsDecrypt: (value) => ipcRenderer.invoke("netcatty:credentials:decrypt", value),

  // Auto-update
  checkForUpdate: () => ipcRenderer.invoke("netcatty:update:check"),
  downloadUpdate: () => ipcRenderer.invoke("netcatty:update:download"),
  installUpdate: () => ipcRenderer.invoke("netcatty:update:install"),
  getUpdateStatus: () => ipcRenderer.invoke("netcatty:update:getStatus"),
  setAutoUpdate: (enabled) => ipcRenderer.invoke("netcatty:update:setAutoUpdate", { enabled }),
  getAutoUpdate: () => ipcRenderer.invoke("netcatty:update:getAutoUpdate"),
  onUpdateAvailable: (cb) => {
    updateAvailableListeners.add(cb);
    return () => updateAvailableListeners.delete(cb);
  },
  onUpdateNotAvailable: (cb) => {
    updateNotAvailableListeners.add(cb);
    return () => updateNotAvailableListeners.delete(cb);
  },
  onUpdateDownloadProgress: (cb) => {
    updateDownloadProgressListeners.add(cb);
    return () => updateDownloadProgressListeners.delete(cb);
  },
  onUpdateDownloaded: (cb) => {
    updateDownloadedListeners.add(cb);
    return () => updateDownloadedListeners.delete(cb);
  },
  onUpdateError: (cb) => {
    updateErrorListeners.add(cb);
    return () => updateErrorListeners.delete(cb);
  },

  // ── AI Bridge ──
  aiSyncProviders: async (providers) => {
    return ipcRenderer.invoke("netcatty:ai:sync-providers", { providers });
  },
  aiSyncWebSearch: async (apiHost, apiKey) => {
    return ipcRenderer.invoke("netcatty:ai:sync-web-search", { apiHost, apiKey });
  },
  aiChatStream: async (requestId, url, headers, body, providerId) => {
    return ipcRenderer.invoke("netcatty:ai:chat:stream", { requestId, url, headers, body, providerId });
  },
  aiChatCancel: async (requestId) => {
    return ipcRenderer.invoke("netcatty:ai:chat:cancel", { requestId });
  },
  aiFetch: async (url, method, headers, body, providerId, skipHostCheck, followRedirects, skipTLSVerify) => {
    return ipcRenderer.invoke("netcatty:ai:fetch", { url, method, headers, body, providerId, skipHostCheck, followRedirects, skipTLSVerify });
  },
  aiAllowlistAddHost: async (baseURL) => {
    return ipcRenderer.invoke("netcatty:ai:allowlist:add-host", { baseURL });
  },
  aiExec: async (sessionId, command, chatSessionId) => {
    return ipcRenderer.invoke("netcatty:ai:exec", { sessionId, command, chatSessionId });
  },
  aiCattyCancelExec: async (chatSessionId) => {
    return ipcRenderer.invoke("netcatty:ai:catty:cancel", { chatSessionId });
  },
  aiDiscoverAgents: async () => {
    return ipcRenderer.invoke("netcatty:ai:agents:discover");
  },
  aiResolveCli: async (params) => {
    return ipcRenderer.invoke("netcatty:ai:resolve-cli", params);
  },
  aiCodexGetIntegration: async () => {
    return ipcRenderer.invoke("netcatty:ai:codex:get-integration");
  },
  aiCodexStartLogin: async () => {
    return ipcRenderer.invoke("netcatty:ai:codex:start-login");
  },
  aiCodexGetLoginSession: async (sessionId) => {
    return ipcRenderer.invoke("netcatty:ai:codex:get-login-session", { sessionId });
  },
  aiCodexCancelLogin: async (sessionId) => {
    return ipcRenderer.invoke("netcatty:ai:codex:cancel-login", { sessionId });
  },
  aiCodexLogout: async () => {
    return ipcRenderer.invoke("netcatty:ai:codex:logout");
  },
  aiSpawnAgent: async (agentId, command, args, env, options) => {
    return ipcRenderer.invoke("netcatty:ai:agent:spawn", { agentId, command, args, env, closeStdin: options?.closeStdin });
  },
  aiWriteToAgent: async (agentId, data) => {
    return ipcRenderer.invoke("netcatty:ai:agent:write", { agentId, data });
  },
  aiCloseAgentStdin: async (agentId) => {
    return ipcRenderer.invoke("netcatty:ai:agent:close-stdin", { agentId });
  },
  aiKillAgent: async (agentId) => {
    return ipcRenderer.invoke("netcatty:ai:agent:kill", { agentId });
  },
  // MCP Server session metadata
  aiMcpUpdateSessions: async (sessions, chatSessionId) => {
    return ipcRenderer.invoke("netcatty:ai:mcp:update-sessions", { sessions, chatSessionId });
  },
  aiMcpSetCommandBlocklist: async (blocklist) => {
    return ipcRenderer.invoke("netcatty:ai:mcp:set-command-blocklist", { blocklist });
  },
  aiMcpSetCommandTimeout: async (timeout) => {
    return ipcRenderer.invoke("netcatty:ai:mcp:set-command-timeout", { timeout });
  },
  aiMcpSetMaxIterations: async (maxIterations) => {
    return ipcRenderer.invoke("netcatty:ai:mcp:set-max-iterations", { maxIterations });
  },
  aiMcpSetPermissionMode: async (mode) => {
    return ipcRenderer.invoke("netcatty:ai:mcp:set-permission-mode", { mode });
  },
  // MCP approval gate: renderer receives approval requests from main process
  onMcpApprovalRequest: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("netcatty:ai:mcp:approval-request", handler);
    return () => ipcRenderer.removeListener("netcatty:ai:mcp:approval-request", handler);
  },
  respondMcpApproval: async (approvalId, approved) => {
    return ipcRenderer.invoke("netcatty:ai:mcp:approval-response", { approvalId, approved });
  },
  // MCP approval cleared: main process timed out or cancelled an approval
  onMcpApprovalCleared: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("netcatty:ai:mcp:approval-cleared", handler);
    return () => ipcRenderer.removeListener("netcatty:ai:mcp:approval-cleared", handler);
  },
  // ACP streaming
  aiAcpStream: async (requestId, chatSessionId, acpCommand, acpArgs, prompt, cwd, providerId, model, existingSessionId, historyMessages, images) => {
    return ipcRenderer.invoke("netcatty:ai:acp:stream", { requestId, chatSessionId, acpCommand, acpArgs, prompt, cwd, providerId, model, existingSessionId, historyMessages, images });
  },
  aiAcpCancel: async (requestId, chatSessionId) => {
    return ipcRenderer.invoke("netcatty:ai:acp:cancel", { requestId, chatSessionId });
  },
  aiAcpCleanup: async (chatSessionId) => {
    return ipcRenderer.invoke("netcatty:ai:acp:cleanup", { chatSessionId });
  },
  onAiAcpEvent: (requestId, cb) => {
    const handler = (_event, payload) => {
      if (payload.requestId === requestId) cb(payload.event);
    };
    ipcRenderer.on("netcatty:ai:acp:event", handler);
    return () => ipcRenderer.removeListener("netcatty:ai:acp:event", handler);
  },
  onAiAcpDone: (requestId, cb) => {
    const handler = (_event, payload) => {
      if (payload.requestId === requestId) cb();
    };
    ipcRenderer.on("netcatty:ai:acp:done", handler);
    return () => ipcRenderer.removeListener("netcatty:ai:acp:done", handler);
  },
  onAiAcpError: (requestId, cb) => {
    const handler = (_event, payload) => {
      if (payload.requestId === requestId) cb(payload.error);
    };
    ipcRenderer.on("netcatty:ai:acp:error", handler);
    return () => ipcRenderer.removeListener("netcatty:ai:acp:error", handler);
  },
  onAiStreamData: (requestId, cb) => {
    const handler = (_event, payload) => {
      if (payload.requestId === requestId) cb(payload.data);
    };
    ipcRenderer.on("netcatty:ai:stream:data", handler);
    return () => ipcRenderer.removeListener("netcatty:ai:stream:data", handler);
  },
  onAiStreamEnd: (requestId, cb) => {
    const handler = (_event, payload) => {
      if (payload.requestId === requestId) cb();
    };
    ipcRenderer.on("netcatty:ai:stream:end", handler);
    return () => ipcRenderer.removeListener("netcatty:ai:stream:end", handler);
  },
  onAiStreamError: (requestId, cb) => {
    const handler = (_event, payload) => {
      if (payload.requestId === requestId) cb(payload.error);
    };
    ipcRenderer.on("netcatty:ai:stream:error", handler);
    return () => ipcRenderer.removeListener("netcatty:ai:stream:error", handler);
  },
  onAiAgentStdout: (agentId, cb) => {
    const handler = (_event, payload) => {
      if (payload.agentId === agentId) cb(payload.data);
    };
    ipcRenderer.on("netcatty:ai:agent:stdout", handler);
    return () => ipcRenderer.removeListener("netcatty:ai:agent:stdout", handler);
  },
  onAiAgentStderr: (agentId, cb) => {
    const handler = (_event, payload) => {
      if (payload.agentId === agentId) cb(payload.data);
    };
    ipcRenderer.on("netcatty:ai:agent:stderr", handler);
    return () => ipcRenderer.removeListener("netcatty:ai:agent:stderr", handler);
  },
  onAiAgentExit: (agentId, cb) => {
    const handler = (_event, payload) => {
      if (payload.agentId === agentId) cb(payload.code);
    };
    ipcRenderer.on("netcatty:ai:agent:exit", handler);
    return () => ipcRenderer.removeListener("netcatty:ai:agent:exit", handler);
  },
};

// Fig autocomplete spec loading via main process
const figSpecApi = {
  listFigSpecs: () => ipcRenderer.invoke("netcatty:figspec:list"),
  loadFigSpec: (commandName) => ipcRenderer.invoke("netcatty:figspec:load", commandName),
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
