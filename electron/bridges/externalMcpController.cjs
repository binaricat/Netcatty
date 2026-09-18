"use strict";

const crypto = require("node:crypto");

const {
  getExternalMcpDiscoveryFilePath,
  getExternalMcpLauncherPath,
  EXTERNAL_MCP_CHAT_SESSION_ID,
  buildDiscoveryEnv,
} = require("../cli/externalMcpDiscoveryPath.cjs");
const {
  writeExternalDiscovery,
  removeExternalDiscovery,
} = require("../cli/externalMcpDiscovery.cjs");
const { createExternalMcpCodexSetup } = require("./externalMcp/codexSetup.cjs");
const { createExternalMcpClaudeSetup } = require("./externalMcp/claudeSetup.cjs");
const { createExternalMcpGrokSetup } = require("./externalMcp/grokSetup.cjs");
const {
  readBundledNetcattySkillContent,
} = require("./externalMcp/netcattySkillInstaller.cjs");
const {
  buildUniversalSetupPrompt,
} = require("./externalMcp/universalSetupPrompt.cjs");
const {
  DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES,
  normalizeSessionIdleTimeoutMinutes,
} = require("./mcpServerBridge/sessionIdleManager.cjs");

const EXTERNAL_MCP_MODE_TEMPORARY = "temporary";
const EXTERNAL_MCP_MODE_PERSISTENT = "persistent";
const DEFAULT_IDLE_TIMEOUT_MINUTES = 10;
const MIN_IDLE_TIMEOUT_MINUTES = 1;
const MAX_IDLE_TIMEOUT_MINUTES = 24 * 60;

function normalizeMode(value) {
  return value === EXTERNAL_MCP_MODE_PERSISTENT
    ? EXTERNAL_MCP_MODE_PERSISTENT
    : EXTERNAL_MCP_MODE_TEMPORARY;
}

function normalizeIdleTimeoutMinutes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_IDLE_TIMEOUT_MINUTES;
  return Math.min(
    MAX_IDLE_TIMEOUT_MINUTES,
    Math.max(MIN_IDLE_TIMEOUT_MINUTES, Math.round(parsed)),
  );
}

