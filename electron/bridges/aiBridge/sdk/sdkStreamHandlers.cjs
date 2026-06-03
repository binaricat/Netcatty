/* eslint-disable no-undef */

const { getDriver, listBackends } = require("./index.cjs");
const { buildSdkAgentEnv } = require("./env.cjs");
const { buildInjectedMcpServers } = require("./injectMcp.cjs");
const { createStreamEmitter } = require("./emit.cjs");

const VALID_BACKENDS = new Set(listBackends());

/** Map the renderer-supplied backend value (acpCommand field) to a registry key. */
function resolveBackendKey(value) {
  const key = String(value || "").trim();
  return VALID_BACKENDS.has(key) ? key : null;
}

function registerSdkStreamHandlers(ctx) {
  with (ctx) {
    // chatSessionId -> { sessionId } for resume; controller per requestId.
    const sdkActiveStreams = new Map(); // requestId -> AbortController
    const sdkRequestSessions = new Map(); // requestId -> chatSessionId
    const sdkSessionIds = new Map(); // chatSessionId -> last sessionId

    ipcMain.handle(
      "netcatty:ai:acp:stream",
      async (event, payload) => {
        if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
        const {
          requestId, chatSessionId, acpCommand, prompt, cwd,
          model, existingSessionId, toolIntegrationMode,
          defaultTargetSession, userSkillsContext, agentEnv: requestedAgentEnv,
        } = payload;

        const backendKey = resolveBackendKey(acpCommand);
        if (!backendKey) {
          safeSend(event.sender, "netcatty:ai:acp:error", {
            requestId, error: `Unknown SDK backend: ${acpCommand}`,
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

          const env = buildSdkAgentEnv({
            shellEnv,
            requestedAgentEnv: normalizeAgentEnv(requestedAgentEnv),
            withCliDiscoveryEnv,
            normalizeClaudeCodeExecutableEnv: normalizeClaudeCodeExecutableEnvForAcp,
          });

          // Resolve absolute CLI path for the backend (claude needs absolute).
          const binPath = resolveCliFromPath(backendKey, shellEnv) || undefined;

          const contextualPrompt = buildExternalAgentContextualPrompt({
            mode: effectiveMode,
            prompt,
            chatSessionId,
            defaultTargetSession,
            userSkillsContext,
          });

          const resumeSessionId = sdkSessionIds.get(chatSessionId) || existingSessionId || undefined;

          const driver = getDriver(backendKey);
          const result = await driver.runTurn({
            prompt: contextualPrompt,
            cwd: cwd || process.cwd(),
            model: model || undefined,
            env,
            binPath,
            injectedMcpServers,
            emitter,
            signal: abortController.signal,
            abortController,
            resumeSessionId,
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

    ipcMain.handle("netcatty:ai:acp:list-models", async (event, { acpCommand }) => {
      if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
      const backendKey = resolveBackendKey(acpCommand);
      if (!backendKey) return { ok: false, error: `Unknown SDK backend: ${acpCommand}` };
      // SDK backends don't expose a uniform pre-flight model catalog like ACP
      // sessionInfo.configOptions did. The UI selects from its own per-backend
      // model list (managedAgents) and passes `model` through to the SDK.
      // Returning empty keeps the UI's existing "use configured model" path.
      // 🔬 SMOKE-CALIBRATE: if a backend can cheaply enumerate models, wire it here.
      return { ok: true, currentModelId: null, models: [] };
    });

    ipcMain.handle("netcatty:ai:acp:cancel", async (event, { requestId, chatSessionId }) => {
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

    ipcMain.handle("netcatty:ai:acp:cleanup", async (event, { chatSessionId }) => {
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

module.exports = { registerSdkStreamHandlers, resolveBackendKey };
