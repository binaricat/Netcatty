const {
  clearTerminalDataSession,
  hasPluginPipelineIngressMarker,
} = require("./terminalDataBacklog.cjs");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { stageRendererFileToTemp } = require("./stageUploadFile.cjs");

function createPreloadApi(ctx) {
  const terminalDataBacklog = ctx.terminalDataBacklog || null;
  const displayDataListeners = ctx.displayDataListeners || new Map();
  const closedTerminalDataSessions = ctx.closedTerminalDataSessions || null;
  const globalSftpTransferListeners = ctx.globalSftpTransferListeners || new Set();
  const pluginContributionsChangedListeners = ctx.pluginContributionsChangedListeners || new Set();
  const uploadStageControllers = new Map();
  // Lightweight test contexts may omit this map; default so closeSession never throws.
  if (!ctx.moshSessionReadyListeners) {
    ctx.moshSessionReadyListeners = new Map();
  }
  const markTerminalDataSessionOpen = (sessionId) => {
    if (!sessionId) return;
    closedTerminalDataSessions?.delete?.(sessionId);
  };
  const markRequestedTerminalDataSessionOpen = (options) => {
    markTerminalDataSessionOpen(options?.sessionId);
  };
  const markTerminalDataSessionClosed = (sessionId) => {
    if (!sessionId) return;
    closedTerminalDataSessions?.add?.(sessionId);
    ctx.clearTerminalOutputSessionState?.(sessionId);
    clearTerminalDataSession({
      dataListeners: ctx.dataListeners,
      displayDataListeners,
      terminalDataBacklog,
    }, sessionId);
    ctx.terminalOutputPorts?.closeSession?.(sessionId);
  };
  const removeSessionListener = (listeners, sessionId, cb) => {
    const set = listeners?.get?.(sessionId);
    set?.delete(cb);
    if (set?.size === 0) listeners.delete(sessionId);
  };
  const clearSessionScopedTerminalListeners = (sessionId) => {
    ctx.telnetAutoLoginCompleteListeners?.delete?.(sessionId);
    ctx.telnetAutoLoginCancelledListeners?.delete?.(sessionId);
    ctx.moshSessionReadyListeners?.delete?.(sessionId);
    ctx.telnetEchoModeListeners?.delete?.(sessionId);
    ctx.authFailedListeners?.delete?.(sessionId);
  };
  const sanitizeInterruptTrace = (trace) => {
    if (!trace || typeof trace !== "object") return undefined;
    const priority = trace.rendererPriority && typeof trace.rendererPriority === "object"
      ? {
          sessionId: typeof trace.rendererPriority.sessionId === "string" ? trace.rendererPriority.sessionId : null,
          backlogBytes: Number(trace.rendererPriority.backlogBytes) || 0,
          writeQueueDepth: Number(trace.rendererPriority.writeQueueDepth) || 0,
          deferredAckBytes: Number(trace.rendererPriority.deferredAckBytes) || 0,
          ackAfterInputBytes: Number(trace.rendererPriority.ackAfterInputBytes) || 0,
          scheduledBackendResume: Boolean(trace.rendererPriority.scheduledBackendResume),
          skippedReason: typeof trace.rendererPriority.skippedReason === "string" ? trace.rendererPriority.skippedReason : undefined,
        }
      : undefined;
    return {
      debug: trace.debug === true,
      traceId: typeof trace.traceId === "string" ? trace.traceId.slice(0, 128) : undefined,
      source: typeof trace.source === "string" ? trace.source.slice(0, 80) : undefined,
      sessionId: typeof trace.sessionId === "string" ? trace.sessionId : undefined,
      rendererKeyAt: Number.isFinite(trace.rendererKeyAt) ? trace.rendererKeyAt : undefined,
      rendererSendAt: Number.isFinite(trace.rendererSendAt) ? trace.rendererSendAt : undefined,
      rendererStatus: typeof trace.rendererStatus === "string" ? trace.rendererStatus.slice(0, 40) : undefined,
      rendererHasSelection: trace.rendererHasSelection === true,
      rendererPriority: priority,
    };
  };
  const sanitizeKittyKeyboardModeState = (value) => {
    if (!value || typeof value !== "object") return undefined;
    const flags = (input) => Number.isFinite(input) ? Math.max(0, Math.floor(input)) & 31 : 0;
    const stack = (input) => Array.isArray(input)
      ? input.slice(-32).map(flags)
      : [];
    return {
      mainFlags: flags(value.mainFlags),
      alternateFlags: flags(value.alternateFlags),
      mainStack: stack(value.mainStack),
      alternateStack: stack(value.alternateStack),
      alternateScreenActive: value.alternateScreenActive === true,
    };
  };
  with (ctx) {
    return {
  getPluginRuntimeStatus: () => ipcRenderer.invoke("netcatty:plugins:status"),
  listPlugins: () => ipcRenderer.invoke("netcatty:plugins:list"),
  installPluginPackage: (archivePath, options) => ipcRenderer.invoke("netcatty:plugins:install", {
    archivePath,
    enable: options?.enable === true,
  }),
  setPluginEnabled: (pluginId, enabled) => ipcRenderer.invoke("netcatty:plugins:set-enabled", {
    pluginId,
    enabled: enabled === true,
  }),
  restartPlugin: (pluginId) => ipcRenderer.invoke("netcatty:plugins:restart", { pluginId }),
  uninstallPlugin: (pluginId) => ipcRenderer.invoke("netcatty:plugins:uninstall", { pluginId }),
  getPluginContributions: (options) => ipcRenderer.invoke("netcatty:plugins:contributions", options ?? {}),
  getPluginContributionIcon: (pluginId, icon) => ipcRenderer.invoke("netcatty:plugins:contribution-icon", { pluginId, icon }),
  executePluginCommand: (command, args, context) => ipcRenderer.invoke("netcatty:plugins:execute-command", {
    command,
    ...(args === undefined ? {} : { args }),
    ...(context === undefined ? {} : { context }),
  }),
  updatePluginSetting: (pluginId, settingId, value, scopeId) => ipcRenderer.invoke(
    "netcatty:plugins:update-setting",
    { pluginId, settingId, value, ...(scopeId === undefined ? {} : { scopeId }) },
  ),
  resetPluginSetting: (pluginId, settingId, scopeId) => ipcRenderer.invoke(
    "netcatty:plugins:reset-setting",
    { pluginId, settingId, ...(scopeId === undefined ? {} : { scopeId }) },
  ),
  setPluginEnvironment: (environment) => ipcRenderer.invoke("netcatty:plugins:set-environment", environment),
  listPluginTerminalProviders: (options) => ipcRenderer.invoke("netcatty:plugins:terminal-providers", options ?? {}),
  providePluginTerminal: (request) => ipcRenderer.invoke("netcatty:plugins:terminal-provide", request),
  cancelPluginTerminalRequest: (requestId) => ipcRenderer.invoke("netcatty:plugins:terminal-cancel", { requestId }),
  publishPluginTerminalSessionEvent: (event) => ipcRenderer.invoke("netcatty:plugins:terminal-session-event", event),
  listPluginExtensionProviders: (options) => ipcRenderer.invoke("netcatty:plugins:extension-providers", options ?? {}),
  updatePluginCredentialCatalog: (entries) => ipcRenderer.invoke(
    "netcatty:plugins:credential-catalog-update",
    { entries },
  ),
  invokePluginExtensionProvider: (request) => ipcRenderer.invoke("netcatty:plugins:extension-invoke", {
    requestId: request?.requestId ?? randomUUID(),
    ...request,
  }),
  cancelPluginExtensionRequest: (requestId) => ipcRenderer.invoke("netcatty:plugins:extension-cancel", { requestId }),
  pluginSyncConnect: (request) => {
    const requestId = typeof request?.requestId === "string" && request.requestId
      ? request.requestId
      : randomUUID();
    return ipcRenderer.invoke("netcatty:plugins:sync-connect", { ...request, requestId });
  },
  pluginSyncDisconnect: (request) => {
    const requestId = typeof request?.requestId === "string" && request.requestId
      ? request.requestId
      : randomUUID();
    return ipcRenderer.invoke("netcatty:plugins:sync-disconnect", { ...request, requestId });
  },
  pluginSyncGetAccount: (request) => {
    const requestId = typeof request?.requestId === "string" && request.requestId
      ? request.requestId
      : randomUUID();
    return ipcRenderer.invoke("netcatty:plugins:sync-get-account", { ...request, requestId });
  },
  pluginSyncGetCapabilities: (request) => {
    const requestId = typeof request?.requestId === "string" && request.requestId
      ? request.requestId
      : randomUUID();
    return ipcRenderer.invoke("netcatty:plugins:sync-get-capabilities", { ...request, requestId });
  },
  pluginSyncReadObject: (request) => {
    const requestId = typeof request?.requestId === "string" && request.requestId
      ? request.requestId
      : randomUUID();
    return ipcRenderer.invoke("netcatty:plugins:sync-read-object", { ...request, requestId });
  },
  pluginSyncReadChunk: (request) => ipcRenderer.invoke("netcatty:plugins:sync-read-chunk", request),
  pluginSyncWriteObject: (request) => {
    const requestId = typeof request?.requestId === "string" && request.requestId
      ? request.requestId
      : randomUUID();
    return ipcRenderer.invoke("netcatty:plugins:sync-write-object", { ...request, requestId });
  },
  pluginSyncWriteBegin: (request) => {
    const requestId = typeof request?.requestId === "string" && request.requestId
      ? request.requestId
      : randomUUID();
    return ipcRenderer.invoke("netcatty:plugins:sync-write-begin", { ...request, requestId });
  },
  pluginSyncWriteChunk: (request) => ipcRenderer.invoke("netcatty:plugins:sync-write-chunk", request),
  pluginSyncWriteCommit: (request) => ipcRenderer.invoke("netcatty:plugins:sync-write-commit", request),
  pluginSyncDeleteObject: (request) => {
    const requestId = typeof request?.requestId === "string" && request.requestId
      ? request.requestId
      : randomUUID();
    return ipcRenderer.invoke("netcatty:plugins:sync-delete-object", { ...request, requestId });
  },
  pluginSyncPutSecret: (request) => ipcRenderer.invoke("netcatty:plugins:sync-put-secret", request ?? {}),
  pluginSyncDeleteSecrets: (request) => ipcRenderer.invoke("netcatty:plugins:sync-delete-secrets", request ?? {}),
  pluginSyncRestoreSecrets: (request) => ipcRenderer.invoke("netcatty:plugins:sync-restore-secrets", request ?? {}),
  collectPluginSyncSidecars: () => ipcRenderer.invoke("netcatty:plugins:sync-sidecars-collect", {}),
  applyPluginSyncSidecars: (bundle) => ipcRenderer.invoke("netcatty:plugins:sync-sidecars-apply", bundle ?? { version: 1, entries: [] }),
  /** True only when the main-process plugin host wired a sidecar service. */
  pluginHostReady: () => {
    try {
      return ipcRenderer.sendSync("netcatty:plugins:host-available-sync") === true;
    } catch {
      return false;
    }
  },
  startPluginConnection: async (request) => {
    markRequestedTerminalDataSessionOpen(request);
    const result = await ipcRenderer.invoke("netcatty:plugins:connection-start", {
      requestId: request?.requestId ?? randomUUID(),
      ...request,
    });
    markTerminalDataSessionOpen(result?.sessionId);
    return result;
  },
  writePluginConnection: (sessionId, data) => ipcRenderer.invoke("netcatty:plugins:connection-write", { sessionId, data }),
  controlPluginConnection: (sessionId, operation, payload) => ipcRenderer.invoke(
    "netcatty:plugins:connection-control",
    { sessionId, operation, payload: payload ?? {} },
  ),
  detectPluginImporter: (request) => ipcRenderer.invoke("netcatty:plugins:importer-detect", {
    requestId: request?.requestId ?? randomUUID(),
    ...request,
  }),
  selectPluginImporterFile: () => ipcRenderer.invoke("netcatty:plugins:importer-select-file", {}),
  releasePluginImporterFile: (selectionToken) => ipcRenderer.invoke(
    "netcatty:plugins:importer-release-file",
    { selectionToken },
  ),
  parsePluginImporterFile: (request) => ipcRenderer.invoke("netcatty:plugins:importer-parse-file", {
    requestId: request?.requestId ?? randomUUID(),
    ...request,
  }),
  onPluginImporterProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("netcatty:plugins:importer-progress", listener);
    return () => ipcRenderer.removeListener("netcatty:plugins:importer-progress", listener);
  },
  respondPluginAuthenticationChallenge: (response) => ipcRenderer.invoke(
    "netcatty:plugins:authentication-respond",
    response,
  ),
  onPluginAuthenticationChallenge: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("netcatty:plugins:authentication-challenge", listener);
    return () => ipcRenderer.removeListener("netcatty:plugins:authentication-challenge", listener);
  },
  onPluginConnectionData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("netcatty:plugins:connection-data", listener);
    return () => ipcRenderer.removeListener("netcatty:plugins:connection-data", listener);
  },
  onPluginConnectionClosed: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("netcatty:plugins:connection-closed", listener);
    return () => ipcRenderer.removeListener("netcatty:plugins:connection-closed", listener);
  },
  openPluginView: (payload) => ipcRenderer.invoke("netcatty:plugins:open-view", payload),
  closePluginView: (instanceId) => ipcRenderer.invoke("netcatty:plugins:close-view", { instanceId }),
  setPluginViewBounds: (instanceId, bounds) => ipcRenderer.invoke("netcatty:plugins:set-view-bounds", { instanceId, bounds }),
  setPluginViewVisibility: (instanceId, visible) => ipcRenderer.invoke("netcatty:plugins:set-view-visibility", {
    instanceId,
    visible: visible === true,
  }),
  postPluginViewMessage: (instanceId, message) => ipcRenderer.invoke("netcatty:plugins:view-message", { instanceId, message }),
  onPluginContributionsChanged: (callback) => {
    pluginContributionsChangedListeners.add(callback);
    return () => pluginContributionsChangedListeners.delete(callback);
  },
  onPluginViewMessage: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("netcatty:plugins:view-message-posted", listener);
    return () => ipcRenderer.removeListener("netcatty:plugins:view-message-posted", listener);
  },
  onPluginViewClosed: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("netcatty:plugins:view-closed", listener);
    return () => ipcRenderer.removeListener("netcatty:plugins:view-closed", listener);
  },
  getPluginScopeCatalog: () => ipcRenderer.invoke("netcatty:plugins:get-scope-catalog"),
  setPluginScopeCatalog: (catalog) => ipcRenderer.invoke("netcatty:plugins:set-scope-catalog", catalog),
  onPluginScopeCatalogChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("netcatty:plugins:scope-catalog-changed", listener);
    return () => ipcRenderer.removeListener("netcatty:plugins:scope-catalog-changed", listener);
  },
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
    markRequestedTerminalDataSessionOpen(options);
    const result = await ipcRenderer.invoke("netcatty:start", options);
    markTerminalDataSessionOpen(result?.sessionId);
    return result.sessionId;
  },
  startTelnetSession: async (options) => {
    markRequestedTerminalDataSessionOpen(options);
    const result = await ipcRenderer.invoke("netcatty:telnet:start", options);
    markTerminalDataSessionOpen(result?.sessionId);
    return result.sessionId;
  },
  startMoshSession: async (options) => {
    markRequestedTerminalDataSessionOpen(options);
    const result = await ipcRenderer.invoke("netcatty:mosh:start", options);
    markTerminalDataSessionOpen(result?.sessionId);
    return result.sessionId;
  },
  startEtSession: async (options) => {
    markRequestedTerminalDataSessionOpen(options);
    const result = await ipcRenderer.invoke("netcatty:et:start", options);
    markTerminalDataSessionOpen(result?.sessionId);
    return result.sessionId;
  },
  startLocalSession: async (options) => {
    markRequestedTerminalDataSessionOpen(options);
    const result = await ipcRenderer.invoke("netcatty:local:start", options || {});
    markTerminalDataSessionOpen(result?.sessionId);
    return result.sessionId;
  },
  startSerialSession: async (options) => {
    markRequestedTerminalDataSessionOpen(options);
    const result = await ipcRenderer.invoke("netcatty:serial:start", options);
    markTerminalDataSessionOpen(result?.sessionId);
    return result.sessionId;
  },
  listSerialPorts: async () => {
    return ipcRenderer.invoke("netcatty:serial:list");
  },
  sendSerialYmodem: async (sessionId, filePath) => {
    return ipcRenderer.invoke("netcatty:serial:ymodem-send", { sessionId, filePath });
  },
  receiveSerialYmodem: async (sessionId, destinationDir) => {
    return ipcRenderer.invoke("netcatty:serial:ymodem-receive", { sessionId, destinationDir });
  },
  getDefaultShell: async () => {
    return ipcRenderer.invoke("netcatty:local:defaultShell");
  },
  discoverShells: () => ipcRenderer.invoke("netcatty:shells:discover"),
  validatePath: async (path, type) => {
    return ipcRenderer.invoke("netcatty:local:validatePath", { path, type });
  },
  writeToSession: (sessionId, data, options) => {
    const lineDelayMs = Number(options?.lineDelayMs);
    ipcRenderer.send("netcatty:write", {
      sessionId,
      data,
      automated: Boolean(options?.automated),
      sensitive: options?.sensitive === true,
      lineDelayMs: Number.isFinite(lineDelayMs) && lineDelayMs > 0 ? lineDelayMs : undefined,
      logRewrite: options?.logRewrite && typeof options.logRewrite === "object"
        ? {
            sentCommand: String(options.logRewrite.sentCommand ?? ""),
            displayCommand: String(options.logRewrite.displayCommand ?? ""),
          }
        : undefined,
    });
  },
  interruptSession: (sessionId, trace) => {
    const sanitizedTrace = sanitizeInterruptTrace(trace);
    if (ctx.terminalUrgentInputPorts?.postInterrupt?.(sessionId, sanitizedTrace)) {
      return;
    }
    ipcRenderer.send("netcatty:interrupt", { sessionId, trace: sanitizedTrace });
  },
  execCommand: async (options) => {
    return ipcRenderer.invoke("netcatty:ssh:exec", options);
  },
  getSessionPwd: async (sessionId, options) => {
    return ipcRenderer.invoke("netcatty:ssh:pwd", {
      sessionId,
      allowHomeFallback: options?.allowHomeFallback,
      timeoutMs: options?.timeoutMs,
    });
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
  probeSystemCapabilities: async (sessionId) => {
    return ipcRenderer.invoke("netcatty:system:probeCapabilities", { sessionId });
  },
  listSystemProcesses: async (sessionId) => {
    return ipcRenderer.invoke("netcatty:system:listProcesses", { sessionId });
  },
  signalSystemProcess: async (options) => {
    return ipcRenderer.invoke("netcatty:system:signalProcess", options);
  },
  setupOsc7Tracking: async (sessionId, command) => {
    return ipcRenderer.invoke("netcatty:system:setupOsc7Tracking", { sessionId, command });
  },
  listTmuxSessions: async (sessionId) => {
    return ipcRenderer.invoke("netcatty:system:listTmuxSessions", { sessionId });
  },
  createTmuxSession: async (options) => {
    return ipcRenderer.invoke("netcatty:system:createTmuxSession", options);
  },
  listTmuxWindows: async (options) => {
    return ipcRenderer.invoke("netcatty:system:listTmuxWindows", options);
  },
  listTmuxPanes: async (options) => {
    return ipcRenderer.invoke("netcatty:system:listTmuxPanes", options);
  },
  listTmuxClients: async (options) => {
    return ipcRenderer.invoke("netcatty:system:listTmuxClients", options);
  },
  tmuxAction: async (options) => {
    return ipcRenderer.invoke("netcatty:system:tmuxAction", options);
  },
  listDockerContainers: async (sessionId) => {
    return ipcRenderer.invoke("netcatty:system:listDockerContainers", { sessionId });
  },
  listDockerImages: async (sessionId) => {
    return ipcRenderer.invoke("netcatty:system:listDockerImages", { sessionId });
  },
  getDockerStats: async (options) => {
    return ipcRenderer.invoke("netcatty:system:dockerStats", options);
  },
  listAccelerators: async (sessionId) => {
    return ipcRenderer.invoke("netcatty:system:listAccelerators", { sessionId });
  },
  dockerInspect: async (options) => {
    return ipcRenderer.invoke("netcatty:system:dockerInspect", options);
  },
  dockerImageInspect: async (options) => {
    return ipcRenderer.invoke("netcatty:system:dockerImageInspect", options);
  },
  dockerAction: async (options) => {
    return ipcRenderer.invoke("netcatty:system:dockerAction", options);
  },
  dockerImageAction: async (options) => {
    return ipcRenderer.invoke("netcatty:system:dockerImageAction", options);
  },
  openTerminalPopup: async (payload) => {
    return ipcRenderer.invoke("netcatty:window:openTerminalPopup", payload);
  },
  logDiagnostic: async (payload) => {
    return ipcRenderer.invoke("netcatty:diagnostics:log", payload);
  },
  onTerminalPopupConfig: (cb) => {
    terminalPopupConfigState.listeners.add(cb);
    const replay = terminalPopupConfigState.pending ?? terminalPopupConfigState.lastPayload;
    if (replay) {
      // Drain the one-shot pending slot once a live subscriber exists, but keep
      // lastPayload so StrictMode remount can resubscribe and still setConfig.
      terminalPopupConfigState.pending = null;
      queueMicrotask(() => {
        try {
          cb(replay);
        } catch (err) {
          console.error("Terminal popup config callback failed", err);
        }
      });
    }
    return () => terminalPopupConfigState.listeners.delete(cb);
  },
  readRemoteHistory: async (sessionId, limit) => {
    return ipcRenderer.invoke("netcatty:ssh:readRemoteHistory", { sessionId, limit });
  },
  generateKeyPair: async (options) => {
    return ipcRenderer.invoke("netcatty:key:generate", options);
  },
  checkSshAgent: async (options) => {
    return ipcRenderer.invoke("netcatty:ssh:check-agent", options);
  },
  getDefaultKeys: async () => {
    return ipcRenderer.invoke("netcatty:ssh:get-default-keys");
  },
  resizeSession: (sessionId, cols, rows) => {
    ipcRenderer.send("netcatty:resize", { sessionId, cols, rows });
  },
  clearSessionPtyBuffer: (sessionId) => {
    if (!sessionId) return;
    ipcRenderer.send("netcatty:pty:clear", { sessionId });
  },
  setSessionFlowPaused: (sessionId, paused) => {
    ipcRenderer.send("netcatty:flow", { sessionId, paused: Boolean(paused) });
  },
  setSessionFlowPausedAndWait: (sessionId, paused) =>
    ipcRenderer.invoke("netcatty:terminal:setFlowPausedAndWait", {
      sessionId,
      paused: Boolean(paused),
    }),
  acquireSessionFlowPauseLease: (sessionId) =>
    ipcRenderer.invoke("netcatty:terminal:acquireFlowPauseLease", { sessionId }),
  waitSessionFlowPauseLease: (sessionId, leaseId) =>
    ipcRenderer.invoke("netcatty:terminal:waitFlowPauseLease", { sessionId, leaseId }),
  releaseSessionFlowPauseLease: (sessionId, leaseId, options) =>
    ipcRenderer.invoke("netcatty:terminal:releaseFlowPauseLease", {
      sessionId,
      leaseId,
      keepPaused: options?.keepPaused === true,
    }),
  onTerminalOutputDrainRequest: (sessionId, cb) => {
    const listeners = ctx.terminalOutputDrainListeners;
    if (!listeners.has(sessionId)) listeners.set(sessionId, new Set());
    listeners.get(sessionId).add(cb);
    return () => {
      const set = listeners.get(sessionId);
      set?.delete(cb);
      if (set?.size === 0) listeners.delete(sessionId);
    };
  },
  respondTerminalOutputDrain: (requestId) => {
    ipcRenderer.send("netcatty:terminal:output-drain-response", { requestId });
  },
  notifyTerminalSessionDisplayReady: (sessionId) => {
    ipcRenderer.send("netcatty:terminal:display-ready", { sessionId });
  },
  ackSessionFlow: (sessionId, bytes) => {
    if (!sessionId || !Number.isFinite(bytes) || bytes <= 0) return;
    ipcRenderer.send("netcatty:flow:ack", { sessionId, bytes });
  },
  closeSession: async (sessionId, options) => {
    const payload = {
      sessionId,
      ...(Number.isFinite(options?.bootEpoch) ? { bootEpoch: Number(options.bootEpoch) } : {}),
    };
    const epochScoped = Number.isFinite(options?.bootEpoch);
    // Unscoped closes keep the historical sync listener teardown so reconnect
    // paths that fire-and-forget closeSession still drop stale handlers.
    // Epoch-scoped closes are only used to dispose a superseded backend owner;
    // they must never clear preload listeners for the shared sessionId, because
    // a replacement boot may already have registered readiness/auto-login hooks.
    if (!epochScoped) {
      markTerminalDataSessionClosed(sessionId);
      clearSessionScopedTerminalListeners(sessionId);
    }
    try {
      await ipcRenderer.invoke("netcatty:close:await", payload);
    } catch {
      ipcRenderer.send("netcatty:close", payload);
    }
  },
  rebindTerminalSessionOutput: (sessionId, authorization) =>
    ipcRenderer.invoke("netcatty:terminal:rebindOutput", { sessionId, authorization }),
  restoreTerminalSessionOutput: (sessionId, webContentsId, authorization) =>
    ipcRenderer.invoke("netcatty:terminal:restoreOutput", { sessionId, webContentsId, authorization }),
  requestTerminalSessionSnapshot: (sessionId, authorization) =>
    ipcRenderer.invoke("netcatty:terminal:requestSnapshot", { sessionId, authorization }),
  onTerminalSessionSnapshotRequest: (cb) => {
    const handler = (_event, payload) => {
      try {
        cb?.(payload);
      } catch {
        // Provider failures must not break the main process request.
      }
    };
    ipcRenderer.on("netcatty:terminal:snapshot-request", handler);
    return () => ipcRenderer.removeListener("netcatty:terminal:snapshot-request", handler);
  },
  respondTerminalSessionSnapshot: (
    requestId,
    snapshot,
    kittyKeyboardModeState,
    kittyKeyboardProtocolEnabled,
    passwordPromptActive,
    cwd,
    title,
  ) => {
    ipcRenderer.send("netcatty:terminal:snapshot-response", {
      requestId,
      snapshot: typeof snapshot === "string" ? snapshot : "",
      kittyKeyboardModeState: sanitizeKittyKeyboardModeState(kittyKeyboardModeState),
      kittyKeyboardProtocolEnabled: typeof kittyKeyboardProtocolEnabled === "boolean"
        ? kittyKeyboardProtocolEnabled
        : undefined,
      passwordPromptActive: typeof passwordPromptActive === "boolean"
        ? passwordPromptActive
        : undefined,
      cwd: cwd === null ? null : typeof cwd === "string" ? cwd : undefined,
      title: title === null ? null : typeof title === "string" ? title : undefined,
    });
  },
  applyTerminalSessionSnapshot: (sessionId, snapshot, context, authorization) =>
    ipcRenderer.invoke("netcatty:terminal:applySnapshot", {
      sessionId,
      snapshot: typeof snapshot === "string" ? snapshot : "",
      contextSnapshot: typeof context?.contextSnapshot === "string" ? context.contextSnapshot : "",
      contextViewportSnapshot: typeof context?.contextViewportSnapshot === "string"
        ? context.contextViewportSnapshot
        : "",
      contextScrollbackSnapshot: typeof context?.contextScrollbackSnapshot === "string"
        ? context.contextScrollbackSnapshot
        : "",
      alternateScreen: context?.alternateScreen === true,
      kittyKeyboardModeState: sanitizeKittyKeyboardModeState(context?.kittyKeyboardModeState),
      kittyKeyboardProtocolEnabled: typeof context?.kittyKeyboardProtocolEnabled === "boolean"
        ? context.kittyKeyboardProtocolEnabled
        : undefined,
      passwordPromptActive: typeof context?.passwordPromptActive === "boolean"
        ? context.passwordPromptActive
        : undefined,
      cwd: context?.cwd === null ? null : typeof context?.cwd === "string" ? context.cwd : undefined,
      title: context?.title === null ? null : typeof context?.title === "string" ? context.title : undefined,
      authorization,
    }),
  markAttachPopupClosePrepared: (sessionId, authorization) =>
    ipcRenderer.invoke("netcatty:terminal:markAttachClosePrepared", { sessionId, authorization }),
  onTerminalPopupPrepareClose: (cb) => {
    const handler = (_event, payload) => cb?.(payload);
    ipcRenderer.on("netcatty:terminal-popup:prepare-close", handler);
    return () => ipcRenderer.removeListener("netcatty:terminal-popup:prepare-close", handler);
  },
  onTerminalSessionApplySnapshot: (cb) => {
    const handler = (_event, payload) => {
      Promise.resolve().then(() => cb?.(payload)).then(
        (handled) => {
          if (handled !== true) return;
          ipcRenderer.send("netcatty:terminal:apply-snapshot-response", {
            requestId: payload?.requestId,
            success: true,
          });
        },
        (err) => ipcRenderer.send("netcatty:terminal:apply-snapshot-response", {
          requestId: payload?.requestId,
          success: false,
          error: err?.message || String(err),
        }),
      );
    };
    ipcRenderer.on("netcatty:terminal:apply-snapshot", handler);
    return () => ipcRenderer.removeListener("netcatty:terminal:apply-snapshot", handler);
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
    return () => {
      const set = zmodemListeners.get(sessionId);
      if (!set) return;
      set.delete(cb);
      if (set.size === 0) zmodemListeners.delete(sessionId);
    };
  },
  cancelZmodem: (sessionId, options) => {
    ipcRenderer.send("netcatty:zmodem:cancel", { sessionId, options });
  },
  startZmodemDragDropUpload: (sessionId, files, uploadCommand) => {
    return ipcRenderer.invoke("netcatty:zmodem:drag-drop-upload", {
      sessionId,
      files,
      uploadCommand,
    });
  },
  onZmodemOverwriteRequest: (sessionId, cb) => {
    if (!zmodemOverwriteListeners.has(sessionId)) zmodemOverwriteListeners.set(sessionId, new Set());
    zmodemOverwriteListeners.get(sessionId).add(cb);
    return () => {
      const set = zmodemOverwriteListeners.get(sessionId);
      if (!set) return;
      set.delete(cb);
      if (set.size === 0) zmodemOverwriteListeners.delete(sessionId);
    };
  },
  respondZmodemOverwrite: (payload) => {
    ipcRenderer.send("netcatty:zmodem:overwrite-response", payload);
  },
  onSessionData: (sessionId, cb, options) => {
    const replayBacklog = options?.replayBacklog === true;
    if (!dataListeners.has(sessionId)) dataListeners.set(sessionId, new Set());
    dataListeners.get(sessionId).add(cb);
    if (replayBacklog) {
      if (!displayDataListeners.has(sessionId)) displayDataListeners.set(sessionId, new Set());
      displayDataListeners.get(sessionId).add(cb);
      const pendingEntry = terminalDataBacklog?.takeEntry?.(sessionId)
        ?? { data: terminalDataBacklog?.take?.(sessionId) || "", meta: undefined };
      if (pendingEntry.data || hasPluginPipelineIngressMarker(pendingEntry.meta)) {
        try {
          cb(pendingEntry.data, pendingEntry.meta);
        } catch (err) {
          console.error("Data callback failed", err);
        }
      }
    }
    return () => {
      const dataSet = dataListeners.get(sessionId);
      dataSet?.delete(cb);
      if (dataSet?.size === 0) dataListeners.delete(sessionId);

      if (!replayBacklog) return;
      const displaySet = displayDataListeners.get(sessionId);
      displaySet?.delete(cb);
      if (displaySet?.size === 0) displayDataListeners.delete(sessionId);
    };
  },
  onSessionExit: (sessionId, cb) => {
    if (!exitListeners.has(sessionId)) exitListeners.set(sessionId, new Set());
    exitListeners.get(sessionId).add(cb);
    return () => {
      const set = exitListeners.get(sessionId);
      set?.delete(cb);
      if (set?.size === 0) exitListeners.delete(sessionId);
    };
  },
  onTelnetAutoLoginComplete: (sessionId, cb) => {
    if (!telnetAutoLoginCompleteListeners.has(sessionId)) {
      telnetAutoLoginCompleteListeners.set(sessionId, new Set());
    }
    telnetAutoLoginCompleteListeners.get(sessionId).add(cb);
    return () => removeSessionListener(telnetAutoLoginCompleteListeners, sessionId, cb);
  },
  onTelnetAutoLoginCancelled: (sessionId, cb) => {
    if (!telnetAutoLoginCancelledListeners.has(sessionId)) {
      telnetAutoLoginCancelledListeners.set(sessionId, new Set());
    }
    telnetAutoLoginCancelledListeners.get(sessionId).add(cb);
    return () => removeSessionListener(telnetAutoLoginCancelledListeners, sessionId, cb);
  },
  onMoshSessionReady: (sessionId, cb) => {
    if (!moshSessionReadyListeners.has(sessionId)) {
      moshSessionReadyListeners.set(sessionId, new Set());
    }
    moshSessionReadyListeners.get(sessionId).add(cb);
    return () => removeSessionListener(moshSessionReadyListeners, sessionId, cb);
  },
  onTelnetEchoMode: (sessionId, cb) => {
    if (!telnetEchoModeListeners.has(sessionId)) {
      telnetEchoModeListeners.set(sessionId, new Set());
    }
    telnetEchoModeListeners.get(sessionId).add(cb);
    return () => removeSessionListener(telnetEchoModeListeners, sessionId, cb);
  },
  getTelnetEchoMode: (sessionId) =>
    ipcRenderer.invoke("netcatty:telnet:getEchoMode", { sessionId }),
  onAuthFailed: (sessionId, cb) => {
    if (!authFailedListeners.has(sessionId)) authFailedListeners.set(sessionId, new Set());
    authFailedListeners.get(sessionId).add(cb);
    return () => removeSessionListener(authFailedListeners, sessionId, cb);
  },
  // Keyboard-interactive authentication (2FA/MFA)
  onKeyboardInteractive: (cb) => {
    keyboardInteractiveListeners.add(cb);
    return () => keyboardInteractiveListeners.delete(cb);
  },
  onKeyboardInteractiveCancelled: (cb) => {
    keyboardInteractiveCancelledListeners.add(cb);
    return () => keyboardInteractiveCancelledListeners.delete(cb);
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
  openSftpForSession: async (sessionId, expectedEndpoint) => {
    const result = await ipcRenderer.invoke("netcatty:sftp:openForSession", {
      sessionId,
      expectedEndpoint,
    });
    return result.sftpId;
  },
  listSftp: async (sftpId, path, encoding) => {
    return ipcRenderer.invoke("netcatty:sftp:list", { sftpId, path, encoding });
  },
  realpathSftp: async (sftpId, path, encoding) => {
    return ipcRenderer.invoke("netcatty:sftp:realpath", { sftpId, path, encoding });
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
  retainSftpTransferSession: async (sftpId, leaseId) => {
    return ipcRenderer.invoke("netcatty:transfer:retain-sftp-session", { sftpId, leaseId });
  },
  releaseSftpTransferSession: async (sftpId, leaseId) => {
    return ipcRenderer.invoke("netcatty:transfer:release-sftp-session", { sftpId, leaseId });
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
  getSftpHomeDir: async (sftpId, encoding) => {
    return ipcRenderer.invoke("netcatty:sftp:homeDir", { sftpId, encoding });
  },
  // Local filesystem operations
  listLocalDir: async (path) => {
    return ipcRenderer.invoke("netcatty:local:list", { path });
  },
  readLocalFile: async (path, options) => {
    return ipcRenderer.invoke("netcatty:local:read", {
      path,
      maxBytes: options?.maxBytes,
    });
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
  listLocalTree: async (path, options = {}) => {
    const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
    const onEntries = typeof options?.onEntries === "function" ? options.onEntries : null;
    const token = typeof options?.scanId === "string" && options.scanId
      ? options.scanId
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const progressChannel = onProgress
      ? `netcatty:local:tree-progress:${token}`
      : undefined;
    const entriesChannel = onEntries
      ? `netcatty:local:tree-entries:${token}`
      : undefined;
    const cancelChannel = `netcatty:local:tree-cancel:${token}`;
    const progressHandler = onProgress && progressChannel
      ? (_event, stats) => {
        try {
          onProgress(stats);
        } catch {
          // Ignore renderer progress handler errors so the scan can finish.
        }
      }
      : null;
    // Entry batches arrive on a different channel than the invoke reply. If we
    // tear down the listener when invoke resolves, nested-folder batches that
    // are still in the IPC queue are dropped (top-level files look fine).
    let settleEntriesStream = null;
    const entriesStreamDone = onEntries && entriesChannel
      ? new Promise((resolve) => {
        settleEntriesStream = resolve;
      })
      : null;
    const entriesHandler = onEntries && entriesChannel
      ? (_event, payload) => {
        if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.type === "tree-end") {
          settleEntriesStream?.();
          return;
        }
        try {
          if (Array.isArray(payload)) onEntries(payload);
        } catch {
          // Ignore batch handler errors so the scan can finish.
        }
      }
      : null;
    if (progressHandler && progressChannel) {
      ipcRenderer.on(progressChannel, progressHandler);
    }
    if (entriesHandler && entriesChannel) {
      ipcRenderer.on(entriesChannel, entriesHandler);
    }
    try {
      const result = await ipcRenderer.invoke("netcatty:local:tree", {
        path,
        progressChannel,
        entriesChannel,
        cancelChannel,
        limits: options?.limits,
      });
      if (entriesStreamDone) {
        // Wait for the main-process end marker so late nested batches are not
        // lost. Fail the scan if the marker never arrives (do not pretend a
        // partial tree is complete).
        let timedOut = false;
        await Promise.race([
          entriesStreamDone,
          new Promise((resolve) => {
            setTimeout(() => {
              timedOut = true;
              resolve();
            }, 5_000);
          }),
        ]);
        if (timedOut) {
          throw new Error("Local tree scan ended without a completion marker");
        }
      }
      return result;
    } finally {
      settleEntriesStream?.();
      if (progressHandler && progressChannel) {
        ipcRenderer.removeListener(progressChannel, progressHandler);
      }
      if (entriesHandler && entriesChannel) {
        ipcRenderer.removeListener(entriesChannel, entriesHandler);
      }
    }
  },
  cancelLocalTreeScan: async (scanId) => {
    if (typeof scanId === "string" && scanId) {
      ipcRenderer.send(`netcatty:local:tree-cancel:${scanId}`);
    }
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
  setAppIconVariant: async (variant) => {
    return ipcRenderer.invoke("netcatty:setAppIconVariant", variant);
  },
  setLanguage: async (language) => {
    return ipcRenderer.invoke("netcatty:setLanguage", language);
  },
  onLanguageChanged: (cb) => {
    languageChangeListeners.add(cb);
    return () => languageChangeListeners.delete(cb);
  },
  // Transfer state is delivered only through onGlobalSftpTransferEvent.
  startStreamTransfer: async (options) => ipcRenderer.invoke("netcatty:transfer:start", options),
  cancelTransfer: async (transferId) => {
    return ipcRenderer.invoke("netcatty:transfer:cancel", { transferId });
  },
  clearPendingTransferCancel: async (transferId) => {
    return ipcRenderer.invoke("netcatty:transfer:clear-pending-cancel", { transferId });
  },
  pauseTransfer: async (transferId) => {
    return ipcRenderer.invoke("netcatty:transfer:pause", { transferId });
  },
  resumeTransfer: async (transferId) => {
    return ipcRenderer.invoke("netcatty:transfer:resume", { transferId });
  },
  prioritizeTransfer: async (transferId) => {
    return ipcRenderer.invoke("netcatty:transfer:prioritize", { transferId });
  },
  setGlobalTransferConcurrency: async (limit) => {
    return ipcRenderer.invoke("netcatty:transfer:set-concurrency", { limit });
  },
  cleanupTransferArtifacts: async (payload) => {
    return ipcRenderer.invoke("netcatty:transfer:cleanup", payload);
  },
  onGlobalSftpTransferEvent: (callback) => {
    globalSftpTransferListeners.add(callback);
    return () => globalSftpTransferListeners.delete(callback);
  },
  sameHostCopyDirectory: async (sftpId, sourcePath, targetPath, encoding, transferId) => {
    return ipcRenderer.invoke("netcatty:transfer:same-host-copy-dir", { sftpId, sourcePath, targetPath, encoding, transferId });
  },
  // Compressed folder upload
  startCompressedUpload: async (options) => {
    return ipcRenderer.invoke("netcatty:compress:start", options);
  },
  cancelCompressedUpload: async (compressionId) => {
    return ipcRenderer.invoke("netcatty:compress:cancel", { compressionId });
  },
  pauseCompressedUpload: async (compressionId) => {
    return ipcRenderer.invoke("netcatty:compress:pause", { compressionId });
  },
  resumeCompressedUpload: async (compressionId) => {
    return ipcRenderer.invoke("netcatty:compress:resume", { compressionId });
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
  onWindowShown: (cb) => {
    windowShownListeners.add(cb);
    return () => windowShownListeners.delete(cb);
  },
  onWindowFocusRequested: (cb) => {
    windowFocusRequestedListeners.add(cb);
    return () => windowFocusRequestedListeners.delete(cb);
  },
  onWindowWillHide: (cb) => {
    windowWillHideListeners.add(cb);
    return () => windowWillHideListeners.delete(cb);
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

  onSshDeepLink: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("netcatty:deepLink:ssh", handler);
    return () => ipcRenderer.removeListener("netcatty:deepLink:ssh", handler);
  },
  onTelnetDeepLink: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("netcatty:deepLink:telnet", handler);
    return () => ipcRenderer.removeListener("netcatty:deepLink:telnet", handler);
  },
  onOpenTerminalPath: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("netcatty:openTerminalPath", handler);
    return () => ipcRenderer.removeListener("netcatty:openTerminalPath", handler);
  },
  setSshDeepLinkEnabled: (enabled) =>
    ipcRenderer.invoke("netcatty:deepLink:ssh:setEnabled", { enabled }),
  getSshDeepLinkEnabled: () =>
    ipcRenderer.invoke("netcatty:deepLink:ssh:getEnabled"),

  onJmsDeepLink: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("netcatty:deepLink:jms", handler);
    return () => ipcRenderer.removeListener("netcatty:deepLink:jms", handler);
  },
  setJmsDeepLinkEnabled: (enabled) =>
    ipcRenderer.invoke("netcatty:deepLink:jms:setEnabled", { enabled }),
  getJmsDeepLinkEnabled: () =>
    ipcRenderer.invoke("netcatty:deepLink:jms:getEnabled"),

  setExplorerContextMenuEnabled: (enabled) =>
    ipcRenderer.invoke("netcatty:explorerContextMenu:setEnabled", { enabled }),
  getExplorerContextMenuEnabled: () =>
    ipcRenderer.invoke("netcatty:explorerContextMenu:getEnabled"),

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
  subscribePortForward: async (tunnelId) => {
    return ipcRenderer.invoke("netcatty:portforward:subscribe", { tunnelId });
  },
  listPortForwards: async () => {
    return ipcRenderer.invoke("netcatty:portforward:list");
  },
  getPortForwardSnapshot: async () => {
    return ipcRenderer.invoke("netcatty:portforward:snapshot");
  },
  subscribePortForwardRuntime: async () => {
    return ipcRenderer.invoke("netcatty:portforward:subscribeRuntime");
  },
  unsubscribePortForwardRuntime: async () => {
    return ipcRenderer.invoke("netcatty:portforward:unsubscribeRuntime");
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
  onPortForwardRuntime: (cb) => {
    portForwardRuntimeListeners.add(cb);
    return () => {
      portForwardRuntimeListeners.delete(cb);
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
  githubDownloadGistRawContent: (options) => ipcRenderer.invoke("netcatty:github:gistRawContent", options),

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
  downloadSftpToTempWithProgress: (sftpId, remotePath, fileName, encoding, transferId) =>
    ipcRenderer.invoke("netcatty:sftp:downloadToTempWithProgress", {
      sftpId,
      remotePath,
      fileName,
      encoding,
      transferId,
    }),

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
  unregisterTempFile: (sftpId, localPath) =>
    ipcRenderer.invoke("netcatty:filewatch:unregisterTempFile", { sftpId, localPath }),
  onFileWatchSynced: (cb) => {
    fileWatchSyncedListeners.add(cb);
    return () => fileWatchSyncedListeners.delete(cb);
  },
  onFileWatchError: (cb) => {
    fileWatchErrorListeners.add(cb);
    return () => fileWatchErrorListeners.delete(cb);
  },
  onFileWatchStopped: (cb) => {
    fileWatchStoppedListeners.add(cb);
    return () => fileWatchStoppedListeners.delete(cb);
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
  getToolOutputPersistenceStatus: () =>
    ipcRenderer.invoke("netcatty:tempdir:toolOutputPersistenceStatus"),
  writeToolOutputTemp: (record, content) =>
    ipcRenderer.invoke("netcatty:tempdir:toolOutputWrite", { record, content }),
  restoreToolOutputTemp: (handleId, chatSessionId) =>
    ipcRenderer.invoke("netcatty:tempdir:toolOutputRestore", { handleId, chatSessionId }),
  readToolOutputTemp: (filePath, request) =>
    ipcRenderer.invoke("netcatty:tempdir:toolOutputRead", { path: filePath, request }),
  deleteToolOutputTemp: (filePath) =>
    ipcRenderer.invoke("netcatty:tempdir:toolOutputDelete", { path: filePath }),
  deleteChatToolOutputsTemp: (chatSessionId) =>
    ipcRenderer.invoke("netcatty:tempdir:toolOutputDeleteSession", { chatSessionId }),
  deleteTerminalToolOutputsTemp: (chatSessionId, terminalSessionId) =>
    ipcRenderer.invoke("netcatty:tempdir:toolOutputDeleteTerminalSession", { chatSessionId, terminalSessionId }),
  deleteTerminalToolOutputsEverywhereTemp: (terminalSessionId) =>
    ipcRenderer.invoke("netcatty:tempdir:toolOutputDeleteTerminal", { terminalSessionId }),

  // Session Logs
  exportSessionLog: (payload) =>
    ipcRenderer.invoke("netcatty:sessionLogs:export", payload),
  selectSessionLogsDir: () =>
    ipcRenderer.invoke("netcatty:sessionLogs:selectDir"),
  autoSaveSessionLog: (payload) =>
    ipcRenderer.invoke("netcatty:sessionLogs:autoSave", payload),
  openSessionLogsDir: (directory) =>
    ipcRenderer.invoke("netcatty:sessionLogs:openDir", { directory }),
  clearSessionLogsDir: (directory) =>
    ipcRenderer.invoke("netcatty:sessionLogs:clear", { directory }),
  startManualSessionLog: (payload) =>
    ipcRenderer.invoke("netcatty:sessionLog:manualStart", payload),
  stopManualSessionLog: (payload) =>
    ipcRenderer.invoke("netcatty:sessionLog:manualStop", payload),
  getManualSessionLogStatus: (payload) =>
    ipcRenderer.invoke("netcatty:sessionLog:manualStatus", payload),

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

  // App-level HTTP(S) network proxy (cloud sync / AI providers)
  setHttpNetworkProxy: (settings) =>
    ipcRenderer.invoke("netcatty:networkProxy:set", settings),
  getHttpNetworkProxy: () =>
    ipcRenderer.invoke("netcatty:networkProxy:get"),
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
  onTrayPanelCloseSession: (callback) => {
    const handler = (_event, sessionId) => callback(sessionId);
    ipcRenderer.on("netcatty:trayPanel:closeSession", handler);
    return () => ipcRenderer.removeListener("netcatty:trayPanel:closeSession", handler);
  },

  // Tray panel window
  hideTrayPanel: () => ipcRenderer.invoke("netcatty:trayPanel:hide"),
  openMainWindow: () => ipcRenderer.invoke("netcatty:trayPanel:openMainWindow"),
  quitApp: () => ipcRenderer.invoke("netcatty:trayPanel:quitApp"),
  jumpToSessionFromTrayPanel: (sessionId) =>
    ipcRenderer.invoke("netcatty:trayPanel:jumpToSession", sessionId),
  connectToHostFromTrayPanel: (hostId) =>
    ipcRenderer.invoke("netcatty:trayPanel:connectToHost", hostId),
  closeSessionFromTrayPanel: (sessionId) =>
    ipcRenderer.invoke("netcatty:trayPanel:closeSession", sessionId),
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
  stageUploadFile: async (file, transferId) => {
    uploadStageControllers.get(transferId)?.abort(new Error("Upload staging superseded"));
    const controller = new AbortController();
    uploadStageControllers.set(transferId, controller);
    let localPath = null;
    try {
      localPath = await ipcRenderer.invoke("netcatty:tempdir:createUploadPath", {
        transferId: `${transferId}-${randomUUID()}`,
        fileName: file?.name || "upload.bin",
      });
      return await stageRendererFileToTemp(file, localPath, fs, controller.signal);
    } catch (error) {
      if (localPath) {
        await ipcRenderer.invoke("netcatty:deleteTempFile", { filePath: localPath }).catch(() => {});
      }
      throw error;
    } finally {
      if (uploadStageControllers.get(transferId) === controller) {
        uploadStageControllers.delete(transferId);
      }
    }
  },
  cancelStagedUploadFile: async (transferId) => {
    const controller = uploadStageControllers.get(transferId);
    if (!controller) return { success: false };
    controller.abort(new Error("Upload staging cancelled"));
    return { success: true };
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
  readClipboardImage: async () => {
    return ipcRenderer.invoke("netcatty:clipboard:readImage");
  },
  hasClipboardImage: async () => {
    return ipcRenderer.invoke("netcatty:clipboard:hasImage");
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
  aiSetChatSessionCancelled: async (chatSessionId, cancelled = true) => {
    return ipcRenderer.invoke("netcatty:ai:chat-session:set-cancelled", { chatSessionId, cancelled });
  },
  aiCapability: async (rpcMethod, params, chatSessionId) => {
    return ipcRenderer.invoke("netcatty:ai:capability", { rpcMethod, params, chatSessionId });
  },
  aiDiscoverAgents: async (options) => {
    return ipcRenderer.invoke("netcatty:ai:agents:discover", options);
  },
  aiPrewarmShellEnv: async () => {
    return ipcRenderer.invoke("netcatty:ai:shell-env:prewarm");
  },
  aiResolveCli: async (params) => {
    return ipcRenderer.invoke("netcatty:ai:resolve-cli", params);
  },
  aiCodexGetIntegration: async (options) => {
    return ipcRenderer.invoke("netcatty:ai:codex:get-integration", options);
  },
  aiCodexStartLogin: async (options) => {
    return ipcRenderer.invoke("netcatty:ai:codex:start-login", options);
  },
  aiCodexGetLoginSession: async (sessionId) => {
    return ipcRenderer.invoke("netcatty:ai:codex:get-login-session", { sessionId });
  },
  aiCodexCancelLogin: async (sessionId) => {
    return ipcRenderer.invoke("netcatty:ai:codex:cancel-login", { sessionId });
  },
  aiCodexLogout: async (options) => {
    return ipcRenderer.invoke("netcatty:ai:codex:logout", options);
  },
  // External MCP (productized catalog MCP for Codex / Claude Code / Cursor / Grok)
  externalMcpGetStatus: async () => {
    return ipcRenderer.invoke("netcatty:external-mcp:get-status");
  },
  externalMcpSetEnabled: async (enabled) => {
    return ipcRenderer.invoke("netcatty:external-mcp:set-enabled", { enabled });
  },
  externalMcpSetConfig: async (config) => {
    return ipcRenderer.invoke("netcatty:external-mcp:set-config", config || {});
  },
  externalMcpCodexGetStatus: async () => {
    return ipcRenderer.invoke("netcatty:external-mcp:codex:get-status");
  },
  externalMcpCodexAdd: async () => {
    return ipcRenderer.invoke("netcatty:external-mcp:codex:add");
  },
  externalMcpClaudeGetStatus: async () => {
    return ipcRenderer.invoke("netcatty:external-mcp:claude:get-status");
  },
  externalMcpClaudeAdd: async () => {
    return ipcRenderer.invoke("netcatty:external-mcp:claude:add");
  },
  externalMcpGrokGetStatus: async () => {
    return ipcRenderer.invoke("netcatty:external-mcp:grok:get-status");
  },
  externalMcpGrokAdd: async () => {
    return ipcRenderer.invoke("netcatty:external-mcp:grok:add");
  },
  // MCP Server session metadata
  aiMcpUpdateSessions: async (sessions, chatSessionId) => {
    return ipcRenderer.invoke("netcatty:ai:mcp:update-sessions", { sessions, chatSessionId });
  },
  aiMcpMergeSessions: async (sessions, chatSessionId) => {
    return ipcRenderer.invoke("netcatty:ai:mcp:merge-sessions", { sessions, chatSessionId });
  },
  aiMcpUpdateAttachments: async (attachments, chatSessionId) => {
    return ipcRenderer.invoke("netcatty:ai:mcp:update-attachments", { attachments, chatSessionId });
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
  aiMcpSyncPermissionGrants: async (grants) => {
    return ipcRenderer.invoke("netcatty:ai:mcp:sync-permission-grants", { grants });
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
  cancelMcpApprovalTimeout: async (approvalId) => {
    return ipcRenderer.invoke("netcatty:ai:mcp:approval-cancel-timeout", { approvalId });
  },
  // MCP approval cleared: main process timed out or cancelled an approval
  onMcpApprovalCleared: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("netcatty:ai:mcp:approval-cleared", handler);
    return () => ipcRenderer.removeListener("netcatty:ai:mcp:approval-cleared", handler);
  },
  onVaultAgentRequest: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("netcatty:ai:vault-agent:request", handler);
    return () => ipcRenderer.removeListener("netcatty:ai:vault-agent:request", handler);
  },
  respondVaultAgent: async (requestId, result) => {
    return ipcRenderer.invoke("netcatty:ai:vault-agent:response", { requestId, result });
  },
  // SDK external agent streaming
  aiSdkAgentStream: async (requestId, chatSessionId, sdkBackend, prompt, cwd, providerId, model, existingSessionId, historyMessages, images, toolIntegrationMode, defaultTargetSession, userSkillsContext, agentEnv, agentCommand, codexRuntime, permissionMode, codebuddyOptions) => {
    const advanced = codebuddyOptions && typeof codebuddyOptions === "object"
      ? {
          effort: codebuddyOptions.effort,
          maxTurns: codebuddyOptions.maxTurns,
          maxBudgetUsd: codebuddyOptions.maxBudgetUsd,
          fallbackModel: codebuddyOptions.fallbackModel,
          sandbox: codebuddyOptions.sandbox,
          enableFileCheckpointing: codebuddyOptions.enableFileCheckpointing,
        }
      : {};
    return ipcRenderer.invoke("netcatty:ai:sdk-agent:stream", {
      requestId,
      chatSessionId,
      sdkBackend,
      prompt,
      cwd,
      providerId,
      model,
      existingSessionId,
      historyMessages,
      images,
      toolIntegrationMode,
      defaultTargetSession,
      userSkillsContext,
      agentEnv,
      agentCommand,
      codexRuntime,
      permissionMode,
      ...advanced,
    });
  },
  aiSdkAgentSteer: async (requestId, chatSessionId, prompt, images, clientUserMessageId) => {
    return ipcRenderer.invoke("netcatty:ai:sdk-agent:steer", {
      requestId,
      chatSessionId,
      prompt,
      images,
      clientUserMessageId,
    });
  },
  aiSdkAgentListModels: async (sdkBackend, cwd, providerId, chatSessionId, agentEnv, agentCommand, codexRuntime) => {
    return ipcRenderer.invoke("netcatty:ai:sdk-agent:list-models", { sdkBackend, cwd, providerId, chatSessionId, agentEnv, agentCommand, codexRuntime });
  },
  codexAppServerGetStatus: async (agentCommand, agentEnv) => {
    return ipcRenderer.invoke("netcatty:ai:codex-app-server:status", { agentCommand, agentEnv });
  },
  onCodexAppServerInteractionRequest: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("netcatty:ai:codex-app-server:interaction-request", handler);
    return () => ipcRenderer.removeListener("netcatty:ai:codex-app-server:interaction-request", handler);
  },
  onCodexAppServerInteractionCleared: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("netcatty:ai:codex-app-server:interaction-cleared", handler);
    return () => ipcRenderer.removeListener("netcatty:ai:codex-app-server:interaction-cleared", handler);
  },
  respondCodexAppServerInteraction: async (payload) => {
    return ipcRenderer.invoke("netcatty:ai:codex-app-server:interaction-response", payload);
  },
  cancelCodexAppServerInteractionTimeout: async (interactionId) => {
    return ipcRenderer.invoke("netcatty:ai:codex-app-server:interaction-cancel-timeout", { interactionId });
  },
  aiSdkAgentCancel: async (requestId, chatSessionId) => {
    return ipcRenderer.invoke("netcatty:ai:sdk-agent:cancel", { requestId, chatSessionId });
  },
  aiSdkAgentCleanup: async (chatSessionId) => {
    return ipcRenderer.invoke("netcatty:ai:sdk-agent:cleanup", { chatSessionId });
  },
  aiSdkAgentElicitationResponse: async (elicitationId, action, content) => {
    return ipcRenderer.invoke("netcatty:ai:sdk-agent:elicitation-response", { elicitationId, action, content });
  },
  aiSdkAgentMcpStatus: async (agentEnv, agentCommand) => {
    return ipcRenderer.invoke("netcatty:ai:sdk-agent:mcp-status", { agentEnv, agentCommand });
  },
  aiSdkAgentAccountInfo: async (agentEnv, agentCommand) => {
    return ipcRenderer.invoke("netcatty:ai:sdk-agent:account-info", { agentEnv, agentCommand });
  },
  aiSdkAgentPluginInstall: async (options) => {
    return ipcRenderer.invoke("netcatty:ai:sdk-agent:plugin-install", { options });
  },
  aiSdkAgentPluginEnable: async (name, marketplace) => {
    return ipcRenderer.invoke("netcatty:ai:sdk-agent:plugin-enable", { name, marketplace });
  },
  aiSdkAgentPluginDisable: async (name, marketplace) => {
    return ipcRenderer.invoke("netcatty:ai:sdk-agent:plugin-disable", { name, marketplace });
  },
  aiSdkAgentMarketplaceInstall: async (options) => {
    return ipcRenderer.invoke("netcatty:ai:sdk-agent:marketplace-install", { options });
  },
  aiSdkAgentMarketplaceRemove: async (options) => {
    return ipcRenderer.invoke("netcatty:ai:sdk-agent:marketplace-remove", { options });
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
  scriptRun: async (params) => ipcRenderer.invoke("netcatty:script:run", params),
  scriptStop: async (runId) => ipcRenderer.invoke("netcatty:script:stop", { runId }),
  scriptPause: async (runId) => ipcRenderer.invoke("netcatty:script:pause", { runId }),
  scriptResume: async (runId) => ipcRenderer.invoke("netcatty:script:resume", { runId }),
  scriptGetRuns: async (sessionId) => ipcRenderer.invoke("netcatty:script:get-runs", sessionId ? { sessionId } : {}),
  scriptDialogResponse: async (requestId, value, cancelled) =>
    ipcRenderer.invoke("netcatty:script:dialog-response", { requestId, value, cancelled }),
  scriptScreenSnapshotResponse: async (requestId, snapshot) =>
    ipcRenderer.invoke("netcatty:script:screen-snapshot-response", { requestId, snapshot }),
  scriptRecordingStart: async (sessionId) => ipcRenderer.invoke("netcatty:script:recording:start", { sessionId }),
  scriptRecordingStop: async (sessionId) => ipcRenderer.invoke("netcatty:script:recording:stop", { sessionId }),
  scriptRecordingAppendStep: async (sessionId, step) =>
    ipcRenderer.invoke("netcatty:script:recording:append-step", { sessionId, step }),
  onScriptRunsUpdated: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("netcatty:script:runs-updated", handler);
    return () => ipcRenderer.removeListener("netcatty:script:runs-updated", handler);
  },
  onScriptDialogRequest: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("netcatty:script:dialog-request", handler);
    return () => ipcRenderer.removeListener("netcatty:script:dialog-request", handler);
  },
  onScriptScreenSnapshotRequest: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("netcatty:script:screen-snapshot-request", handler);
    return () => ipcRenderer.removeListener("netcatty:script:screen-snapshot-request", handler);
  },
  onScriptSessionInput: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("netcatty:script:session-input", handler);
    return () => ipcRenderer.removeListener("netcatty:script:session-input", handler);
  },
    };
  }
}

module.exports = { createPreloadApi };
