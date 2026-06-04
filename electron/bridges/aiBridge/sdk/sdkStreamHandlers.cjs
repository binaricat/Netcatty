/* eslint-disable no-undef */

const { getDriver, listBackends } = require("./index.cjs");
const { buildSdkAgentEnv } = require("./env.cjs");
const { buildInjectedMcpServers } = require("./injectMcp.cjs");
const { createStreamEmitter } = require("./emit.cjs");

const VALID_BACKENDS = new Set(listBackends());

// Pre-flight model catalog cache. claude/copilot enumerate models via the SDK
// (supportedModels / listModels); spawning the CLI is ~1-2s, so cache per backend
// and always degrade to [] on error/timeout (the renderer keeps its presets).
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_LIST_TIMEOUT_MS = 10000;
const sdkModelCache = new Map();

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
          defaultTargetSession, userSkillsContext, agentEnv: requestedAgentEnv,
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

          const env = buildSdkAgentEnv({
            shellEnv,
            requestedAgentEnv: normalizedAgentEnv,
            withCliDiscoveryEnv,
            normalizeClaudeCodeExecutableEnv: normalizeClaudeCodeExecutableEnvForSdk,
          });

          // Resolve absolute CLI path for the backend (claude needs absolute).
          const binPath = resolveCliFromPath(backendKey, shellEnv) || undefined;

          const hasInMemorySession = sdkSessionIds.has(chatSessionId);
          const resumeSessionId = sdkSessionIds.get(chatSessionId) || existingSessionId || undefined;
          const stagedAttachments = [];
          const turnPrompt = buildSdkTurnPrompt({
            prompt,
            historyMessages: payload?.historyMessages,
            replayHistory: !hasInMemorySession,
            attachments: payload?.images,
            onStagedAttachment: (attachment) => stagedAttachments.push(attachment),
          });
          mcpServerBridge.updateAttachmentMetadata?.(stagedAttachments, chatSessionId);

          const contextualPrompt = buildExternalAgentContextualPrompt({
            mode: effectiveMode,
            prompt: turnPrompt,
            chatSessionId,
            defaultTargetSession,
            userSkillsContext,
          });

          const driver = getDriver(backendKey);
          const result = await driver.runTurn({
            prompt: contextualPrompt,
            cwd: cwd || process.cwd(),
            model: model || undefined,
            env,
            binPath,
            injectedMcpServers,
            claudeSettings,
            toolIntegrationMode: effectiveMode,
            emitter,
            signal: abortController.signal,
            abortController,
            resumeSessionId,
            attachments: stagedAttachments,
          });

          // Persist any new session id for resume on the next turn.
          const newSessionId = result?.sessionId || result?.threadId;
          if (newSessionId) sdkSessionIds.set(chatSessionId, newSessionId);

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
      const { sdkBackend, agentEnv: requestedAgentEnv } = payload || {};
      const backendKey = resolveBackendKey(sdkBackend);
      if (!backendKey) return { ok: false, error: `Unknown SDK backend: ${sdkBackend}` };

      // claude/copilot enumerate models via the SDK; codex has no catalog (its
      // driver returns []), so the renderer falls back to curated presets.
      const cached = sdkModelCache.get(backendKey);
      if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) {
        return { ok: true, currentModelId: null, models: cached.models };
      }
      try {
        const driver = getDriver(backendKey);
        if (typeof driver.listModels !== "function") {
          return { ok: true, currentModelId: null, models: [] };
        }
        const shellEnv = await getShellEnv();
        const binPath = resolveCliFromPath(backendKey, shellEnv) || undefined;
        const env = buildSdkAgentEnv({
          shellEnv,
          requestedAgentEnv: normalizeAgentEnv(requestedAgentEnv),
          withCliDiscoveryEnv,
          normalizeClaudeCodeExecutableEnv: normalizeClaudeCodeExecutableEnvForSdk,
        });
        const raw = await withTimeout(driver.listModels({ binPath, env }), MODEL_LIST_TIMEOUT_MS);
        const models = Array.isArray(raw) ? raw.filter((m) => m && m.id) : [];
        sdkModelCache.set(backendKey, { at: Date.now(), models });
        return { ok: true, currentModelId: null, models };
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
      mcpServerBridge.clearPendingApprovals(effectiveChatSessionId);
      void mcpServerBridge.cancelSftpOpsForSession?.(effectiveChatSessionId);
      const controller = sdkActiveStreams.get(requestId);
      if (controller) {
        controller.abort();
        sdkActiveStreams.delete(requestId);
        return { ok: true };
      }
      return { ok: false, error: "Stream not found" };
    });

    ipcMain.handle("netcatty:ai:sdk-agent:cleanup", async (event, { chatSessionId }) => {
      if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
      mcpServerBridge.setChatSessionCancelled?.(chatSessionId, true);
      mcpServerBridge.cancelPtyExecsForSession(chatSessionId);
      sdkSessionIds.delete(chatSessionId);
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
  normalizeHistoryMessages,
  buildSdkTurnPrompt,
};
