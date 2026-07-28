/* eslint-disable no-undef */

const { getDriver, listBackends } = require("./index.cjs");
const { buildSdkAgentEnv } = require("./env.cjs");
const { buildInjectedMcpServers } = require("./injectMcp.cjs");
const { createStreamEmitter } = require("./emit.cjs");
const { buildNetcattySkillsOpenCodePathAllowlist } = require("./netcattySkillsOpenCodePermissions.cjs");
const { getToolCliStateDir } = require("../../../cli/discoveryPath.cjs");
const tempDirBridge = require("../../tempDirBridge.cjs");
const { realpathSync } = require("node:fs");
const { CodexAppServerRuntime } = require("../codexAppServer/runtime.cjs");
const { probeCodexAppServer } = require("../codexAppServer/probe.cjs");

const VALID_BACKENDS = new Set(listBackends());

// Pre-flight model catalog cache. SDK listModels often spawns a CLI/server
// (~1-2s+), so cache per backend+binPath and coalesce in-flight loads.
// Always degrade to [] on error/timeout (the renderer keeps its presets).
// OpenCode is included: catalogs can drift outside Netcatty, but a short TTL
// is far cheaper than spawning a new opencode process on every panel render
// (issue #2184).
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_LIST_TIMEOUT_MS = 10000;
const sdkModelCache = new Map();
const sdkModelInFlight = new Map();
const { parseSdkSessionIdentity: parseSdkSessionIdentityPayload, SDK_SESSION_ID_PREFIX } = require("../../../shared/sdkSessionIdentity.cjs");
const { isPathLikeCommand } = require("../../../shared/pathLikeCommand.cjs");

function parseSdkSessionIdentity(value) {
  const parsed = parseSdkSessionIdentityPayload(value);
  if (!parsed) return null;
  return {
    sessionId: parsed.id,
    backendKey: parsed.backend,
    binPath: parsed.binPath || "",
    runtime: parsed.runtime === "app-server" ? "app-server" : "sdk",
    authMode: parsed.authMode === "cli-login" ? "cli-login" : parsed.authMode === "api-key" ? "api-key" : "",
    cliMode: parsed.cliMode === "ask" ? "ask" : parsed.cliMode === "agent" ? "agent" : "",
  };
}

function buildSdkSessionKey(chatSessionId, backendKey, binPath, runtime = "sdk", authMode = "", cliMode = "") {
  return [
    String(chatSessionId || ""),
    String(backendKey || ""),
    String(binPath || ""),
    String(runtime || "sdk"),
    String(authMode || ""),
    String(cliMode || ""),
  ].join("\u0000");
}

function normalizeResumeAuthMode(authMode) {
  return authMode === "cli-login" ? "cli-login" : authMode === "api-key" ? "api-key" : "";
}

function normalizeResumeCliMode(cliMode) {
  return cliMode === "ask" ? "ask" : cliMode === "agent" ? "agent" : "";
}

// Environment that can change an SDK agent's model catalog without changing the
// binary path (especially OpenCode HOME / XDG / config overrides).
const SDK_MODEL_CACHE_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "OPENCODE_BIN",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
  "CLAUDE_CODE_EXECUTABLE",
  "CODEBUDDY_CODE_PATH",
  "CURSOR_API_KEY",
];

function buildSdkModelCacheKey(backendKey, binPath, env, runtime = "sdk") {
  const envFingerprint = SDK_MODEL_CACHE_ENV_KEYS
    .map((key) => `${key}=${env?.[key] == null ? "" : String(env[key])}`)
    .join("\u0000");
  return [String(backendKey || ""), String(binPath || ""), String(runtime || "sdk"), envFingerprint].join("\u0000");
}

