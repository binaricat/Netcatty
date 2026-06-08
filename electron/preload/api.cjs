 
function createPreloadApi(ctx) {
  with (ctx) {
    return {
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
  startEtSession: async (options) => {
    const result = await ipcRenderer.invoke("netcatty:et:start", options);
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
  discoverShells: () => ipcRenderer.invoke("netcatty:shells:discover"),
  validatePath: async (path, type) => {
    return ipcRenderer.invoke("netcatty:local:validatePath", { path, type });
  },
  writeToSession: (sessionId, data, options) => {
    ipcRenderer.send("netcatty:write", {
      sessionId,
      data,
      automated: Boolean(options?.automated),
    });
  },
  execCommand: async (options) => {
    return ipcRenderer.invoke("netcatty:ssh:exec", options);
  },
  getSessionPwd: async (sessionId) => {
    return ipcRenderer.invoke("netcatty:ssh:pwd", { sessionId });
  },
  getSessionRemoteInfo: async (sessionId) => {
    return ipcRenderer.invoke("netcatty:ssh:remoteInfo", { sessionId });
  },
  getSessionDistroInfo: async (sessionId) => {
    return ipcRenderer.invoke("netcatty:ssh:distroInfo", { sessionId });
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
  setSessionFlowPaused: (sessionId, paused) => {
    ipcRenderer.send("netcatty:flow", { sessionId, paused: Boolean(paused) });
  },
  closeSession: (sessionId) => {
    ipcRenderer.send("netcatty:close", { sessionId });
  },
  setSessionEncoding: async (sessionId, encoding) => {
    // Try the SSH handler first; it returns { ok: false } for non-SSH
    // sessions (no session.stream). Telnet and serial sessions fall
    // through to terminalBridge's handler.
    const ssh = await ipcRenderer.invoke("netcatty:ssh:setEncoding", { sessionId, encoding });
    if (ssh?.ok) return ssh;
    return ipcRenderer.invoke("netcatty:terminal:setEncoding", { sessionId, encoding });
  },
  onZmodemEvent: (sessionId, cb) => {
    if (!zmodemListeners.has(sessionId)) zmodemListeners.set(sessionId, new Set());
    zmodemListeners.get(sessionId).add(cb);
    return () => zmodemListeners.get(sessionId)?.delete(cb);
  },
  cancelZmodem: (sessionId) => {
    ipcRenderer.send("netcatty:zmodem:cancel", { sessionId });
  },
  onZmodemOverwriteRequest: (sessionId, cb) => {
    if (!zmodemOverwriteListeners.has(sessionId)) zmodemOverwriteListeners.set(sessionId, new Set());
    zmodemOverwriteListeners.get(sessionId).add(cb);
    return () => zmodemOverwriteListeners.get(sessionId)?.delete(cb);
  },
  respondZmodemOverwrite: (payload) => {
    ipcRenderer.send("netcatty:zmodem:overwrite-response", payload);
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
  onTelnetAutoLoginComplete: (sessionId, cb) => {
    if (!telnetAutoLoginCompleteListeners.has(sessionId)) {
      telnetAutoLoginCompleteListeners.set(sessionId, new Set());
    }
    telnetAutoLoginCompleteListeners.get(sessionId).add(cb);
    return () => telnetAutoLoginCompleteListeners.get(sessionId)?.delete(cb);
  },
  onTelnetAutoLoginCancelled: (sessionId, cb) => {
    if (!telnetAutoLoginCancelledListeners.has(sessionId)) {
      telnetAutoLoginCancelledListeners.set(sessionId, new Set());
    }
    telnetAutoLoginCancelledListeners.get(sessionId).add(cb);
    return () => telnetAutoLoginCancelledListeners.get(sessionId)?.delete(cb);
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
  onHostKeyVerification: (cb) => {
    hostKeyVerificationListeners.add(cb);
    return () => hostKeyVerificationListeners.delete(cb);
  },
  respondHostKeyVerification: async (requestId, accept, addToKnownHosts = false) => {
    return ipcRenderer.invoke("netcatty:host-key:respond", {
      requestId,
      accept,
      addToKnownHosts,
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
  onPassphraseCancelled: (cb) => {
    passphraseCancelledListeners.add(cb);
    return () => passphraseCancelledListeners.delete(cb);
  },
  onPassphraseAuthFailed: (cb) => {
    passphraseAuthFailedListeners.add(cb);
    return () => passphraseAuthFailedListeners.delete(cb);
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
  listLocalTree: async (path) => {
    return ipcRenderer.invoke("netcatty:local:tree", { path });
  },
  getHomeDir: async () => {
    return ipcRenderer.invoke("netcatty:local:homedir");
  },
  listDrives: async () => {
    return ipcRenderer.invoke("netcatty:local:drives");
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
  setWindowOpacity: async (opacity) => {
    return ipcRenderer.invoke("netcatty:setWindowOpacity", opacity);
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
  sameHostCopyDirectory: async (sftpId, sourcePath, targetPath, encoding, transferId) => {
    return ipcRenderer.invoke("netcatty:transfer:same-host-copy-dir", { sftpId, sourcePath, targetPath, encoding, transferId });
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
  windowFocus: () => ipcRenderer.invoke("netcatty:window:focus"),
  setWindowTitle: (title) => ipcRenderer.invoke("netcatty:window:setTitle", title),
  openSessionInNewWindow: (payload) => ipcRenderer.invoke("netcatty:window:openSession", payload),
  onOpenSessionInNewWindow: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("netcatty:window:openSession", handler);
    return () => ipcRenderer.removeListener("netcatty:window:openSession", handler);
  },
  onWindowCommandCloseRequested: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("netcatty:window:command-close", handler);
    return () => ipcRenderer.removeListener("netcatty:window:command-close", handler);
  },
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
  getSshDebugLogInfo: () => ipcRenderer.invoke("netcatty:sshDebugLog:info"),
  openSshDebugLogDir: () => ipcRenderer.invoke("netcatty:sshDebugLog:openDir"),

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
  openPath: (path) => ipcRenderer.invoke("netcatty:openPath", path),

  // App info
  getAppInfo: () => ipcRenderer.invoke("netcatty:app:getInfo"),
  ptyGetChildProcesses: (sessionId) =>
    ipcRenderer.invoke("netcatty:pty:childProcesses", sessionId),
  confirmCloseBusy: (payload) =>
    ipcRenderer.invoke("netcatty:dialog:confirmCloseBusy", payload),
  getVaultBackupCapabilities: () =>
    ipcRenderer.invoke("netcatty:vaultBackups:capabilities"),
  createVaultBackup: (payload) =>
    ipcRenderer.invoke("netcatty:vaultBackups:create", payload),
  listVaultBackups: () =>
    ipcRenderer.invoke("netcatty:vaultBackups:list"),
  readVaultBackup: (payload) =>
    ipcRenderer.invoke("netcatty:vaultBackups:read", payload),
  trimVaultBackups: (payload) =>
    ipcRenderer.invoke("netcatty:vaultBackups:trim", payload),
  openVaultBackupDir: () =>
    ipcRenderer.invoke("netcatty:vaultBackups:openDir"),
  // Subscribe to cross-window "backups changed" events emitted by the
  // main process whenever a create/trim actually mutated the on-disk
  // set. Returns an unsubscribe function so React-style consumers can
  // release the listener on unmount without leaking IPC handlers.
  onVaultBackupsChanged: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = () => {
      try { handler(); } catch (error) {
        console.warn("[preload] onVaultBackupsChanged handler threw:", error);
      }
    };
    ipcRenderer.on("netcatty:vaultBackups:changed", listener);
    return () => {
      try { ipcRenderer.removeListener("netcatty:vaultBackups:changed", listener); }
      catch { /* ignore */ }
    };
  },

  // Tell main process the renderer has mounted/painted (used to avoid initial blank screen).
  rendererReady: () => ipcRenderer.send("netcatty:renderer:ready"),

  // Quit guard: main process asks whether any editor tabs have unsaved changes.
  // Returns an unsubscribe function so React effects can clean up on unmount.
  onCheckDirtyEditors: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("app:query-dirty-editors", handler);
    return () => ipcRenderer.removeListener("app:query-dirty-editors", handler);
  },
  // Renderer reports the dirty-check result back to the main process.
  reportDirtyEditorsResult: (hasDirty) => ipcRenderer.send("app:dirty-editors-result", { hasDirty }),
  
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
    const id = randomUUID();
    chainProgressListeners.set(id, cb);
    return () => {
      chainProgressListeners.delete(id);
    };
  },
  onConnectionReuseFallback: (cb) => {
    connectionReuseFallbackListeners.add(cb);
    return () => {
      connectionReuseFallbackListeners.delete(cb);
    };
  },
  // SFTP connection progress listener (auth method logs)
  onSftpConnectionProgress: (cb) => {
    sftpConnectionProgressListeners.add(cb);
    return () => {
      sftpConnectionProgressListeners.delete(cb);
    };
  },

  // OAuth callback server — two-step so the renderer can learn the bound
  // port (which may differ from the preferred 45678 if it was in use) and
  // embed it into the provider's redirect_uri before opening the browser.
  prepareOAuthCallback: () => ipcRenderer.invoke("oauth:prepareCallback"),
  awaitOAuthCallback: (expectedState, sessionId) =>
    ipcRenderer.invoke("oauth:awaitCallback", expectedState, sessionId),
  cancelOAuthCallback: (sessionId) => ipcRenderer.invoke("oauth:cancelCallback", sessionId),

  // GitHub Device Flow (proxied via main process to avoid CORS)
  githubStartDeviceFlow: (options) => ipcRenderer.invoke("netcatty:github:deviceFlow:start", options),
  githubPollDeviceFlowToken: (options) => ipcRenderer.invoke("netcatty:github:deviceFlow:poll", options),
  githubCancelDeviceFlowPoll: (pollId) => ipcRenderer.invoke("netcatty:github:deviceFlow:cancelPoll", pollId),

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
  openWithSystemDefault: (filePath) =>
    ipcRenderer.invoke("netcatty:openWithSystemDefault", { filePath }),
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
  writeClipboardText: async (text) => {
    return ipcRenderer.invoke("netcatty:clipboard:writeText", text);
  },
  readClipboardFiles: async () => {
    return ipcRenderer.invoke("netcatty:clipboard:readFiles");
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
  onUpdateNeedsSave: (cb) => {
    updateNeedsSaveListeners.add(cb);
    return () => updateNeedsSaveListeners.delete(cb);
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
  aiCodexGetIntegration: async (options) => {
    return ipcRenderer.invoke("netcatty:ai:codex:get-integration", options);
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
  aiMcpSetToolIntegrationMode: async (mode) => {
    return ipcRenderer.invoke("netcatty:ai:mcp:set-tool-integration-mode", { mode });
  },
  aiUserSkillsGetStatus: async () => {
    return ipcRenderer.invoke("netcatty:ai:user-skills:status");
  },
  aiUserSkillsOpenFolder: async () => {
    return ipcRenderer.invoke("netcatty:ai:user-skills:open");
  },
  aiUserSkillsBuildContext: async (prompt, selectedSkillSlugs) => {
    return ipcRenderer.invoke("netcatty:ai:user-skills:build-context", { prompt, selectedSkillSlugs });
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
  // SDK external agent streaming
  aiSdkAgentStream: async (requestId, chatSessionId, sdkBackend, prompt, cwd, providerId, model, existingSessionId, historyMessages, images, toolIntegrationMode, defaultTargetSession, userSkillsContext, agentEnv) => {
    return ipcRenderer.invoke("netcatty:ai:sdk-agent:stream", { requestId, chatSessionId, sdkBackend, prompt, cwd, providerId, model, existingSessionId, historyMessages, images, toolIntegrationMode, defaultTargetSession, userSkillsContext, agentEnv });
  },
  aiSdkAgentListModels: async (sdkBackend, cwd, providerId, chatSessionId, agentEnv) => {
    return ipcRenderer.invoke("netcatty:ai:sdk-agent:list-models", { sdkBackend, cwd, providerId, chatSessionId, agentEnv });
  },
  aiSdkAgentCancel: async (requestId, chatSessionId) => {
    return ipcRenderer.invoke("netcatty:ai:sdk-agent:cancel", { requestId, chatSessionId });
  },
  aiSdkAgentCleanup: async (chatSessionId) => {
    return ipcRenderer.invoke("netcatty:ai:sdk-agent:cleanup", { chatSessionId });
  },
  onAiSdkAgentEvent: (requestId, cb) => {
    const handler = (_event, payload) => {
      if (payload.requestId === requestId) cb(payload.event);
    };
    ipcRenderer.on("netcatty:ai:sdk-agent:event", handler);
    return () => ipcRenderer.removeListener("netcatty:ai:sdk-agent:event", handler);
  },
  onAiSdkAgentDone: (requestId, cb) => {
    const handler = (_event, payload) => {
      if (payload.requestId === requestId) cb();
    };
    ipcRenderer.on("netcatty:ai:sdk-agent:done", handler);
    return () => ipcRenderer.removeListener("netcatty:ai:sdk-agent:done", handler);
  },
  onAiSdkAgentError: (requestId, cb) => {
    const handler = (_event, payload) => {
      if (payload.requestId === requestId) cb(payload.error);
    };
    ipcRenderer.on("netcatty:ai:sdk-agent:error", handler);
    return () => ipcRenderer.removeListener("netcatty:ai:sdk-agent:error", handler);
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
  }
}

module.exports = { createPreloadApi };