function createExternalMcpController(options = {}) {
  const deps = {
    mcpServerBridge: options.mcpServerBridge || null,
    getDiscoveryFilePath: options.getDiscoveryFilePath || getExternalMcpDiscoveryFilePath,
    getLauncherPath: options.getLauncherPath || getExternalMcpLauncherPath,
    writeDiscovery: options.writeDiscovery || writeExternalDiscovery,
    removeDiscovery: options.removeDiscovery || removeExternalDiscovery,
    createCodexSetup: options.createCodexSetup || createExternalMcpCodexSetup,
    createClaudeSetup: options.createClaudeSetup || createExternalMcpClaudeSetup,
    createGrokSetup: options.createGrokSetup || createExternalMcpGrokSetup,
    readSkillContent: options.readSkillContent || readBundledNetcattySkillContent,
    buildUniversalSetupPrompt: options.buildUniversalSetupPrompt || buildUniversalSetupPrompt,
    randomBytes: options.randomBytes || ((size) => crypto.randomBytes(size)),
    Date: options.Date || Date,
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout,
    chatSessionId: options.chatSessionId || EXTERNAL_MCP_CHAT_SESSION_ID,
  };

  let discoveryFilePath = null;
  let enabled = false;
  let state = "disabled";
  let error = null;
  let mode = EXTERNAL_MCP_MODE_TEMPORARY;
  let idleTimeoutMinutes = DEFAULT_IDLE_TIMEOUT_MINUTES;
  let sessionIdleTimeoutMinutes = DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES;
  let lastActivityAt = null;
  let idleExpiresAt = null;
  let idleTimer = null;
  let startPromise = null;
  let stopPromise = null;
  let setEnabledChain = Promise.resolve();
  let startGeneration = 0;
  let lastKnownPort = null;
  let lastKnownToken = null;
  let sessionSyncHandler = null;
  let codexSetup = null;
  let claudeSetup = null;
  let grokSetup = null;

  function getNow() {
    return deps.Date.now();
  }

  function clearIdleTimer() {
    if (!idleTimer) return;
    deps.clearTimeout(idleTimer);
    idleTimer = null;
  }

  function scheduleIdleShutdown() {
    clearIdleTimer();
    if (!enabled || state !== "running" || mode !== EXTERNAL_MCP_MODE_TEMPORARY) {
      idleExpiresAt = null;
      return;
    }
    const now = getNow();
    if (!lastActivityAt) lastActivityAt = now;
    idleExpiresAt = lastActivityAt + idleTimeoutMinutes * 60 * 1000;
    const delayMs = Math.max(0, idleExpiresAt - now);
    idleTimer = deps.setTimeout(() => {
      idleTimer = null;
      void setEnabled(false);
    }, delayMs);
  }

  function recordActivity() {
    if (!enabled) return;
    lastActivityAt = getNow();
    scheduleIdleShutdown();
  }

  function ensureClientSetup() {
    const launcherPath = deps.getLauncherPath() || null;
    const discoveryEnv = buildDiscoveryEnv(discoveryFilePath);
    if (!codexSetup) {
      codexSetup = deps.createCodexSetup({ launcherPath, discoveryEnv });
    }
    if (!claudeSetup) {
      claudeSetup = deps.createClaudeSetup({ launcherPath, discoveryEnv });
    }
    if (!grokSetup) {
      grokSetup = deps.createGrokSetup({ launcherPath, discoveryEnv });
    }
  }

  function getBridge() {
    return deps.mcpServerBridge;
  }

  function getExposedSessionCount() {
    const bridge = getBridge();
    if (!bridge?.getScopedSessionIds) return 0;
    return bridge.getScopedSessionIds(deps.chatSessionId).length;
  }

  function buildStatus() {
    const bridge = getBridge();
    const hostRunning = Boolean(bridge && typeof bridge.getOrCreateHost === "function" && lastKnownPort);
    return {
      ok: true,
      enabled,
      state,
      host: "127.0.0.1",
      port: lastKnownPort,
      discoveryPath: discoveryFilePath || null,
      launcherPath: deps.getLauncherPath() || null,
      chatSessionId: deps.chatSessionId,
      exposedSessionCount: getExposedSessionCount(),
      mode,
      idleTimeoutMinutes,
      sessionIdleTimeoutMinutes,
      lastActivityAt,
      idleExpiresAt,
      permissionMode: bridge?.getPermissionMode?.() || "confirm",
      hostRunning,
      error,
    };
  }

  function writeDiscoveryFromBridge() {
    const bridge = getBridge();
    if (!discoveryFilePath || !bridge) return null;
    // Prefer live host credentials from bridge module state via buildMcpServerConfig side channel.
    // getOrCreateHost already started; read port/token from discovery write inputs we track.
    if (lastKnownPort == null || !lastKnownToken) return null;
    return deps.writeDiscovery(discoveryFilePath, {
      host: "127.0.0.1",
      port: lastKnownPort,
      token: lastKnownToken,
      pid: process.pid,
      permissionMode: bridge.getPermissionMode?.() || "confirm",
      chatSessionId: deps.chatSessionId,
    });
  }

  async function resolveHostCredentials() {
    const bridge = getBridge();
    if (!bridge?.getOrCreateHost) {
      throw new Error("MCP bridge is unavailable.");
    }
    const port = await bridge.getOrCreateHost();
    // External MCP uses a dedicated token (rotated on enable) so disable can
    // invalidate discovery without rotating the shared Catty/CLI TCP token.
    const token = typeof bridge.issueExternalMcpAuthToken === "function"
      ? bridge.issueExternalMcpAuthToken()
      : (typeof bridge.getExternalMcpAuthToken === "function" ? bridge.getExternalMcpAuthToken() : "");
    if (!port || !token) {
      throw new Error("Failed to resolve MCP bridge port/token for external mode.");
    }
    lastKnownPort = port;
    lastKnownToken = token;
    return { port, token };
  }

  async function startRuntime() {
    if (!discoveryFilePath) {
      throw new Error("External MCP discovery path is not configured.");
    }
    await resolveHostCredentials();
    if (!enabled) {
      throw new Error("External MCP was disabled during startup.");
    }
    writeDiscoveryFromBridge();
    lastActivityAt = getNow();
    if (typeof sessionSyncHandler === "function") {
      await sessionSyncHandler();
    }
  }

  async function stopActiveRuntime() {
    clearIdleTimer();
    idleExpiresAt = null;
    lastKnownPort = null;
    lastKnownToken = null;
    if (discoveryFilePath) {
      deps.removeDiscovery(discoveryFilePath);
    }
    const bridge = getBridge();
    // Soft revoke: rotate/clear the external token and reject reserved-scope
    // RPCs while disabled. Keep TCP sockets alive so long-lived stdio clients
    // can resume after re-enable without restarting Codex/Claude/Grok.
    if (typeof bridge?.revokeExternalMcpAuthToken === "function") {
      try {
        bridge.revokeExternalMcpAuthToken();
      } catch {
        // Best-effort token revoke.
      }
    }
    if (typeof bridge?.cancelPtyExecsForSession === "function") {
      try {
        bridge.cancelPtyExecsForSession(deps.chatSessionId);
      } catch {
        // Best-effort exec cancel.
      }
    }
    if (typeof bridge?.cancelBackgroundJobsForSession === "function") {
      try {
        bridge.cancelBackgroundJobsForSession(deps.chatSessionId);
      } catch {
        // Best-effort background job cancel.
      }
    }
    if (typeof bridge?.cancelWorkerBackgroundJobsForSession === "function") {
      try {
        bridge.cancelWorkerBackgroundJobsForSession(deps.chatSessionId);
      } catch {
        // Best-effort worker job cancel.
      }
    }
    if (typeof bridge?.cancelSftpOpsForSession === "function") {
      try {
        await bridge.cancelSftpOpsForSession(deps.chatSessionId);
      } catch {
        // Best-effort SFTP cancel.
      }
    }
    if (typeof bridge?.setChatSessionCancelled === "function") {
      try {
        bridge.setChatSessionCancelled(deps.chatSessionId, true);
      } catch {
        // Best-effort cancel flag.
      }
    }
    if (typeof bridge?.clearPendingApprovals === "function") {
      try {
        bridge.clearPendingApprovals(deps.chatSessionId);
      } catch {
        // Best-effort approval revoke.
      }
    }
    if (bridge?.cleanupScopedMetadata) {
      await bridge.cleanupScopedMetadata(deps.chatSessionId);
    }
    // cleanupScopedMetadata clears cancelledChatSessions; re-assert cancel so
    // soft-revoke still blocks in-flight external work after metadata wipe.
    if (typeof bridge?.setChatSessionCancelled === "function") {
      try {
        bridge.setChatSessionCancelled(deps.chatSessionId, true);
      } catch {
        // Best-effort cancel flag.
      }
    }
  }

  async function setEnabledUnlocked(nextEnabled) {
    const wantEnabled = Boolean(nextEnabled);
    enabled = wantEnabled;

    if (!wantEnabled) {
      startGeneration += 1;
      if (startPromise) {
        state = "disabled";
        error = null;
        await startPromise.catch(() => {});
      }
      if (stopPromise) {
        await stopPromise;
      }
      state = "disabled";
      error = null;
      stopPromise = stopActiveRuntime().finally(() => {
        stopPromise = null;
      });
      await stopPromise;
      return buildStatus();
    }

    if (state === "running" && lastKnownPort != null && lastKnownToken) {
      writeDiscoveryFromBridge();
      scheduleIdleShutdown();
      return buildStatus();
    }
    if (stopPromise) {
      await stopPromise;
    }
    if (!enabled) {
      return buildStatus();
    }
    if (startPromise) {
      await startPromise.catch(() => {});
      if (!enabled) {
        return buildStatus();
      }
      if (state === "running" && lastKnownPort != null && lastKnownToken) {
        writeDiscoveryFromBridge();
        scheduleIdleShutdown();
        return buildStatus();
      }
    }

    const generation = ++startGeneration;
    state = "starting";
    error = null;
    const bridgeForEnable = getBridge();
    if (typeof bridgeForEnable?.setChatSessionCancelled === "function") {
      try {
        bridgeForEnable.setChatSessionCancelled(deps.chatSessionId, false);
      } catch {
        // Best-effort clear of a previous disable cancel flag.
      }
    }
    startPromise = startRuntime()
      .then(() => {
        if (!enabled || generation !== startGeneration) {
          state = "disabled";
          error = null;
          return;
        }
        state = "running";
        scheduleIdleShutdown();
      })
      .catch(async (startError) => {
        if (generation !== startGeneration) return;
        error = startError?.message || String(startError);
        enabled = false;
        state = "disabled";
        try {
          await stopActiveRuntime();
        } catch {
          // Ignore cleanup failures while surfacing the startup error.
        }
      })
      .finally(() => {
        if (generation === startGeneration) {
          startPromise = null;
        }
      });

    await startPromise;
    return buildStatus();
  }

  function setEnabled(nextEnabled) {
    const run = () => setEnabledUnlocked(nextEnabled);
    const result = setEnabledChain.then(run, run);
    setEnabledChain = result.then(() => {}, () => {});
    return result;
  }

  function setConfig(config = {}) {
    const nextMode = config.mode == null ? mode : normalizeMode(config.mode);
    const nextIdleTimeoutMinutes = config.idleTimeoutMinutes == null
      ? idleTimeoutMinutes
      : normalizeIdleTimeoutMinutes(config.idleTimeoutMinutes);
    const nextSessionIdleTimeoutMinutes = config.sessionIdleTimeoutMinutes == null
      ? sessionIdleTimeoutMinutes
      : normalizeSessionIdleTimeoutMinutes(config.sessionIdleTimeoutMinutes);
    const modeChanged = nextMode !== mode;
    const timeoutChanged = nextIdleTimeoutMinutes !== idleTimeoutMinutes;

    mode = nextMode;
    idleTimeoutMinutes = nextIdleTimeoutMinutes;
    sessionIdleTimeoutMinutes = nextSessionIdleTimeoutMinutes;
    getBridge()?.setSessionIdleTimeoutMinutes?.(sessionIdleTimeoutMinutes);

    if ((modeChanged || timeoutChanged) && enabled && state === "running") {
      lastActivityAt = getNow();
      scheduleIdleShutdown();
    }

    return buildStatus();
  }

  function getStatus() {
    return buildStatus();
  }

  function isEnabled() {
    // Accept clients while starting/running as soon as the switch is on.
    // Discovery may be written before state flips to "running". Do not treat
    // error/disabled as enabled after cleanup revoked discovery/sockets.
    return enabled && (state === "starting" || state === "running");
  }

  function getChatSessionId() {
    return deps.chatSessionId;
  }

  function setSessionSyncHandler(handler) {
    sessionSyncHandler = typeof handler === "function" ? handler : null;
  }

  function onBridgeHostReady({ port }) {
    if (!isEnabled()) return;
    // Host-ready reports the shared Catty/CLI TCP token — never write that into
    // External discovery. Only refresh with an already-issued external token;
    // do not issue here or cold-start enable double-rotates before
    // resolveHostCredentials runs.
    if (port) lastKnownPort = port;
    const bridge = getBridge();
    const externalToken = typeof bridge?.getExternalMcpAuthToken === "function"
      ? bridge.getExternalMcpAuthToken()
      : null;
    if (!externalToken) return;
    lastKnownToken = externalToken;
    if (discoveryFilePath && lastKnownPort && lastKnownToken) {
      writeDiscoveryFromBridge();
    }
  }

  function onPermissionModeChanged() {
    if (isEnabled() && state === "running") {
      writeDiscoveryFromBridge();
    }
  }

  function init(initOptions = {}) {
    if (initOptions.mcpServerBridge) {
      deps.mcpServerBridge = initOptions.mcpServerBridge;
    }
    discoveryFilePath = initOptions.discoveryFilePath
      || deps.getDiscoveryFilePath(
        initOptions.userDataDir ? { userDataDir: initOptions.userDataDir } : {},
      );
    // Rotate any stale discovery from a previous process.
    if (discoveryFilePath) {
      deps.removeDiscovery(discoveryFilePath);
    }
    // Recreate client setup helpers so they pick up the resolved discovery path.
    codexSetup = null;
    claudeSetup = null;
    grokSetup = null;
    ensureClientSetup();
  }

  function cleanup() {
    clearIdleTimer();
    if (discoveryFilePath) {
      deps.removeDiscovery(discoveryFilePath);
    }
    enabled = false;
    state = "disabled";
    lastKnownPort = null;
    lastKnownToken = null;
  }

  async function getCodexStatus() {
    ensureClientSetup();
    return await codexSetup.getStatus();
  }

  async function addToCodex() {
    ensureClientSetup();
    return await codexSetup.addToCodex();
  }

  async function getClaudeStatus() {
    ensureClientSetup();
    return await claudeSetup.getStatus();
  }

  async function addToClaude() {
    ensureClientSetup();
    return await claudeSetup.addToClaude();
  }

  async function getGrokStatus() {
    ensureClientSetup();
    return await grokSetup.getStatus();
  }

  async function addToGrok() {
    ensureClientSetup();
    return await grokSetup.addToGrok();
  }

  async function getUniversalSetupPrompt() {
    try {
      const skillContent = await deps.readSkillContent();
      return {
        ok: true,
        prompt: deps.buildUniversalSetupPrompt({
          launcherPath: deps.getLauncherPath() || "",
          discoveryPath: discoveryFilePath || "",
          skillContent,
        }),
        error: null,
      };
    } catch (promptError) {
      return {
        ok: false,
        prompt: "",
        error: promptError?.message || String(promptError),
      };
    }
  }

  function registerHandlers(ipcMain, validateSender) {
    const guard = typeof validateSender === "function"
      ? validateSender
      : () => true;

    ipcMain.handle("netcatty:external-mcp:get-status", async (event) => {
      if (!guard(event)) return { ok: false, error: "Unauthorized IPC sender" };
      return getStatus();
    });
    ipcMain.handle("netcatty:external-mcp:set-enabled", async (event, payload) => {
      if (!guard(event)) return { ok: false, error: "Unauthorized IPC sender" };
      return await setEnabled(Boolean(payload?.enabled));
    });
    ipcMain.handle("netcatty:external-mcp:set-config", async (event, payload) => {
      if (!guard(event)) return { ok: false, error: "Unauthorized IPC sender" };
      return setConfig(payload || {});
    });
    ipcMain.handle("netcatty:external-mcp:get-universal-setup-prompt", async (event) => {
      if (!guard(event)) return { ok: false, error: "Unauthorized IPC sender" };
      return await getUniversalSetupPrompt();
    });
    ipcMain.handle("netcatty:external-mcp:codex:get-status", async (event) => {
      if (!guard(event)) return { ok: false, error: "Unauthorized IPC sender" };
      return await getCodexStatus();
    });
    ipcMain.handle("netcatty:external-mcp:codex:add", async (event) => {
      if (!guard(event)) return { ok: false, error: "Unauthorized IPC sender" };
      return await addToCodex();
    });
    ipcMain.handle("netcatty:external-mcp:claude:get-status", async (event) => {
      if (!guard(event)) return { ok: false, error: "Unauthorized IPC sender" };
      return await getClaudeStatus();
    });
    ipcMain.handle("netcatty:external-mcp:claude:add", async (event) => {
      if (!guard(event)) return { ok: false, error: "Unauthorized IPC sender" };
      return await addToClaude();
    });
    ipcMain.handle("netcatty:external-mcp:grok:get-status", async (event) => {
      if (!guard(event)) return { ok: false, error: "Unauthorized IPC sender" };
      return await getGrokStatus();
    });
    ipcMain.handle("netcatty:external-mcp:grok:add", async (event) => {
      if (!guard(event)) return { ok: false, error: "Unauthorized IPC sender" };
      return await addToGrok();
    });
  }

  return {
    init,
    cleanup,
    setEnabled,
    setConfig,
    getStatus,
    isEnabled,
    getChatSessionId,
    setSessionSyncHandler,
    recordActivity,
    onBridgeHostReady,
    onPermissionModeChanged,
    registerHandlers,
    getCodexStatus,
    addToCodex,
    getClaudeStatus,
    addToClaude,
    getGrokStatus,
    addToGrok,
    getUniversalSetupPrompt,
    EXTERNAL_MCP_CHAT_SESSION_ID: deps.chatSessionId,
  };
}

module.exports = {
  createExternalMcpController,
  normalizeMode,
  normalizeIdleTimeoutMinutes,
  EXTERNAL_MCP_MODE_TEMPORARY,
  EXTERNAL_MCP_MODE_PERSISTENT,
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  EXTERNAL_MCP_CHAT_SESSION_ID,
};
