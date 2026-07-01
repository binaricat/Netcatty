"use strict";

const crypto = require("node:crypto");

const { createPublicSessionRegistry } = require("./publicMcpBridge/sessionRegistry.cjs");
const { createPublicTerminalHandlers } = require("./publicMcpBridge/terminalHandlers.cjs");
const { createPublicSftpHandlers } = require("./publicMcpBridge/sftpHandlers.cjs");
const { createPublicRpcHandlers } = require("./publicMcpBridge/rpcHandlers.cjs");
const { createPublicTcpServer } = require("./publicMcpBridge/tcpServer.cjs");
const { writePublicDiscovery, removePublicDiscovery } = require("./publicMcpBridge/discovery.cjs");
const { createPublicMcpCodexSetup } = require("./publicMcpBridge/codexSetup.cjs");
const { createPublicMcpClaudeSetup } = require("./publicMcpBridge/claudeSetup.cjs");
const { getPublicMcpLauncherPath } = require("../cli/publicMcpDiscoveryPath.cjs");

let mainWebContentsId = null;
const PUBLIC_MCP_MODE_TEMPORARY = "temporary";
const PUBLIC_MCP_MODE_PERSISTENT = "persistent";
const DEFAULT_PUBLIC_MCP_IDLE_TIMEOUT_MINUTES = 10;
const MIN_PUBLIC_MCP_IDLE_TIMEOUT_MINUTES = 1;
const MAX_PUBLIC_MCP_IDLE_TIMEOUT_MINUTES = 24 * 60;

function loadPtyExecDeps() {
  return require("./ai/ptyExec.cjs");
}

function loadShellUtilsDeps() {
  return require("./ai/shellUtils.cjs");
}

function loadIpcUtilsDeps() {
  return require("./ipcUtils.cjs");
}

function validateSenderOrSettings(event) {
  try {
    const windowManager = require("./windowManager.cjs");
    const mainWin = windowManager.getMainWindow?.();
    if (mainWin && !mainWin.isDestroyed?.()) {
      mainWebContentsId = mainWin.webContents?.id ?? null;
    }

    const senderId = event?.sender?.id;
    if (senderId == null) return false;
    if (mainWebContentsId != null && senderId === mainWebContentsId) return true;

    const settingsWin = windowManager.getSettingsWindow?.();
    if (settingsWin && !settingsWin.isDestroyed?.()) {
      if (senderId === settingsWin.webContents?.id) return true;
    }

    return false;
  } catch {
    return false;
  }
}

function normalizePublicMcpMode(value) {
  return value === PUBLIC_MCP_MODE_PERSISTENT ? PUBLIC_MCP_MODE_PERSISTENT : PUBLIC_MCP_MODE_TEMPORARY;
}

function normalizeIdleTimeoutMinutes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PUBLIC_MCP_IDLE_TIMEOUT_MINUTES;
  return Math.min(
    MAX_PUBLIC_MCP_IDLE_TIMEOUT_MINUTES,
    Math.max(MIN_PUBLIC_MCP_IDLE_TIMEOUT_MINUTES, Math.round(parsed)),
  );
}

