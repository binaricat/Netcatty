/* eslint-disable no-undef */

const { getDriver, listBackends } = require("./index.cjs");
const { buildSdkAgentEnv } = require("./env.cjs");
const { buildInjectedMcpServers } = require("./injectMcp.cjs");
const { createStreamEmitter } = require("./emit.cjs");
const { buildNetcattySkillsOpenCodePathAllowlist } = require("./netcattySkillsOpenCodePermissions.cjs");
const { getToolCliStateDir } = require("../../../cli/discoveryPath.cjs");
const tempDirBridge = require("../../tempDirBridge.cjs");
const { realpathSync } = require("node:fs");

const VALID_BACKENDS = new Set(listBackends());

// Pre-flight model catalog cache. claude/copilot enumerate models via the SDK
// (supportedModels / listModels); spawning the CLI is ~1-2s, so cache per backend
// and always degrade to [] on error/timeout (the renderer keeps its presets).
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_LIST_TIMEOUT_MS = 10000;
const sdkModelCache = new Map();
const { parseSdkSessionIdentity: parseSdkSessionIdentityPayload, SDK_SESSION_ID_PREFIX } = require("../../../shared/sdkSessionIdentity.cjs");
const { isPathLikeCommand } = require("../../../shared/pathLikeCommand.cjs");

function parseSdkSessionIdentity(value) {
  const parsed = parseSdkSessionIdentityPayload(value);
  if (!parsed) return null;
  return {
    sessionId: parsed.id,
    backendKey: parsed.backend,
    binPath: parsed.binPath || "",
  };
}

function buildSdkSessionKey(chatSessionId, backendKey, binPath) {
  return [
    String(chatSessionId || ""),
    String(backendKey || ""),
    String(binPath || ""),
  ].join("\u0000");
}

function buildSdkModelCacheKey(backendKey, binPath) {
  return [String(backendKey || ""), String(binPath || "")].join("\u0000");
}

function shouldCacheSdkRuntimeModels(backendKey) {
  return backendKey !== "opencode";
}

function normalizeSdkListModelsResult(raw) {
  const rawModels = Array.isArray(raw) ? raw : raw?.models;
  const currentModelId = Array.isArray(raw) ? null : raw?.currentModelId || null;
  const models = Array.isArray(rawModels) ? rawModels.filter((m) => m && m.id) : [];
  return { currentModelId, models };
}

function deleteSdkSessionKeysForChat(sdkSessionIds, chatSessionId) {
  const prefix = `${String(chatSessionId || "")}\u0000`;
  for (const key of sdkSessionIds.keys()) {
    if (key.startsWith(prefix)) {
      sdkSessionIds.delete(key);
    }
  }
}

