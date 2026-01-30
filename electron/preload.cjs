const { ipcRenderer, contextBridge, webUtils } = require("electron");

const dataListeners = new Map();
const exitListeners = new Map();
const transferProgressListeners = new Map();
const transferCompleteListeners = new Map();
const transferErrorListeners = new Map();
const chainProgressListeners = new Map();
const authFailedListeners = new Map();
const languageChangeListeners = new Set();
const fullscreenChangeListeners = new Set();
const keyboardInteractiveListeners = new Set();
const passphraseListeners = new Set();
const passphraseTimeoutListeners = new Set();

ipcRenderer.on("netcatty:data", (_event, payload) => {
  const set = dataListeners.get(payload.sessionId);
  if (!set) return;
  set.forEach((cb) => {
    try {
      cb(payload.data);
    } catch (err) {
      console.error("Data callback failed", err);
    }
  });
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
});

// Chain progress events (for jump host connections)
ipcRenderer.on("netcatty:chain:progress", (_event, payload) => {
  const { hop, total, label, status } = payload;
  // Notify all registered chain progress listeners
  chainProgressListeners.forEach((cb) => {
    try {
      cb(hop, total, label, status);
    } catch (err) {
      console.error("Chain progress callback failed", err);
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
  // Cleanup listeners
  transferProgressListeners.delete(payload.transferId);
  transferCompleteListeners.delete(payload.transferId);
  transferErrorListeners.delete(payload.transferId);
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
  // Cleanup listeners
  transferProgressListeners.delete(payload.transferId);
  transferCompleteListeners.delete(payload.transferId);
  transferErrorListeners.delete(payload.transferId);
});

ipcRenderer.on("netcatty:transfer:cancelled", (_event, payload) => {
  // Just cleanup listeners, the UI already knows it's cancelled
  transferProgressListeners.delete(payload.transferId);
  transferCompleteListeners.delete(payload.transferId);
  transferErrorListeners.delete(payload.transferId);
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

const api = {
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
    // Cleanup listeners
    transferProgressListeners.delete(transferId);
    transferCompleteListeners.delete(transferId);
    transferErrorListeners.delete(transferId);
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

  // Save dialog for file downloads
  showSaveDialog: (defaultPath, filters) =>
    ipcRenderer.invoke("netcatty:showSaveDialog", { defaultPath, filters }),

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

  // Get file path from File object (for drag-and-drop)
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return undefined;
    }
  },
};

// Merge with existing netcatty (if any) to avoid stale objects on hot reload
const existing = (typeof window !== "undefined" && window.netcatty) ? window.netcatty : {};
contextBridge.exposeInMainWorld("netcatty", { ...existing, ...api });
