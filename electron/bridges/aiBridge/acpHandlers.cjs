/* eslint-disable no-undef */
function registerAcpHandlers(ctx) {
  with (ctx) {
  ipcMain.handle("netcatty:ai:acp:list-models", async (event, { acpCommand, acpArgs, cwd, providerId, chatSessionId, agentEnv: requestedAgentEnv }) => {
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }

    let provider = null;
    let copilotConfigInfo = null;
    try {
      const { createACPProvider } = require("@mcpc-tech/acp-ai-provider");
      const shellEnv = await getShellEnv();
      const sessionCwd = cwd || process.cwd();
      const isCodexAgent = matchesAgentCommand(acpCommand, "codex-acp");
      const isClaudeAgent = matchesAgentCommand(acpCommand, "claude-agent-acp");
      const isCopilotAgent = matchesAgentCommand(acpCommand, "copilot");
      const agentLabel = isCodexAgent ? "codex" : isClaudeAgent ? "claude" : isCopilotAgent ? "copilot" : acpCommand;

      const resolvedProvider = providerId ? resolveProviderApiKey(providerId) : null;
      const apiKey = resolvedProvider?.apiKey || undefined;

      // Mirror the stream handler's pre-flight: if Codex is pointed at a
      // config.toml custom provider whose env_key is not exported, surface
      // a targeted error instead of spawning codex-acp and letting it fail
      // mid-init with an opaque message.
      if (isCodexAgent && !apiKey) {
        const preflight = getCodexCustomConfigPreflightError(
          readCodexCustomProviderConfig(shellEnv),
        );
        if (preflight) {
          return { ok: false, models: [], error: preflight };
        }
      }

      let agentEnv = withCliDiscoveryEnv({ ...shellEnv, ...normalizeAgentEnv(requestedAgentEnv) });
      if (isClaudeAgent) {
        agentEnv = normalizeClaudeCodeExecutableEnvForAcp(agentEnv);
      }
      if (isCodexAgent && apiKey) {
        agentEnv.CODEX_API_KEY = apiKey;
      }
      if (isCodexAgent && resolvedProvider?.provider?.baseURL) {
        agentEnv.OPENAI_BASE_URL = resolvedProvider.provider.baseURL;
      }
      // Claude agent auth is owned entirely by its CLI config/login state
      // (`claude auth login`, ~/.claude settings, or ANTHROPIC_* in the user's
      // shell env). netcatty's provider list must not override it.

      if (isCopilotAgent) {
        copilotConfigInfo = prepareCopilotHome(shellEnv, [], chatSessionId || `models_${Date.now()}`);
        agentEnv.COPILOT_HOME = copilotConfigInfo.copilotHome;
      }

      const claudeAcp = isClaudeAgent ? resolveClaudeAcpBinaryPath(shellEnv, electronModule) : null;
      const resolvedCommand = isCodexAgent
        ? resolveCodexAcpBinaryPath(shellEnv, electronModule)
        : claudeAcp
          ? claudeAcp.command
          : acpCommand;
      if (!resolvedCommand) {
        return { ok: false, models: [], error: `${agentLabel} binary not found` };
      }
      const resolvedArgs = claudeAcp
        ? [...claudeAcp.prependArgs, ...(acpArgs || [])]
        : acpArgs || [];
      if (claudeAcp?.env) {
        Object.assign(agentEnv, claudeAcp.env);
      }

      provider = createACPProvider({
        command: resolvedCommand,
        args: resolvedArgs,
        env: agentEnv,
        session: {
          cwd: sessionCwd,
          mcpServers: [],
        },
        ...(isCodexAgent
          ? getCodexAuthOverride(apiKey, shellEnv)
          : isCopilotAgent
            ? { authMethodId: "copilot-login" }
            : {}),
      });

      const sessionInfo = await provider.initSession();
      const modelCatalog = normalizeAcpSessionModels(sessionInfo);

      if (isCopilotAgent) {
        logAcpDebug(agentLabel, "Fetched session models", {
          chatSessionId: chatSessionId || null,
          currentModelId: modelCatalog.currentModelId || null,
          availableModelIds: modelCatalog.models.map((modelInfo) => modelInfo.id),
          copilotHome: copilotConfigInfo?.copilotHome || null,
          copilotMcpConfigPath: copilotConfigInfo?.configPath || null,
        });
      }

      return {
        ok: true,
        currentModelId: modelCatalog.currentModelId || null,
        models: modelCatalog.models,
      };
    } catch (err) {
      const normalized = extractCodexError(err);
      console.error("[ACP] Failed to list models:", normalized.message);
      return { ok: false, error: normalized.message };
    } finally {
      try {
        cleanupAcpProviderInstance(provider, chatSessionId || "transient-model-list");
      } catch {
        // Ignore cleanup failures for transient model-discovery providers.
      }
      // Clean up transient COPILOT_HOME created for model listing
      if (copilotConfigInfo?.copilotHome) {
        try {
          fs.rmSync(copilotConfigInfo.copilotHome, { recursive: true, force: true });
        } catch { /* best-effort */ }
      }
    }
  });

  ipcMain.handle("netcatty:ai:acp:stream", async (event, { requestId, chatSessionId, acpCommand, acpArgs, prompt, cwd, providerId, model, existingSessionId, historyMessages, images, toolIntegrationMode, defaultTargetSession, userSkillsContext, agentEnv: requestedAgentEnv }) => {
    // Validate IPC sender (Issue #17)
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }
    let abortController = null;
    // Hoisted so the catch block can reference them for Claude-specific error handling.
    let isClaudeAgent = false;
    let claudeAuthPresence = null;
    try {
      const existingRun = acpChatRuns.get(chatSessionId);
      if (existingRun && existingRun.requestId !== requestId) {
        // Capture whether the prior run was already cancelled (via the
        // cancel IPC) BEFORE we set the flag ourselves — the cancel IPC
        // contract explicitly preserves the provider session so the
        // next prompt can continue in the same conversation. Tearing
        // down the provider here would silently break that contract in
        // the "click Stop, then immediately send next prompt" flow,
        // discarding the recovered ACP session.
        const alreadyCancelledViaIpc = existingRun.cancelRequested;
        existingRun.cancelRequested = true;
        const existingController = acpActiveStreams.get(existingRun.requestId);
        if (existingController) {
          existingController.abort();
          acpActiveStreams.delete(existingRun.requestId);
        }
        acpRequestSessions.delete(existingRun.requestId);
        // Only tear down the provider for true interrupt-and-restart
        // flows (user typed a new prompt while the old one was still
        // streaming, no explicit cancel). When we do skip cleanup here,
        // the reuse/reset logic below still handles auth/MCP/permission
        // changes correctly — the provider is preserved only when
        // nothing else would require rebuilding it.
        if (!alreadyCancelledViaIpc) {
          cleanupAcpProvider(chatSessionId);
        }
      }

      mcpServerBridge.setChatSessionCancelled?.(chatSessionId, false);
      abortController = new AbortController();
      acpActiveStreams.set(requestId, abortController);
      acpRequestSessions.set(requestId, chatSessionId);
      acpChatRuns.set(chatSessionId, { requestId, cancelRequested: false });

      const consumePendingStartupCancel = () => {
        if (!acpPendingCancelRequests.has(requestId)) return false;
        acpPendingCancelRequests.delete(requestId);
        abortController?.abort();
        return true;
      };

      const shouldAbortStartup = () =>
        Boolean(abortController?.signal?.aborted || consumePendingStartupCancel());

      const { createACPProvider } = require("@mcpc-tech/acp-ai-provider");
      const { streamText, stepCountIs } = require("ai");

      const shellEnv = await getShellEnv();
      if (shouldAbortStartup()) return { ok: true };
      const sessionCwd = cwd || process.cwd();
      const isCodexAgent = matchesAgentCommand(acpCommand, "codex-acp");
      isClaudeAgent = matchesAgentCommand(acpCommand, "claude-agent-acp");
      const isCopilotAgent = matchesAgentCommand(acpCommand, "copilot");
      // For Claude: detect whether any auth is reachable so we can turn an
      // opaque "-32603 Internal error" into actionable guidance on failure.
      // Heuristic only (macOS may keep creds in Keychain) — never hard-block.
      claudeAuthPresence = isClaudeAgent
        ? detectClaudeAuthPresence({ ...shellEnv, ...normalizeAgentEnv(requestedAgentEnv) })
        : null;
      const agentLabel = isCodexAgent ? "codex" : isClaudeAgent ? "claude" : isCopilotAgent ? "copilot" : acpCommand;
      const effectiveToolIntegrationMode = normalizeToolIntegrationMode(toolIntegrationMode);
      debugMcpLog("ACP request start", {
        requestId,
        chatSessionId,
        acpCommand,
        acpArgs,
        model,
        providerId,
        sessionCwd,
        isCodexAgent,
        isClaudeAgent,
        toolIntegrationMode: effectiveToolIntegrationMode,
      });

      // Resolve API key from providerId (decrypted in main process only)
      const resolvedProvider = providerId ? resolveProviderApiKey(providerId) : null;
      const apiKey = resolvedProvider?.apiKey || undefined;

      // Probe ~/.codex/config.toml first so we can tell a ChatGPT user
      // (needs login validation) from a custom-provider user (must NOT be
      // forced through ChatGPT validation, since their auth lives in
      // config.toml / shell env, not auth.json).
      const codexCustomConfig = isCodexAgent && !apiKey
        ? readCodexCustomProviderConfig(shellEnv)
        : null;

      // Fail loud: custom-provider config is set but has no usable auth
      // material yet (env_key is named but not exported in the shell env,
      // and no api_key is hardcoded). Don't spawn — codex-acp would fail
      // mid-request with an opaque "Missing environment variable" error.
      const preflightError = getCodexCustomConfigPreflightError(codexCustomConfig);
      if (preflightError) {
        safeSend(event.sender, "netcatty:ai:acp:error", {
          requestId,
          error: preflightError,
        });
        return { ok: false, error: `Missing env var ${codexCustomConfig.envKey}` };
      }

      if (isCodexAgent && !apiKey && !codexCustomConfig) {
        const validation = await validateCodexChatGptAuth({ maxAgeMs: 10000 });
        if (shouldAbortStartup()) return { ok: true };
        if (!validation.ok) {
          if (isCodexAuthError(validation)) {
            try {
              await runCodexCli(["logout"]);
            } catch {
              // Ignore logout failures during recovery.
            }
            invalidateCodexValidationCache();
          }

          safeSend(event.sender, "netcatty:ai:acp:error", {
            requestId,
            error: `Codex ChatGPT login is stale or invalid. Reconnect Codex in Settings -> AI.\n\nDetails: ${validation.error || "Unknown authentication error"}`,
          });
          return { ok: false, error: validation.error || "Codex authentication validation failed" };
        }
      }

      const authFingerprint = isCodexAgent
        ? getAcpProviderAuthFingerprint(apiKey, resolvedProvider?.provider, codexCustomConfig)
        : isClaudeAgent
          // Fingerprint the Claude agent env (config dir + user env vars) so a
          // settings change invalidates the cached per-session provider and the
          // next turn respawns with the new config instead of reusing a stale
          // process spawned with the old env.
          ? JSON.stringify(normalizeAgentEnv(requestedAgentEnv))
          : null;
      const mcpSnapshot = isCodexAgent
        ? await resolveCodexMcpSnapshot(sessionCwd)
        : { mcpServers: [], fingerprint: getCodexMcpFingerprint([]) };
      if (shouldAbortStartup()) return { ok: true };

      setToolIntegrationMode(effectiveToolIntegrationMode);
      if (effectiveToolIntegrationMode === "skills") {
        try {
          await ensureSkillsCliHost();
        } catch (err) {
          const message = err?.message || String(err);
          safeSend(event.sender, "netcatty:ai:acp:error", {
            requestId,
            error: `Failed to initialize Netcatty Skills + CLI bridge.\n\nDetails: ${message}`,
          });
          return { ok: false, error: message };
        }
      }

      // Inject Netcatty MCP server for scoped terminal-session access only when
      // the user selected MCP mode. Skills mode uses the Netcatty CLI instead.
      if (effectiveToolIntegrationMode === "mcp") {
        try {
          const mcpPort = await mcpServerBridge.getOrCreateHost();
          const scopedIds = mcpServerBridge.getScopedSessionIds(chatSessionId);
          const netcattyMcpConfig = mcpServerBridge.buildMcpServerConfig(mcpPort, scopedIds, chatSessionId);
          mcpSnapshot.mcpServers.push(netcattyMcpConfig);
          debugMcpLog("Injected Netcatty MCP server", {
            requestId,
            chatSessionId,
            mcpPort,
            scopedIds,
            mcpServerNames: mcpSnapshot.mcpServers.map(server => server.name),
          });
          if (isCopilotAgent) {
            logAcpDebug(agentLabel, "Injected Netcatty MCP server into session", {
              chatSessionId,
              scopedIds,
              injectedServer: summarizeMcpServersForDebug([netcattyMcpConfig])[0],
            });
          }
        } catch (err) {
          console.error("[ACP] Failed to inject Netcatty MCP server:", err?.message || err);
        }
      }
      if (shouldAbortStartup()) return { ok: true };

      // Recalculate fingerprint after injection
      mcpSnapshot.fingerprint = getCodexMcpFingerprint(mcpSnapshot.mcpServers);

      const currentPermissionMode = mcpServerBridge.getPermissionMode();
      let providerEntry = acpProviders.get(chatSessionId);
      const shouldReuseProvider = Boolean(
        providerEntry &&
        providerEntry.acpCommand === acpCommand &&
        providerEntry.cwd === sessionCwd &&
        providerEntry.authFingerprint === authFingerprint &&
        providerEntry.mcpFingerprint === mcpSnapshot.fingerprint &&
        providerEntry.permissionMode === currentPermissionMode,
      );
      const shouldResetProviderForHistoryReplay = Boolean(
        shouldReuseProvider &&
        providerEntry?.historyReplayFallback &&
        Array.isArray(historyMessages) &&
        historyMessages.length > 0,
      );

      if (!shouldReuseProvider || shouldResetProviderForHistoryReplay) {
        const resumeSessionId = shouldResetProviderForHistoryReplay
          ? undefined
          : providerEntry?.provider?.getSessionId?.() || existingSessionId || undefined;
        // Preserve the replay-fallback flag across any recreation where
        // history recovery is still pending, not just the reset-for-replay
        // path. Otherwise a provider recreation driven by an orthogonal
        // change (permission mode / MCP scope / auth fingerprint) between
        // a still-empty recovered turn and its retry would drop the flag
        // and lose the recovered conversation on the next turn.
        //
        // Also hedge whenever we're spawning a brand-new provider process
        // that's being told to resume an existing session id (the common
        // app-restart / reconnect flow — #753). Some ACP agents (Copilot
        // CLI, some Codex builds) silently spin up a fresh session
        // instead of erroring with "session not found", so the catch-
        // block fallback below never fires and the agent ends up with
        // zero prior context. Scheduling a compact replay on the first
        // turn guarantees the agent sees durable constraints and the
        // last few raw turns even when session/load is effectively a
        // no-op. After the first successful streamed turn the flag
        // clears (post-stream hook), so steady-state cost stays at
        // just the latest prompt.
        const preserveHistoryReplayFallback =
          shouldResetProviderForHistoryReplay ||
          Boolean(
            providerEntry?.historyReplayFallback &&
            Array.isArray(historyMessages) &&
            historyMessages.length > 0,
          ) ||
          Boolean(
            resumeSessionId &&
            Array.isArray(historyMessages) &&
            historyMessages.length > 0,
          );
        cleanupAcpProvider(chatSessionId);

        let agentEnv = withCliDiscoveryEnv({ ...shellEnv, ...normalizeAgentEnv(requestedAgentEnv) });
        if (isClaudeAgent) {
          agentEnv = normalizeClaudeCodeExecutableEnvForAcp(agentEnv);
        }
        if (isCodexAgent && apiKey) {
          agentEnv.CODEX_API_KEY = apiKey;
        }
        if (isCodexAgent && resolvedProvider?.provider?.baseURL) {
          agentEnv.OPENAI_BASE_URL = resolvedProvider.provider.baseURL;
        }
        // See comment above: Claude auth is CLI-owned, not provider-driven.
        let copilotConfigInfo = null;
        if (isCopilotAgent) {
          copilotConfigInfo = prepareCopilotHome(shellEnv, mcpSnapshot.mcpServers, chatSessionId);
          agentEnv.COPILOT_HOME = copilotConfigInfo.copilotHome;
        }

        const claudeAcp = isClaudeAgent ? resolveClaudeAcpBinaryPath(shellEnv, electronModule) : null;
        const resolvedCommand = isCodexAgent
          ? resolveCodexAcpBinaryPath(shellEnv, electronModule)
          : claudeAcp
            ? claudeAcp.command
            : acpCommand;
        if (!resolvedCommand) {
          throw new Error(`${agentLabel} binary not found`);
        }
        const resolvedArgs = claudeAcp
          ? [...claudeAcp.prependArgs, ...(acpArgs || [])]
          : acpArgs || [];
        if (claudeAcp?.env) {
          Object.assign(agentEnv, claudeAcp.env);
        }
        const sessionMcpServers = isCopilotAgent ? [] : mcpSnapshot.mcpServers;

        const provider = createACPProvider({
          command: resolvedCommand,
          args: resolvedArgs,
          env: agentEnv,
          session: {
            cwd: sessionCwd,
            mcpServers: sessionMcpServers,
          },
          ...(resumeSessionId ? { existingSessionId: resumeSessionId } : {}),
          ...(isCodexAgent
            ? getCodexAuthOverride(apiKey, shellEnv)
            : isCopilotAgent
              ? { authMethodId: "copilot-login" }
            : {}),
          persistSession: true,
        });
        debugMcpLog("Created ACP provider", {
          requestId,
          chatSessionId,
          resolvedCommand,
          resolvedArgs,
          mcpServerNames: mcpSnapshot.mcpServers.map(server => server.name),
          authMethodId: isCodexAgent ? (getCodexAuthOverride(apiKey, shellEnv).authMethodId || null) : null,
        });

        if (isCopilotAgent) {
          logAcpDebug(agentLabel, "Creating ACP provider", {
            requestId,
            chatSessionId,
            cwd: sessionCwd,
            resolvedCommand,
            resolvedArgs,
            sessionMcpServers: summarizeMcpServersForDebug(sessionMcpServers),
            copilotHome: copilotConfigInfo?.copilotHome || null,
            copilotMcpConfigPath: copilotConfigInfo?.configPath || null,
            copilotMcpServerNames: copilotConfigInfo?.serverNames || [],
          });
        }

        providerEntry = {
          provider,
          acpCommand,
          cwd: sessionCwd,
          authFingerprint,
          mcpFingerprint: mcpSnapshot.fingerprint,
          permissionMode: currentPermissionMode,
          historyReplayFallback: preserveHistoryReplayFallback,
        };
        acpProviders.set(chatSessionId, providerEntry);
      }
      let modelInstance = providerEntry.provider.languageModel(model || undefined);
      try {
        await providerEntry.provider.initSession(providerEntry.provider.tools);
        debugMcpLog("provider.initSession ok", {
          requestId,
          chatSessionId,
          providerSessionId: providerEntry.provider.getSessionId?.() || null,
        });
        if (isCopilotAgent) {
          logAcpDebug(agentLabel, "ACP session initialized", {
            requestId,
            chatSessionId,
            providerSessionId: providerEntry.provider.getSessionId?.() || null,
            toolNames: Object.keys(providerEntry.provider.tools || {}),
          });
        }
        if (shouldAbortStartup()) return { ok: true };
      } catch (err) {
        debugMcpLog("provider.initSession error", {
          requestId,
          chatSessionId,
          message: err?.message || String(err),
        });
        const attemptedResumeSessionId = providerEntry.provider?.getSessionId?.() || existingSessionId;
        if (!attemptedResumeSessionId || !shouldRetryFreshSession(err)) {
          throw err;
        }

        cleanupAcpProvider(chatSessionId);

        const fallbackClaudeAcp = isClaudeAgent ? resolveClaudeAcpBinaryPath(shellEnv, electronModule) : null;
        const fallbackCommand = isCodexAgent
          ? resolveCodexAcpBinaryPath(shellEnv, electronModule)
          : fallbackClaudeAcp
            ? fallbackClaudeAcp.command
            : acpCommand;
        if (!fallbackCommand) {
          throw new Error(`${agentLabel} binary not found`);
        }
        const fallbackProvider = createACPProvider({
          command: fallbackCommand,
          args: fallbackClaudeAcp
            ? [...fallbackClaudeAcp.prependArgs, ...(acpArgs || [])]
            : acpArgs || [],
          env: (() => {
            let fallbackEnv = withCliDiscoveryEnv(
              isCodexAgent && apiKey
                ? { ...shellEnv, ...normalizeAgentEnv(requestedAgentEnv), CODEX_API_KEY: apiKey }
                : { ...shellEnv, ...normalizeAgentEnv(requestedAgentEnv) },
            );
            if (isClaudeAgent) {
              fallbackEnv = normalizeClaudeCodeExecutableEnvForAcp(fallbackEnv);
            }
            if (isCodexAgent && resolvedProvider?.provider?.baseURL) {
              fallbackEnv.OPENAI_BASE_URL = resolvedProvider.provider.baseURL;
            }
            // See comment above: Claude auth is CLI-owned, not provider-driven.
            if (isCopilotAgent) {
              const fallbackCopilotConfig = prepareCopilotHome(shellEnv, mcpSnapshot.mcpServers, chatSessionId);
              fallbackEnv.COPILOT_HOME = fallbackCopilotConfig.copilotHome;
            }
            if (fallbackClaudeAcp?.env) {
              Object.assign(fallbackEnv, fallbackClaudeAcp.env);
            }
            return fallbackEnv;
          })(),
          session: {
            cwd: sessionCwd,
            mcpServers: isCopilotAgent ? [] : mcpSnapshot.mcpServers,
          },
          ...(isCodexAgent
            ? getCodexAuthOverride(apiKey, shellEnv)
            : isCopilotAgent
              ? { authMethodId: "copilot-login" }
            : {}),
          persistSession: true,
        });

        providerEntry = {
          provider: fallbackProvider,
          acpCommand,
          cwd: sessionCwd,
          authFingerprint,
          mcpFingerprint: mcpSnapshot.fingerprint,
          permissionMode: currentPermissionMode,
          historyReplayFallback: Array.isArray(historyMessages) && historyMessages.length > 0,
        };
        acpProviders.set(chatSessionId, providerEntry);
        modelInstance = providerEntry.provider.languageModel(model || undefined);
        await providerEntry.provider.initSession(providerEntry.provider.tools);
        debugMcpLog("fallback provider.initSession ok", {
          requestId,
          chatSessionId,
          providerSessionId: providerEntry.provider.getSessionId?.() || null,
        });
        if (isCopilotAgent) {
          logAcpDebug(agentLabel, "ACP session initialized after fallback", {
            requestId,
            chatSessionId,
            providerSessionId: providerEntry.provider.getSessionId?.() || null,
            toolNames: Object.keys(providerEntry.provider.tools || {}),
          });
        }
        if (shouldAbortStartup()) return { ok: true };
      }
      const activeProviderSessionId = providerEntry.provider.getSessionId?.() || null;
      if (activeProviderSessionId) {
        safeSend(event.sender, "netcatty:ai:acp:event", {
          requestId,
          event: { type: "session-id", sessionId: activeProviderSessionId },
        });
      }

      // Prepend context hint so the agent uses the configured Netcatty access mode.
      const contextualPrompt = buildExternalAgentContextualPrompt({
        mode: effectiveToolIntegrationMode,
        prompt,
        chatSessionId,
        defaultTargetSession,
        userSkillsContext,
      });

      // Build message content: text + optional attachments
      // ACP provider only supports image/* and audio/* inline via `type: "file"`.
      // For other file types (PDF, text, etc.), tell the agent the original file
      // path so it can read it directly — ACP agents have local file access.
      function buildMessageContent(text, attachments) {
        if (!Array.isArray(attachments) || attachments.length === 0) {
          return text;
        }

        const content = [];
        const fileHints = [];

        for (const att of attachments) {
          if (!att.base64Data || !att.mediaType) continue;

          if (att.mediaType.startsWith("image/")) {
            // Images: pass inline as ACP-compatible file parts
            content.push({
              type: "file",
              mediaType: att.mediaType,
              data: att.base64Data,
              ...(att.filename ? { filename: att.filename } : {}),
            });
          } else if (att.filePath) {
            // Non-image files with a known local path: tell the agent to read it
            fileHints.push(`[Attached file "${att.filename || "file"}" is on the LOCAL machine (not a remote server), path: ${att.filePath} — read it locally]`);
          } else {
            // Pasted/virtual files without a path: save to managed temp dir so the agent can read them
            try {
              const fs = require("node:fs");
              const tempDirBridge = require("./tempDirBridge.cjs");
              const safeName = att.filename || `file-${Date.now()}`;
              const tempPath = tempDirBridge.getTempFilePath(safeName);
              fs.writeFileSync(tempPath, Buffer.from(att.base64Data, "base64"));
              fileHints.push(`[Attached file "${att.filename || safeName}" is on the LOCAL machine (not a remote server), path: ${tempPath} — read it locally]`);
            } catch (err) {
              console.error("[ACP] Failed to save pasted attachment to temp:", err?.message || err);
            }
          }
        }

        const fullText = fileHints.length > 0
          ? fileHints.join("\n") + "\n\n" + text
          : text;

        content.unshift({ type: "text", text: fullText });
        return content;
      }

      const latestPromptMessage = {
        role: "user",
        content: buildMessageContent(contextualPrompt, images),
      };
      const shouldReplayHistory = Boolean(
        providerEntry.historyReplayFallback &&
        Array.isArray(historyMessages) &&
        historyMessages.length > 0,
      );

      const result = streamText({
        model: modelInstance,
        messages: shouldReplayHistory
          ? [
              ...historyMessages.map((msg) => ({ role: msg.role, content: msg.content })),
              latestPromptMessage,
            ]
          : [latestPromptMessage],
        tools: providerEntry.provider.tools,
        stopWhen: stepCountIs(mcpServerBridge.getMaxIterations ? mcpServerBridge.getMaxIterations() : 20),
        abortSignal: abortController.signal,
      });
      const reader = result.fullStream.getReader();
      let hasContent = false;
      // Stall detection: if no chunk for 3s, send a status event
      let stallTimer = null;
      const STALL_TIMEOUT_MS = 3000;
      function resetStallTimer() {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          if (!abortController.signal.aborted) {
            if (!isActiveAcpRun(chatSessionId, requestId)) return;
            safeSend(event.sender, "netcatty:ai:acp:event", {
              requestId,
              event: { type: "status", message: "Waiting for response from agent..." },
            });
          }
        }, STALL_TIMEOUT_MS);
      }
      resetStallTimer();
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done || abortController.signal.aborted) break;
          if (!isActiveAcpRun(chatSessionId, requestId)) break;
          resetStallTimer();
          try {
            const serialized = serializeStreamChunk(chunk);
            if (!serialized || !serialized.type) continue;

            if (serialized.type === "text-delta" || serialized.type === "reasoning-delta" || serialized.type === "tool-call" || serialized.type === "tool-result") {
              hasContent = true;
            }
            if (isCopilotAgent && (serialized.type === "tool-call" || serialized.type === "tool-result" || serialized.type === "error" || serialized.type === "status")) {
              logAcpDebug(agentLabel, `Stream event: ${serialized.type}`, serialized);
            }
            debugMcpLog("ACP stream event", {
              requestId,
              chatSessionId,
              type: serialized.type,
              toolName: serialized.toolName || null,
            });
            safeSend(event.sender, "netcatty:ai:acp:event", {
              requestId,
              event: serialized,
            });
          } catch (serErr) {
            console.error("[ACP stream] Failed to serialize chunk:", chunk?.type, serErr?.message);
          }
        }
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
        reader.releaseLock();
      }

      // If stream completed with zero content, likely an auth or connection issue
      if (!hasContent && !abortController.signal.aborted) {
        debugMcpLog("ACP empty response", {
          requestId,
          chatSessionId,
          isCodexAgent,
          providerSessionId: providerEntry.provider.getSessionId?.() || null,
        });
        if (isCopilotAgent) {
          logAcpDebug(agentLabel, "Stream completed with no content", {
            requestId,
            chatSessionId,
            providerSessionId: providerEntry.provider.getSessionId?.() || null,
          });
        }
        if (!isActiveAcpRun(chatSessionId, requestId)) {
          return { ok: true };
        }
        if (isClaudeAgent) {
          // Reap the persistent agent process so a failed turn doesn't leak
          // node.exe processes (provider uses persistSession:true).
          cleanupAcpProvider(chatSessionId);
        }
        safeSend(event.sender, "netcatty:ai:acp:error", {
          requestId,
          error: isCodexAgent
            ? "Codex returned an empty response. Connect Codex in Settings -> AI, or configure an enabled OpenAI provider API key."
            : isClaudeAgent && claudeAuthPresence === "none"
              ? CLAUDE_AUTH_HELP_MESSAGE
              : "Agent returned an empty response.",
        });
      } else {
        // Clear replay fallback when the recovered turn either streamed
        // content OR was user-aborted. The empty-but-not-aborted case is
        // handled in the if-branch above and intentionally keeps the flag
        // so a follow-up retry can re-replay onto a fresh session.
        //
        // Why also clear on abort: if the user actively cancelled, the
        // freshly recovered ACP session has whatever state was built up so
        // far. Leaving the flag set would make the next turn trigger
        // shouldResetProviderForHistoryReplay, which discards the recovered
        // session (resumeSessionId is forced to undefined in that path) and
        // re-spends tokens on another compact replay. That breaks the
        // cancel-preserves-session contract for users who stop early.
        if (shouldReplayHistory) {
          providerEntry.historyReplayFallback = false;
        }
        debugMcpLog("ACP stream done", { requestId, chatSessionId, hasContent });
        if (!isActiveAcpRun(chatSessionId, requestId)) {
          return { ok: true };
        }
        safeSend(event.sender, "netcatty:ai:acp:done", { requestId });
      }
    } catch (err) {
      console.error("[ACP] Handler caught error:", err?.message || err, err?.stack?.split("\n").slice(0, 3).join("\n"));
      const normalized = extractCodexError(err);
      // #3 (light): include JSON-RPC code/data when present so Claude's bare
      // "Internal error" isn't shown context-free.
      const errCode = typeof err?.code === "number" ? err.code : err?.data?.code;
      // Only surface data fields we don't already show (message/code) so the
      // detail doesn't echo them back.
      let errDetail = "";
      if (err?.data && typeof err.data === "object") {
        const extra = { ...err.data };
        delete extra.code;
        delete extra.message;
        if (Object.keys(extra).length > 0) {
          try { errDetail = JSON.stringify(extra); } catch { errDetail = ""; }
        }
      }
      const errMsg = [normalized.message, errCode != null ? `(code ${errCode})` : "", errDetail]
        .filter(Boolean)
        .join(" ");
      const isAuthErr = isCodexAuthError(normalized);

      if (isAuthErr) {
        console.error("[ACP] Auth error — user needs to re-login:", errMsg);
        cleanupAcpProvider(chatSessionId);
      } else if (isClaudeAgent) {
        // #4: always reap the Claude provider/process tree on error.
        cleanupAcpProvider(chatSessionId);
      }

      safeSend(event.sender, "netcatty:ai:acp:error", {
        requestId,
        error: isAuthErr
          ? `Authentication failed. Connect Codex in Settings -> AI, or configure an enabled OpenAI provider API key.\n\nDetails: ${errMsg}`
          : isClaudeAgent && claudeAuthPresence === "none"
            ? `${CLAUDE_AUTH_HELP_MESSAGE}\n\nDetails: ${errMsg}`
            : errMsg,
      });
    } finally {
      acpActiveStreams.delete(requestId);
      acpRequestSessions.delete(requestId);
      acpPendingCancelRequests.delete(requestId);
      const activeRun = acpChatRuns.get(chatSessionId);
      if (activeRun?.requestId === requestId) {
        acpChatRuns.delete(chatSessionId);
      }
    }

    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:acp:cancel", async (event, { requestId, chatSessionId }) => {
    if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const effectiveChatSessionId = chatSessionId || acpRequestSessions.get(requestId);
    const activeRun = effectiveChatSessionId ? acpChatRuns.get(effectiveChatSessionId) : null;
    const effectiveRequestId = requestId || activeRun?.requestId || "";
    // Cancel synchronous PTY executions scoped to this chat session (send Ctrl+C).
    // Do NOT cancel terminal_start background jobs here — they were intentionally
    // launched as long-running and should keep running when the user only wants
    // to stop the model's polling/output. Background jobs are still cleaned up
    // when the chat session itself is deleted (see cleanupScopedMetadata).
    mcpServerBridge.setChatSessionCancelled?.(effectiveChatSessionId, true);
    mcpServerBridge.cancelPtyExecsForSession(effectiveChatSessionId);
    mcpServerBridge.clearPendingApprovals(effectiveChatSessionId);
    if (activeRun && activeRun.requestId === effectiveRequestId) {
      activeRun.cancelRequested = true;
    }
    // Synchronously clear historyReplayFallback on the preserved provider
    // entry. Without this, a user pressing Stop and immediately sending
    // the next prompt can have their new request enter the stream
    // handler before the aborted run's post-stream clearing code runs.
    // The new turn would then see historyReplayFallback=true, trigger
    // shouldResetProviderForHistoryReplay, and recreate the provider
    // without the recovered existingSessionId — discarding the very
    // session the cancel contract promised to preserve.
    if (effectiveChatSessionId) {
      const preservedEntry = acpProviders.get(effectiveChatSessionId);
      if (preservedEntry) preservedEntry.historyReplayFallback = false;
    }
    const controller = acpActiveStreams.get(effectiveRequestId);
    let cancelled = false;
    if (controller) {
      controller.abort();
      acpActiveStreams.delete(effectiveRequestId);
      cancelled = true;
    } else if (effectiveRequestId) {
      acpPendingCancelRequests.add(effectiveRequestId);
      cancelled = true;
    }
    // Preserve the ACP provider session on stop so the next user message can
    // continue within the same persisted conversation context. Full provider
    // cleanup is handled by netcatty:ai:acp:cleanup when the chat is deleted.
    if (effectiveChatSessionId) cancelled = true;
    if (effectiveRequestId) acpRequestSessions.delete(effectiveRequestId);
    void mcpServerBridge.cancelSftpOpsForSession?.(effectiveChatSessionId);
    return cancelled ? { ok: true } : { ok: false, error: "Stream not found" };
  });

  // Cleanup a specific ACP session (when chat session is deleted)
  ipcMain.handle("netcatty:ai:acp:cleanup", async (event, { chatSessionId }) => {
    if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
    mcpServerBridge.setChatSessionCancelled?.(chatSessionId, true);
    mcpServerBridge.cancelPtyExecsForSession(chatSessionId);
    cleanupAcpProvider(chatSessionId);
    await mcpServerBridge.cleanupScopedMetadata(chatSessionId);
    return { ok: true };
  });
  }
}

module.exports = { registerAcpHandlers };