function createPublicMcpBridge(overrides = {}) {
  const usesDefaultTerminalHandlerFactory = !overrides.createPublicTerminalHandlers;
  let lazyPtyExecDeps = null;
  let lazyShellUtilsDeps = null;
  let lazyIpcUtilsDeps = null;
  const getPtyExecDeps = () => {
    if (!lazyPtyExecDeps) lazyPtyExecDeps = loadPtyExecDeps();
    return lazyPtyExecDeps;
  };
  const getShellUtilsDeps = () => {
    if (!lazyShellUtilsDeps) lazyShellUtilsDeps = loadShellUtilsDeps();
    return lazyShellUtilsDeps;
  };
  const getIpcUtilsDeps = () => {
    if (!lazyIpcUtilsDeps) lazyIpcUtilsDeps = loadIpcUtilsDeps();
    return lazyIpcUtilsDeps;
  };

  const deps = {
    crypto,
    createSessionRegistry: overrides.createSessionRegistry || createPublicSessionRegistry,
    createPublicTerminalHandlers: overrides.createPublicTerminalHandlers || createPublicTerminalHandlers,
    createPublicSftpHandlers: overrides.createPublicSftpHandlers || createPublicSftpHandlers,
    createPublicRpcHandlers: overrides.createPublicRpcHandlers || createPublicRpcHandlers,
    createPublicTcpServer: overrides.createPublicTcpServer || createPublicTcpServer,
    createPublicMcpCodexSetup: overrides.createPublicMcpCodexSetup || createPublicMcpCodexSetup,
    createPublicMcpClaudeSetup: overrides.createPublicMcpClaudeSetup || createPublicMcpClaudeSetup,
    writePublicDiscovery: overrides.writePublicDiscovery || writePublicDiscovery,
    removePublicDiscovery: overrides.removePublicDiscovery || removePublicDiscovery,
    getPublicMcpLauncherPath: overrides.getPublicMcpLauncherPath || getPublicMcpLauncherPath,
    execViaPty: overrides.execViaPty || null,
    startPtyJob: overrides.startPtyJob || null,
    getFreshIdlePrompt: overrides.getFreshIdlePrompt || null,
    safeSend: overrides.safeSend || null,
    validateSenderOrSettings: overrides.validateSenderOrSettings || validateSenderOrSettings,
    randomBytes: overrides.randomBytes || ((size) => deps.crypto.randomBytes(size)),
    Date: overrides.Date || Date,
    setTimeout: overrides.setTimeout || setTimeout,
    clearTimeout: overrides.clearTimeout || clearTimeout,
  };

  let sessions = new Map();
  let electronModule = null;
  let sftpBridge = null;
  let discoveryFilePath = null;
  let commandTimeoutMs = 60000;
  let mcpServerBridge = null;

  let enabled = false;
  let state = "disabled";
  let error = null;
  let host = "127.0.0.1";
  let port = null;
  let token = null;
  let startPromise = null;
  let stopPromise = null;
  let mode = PUBLIC_MCP_MODE_TEMPORARY;
  let idleTimeoutMinutes = DEFAULT_PUBLIC_MCP_IDLE_TIMEOUT_MINUTES;
  let lastActivityAt = null;
  let idleExpiresAt = null;
  let idleTimer = null;
  let tcpServer = null;
  let registry = null;
  let terminalHandlers = null;
  let sftpHandlers = null;
  let rpcHandlers = null;
  let codexSetup = null;
  let claudeSetup = null;
  const activePublicSftpOps = new Set();

  function getCommandTimeoutMs() {
    return mcpServerBridge?.getCommandTimeoutMs?.() || commandTimeoutMs;
  }

  function getPermissionMode() {
    return mcpServerBridge?.getPermissionMode?.() || "confirm";
  }

  function getApprovalTimeoutMs() {
    return mcpServerBridge?.getApprovalTimeoutMs?.() || null;
  }

  async function requestApproval({ method, params }) {
    if (typeof mcpServerBridge?.requestApproval !== "function") {
      return false;
    }
    return await mcpServerBridge.requestApproval(
      method,
      params || {},
      undefined,
    );
  }

  function clearIdleTimer() {
    if (!idleTimer) return;
    deps.clearTimeout(idleTimer);
    idleTimer = null;
  }

  function getNow() {
    return deps.Date.now();
  }

  function scheduleIdleShutdown() {
    clearIdleTimer();
    if (!enabled || state !== "running" || mode !== PUBLIC_MCP_MODE_TEMPORARY) {
      idleExpiresAt = null;
      return;
    }

    const now = getNow();
    if (!lastActivityAt) {
      lastActivityAt = now;
    }
    idleExpiresAt = lastActivityAt + idleTimeoutMinutes * 60 * 1000;
    const delayMs = Math.max(0, idleExpiresAt - now);
    idleTimer = deps.setTimeout(() => {
      idleTimer = null;
      void setEnabled(false);
    }, delayMs);
  }

  function recordActivity() {
    lastActivityAt = getNow();
    scheduleIdleShutdown();
  }

  function ensureRuntime() {
    if (registry && terminalHandlers && sftpHandlers && rpcHandlers) {
      return;
    }

    registry = deps.createSessionRegistry({ sessions });
    const terminalHandlerDeps = {
      registry,
      electronModule,
      reserveSessionExecution: (...args) => mcpServerBridge?.reserveSessionExecution?.(...args),
      releaseSessionExecution: (...args) => mcpServerBridge?.releaseSessionExecution?.(...args),
      getSessionBusyError: (...args) => mcpServerBridge?.getSessionBusyError?.(...args),
      checkCommandSafety: (...args) => mcpServerBridge?.checkCommandSafety?.(...args),
      commandTimeoutMs,
      getCommandTimeoutMs,
      crypto: deps.crypto,
      Date,
    };
    if (usesDefaultTerminalHandlerFactory) {
      terminalHandlerDeps.execViaPty = deps.execViaPty || getPtyExecDeps().execViaPty;
      terminalHandlerDeps.startPtyJob = deps.startPtyJob || getPtyExecDeps().startPtyJob;
      terminalHandlerDeps.getFreshIdlePrompt = deps.getFreshIdlePrompt || getShellUtilsDeps().getFreshIdlePrompt;
      terminalHandlerDeps.safeSend = deps.safeSend || getIpcUtilsDeps().safeSend;
    }
    terminalHandlers = deps.createPublicTerminalHandlers(terminalHandlerDeps);
    sftpHandlers = deps.createPublicSftpHandlers({
      registry,
      sftpBridge,
      commandTimeoutMs,
      getCommandTimeoutMs,
      AbortController,
      setTimeout,
      clearTimeout,
      registerPublicSftpOp(cancel) {
        activePublicSftpOps.add(cancel);
        return () => activePublicSftpOps.delete(cancel);
      },
    });
    rpcHandlers = deps.createPublicRpcHandlers({
      registry,
      terminalHandlers,
      sftpHandlers,
      commandTimeoutMs,
      getCommandTimeoutMs,
      getPermissionMode,
      getApprovalTimeoutMs,
      requestApproval,
      dispatchCapabilityRpc: async (...args) => {
        if (typeof mcpServerBridge?.dispatchCapabilityRpc !== "function") {
          return { ok: false, error: "Public MCP asset capabilities are unavailable." };
        }
        return await mcpServerBridge.dispatchCapabilityRpc(...args);
      },
      getEnabled: () => enabled,
    });
    if (!codexSetup) {
      codexSetup = deps.createPublicMcpCodexSetup({
        launcherPath: deps.getPublicMcpLauncherPath() || null,
      });
    }
    if (!claudeSetup) {
      claudeSetup = deps.createPublicMcpClaudeSetup({
        launcherPath: deps.getPublicMcpLauncherPath() || null,
      });
    }
  }

  function resetRuntime() {
    registry = null;
    terminalHandlers = null;
    sftpHandlers = null;
    rpcHandlers = null;
  }

  function buildStatus() {
    const activeRegistry = registry || deps.createSessionRegistry({ sessions });
    return {
      ok: true,
      enabled,
      state,
      host,
      port,
      discoveryPath: discoveryFilePath || null,
      launcherPath: deps.getPublicMcpLauncherPath() || null,
      exposedSessionCount: activeRegistry.listPublicSessions().length,
      mode,
      idleTimeoutMinutes,
      lastActivityAt,
      idleExpiresAt,
      error,
    };
  }

  async function stopActiveRuntime() {
    clearIdleTimer();
    idleExpiresAt = null;
    for (const cancel of activePublicSftpOps) {
      try {
        cancel?.();
      } catch {
        // Ignore cancellation failures during shutdown.
      }
      activePublicSftpOps.delete(cancel);
    }
    const cleanupTasks = [];
    if (terminalHandlers?.cleanup) cleanupTasks.push(Promise.resolve(terminalHandlers.cleanup()));
    if (sftpHandlers?.cleanup) cleanupTasks.push(Promise.resolve(sftpHandlers.cleanup()));
    await Promise.allSettled(cleanupTasks);

    if (tcpServer?.stop) {
      await tcpServer.stop();
    }

    tcpServer = null;
    port = null;
    token = null;
    if (discoveryFilePath) {
      deps.removePublicDiscovery(discoveryFilePath);
    }
    resetRuntime();
  }

  async function startRuntime() {
    ensureRuntime();
    const nextToken = deps.randomBytes(16).toString("hex");
    const nextServer = deps.createPublicTcpServer({
      host,
      token: nextToken,
      dispatch: (method, params) => rpcHandlers.dispatch(method, params),
      onActivity: recordActivity,
    });

    const address = await nextServer.start();
    if (!enabled) {
      await nextServer.stop();
      throw new Error("Public MCP was disabled during startup");
    }
    if (!discoveryFilePath) {
      await nextServer.stop();
      throw new Error("Public MCP discovery path is not configured");
    }

    token = nextToken;
    tcpServer = nextServer;
    port = address.port;
    deps.writePublicDiscovery(discoveryFilePath, {
      host,
      port,
      token,
      pid: process.pid,
    });
    lastActivityAt = getNow();
  }

  async function setEnabled(nextEnabled) {
    enabled = Boolean(nextEnabled);

    if (!enabled) {
      if (startPromise) {
        state = "disabled";
        error = null;
        await startPromise.catch(() => {});
      }
      if (stopPromise) {
        await stopPromise;
        return buildStatus();
      }

      state = "disabled";
      error = null;
      stopPromise = stopActiveRuntime().finally(() => {
        stopPromise = null;
      });
      await stopPromise;
      return buildStatus();
    }

    if (state === "running" && tcpServer && port != null) {
      return buildStatus();
    }
    if (startPromise) {
      await startPromise.catch(() => {});
      return buildStatus();
    }

    state = "starting";
    error = null;
    startPromise = startRuntime()
      .then(() => {
        if (!enabled) {
          state = "disabled";
          error = null;
          return;
        }
        state = "running";
        scheduleIdleShutdown();
      })
      .catch(async (startError) => {
        error = startError?.message || String(startError);
        state = enabled ? "error" : "disabled";
        try {
          await stopActiveRuntime();
        } catch {
          // Ignore cleanup failures while surfacing the startup error.
        }
      })
      .finally(() => {
        startPromise = null;
      });

    await startPromise;
    return buildStatus();
  }

  function setConfig(config = {}) {
    const nextMode = config.mode == null ? mode : normalizePublicMcpMode(config.mode);
    const nextIdleTimeoutMinutes = config.idleTimeoutMinutes == null
      ? idleTimeoutMinutes
      : normalizeIdleTimeoutMinutes(config.idleTimeoutMinutes);
    const modeChanged = nextMode !== mode;
    const timeoutChanged = nextIdleTimeoutMinutes !== idleTimeoutMinutes;

    mode = nextMode;
    idleTimeoutMinutes = nextIdleTimeoutMinutes;

    if (modeChanged || timeoutChanged) {
      if (enabled && state === "running") {
        lastActivityAt = getNow();
      }
      scheduleIdleShutdown();
    }

    return buildStatus();
  }

  function getStatus() {
    return buildStatus();
  }

  function init(options) {
    sessions = options.sessions || sessions;
    electronModule = options.electronModule || electronModule;
    sftpBridge = options.sftpBridge || sftpBridge;
    discoveryFilePath = options.discoveryFilePath || discoveryFilePath;
    mcpServerBridge = options.mcpServerBridge || mcpServerBridge;
    commandTimeoutMs = mcpServerBridge?.getCommandTimeoutMs?.() || commandTimeoutMs;
    if (discoveryFilePath) {
      deps.removePublicDiscovery(discoveryFilePath);
    }
    resetRuntime();
    codexSetup = deps.createPublicMcpCodexSetup({
      launcherPath: deps.getPublicMcpLauncherPath() || null,
    });
    claudeSetup = deps.createPublicMcpClaudeSetup({
      launcherPath: deps.getPublicMcpLauncherPath() || null,
    });
  }

  function registerHandlers(ipcMain) {
    ipcMain.handle("netcatty:public-mcp:get-status", async (event) => {
      if (!deps.validateSenderOrSettings(event)) {
        return { ok: false, error: "Unauthorized IPC sender" };
      }
      return getStatus();
    });

    ipcMain.handle("netcatty:public-mcp:set-enabled", async (event, payload) => {
      if (!deps.validateSenderOrSettings(event)) {
        return { ok: false, error: "Unauthorized IPC sender" };
      }
      return await setEnabled(Boolean(payload?.enabled));
    });

    ipcMain.handle("netcatty:public-mcp:set-config", async (event, payload) => {
      if (!deps.validateSenderOrSettings(event)) {
        return { ok: false, error: "Unauthorized IPC sender" };
      }
      return setConfig(payload || {});
    });

    ipcMain.handle("netcatty:public-mcp:codex:get-status", async (event) => {
      if (!deps.validateSenderOrSettings(event)) {
        return { ok: false, error: "Unauthorized IPC sender" };
      }
      return await codexSetup.getStatus();
    });

    ipcMain.handle("netcatty:public-mcp:codex:add", async (event) => {
      if (!deps.validateSenderOrSettings(event)) {
        return { ok: false, error: "Unauthorized IPC sender" };
      }
      return await codexSetup.addToCodex();
    });

    ipcMain.handle("netcatty:public-mcp:claude:get-status", async (event) => {
      if (!deps.validateSenderOrSettings(event)) {
        return { ok: false, error: "Unauthorized IPC sender" };
      }
      return await claudeSetup.getStatus();
    });

    ipcMain.handle("netcatty:public-mcp:claude:add", async (event) => {
      if (!deps.validateSenderOrSettings(event)) {
        return { ok: false, error: "Unauthorized IPC sender" };
      }
      return await claudeSetup.addToClaude();
    });
  }

  async function cleanup() {
    enabled = false;
    state = "disabled";
    error = null;
    clearIdleTimer();
    lastActivityAt = null;
    idleExpiresAt = null;
    if (startPromise) {
      await startPromise.catch(() => {});
    }
    await stopActiveRuntime();
  }

  return {
    init,
    registerHandlers,
    setEnabled,
    setConfig,
    getStatus,
    cleanup,
  };
}

const singleton = createPublicMcpBridge();

module.exports = {
  createPublicMcpBridge,
  init: singleton.init,
  registerHandlers: singleton.registerHandlers,
  setEnabled: singleton.setEnabled,
  setConfig: singleton.setConfig,
  getStatus: singleton.getStatus,
  cleanup: singleton.cleanup,
  normalizePublicMcpMode,
  normalizeIdleTimeoutMinutes,
};