function resolveSdkResumeSessionId({
  sdkSessionIds,
  sdkSessionKey,
  existingSessionId,
  backendKey,
  binPath,
  hasConfiguredCommand,
}) {
  const inMemorySessionId = sdkSessionIds.get(sdkSessionKey);
  if (inMemorySessionId) return inMemorySessionId;

  const persisted = parseSdkSessionIdentity(existingSessionId);
  if (persisted) {
    return persisted.backendKey === backendKey && persisted.binPath === String(binPath || "")
      ? persisted.sessionId
      : undefined;
  }

  return existingSessionId && !hasConfiguredCommand ? existingSessionId : undefined;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`list-models timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Map the renderer-supplied backend value to a registry key. */
function resolveBackendKey(value) {
  const key = String(value || "").trim();
  return VALID_BACKENDS.has(key) ? key : null;
}

function normalizeHistoryMessages(historyMessages) {
  if (!Array.isArray(historyMessages)) return [];
  return historyMessages
    .filter((msg) => msg && (msg.role === "user" || msg.role === "assistant"))
    .map((msg) => ({
      role: msg.role,
      content: String(msg.content || "").trim(),
    }))
    .filter((msg) => msg.content.length > 0);
}

function logCursorApiKeySummary({ requestedAgentEnv, shellEnv, env }) {
  const requestedKey = requestedAgentEnv?.CURSOR_API_KEY;
  const shellKey = shellEnv?.CURSOR_API_KEY;
  const effectiveKey = env?.CURSOR_API_KEY;
  const source = requestedKey
    ? "settings"
    : shellKey
      ? "environment"
      : effectiveKey
        ? "merged-env"
        : "missing";
  console.info("[Cursor SDK] API key summary", {
    source,
    hasEffectiveKey: Boolean(effectiveKey),
  });
}

function resolveRealCliPath(cliPath, realpath = realpathSync) {
  if (!cliPath) return cliPath;
  try { return realpath(cliPath); } catch { return cliPath; }
}

function normalizeConfiguredCommandPath(command, normalizeCliPathForPlatform) {
  const raw = String(command || "").trim();
  const pathLike = raw.includes("/") || raw.includes("\\") || /^[a-z]:/i.test(raw);
  if (!raw || !pathLike) {
    return null;
  }
  const normalized = typeof normalizeCliPathForPlatform === "function"
    ? normalizeCliPathForPlatform(raw)
    : raw;
  if (!normalized) {
    throw new Error(`Agent CLI path not found: ${raw}`);
  }
  return normalized;
}

function resolveConfiguredSdkPath({
  backendKey, configuredPath, realpath,
  resolveClaudeCodeExecutableForSdk,
  resolveCodexExecutableForSdk,
  resolveCodebuddyExecutableForSdk,
}) {
  const realPath = resolveRealCliPath(configuredPath, realpath);
  if (backendKey === "claude" && typeof resolveClaudeCodeExecutableForSdk === "function") {
    return resolveClaudeCodeExecutableForSdk(realPath) || undefined;
  }
  if (backendKey === "codex" && typeof resolveCodexExecutableForSdk === "function") {
    return resolveCodexExecutableForSdk(realPath) || undefined;
  }
  if (backendKey === "codebuddy" && typeof resolveCodebuddyExecutableForSdk === "function") {
    return resolveCodebuddyExecutableForSdk(realPath) || undefined;
  }
  return realPath;
}

function resolveSdkBackendBinPath({
  backendKey, configuredCommand, shellEnv, env, resolveCliFromPath, normalizeCliPathForPlatform,
  resolveSdkBinPath, resolveClaudeCodeExecutableForSdk, resolveCodexExecutableForSdk,
  resolveCodebuddyExecutableForSdk, realpath = realpathSync,
}) {
  const configuredPath = normalizeConfiguredCommandPath(configuredCommand, normalizeCliPathForPlatform);
  if (configuredPath) {
    return resolveConfiguredSdkPath({
      backendKey,
      configuredPath,
      realpath,
      resolveClaudeCodeExecutableForSdk,
      resolveCodexExecutableForSdk,
      resolveCodebuddyExecutableForSdk,
    });
  }

  if (backendKey === "codebuddy") {
    const configuredEnvPath = normalizeCliPathForPlatform?.(env?.CODEBUDDY_CODE_PATH);
    const rawPath = configuredEnvPath || resolveCliFromPath(backendKey, shellEnv) || undefined;
    if (!rawPath) return undefined;
    const realPath = resolveRealCliPath(rawPath, realpath);
    // On Windows the discovered path is an npm shim (codebuddy.cmd/.ps1) that the
    // Agent SDK can't run through `node`; resolve it to the package's JS entry so
    // it launches like on macOS/Linux. A null result means the shim is unrunnable
    // and unresolvable, so fall back to the SDK's bundled CLI.
    const sdkPath = typeof resolveCodebuddyExecutableForSdk === "function"
      ? resolveCodebuddyExecutableForSdk(realPath)
      : realPath;
    return sdkPath || undefined;
  }
  if (backendKey === "opencode") {
    const configuredEnvPath = normalizeCliPathForPlatform?.(env?.OPENCODE_BIN);
    const rawPath = configuredEnvPath || resolveCliFromPath(backendKey, shellEnv) || undefined;
    return rawPath ? resolveRealCliPath(rawPath, realpath) : undefined;
  }
  return resolveSdkBinPath?.(backendKey, shellEnv) || undefined;
}

function defaultWriteAttachmentToTemp(attachment) {
  if (attachment?.filePath) return attachment.filePath;
  if (!attachment?.base64Data) return null;
  const fs = require("node:fs");
  const tempDirBridge = require("../../tempDirBridge.cjs");
  const fallbackName = `ai-attachment-${Date.now()}`;
  const target = tempDirBridge.getTempFilePath(attachment.filename || fallbackName);
  fs.writeFileSync(target, Buffer.from(attachment.base64Data, "base64"));
  return target;
}

function buildSdkTurnPrompt({
  prompt,
  historyMessages,
  replayHistory,
  attachments,
  writeAttachmentToTemp = defaultWriteAttachmentToTemp,
  onStagedAttachment,
}) {
  const sections = [];
  const history = replayHistory ? normalizeHistoryMessages(historyMessages) : [];
  if (history.length > 0) {
    sections.push(
      [
        "[Conversation context replay: the agent SDK may be starting from a fresh local session, so use these prior turns as context and answer only the latest user request.]",
        ...history.map((msg) => `${msg.role === "assistant" ? "ASSISTANT" : "USER"}: ${msg.content}`),
      ].join("\n"),
    );
  }

  if (Array.isArray(attachments) && attachments.length > 0) {
    const hints = [];
    for (const attachment of attachments) {
      if (!attachment || !attachment.base64Data || !attachment.mediaType) continue;
      try {
        const localPath = writeAttachmentToTemp(attachment);
        if (localPath) {
          const name = attachment.filename || "attachment";
          hints.push(`- "${name}" (${attachment.mediaType}) is saved on the local machine at: ${localPath}`);
          onStagedAttachment?.({
            filename: name,
            mediaType: attachment.mediaType,
            filePath: localPath,
            base64Data: attachment.base64Data || "",
          });
        }
      } catch (err) {
        console.error("[SDK Agent] Failed to stage attachment:", err?.message || err);
      }
    }
    if (hints.length > 0) {
      sections.push(
        [
          "[Attached files: these paths are local to the machine running Netcatty, not remote hosts. Inspect them locally if needed.]",
          "[If local filesystem tools are unavailable, use Netcatty's list_attachments and read_attachment MCP tools to inspect these user-supplied files.]",
          ...hints,
        ].join("\n"),
      );
    }
  }

  const trimmedPrompt = String(prompt || "");
  return sections.length > 0
    ? `${sections.join("\n\n")}\n\n${trimmedPrompt}`
    : trimmedPrompt;
}

function registerSdkStreamHandlers(ctx) {
  with (ctx) {
    // chatSessionId -> { sessionId } for resume; controller per requestId.
    const sdkActiveStreams = new Map(); // requestId -> AbortController
    const sdkRequestSessions = new Map(); // requestId -> chatSessionId
    const sdkSessionIds = new Map(); // chatSessionId -> last sessionId

    ipcMain.handle(
      "netcatty:ai:sdk-agent:stream",
      async (event, payload) => {
        if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
        const {
          requestId, chatSessionId, sdkBackend, prompt, cwd,
          model, existingSessionId, toolIntegrationMode,
          defaultTargetSession, userSkillsContext, agentEnv: requestedAgentEnv, agentCommand,
        } = payload;

        const backendKey = resolveBackendKey(sdkBackend);
        if (!backendKey) {
          safeSend(event.sender, "netcatty:ai:sdk-agent:error", {
            requestId, error: `Unknown SDK backend: ${sdkBackend}`,
          });
          return { ok: false, error: "Unknown SDK backend" };
        }

        const abortController = new AbortController();
        sdkActiveStreams.set(requestId, abortController);
        sdkRequestSessions.set(requestId, chatSessionId);
        mcpServerBridge.setChatSessionCancelled?.(chatSessionId, false);

        const emitter = createStreamEmitter({ safeSend, sender: event.sender, requestId });
        try {
          const shellEnv = await getShellEnv();
          const effectiveMode = normalizeToolIntegrationMode(toolIntegrationMode);
          setToolIntegrationMode(effectiveMode);

          // Push terminal session metadata + build injected MCP (mcp mode only).
          const injectedMcpServers = await buildInjectedMcpServers({
            mcpServerBridge,
            chatSessionId,
            toolIntegrationMode: effectiveMode,
          });

          // NETCATTY_CLAUDE_SETTINGS is a netcatty marker carrying the claude SDK
          // `settings` option (a settings.json path / inline JSON), NOT a real env
          // var — pull it out so it isn't handed to the agent process as env.
          const normalizedAgentEnv = normalizeAgentEnv(requestedAgentEnv);
          const claudeSettings = normalizedAgentEnv.NETCATTY_CLAUDE_SETTINGS;
          delete normalizedAgentEnv.NETCATTY_CLAUDE_SETTINGS;

          let env = buildSdkAgentEnv({
            shellEnv,
            requestedAgentEnv: normalizedAgentEnv,
            withCliDiscoveryEnv,
            normalizeClaudeCodeExecutableEnv: normalizeClaudeCodeExecutableEnvForSdk,
          });
          if (backendKey === "cursor") {
            logCursorApiKeySummary({ requestedAgentEnv: normalizedAgentEnv, shellEnv, env });
          }

          const binPath = resolveSdkBackendBinPath({
            backendKey,
            configuredCommand: agentCommand,
            shellEnv,
            env,
            resolveCliFromPath,
            normalizeCliPathForPlatform,
            resolveSdkBinPath,
            resolveClaudeCodeExecutableForSdk,
            resolveCodexExecutableForSdk,
            resolveCodebuddyExecutableForSdk,
          });
          if (backendKey === "codex") {
            env = addCodexExecutableEnvForSdk(env, binPath);
          }

          const hasConfiguredCommand = isPathLikeCommand(agentCommand);
          const sdkSessionKey = buildSdkSessionKey(chatSessionId, backendKey, binPath);
          const hasInMemorySession = sdkSessionIds.has(sdkSessionKey);
          const resumeSessionId = resolveSdkResumeSessionId({
            sdkSessionIds,
            sdkSessionKey,
            existingSessionId,
            backendKey,
            binPath,
            hasConfiguredCommand,
          });
          const stagedAttachments = [];
          const turnPrompt = buildSdkTurnPrompt({
            prompt,
            historyMessages: payload?.historyMessages,
            replayHistory: !hasInMemorySession,
            attachments: payload?.images,
            onStagedAttachment: (attachment) => stagedAttachments.push(attachment),
          });
          mcpServerBridge.updateAttachmentMetadata?.(stagedAttachments, chatSessionId);

          const systemContext = buildExternalAgentSystemContext({
            mode: effectiveMode,
            chatSessionId,
            defaultTargetSession,
            userSkillsContext,
          });
          const contextualPrompt = buildExternalAgentContextualPrompt({
            mode: effectiveMode,
            prompt: turnPrompt,
            chatSessionId,
            defaultTargetSession,
            userSkillsContext,
          });

          const driver = getDriver(backendKey);
          const driverEmitter = {
            ...emitter,
            sessionId(sessionId) {
              if (sessionId) {
                emitter.emitEvent({
                  type: "session-id",
                  sessionId,
                  sdkBackend: backendKey,
                  binPath: binPath || "",
                });
              }
            },
          };
          const skillsPathAllowlist = effectiveMode === "skills" && backendKey === "opencode"
            ? buildNetcattySkillsOpenCodePathAllowlist({
              launcherPath: NETCATTY_TOOL_LAUNCHER_PATH,
              cliScriptPath: NETCATTY_TOOL_CLI_PATH,
              skillPath: NETCATTY_TOOL_SKILL_PATH,
              discoveryFilePath: cliDiscoveryFilePath || undefined,
              cliStateDir: cliDiscoveryFilePath
                ? undefined
                : getToolCliStateDir({ userDataDir: electronModule?.getPath?.("userData") }),
              runtimeBinaryPath: process.execPath,
              tempDir: tempDirBridge.getTempDir(),
              extraFilePaths: stagedAttachments
                .map((attachment) => attachment?.filePath)
                .filter(Boolean),
            })
            : undefined;
          const result = await driver.runTurn({
            prompt: backendKey === "opencode" ? turnPrompt : contextualPrompt,
            systemPrompt: backendKey === "opencode" ? systemContext : undefined,
            cwd: cwd || process.cwd(),
            model: model || undefined,
            env,
            binPath,
            injectedMcpServers,
            claudeSettings,
            toolIntegrationMode: effectiveMode,
            skillsPathAllowlist,
            emitter: driverEmitter,
            signal: abortController.signal,
            abortController,
            resumeSessionId,
            attachments: stagedAttachments,
          });

          // Persist any new session id for resume on the next turn.
          const newSessionId = result?.sessionId || result?.threadId;
          if (newSessionId) sdkSessionIds.set(sdkSessionKey, newSessionId);

          return { ok: true };
        } catch (err) {
          emitter.emitError(err?.message || String(err));
          return { ok: false, error: err?.message || String(err) };
        } finally {
          sdkActiveStreams.delete(requestId);
          sdkRequestSessions.delete(requestId);
        }
      },
    );

    ipcMain.handle("netcatty:ai:sdk-agent:list-models", async (event, payload) => {
      if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
      const { sdkBackend, agentEnv: requestedAgentEnv, agentCommand } = payload || {};
      const backendKey = resolveBackendKey(sdkBackend);
      if (!backendKey) return { ok: false, error: `Unknown SDK backend: ${sdkBackend}` };

      try {
        const driver = getDriver(backendKey);
        if (typeof driver.listModels !== "function") {
          return { ok: true, currentModelId: null, models: [] };
        }
        const shellEnv = await getShellEnv();
        const env = buildSdkAgentEnv({
          shellEnv,
          requestedAgentEnv: normalizeAgentEnv(requestedAgentEnv),
          withCliDiscoveryEnv,
          normalizeClaudeCodeExecutableEnv: normalizeClaudeCodeExecutableEnvForSdk,
        });
        const binPath = resolveSdkBackendBinPath({
          backendKey,
          configuredCommand: agentCommand,
          shellEnv,
          env,
          resolveCliFromPath,
          normalizeCliPathForPlatform,
          resolveSdkBinPath,
          resolveClaudeCodeExecutableForSdk,
          resolveCodexExecutableForSdk,
          resolveCodebuddyExecutableForSdk,
        });
        // claude/copilot enumerate models via the SDK; codex has no catalog (its
        // driver returns []), so the renderer falls back to curated presets.
        // OpenCode model catalogs are user-config driven and can change outside
        // Netcatty, so do not cache them behind the generic SDK cache.
        const cacheKey = buildSdkModelCacheKey(backendKey, binPath);
        const shouldCacheModels = shouldCacheSdkRuntimeModels(backendKey);
        const cached = shouldCacheModels ? sdkModelCache.get(cacheKey) : null;
        if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) {
          return { ok: true, currentModelId: cached.currentModelId || null, models: cached.models };
        }
        const raw = await withTimeout(driver.listModels({ binPath, env }), MODEL_LIST_TIMEOUT_MS);
        const { currentModelId, models } = normalizeSdkListModelsResult(raw);
        if (shouldCacheModels) sdkModelCache.set(cacheKey, { at: Date.now(), currentModelId, models });
        return { ok: true, currentModelId, models };
      } catch (err) {
        // Degrade to [] so the renderer keeps its curated presets (never empty).
        console.debug(`[sdk] list-models(${backendKey}) unavailable, using curated presets`);
        return { ok: true, currentModelId: null, models: [] };
      }
    });

    ipcMain.handle("netcatty:ai:sdk-agent:cancel", async (event, { requestId, chatSessionId }) => {
      if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
      const effectiveChatSessionId = chatSessionId || sdkRequestSessions.get(requestId);
      mcpServerBridge.setChatSessionCancelled?.(effectiveChatSessionId, true);
      mcpServerBridge.cancelPtyExecsForSession(effectiveChatSessionId);
      mcpServerBridge.cancelWorkerBackgroundJobsForSession?.(effectiveChatSessionId);
      mcpServerBridge.clearPendingApprovals(effectiveChatSessionId);
      void mcpServerBridge.cancelSftpOpsForSession?.(effectiveChatSessionId);
      const controller = sdkActiveStreams.get(requestId);
      if (controller) {
        controller.abort();
        return { ok: true };
      }
      return { ok: false, error: "Stream not found" };
    });

    ipcMain.handle("netcatty:ai:sdk-agent:cleanup", async (event, { chatSessionId }) => {
      if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
      mcpServerBridge.setChatSessionCancelled?.(chatSessionId, true);
      mcpServerBridge.cancelPtyExecsForSession(chatSessionId);
      mcpServerBridge.cancelWorkerBackgroundJobsForSession?.(chatSessionId);
      deleteSdkSessionKeysForChat(sdkSessionIds, chatSessionId);
      await mcpServerBridge.cleanupScopedMetadata(chatSessionId);
      return { ok: true };
    });

    // Expose teardown so aiBridge.cleanup() can abort active SDK streams.
    ctx.sdkActiveStreams = sdkActiveStreams;
  }
}

module.exports = {
  registerSdkStreamHandlers,
  resolveBackendKey,
  resolveSdkBackendBinPath,
  buildSdkSessionKey,
  buildSdkModelCacheKey,
  normalizeSdkListModelsResult,
  resolveSdkResumeSessionId,
  shouldCacheSdkRuntimeModels,
  normalizeHistoryMessages,
  buildSdkTurnPrompt,
};