function shouldCacheSdkRuntimeModels(_backendKey) {
  return true;
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

/**
 * Cursor CLI --resume is sticky for ask vs agent. When permission mode flips
 * (Observer ↔ Confirm/Auto), drop the inactive mode's in-memory session so a
 * later switch-back cannot revive a stale thread without the intervening turns.
 * Returns true when a sibling key was removed.
 */
function expireSiblingCursorCliModeSessions(sdkSessionIds, {
  chatSessionId,
  backendKey,
  binPath,
  runtime = "sdk",
  authMode = "",
  cliMode = "",
} = {}) {
  const activeCliMode = normalizeResumeCliMode(cliMode);
  if (!activeCliMode || !sdkSessionIds) return false;
  const siblingCliMode = activeCliMode === "ask" ? "agent" : "ask";
  const siblingKey = buildSdkSessionKey(
    chatSessionId,
    backendKey,
    binPath,
    runtime,
    authMode,
    siblingCliMode,
  );
  if (!sdkSessionIds.has(siblingKey)) return false;
  sdkSessionIds.delete(siblingKey);
  return true;
}

function resolveSdkResumeSessionId({
  sdkSessionIds,
  sdkSessionKey,
  existingSessionId,
  backendKey,
  binPath,
  runtime = "sdk",
  authMode = "",
  cliMode = "",
  hasConfiguredCommand,
}) {
  const inMemorySessionId = sdkSessionIds.get(sdkSessionKey);
  if (inMemorySessionId) return inMemorySessionId;

  const requestedAuthMode = normalizeResumeAuthMode(authMode);
  const requestedCliMode = normalizeResumeCliMode(cliMode);
  const persisted = parseSdkSessionIdentity(existingSessionId);
  if (persisted) {
    // Legacy identities omit authMode; treat them as api-key so CLI session
    // UUIDs never resume onto the Cursor SDK path after a mode switch.
    const persistedAuthMode = normalizeResumeAuthMode(persisted.authMode) || "api-key";
    const effectiveRequestedAuthMode = requestedAuthMode || "api-key";
    // Cursor CLI ask vs agent sessions must not resume across each other —
    // --resume keeps the original Cursor execution mode sticky.
    if (requestedCliMode) {
      const persistedCliMode = normalizeResumeCliMode(persisted.cliMode);
      if (!persistedCliMode || persistedCliMode !== requestedCliMode) return undefined;
    }
    return persisted.backendKey === backendKey
      && persisted.binPath === String(binPath || "")
      && persisted.runtime === runtime
      && persistedAuthMode === effectiveRequestedAuthMode
      ? persisted.sessionId
      : undefined;
  }

  // Bare legacy IDs are only safe for the SDK/api-key path. CLI login always
  // persists an encoded identity after the first turn.
  if (requestedAuthMode === "cli-login") return undefined;

  return runtime === "sdk" && existingSessionId && !hasConfiguredCommand
    ? existingSessionId
    : undefined;
}

function withTimeout(promise, ms, abortController) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`list-models timed out after ${ms}ms`);
      try { abortController?.abort?.(error); } catch {}
      reject(error);
    }, ms);
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
    const sdkRequestRuntimes = new Map(); // requestId -> { backendKey, codexRuntime }
    const sdkSessionIds = new Map(); // chatSessionId -> last sessionId
    const codexAppServerRuntime = new CodexAppServerRuntime({
      appVersion: electronModule?.app?.getVersion?.() || "0.0.0",
      sendInteractionRequest(payload, context) {
        const sender = context?.sender;
        if (!sender || sender.isDestroyed?.()) return false;
        safeSend(sender, "netcatty:ai:codex-app-server:interaction-request", payload);
        return true;
      },
      sendInteractionCleared(payload, context) {
        const sender = context?.sender;
        if (!sender || sender.isDestroyed?.()) return;
        safeSend(sender, "netcatty:ai:codex-app-server:interaction-cleared", payload);
      },
    });

    ipcMain.handle(
      "netcatty:ai:sdk-agent:stream",
      async (event, payload) => {
        if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
        const {
          requestId, chatSessionId, sdkBackend, prompt, cwd,
          model, existingSessionId, toolIntegrationMode,
          defaultTargetSession, userSkillsContext, agentEnv: requestedAgentEnv, agentCommand,
          codexRuntime: requestedCodexRuntime, permissionMode,
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
          const cursorAuthMode = normalizedAgentEnv.NETCATTY_CURSOR_AUTH_MODE === "cli-login"
            ? "cli-login"
            : "api-key";
          delete normalizedAgentEnv.NETCATTY_CURSOR_AUTH_MODE;
          let cursorCliBinPath = String(normalizedAgentEnv.NETCATTY_CURSOR_CLI_BIN || "").trim() || null;
          delete normalizedAgentEnv.NETCATTY_CURSOR_CLI_BIN;
          if (cursorAuthMode === "cli-login") {
            delete normalizedAgentEnv.CURSOR_API_KEY;
          }

          let env = buildSdkAgentEnv({
            shellEnv,
            requestedAgentEnv: normalizedAgentEnv,
            withCliDiscoveryEnv,
            normalizeClaudeCodeExecutableEnv: normalizeClaudeCodeExecutableEnvForSdk,
          });
          if (cursorAuthMode === "cli-login") {
            delete env.CURSOR_API_KEY;
          }
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

          if (backendKey === "cursor" && cursorAuthMode === "cli-login") {
            const looksLikeSentinel = !cursorCliBinPath
              || cursorCliBinPath === "cursor"
              || /(?:^|[/\\])cursor$/i.test(cursorCliBinPath);
            if (looksLikeSentinel && typeof probeCursorCliAuth === "function") {
              try {
                const cliAuth = probeCursorCliAuth({ env: shellEnv });
                if (cliAuth?.binPath) cursorCliBinPath = cliAuth.binPath;
              } catch { /* best effort */ }
            }
            if (!cursorCliBinPath) {
              // Only `cursor-agent` — bare `agent` collides with other CLIs (e.g. Grok).
              cursorCliBinPath = await resolveCliFromPathAsync?.("cursor-agent", shellEnv)
                || null;
            }
          }

          const codexRuntime = backendKey === "codex" && requestedCodexRuntime === "app-server"
            ? "app-server"
            : "sdk";
          sdkRequestRuntimes.set(requestId, { backendKey, codexRuntime });

          const hasConfiguredCommand = isPathLikeCommand(agentCommand);
          const sessionBinPath = backendKey === "cursor" && cursorAuthMode === "cli-login"
            ? (cursorCliBinPath || binPath)
            : binPath;
          const cursorSessionAuthMode = backendKey === "cursor" ? cursorAuthMode : "";
          // Cursor CLI --resume keeps ask vs agent sticky; isolate session keys
          // so switching Observer ↔ Confirm/Auto starts a fresh CLI thread.
          const cursorCliMode = backendKey === "cursor" && cursorAuthMode === "cli-login"
            ? (String(permissionMode || "confirm").toLowerCase() === "observer" ? "ask" : "agent")
            : "";
          // Expire the inactive mode first so Obs → Conf → Obs cannot resume the
          // original Ask thread (which would also skip history of Confirm turns).
          if (cursorCliMode) {
            expireSiblingCursorCliModeSessions(sdkSessionIds, {
              chatSessionId,
              backendKey,
              binPath: sessionBinPath,
              runtime: codexRuntime,
              authMode: cursorSessionAuthMode,
              cliMode: cursorCliMode,
            });
          }
          const sdkSessionKey = buildSdkSessionKey(
            chatSessionId,
            backendKey,
            sessionBinPath,
            codexRuntime,
            cursorSessionAuthMode,
            cursorCliMode,
          );
          const hasInMemorySession = sdkSessionIds.has(sdkSessionKey);
          const resumeSessionId = resolveSdkResumeSessionId({
            sdkSessionIds,
            sdkSessionKey,
            existingSessionId,
            backendKey,
            binPath: sessionBinPath,
            runtime: codexRuntime,
            authMode: cursorSessionAuthMode,
            cliMode: cursorCliMode,
            hasConfiguredCommand,
          });
          const stagedAttachments = [];
          const turnPrompt = buildSdkTurnPrompt({
            prompt,
            historyMessages: payload?.historyMessages,
            replayHistory: codexRuntime === "app-server" ? !resumeSessionId : !hasInMemorySession,
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
                  binPath: sessionBinPath || "",
                  runtime: codexRuntime,
                  ...(cursorSessionAuthMode ? { authMode: cursorSessionAuthMode } : {}),
                  ...(cursorCliMode ? { cliMode: cursorCliMode } : {}),
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
          const commonTurnContext = {
            requestId,
            chatSessionId,
            prompt: backendKey === "opencode" ? turnPrompt : contextualPrompt,
            systemPrompt: backendKey === "opencode" ? systemContext : undefined,
            cwd: cwd || process.cwd(),
            model: model || undefined,
            permissionMode: permissionMode || "confirm",
            env,
            binPath,
            cursorAuthMode: backendKey === "cursor" ? cursorAuthMode : undefined,
            cursorCliBinPath: backendKey === "cursor" ? cursorCliBinPath : undefined,
            getTempDir: () => tempDirBridge.getTempDir(),
            injectedMcpServers,
            claudeSettings,
            toolIntegrationMode: effectiveMode,
            skillsPathAllowlist,
            emitter: driverEmitter,
            signal: abortController.signal,
            abortController,
            resumeSessionId,
            resumeThreadId: resumeSessionId,
            attachments: stagedAttachments,
            sender: event.sender,
          };
          const result = codexRuntime === "app-server"
            ? await codexAppServerRuntime.runTurn(commonTurnContext)
            : await driver.runTurn(commonTurnContext);

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
          sdkRequestRuntimes.delete(requestId);
        }
      },
    );

    ipcMain.handle("netcatty:ai:sdk-agent:list-models", async (event, payload) => {
      if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
      const { sdkBackend, agentEnv: requestedAgentEnv, agentCommand, codexRuntime: requestedCodexRuntime } = payload || {};
      const backendKey = resolveBackendKey(sdkBackend);
      if (!backendKey) return { ok: false, error: `Unknown SDK backend: ${sdkBackend}` };

      try {
        const driver = getDriver(backendKey);
        if (typeof driver.listModels !== "function") {
          return { ok: true, currentModelId: null, models: [] };
        }
        const shellEnv = await getShellEnv();
        const normalizedAgentEnv = normalizeAgentEnv(requestedAgentEnv);
        const cursorAuthMode = normalizedAgentEnv.NETCATTY_CURSOR_AUTH_MODE === "cli-login"
          ? "cli-login"
          : "api-key";
        delete normalizedAgentEnv.NETCATTY_CURSOR_AUTH_MODE;
        let cursorCliBinPath = String(normalizedAgentEnv.NETCATTY_CURSOR_CLI_BIN || "").trim() || null;
        delete normalizedAgentEnv.NETCATTY_CURSOR_CLI_BIN;
        if (cursorAuthMode === "cli-login") {
          delete normalizedAgentEnv.CURSOR_API_KEY;
        }
        const env = buildSdkAgentEnv({
          shellEnv,
          requestedAgentEnv: normalizedAgentEnv,
          withCliDiscoveryEnv,
          normalizeClaudeCodeExecutableEnv: normalizeClaudeCodeExecutableEnvForSdk,
        });
        if (cursorAuthMode === "cli-login") {
          delete env.CURSOR_API_KEY;
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
        if (backendKey === "cursor" && cursorAuthMode === "cli-login") {
          const looksLikeSentinel = !cursorCliBinPath
            || cursorCliBinPath === "cursor"
            || /(?:^|[/\\])cursor$/i.test(cursorCliBinPath);
          if (looksLikeSentinel && typeof probeCursorCliAuth === "function") {
            try {
              const cliAuth = probeCursorCliAuth({ env: shellEnv });
              if (cliAuth?.binPath) cursorCliBinPath = cliAuth.binPath;
            } catch { /* best effort */ }
          }
          if (!cursorCliBinPath) {
            // Only `cursor-agent` — bare `agent` collides with other CLIs (e.g. Grok).
            cursorCliBinPath = await resolveCliFromPathAsync?.("cursor-agent", shellEnv)
              || null;
          }
        }
        const codexRuntime = backendKey === "codex" && requestedCodexRuntime === "app-server"
          ? "app-server"
          : "sdk";
        // claude/copilot/opencode enumerate models via the SDK; codex has no
        // catalog (its driver returns []), so the renderer falls back to curated
        // presets. Cache + in-flight coalescing avoid spawn storms (#2184).
        const cacheKey = buildSdkModelCacheKey(
          backendKey,
          cursorAuthMode === "cli-login" ? (cursorCliBinPath || binPath) : binPath,
          env,
          `${codexRuntime}:${cursorAuthMode}`,
        );
        const shouldCacheModels = shouldCacheSdkRuntimeModels(backendKey);
        const cached = shouldCacheModels ? sdkModelCache.get(cacheKey) : null;
        if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) {
          return { ok: true, currentModelId: cached.currentModelId || null, models: cached.models };
        }

        const existing = sdkModelInFlight.get(cacheKey);
        if (existing) return await existing;

        const loadPromise = (async () => {
          const abortController = new AbortController();
          try {
            const raw = await withTimeout(
              codexRuntime === "app-server"
                ? codexAppServerRuntime.listModels({ binPath, env })
                : driver.listModels({
                  binPath,
                  env,
                  abortController,
                  cursorAuthMode: backendKey === "cursor" ? cursorAuthMode : undefined,
                  cursorCliBinPath: backendKey === "cursor" ? cursorCliBinPath : undefined,
                }),
              MODEL_LIST_TIMEOUT_MS,
              abortController,
            );
            const { currentModelId, models } = normalizeSdkListModelsResult(raw);
            // Do not cache degraded empty catalogs: listOpenCodeModels and
            // other drivers often return [] on timeout/startup failure, and
            // pinning that for TTL would block recovery (matches renderer
            // sdkRuntimeModelCache behavior).
            if (shouldCacheModels && (models.length > 0 || currentModelId)) {
              sdkModelCache.set(cacheKey, { at: Date.now(), currentModelId, models });
            }
            return { ok: true, currentModelId, models };
          } catch (err) {
            // Degrade to [] so the renderer keeps its curated presets (never empty).
            console.debug(`[sdk] list-models(${backendKey}) unavailable, using curated presets`);
            return {
              ok: true,
              currentModelId: null,
              models: [],
              warning: codexRuntime === "app-server" ? (err?.message || String(err)) : undefined,
            };
          }
        })();

        sdkModelInFlight.set(cacheKey, loadPromise);
        try {
          return await loadPromise;
        } finally {
          if (sdkModelInFlight.get(cacheKey) === loadPromise) {
            sdkModelInFlight.delete(cacheKey);
          }
        }
      } catch (err) {
        // Degrade to [] so the renderer keeps its curated presets (never empty).
        console.debug(`[sdk] list-models(${backendKey}) unavailable, using curated presets`);
        return {
          ok: true,
          currentModelId: null,
          models: [],
          warning: backendKey === "codex" && requestedCodexRuntime === "app-server"
            ? (err?.message || String(err))
            : undefined,
        };
      }
    });

    ipcMain.handle("netcatty:ai:sdk-agent:steer", async (event, payload) => {
      if (!validateSender(event)) return { status: "failed", message: "Unauthorized IPC sender" };
      const requestId = String(payload?.requestId || "");
      const chatSessionId = String(payload?.chatSessionId || "");
      const prompt = String(payload?.prompt || "");
      const clientUserMessageId = String(payload?.clientUserMessageId || "");
      if (!requestId || !chatSessionId || !clientUserMessageId) {
        return { status: "failed", message: "Invalid Codex steer request" };
      }
      if (sdkRequestSessions.get(requestId) !== chatSessionId) {
        return { status: "inactive" };
      }
      const runtime = sdkRequestRuntimes.get(requestId);
      if (!runtime) return { status: "busy" };
      if (runtime?.backendKey !== "codex" || runtime.codexRuntime !== "app-server") {
        return { status: "unsupported" };
      }

      const stagedAttachments = [];
      const steerPrompt = buildSdkTurnPrompt({
        prompt,
        replayHistory: false,
        attachments: payload?.images,
        onStagedAttachment: (attachment) => stagedAttachments.push(attachment),
      });
      mcpServerBridge.updateAttachmentMetadata?.(stagedAttachments, chatSessionId);
      const result = await codexAppServerRuntime.steerTurn(requestId, {
        chatSessionId,
        prompt: steerPrompt,
        attachments: stagedAttachments,
        clientUserMessageId,
      });
      return result.status === "inactive" && sdkActiveStreams.has(requestId)
        ? { status: "busy" }
        : result;
    });

    ipcMain.handle("netcatty:ai:sdk-agent:cancel", async (event, { requestId, chatSessionId }) => {
      if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
      const effectiveChatSessionId = chatSessionId || sdkRequestSessions.get(requestId);
      mcpServerBridge.setChatSessionCancelled?.(effectiveChatSessionId, true);
      mcpServerBridge.cancelPtyExecsForSession(effectiveChatSessionId);
      mcpServerBridge.cancelWorkerBackgroundJobsForSession?.(effectiveChatSessionId);
      mcpServerBridge.clearPendingApprovals(effectiveChatSessionId);
      void mcpServerBridge.cancelSftpOpsForSession?.(effectiveChatSessionId);
      await codexAppServerRuntime.cancelTurn(requestId);
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
      await codexAppServerRuntime.cleanupChatSession(chatSessionId);
      await mcpServerBridge.cleanupScopedMetadata(chatSessionId);
      return { ok: true };
    });

    ipcMain.handle("netcatty:ai:codex-app-server:interaction-response", async (event, payload) => {
      if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
      const ok = codexAppServerRuntime.respondInteraction(payload?.interactionId, payload, event.sender);
      return ok ? { ok: true } : { ok: false, error: "Interaction not found" };
    });

    ipcMain.handle("netcatty:ai:codex-app-server:status", async (event, payload) => {
      if (!validateSenderOrSettings(event)) return { ok: false, available: false, error: "Unauthorized IPC sender" };
      try {
        const shellEnv = await getShellEnv();
        let env = buildSdkAgentEnv({
          shellEnv,
          requestedAgentEnv: normalizeAgentEnv(payload?.agentEnv),
          withCliDiscoveryEnv,
          normalizeClaudeCodeExecutableEnv: normalizeClaudeCodeExecutableEnvForSdk,
        });
        const binPath = resolveSdkBackendBinPath({
          backendKey: "codex",
          configuredCommand: payload?.agentCommand,
          shellEnv,
          env,
          resolveCliFromPath,
          normalizeCliPathForPlatform,
          resolveSdkBinPath,
          resolveClaudeCodeExecutableForSdk,
          resolveCodexExecutableForSdk,
          resolveCodebuddyExecutableForSdk,
        });
        env = addCodexExecutableEnvForSdk(env, binPath);
        const result = await probeCodexAppServer({ binPath, env });
        return { ok: true, ...result };
      } catch (error) {
        return { ok: true, available: false, error: error?.message || String(error) };
      }
    });

    // Expose teardown so aiBridge.cleanup() can abort active SDK streams.
    ctx.sdkActiveStreams = sdkActiveStreams;
    ctx.codexAppServerRuntime = codexAppServerRuntime;
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
  expireSiblingCursorCliModeSessions,
  shouldCacheSdkRuntimeModels,
  normalizeHistoryMessages,
  buildSdkTurnPrompt,
};
