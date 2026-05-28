/* eslint-disable no-undef */
function registerAgentDiscoveryHandlers(ctx) {
  with (ctx) {
  ipcMain.handle("netcatty:ai:agents:discover", async (event) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const agents = [];
    const knownAgents = [
      {
        command: "claude",
        name: "Claude Code",
        icon: "claude",
        description: "Anthropic's agentic coding assistant",
        acpCommand: "claude-agent-acp",
        acpArgs: [],
        args: ["-p", "--output-format", "text", "{prompt}"],
      },
      {
        command: "codex",
        name: "Codex CLI",
        icon: "openai",
        description: "OpenAI's coding agent",
        acpCommand: "codex-acp",
        acpArgs: [],
        args: ["exec", "--full-auto", "--json", "{prompt}"],
        resolveAcp: resolveCodexAcpBinaryPath,
      },
      {
        command: "copilot",
        name: "GitHub Copilot CLI",
        icon: "copilot",
        description: "GitHub's coding agent CLI",
        acpCommand: "copilot",
        acpArgs: ["--acp", "--stdio"],
        args: ["-p", "{prompt}"],
      },
    ];

    const shellEnv = await getShellEnv();
    const seenPaths = new Set();

    for (const agent of knownAgents) {
      let resolvedPath = resolveCliFromPath(agent.command, shellEnv);
      const supportsBundledAcpFallback = agent.command === "codex";

      // Codex can still work via bundled ACP if its standalone CLI is missing.
      // Claude must resolve to the system `claude` executable and pass version probing.
      // ACP resolvers return either a plain path or { command, prependArgs }.
      let versionCommand = null;
      let versionPrependArgs = [];
      let usesAcpFallback = false;
      const tryResolveAcpFallback = () => {
        if (!agent.resolveAcp) return false;
        const result = agent.resolveAcp(shellEnv, electronModule);
        if (typeof result === "string") {
          if (result && result !== agent.acpCommand && existsSync(result)) {
            resolvedPath = result;
            versionCommand = null;
            versionPrependArgs = [];
            usesAcpFallback = true;
            return true;
          }
        } else if (result?.command) {
          // On Windows the command may be `node` with the script in prependArgs.
          // Use the script path for display/dedup so the UI shows the actual
          // agent rather than the Node binary.
          const scriptPath = result.prependArgs?.[0];
          const displayPath = scriptPath || result.command;
          if (displayPath !== agent.acpCommand && existsSync(displayPath)) {
            resolvedPath = displayPath;
            usesAcpFallback = true;
            if (scriptPath) {
              versionCommand = result.command;
              versionPrependArgs = result.prependArgs;
            } else {
              versionCommand = null;
              versionPrependArgs = [];
            }
            return true;
          }
        }
        return false;
      };
      if (!resolvedPath && supportsBundledAcpFallback) {
        tryResolveAcpFallback();
      }

      if (!resolvedPath || seenPaths.has(resolvedPath)) {
        continue;
      }

      // When the agent is invoked via Node (Windows), probe version with
      // the full command (e.g. `node /path/to/dist/index.js --version`).
      let probe = await probeCliVersion(versionCommand || resolvedPath, [...versionPrependArgs, "--version"], shellEnv);
      let version = probe.version;
      let hasPlausibleVersion = probe.exitCode === 0 && isPlausibleCliVersionOutput(version);
      let hasUsableAcpFallback = isAcpFallbackProbeUsable(
        agent.command,
        usesAcpFallback,
        resolvedPath,
        probe,
      );

      if (!hasPlausibleVersion && !hasUsableAcpFallback && !usesAcpFallback && supportsBundledAcpFallback) {
        const previousPath = resolvedPath;
        if (tryResolveAcpFallback() && resolvedPath !== previousPath && !seenPaths.has(resolvedPath)) {
          probe = await probeCliVersion(versionCommand || resolvedPath, [...versionPrependArgs, "--version"], shellEnv);
          version = probe.version;
          hasPlausibleVersion = probe.exitCode === 0 && isPlausibleCliVersionOutput(version);
          hasUsableAcpFallback = isAcpFallbackProbeUsable(
            agent.command,
            usesAcpFallback,
            resolvedPath,
            probe,
          );
        }
      }

      if (!hasPlausibleVersion && !hasUsableAcpFallback) continue;

      const { resolveAcp: _unused, ...agentInfo } = agent;
      agents.push({
        ...agentInfo,
        acpCommand: agent.command === "copilot" ? resolvedPath : agentInfo.acpCommand,
        path: resolvedPath,
        version: hasPlausibleVersion ? version : "Bundled ACP",
        available: true,
      });
      seenPaths.add(resolvedPath);
    }

    return agents;
  });

  // Resolve a CLI binary path (auto-detect or validate custom path)
  ipcMain.handle("netcatty:ai:resolve-cli", async (event, { command, customPath }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const shellEnv = await getShellEnv();
    let resolvedPath = null;
    let versionCommand = null;
    let versionPrependArgs = [];
    let usesAcpFallback = false;
    const getBundledAcpFallback = () => {
      if (command === "codex") {
        const acpPath = resolveCodexAcpBinaryPath(shellEnv, electronModule);
        if (acpPath && acpPath !== "codex-acp" && existsSync(acpPath)) {
          return {
            displayPath: acpPath,
            command: null,
            prependArgs: [],
          };
        }
        return null;
      }
      return null;
    };
    const resolveBundledAcpFallback = () => {
      const fallback = getBundledAcpFallback();
      if (!fallback) return false;
      if (resolvedPath === fallback.displayPath) {
        versionCommand = fallback.command;
        versionPrependArgs = fallback.prependArgs;
        usesAcpFallback = true;
        return true;
      }
      resolvedPath = fallback.displayPath;
      versionCommand = fallback.command;
      versionPrependArgs = fallback.prependArgs;
      usesAcpFallback = true;
      return true;
    };

    if (customPath) {
      // Normalize Windows shim paths like `codex` -> `codex.cmd` when present.
      // Fall back to PATH search if the stored path no longer exists
      // (e.g. CLI reinstalled to a different location).
      resolvedPath = normalizeCliPathForPlatform(customPath) || resolveCliFromPath(command, shellEnv);
    } else {
      resolvedPath = resolveCliFromPath(command, shellEnv);
    }
    if (!resolvedPath) {
      resolveBundledAcpFallback();
    } else {
      const fallback = getBundledAcpFallback();
      if (fallback && resolvedPath === fallback.displayPath) {
        versionCommand = fallback.command;
        versionPrependArgs = fallback.prependArgs;
        usesAcpFallback = true;
      }
    }

    if (!resolvedPath) {
      return { path: null, version: null, available: false };
    }

    let probe = await probeCliVersion(versionCommand || resolvedPath, [...versionPrependArgs, "--version"], shellEnv);
    let version = probe.version;
    let hasPlausibleVersion = probe.exitCode === 0 && isPlausibleCliVersionOutput(version);
    let hasUsableAcpFallback = isAcpFallbackProbeUsable(command, usesAcpFallback, resolvedPath, probe);
    if (!hasPlausibleVersion && !hasUsableAcpFallback && !usesAcpFallback && command === "codex") {
      if (resolveBundledAcpFallback()) {
        probe = await probeCliVersion(versionCommand || resolvedPath, [...versionPrependArgs, "--version"], shellEnv);
        version = probe.version;
        hasPlausibleVersion = probe.exitCode === 0 && isPlausibleCliVersionOutput(version);
        hasUsableAcpFallback = isAcpFallbackProbeUsable(command, usesAcpFallback, resolvedPath, probe);
      }
    }
    if (!hasPlausibleVersion && !hasUsableAcpFallback) {
      return { path: resolvedPath, version: null, available: false };
    }

    return { path: resolvedPath, version: hasPlausibleVersion ? version : "Bundled ACP", available: true };
  });

  ipcMain.handle("netcatty:ai:codex:get-integration", async (event, options) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    // When the user clicks "Refresh Status" in Settings we also want to
    // rescan the shell env — otherwise a newly-exported variable in
    // .zshrc stays invisible until they restart netcatty entirely.
    if (options && options.refreshShellEnv) {
      invalidateShellEnvCache();
    }
    try {
      const result = await runCodexCli(["login", "status"]);
      const rawOutput = [result.stdout, result.stderr]
        .filter((chunk) => chunk.trim().length > 0)
        .join("\n")
        .trim();
      let state = normalizeCodexIntegrationState(rawOutput);
      let effectiveRawOutput = rawOutput;

      if (state === "connected_chatgpt") {
        const validation = await validateCodexChatGptAuth({ maxAgeMs: 10000 });
        if (!validation.ok) {
          if (isCodexAuthError(validation)) {
            try {
              await runCodexCli(["logout"]);
            } catch {
              // Ignore logout failures; we still want to surface the invalid state.
            }
            invalidateCodexValidationCache();
            state = "not_logged_in";
          } else {
            state = "unknown";
          }

          effectiveRawOutput = [
            rawOutput,
            "",
            "ChatGPT auth validation failed:",
            validation.error || "Unknown validation error",
          ].join("\n").trim();
        }
      }

      // `codex login status` only reflects ~/.codex/auth.json. A user who
      // configured a custom provider directly in ~/.codex/config.toml is
      // functional from the CLI but would look "not_logged_in" here. Probe
      // config.toml so we can surface that as a valid ready state instead of
      // pushing the user into the ChatGPT login flow.
      let customConfig = null;
      if (state !== "connected_chatgpt" && state !== "connected_api_key") {
        try {
          const shellEnv = await getShellEnv();
          customConfig = readCodexCustomProviderConfig(shellEnv);
          if (customConfig) {
            state = "connected_custom_config";
          }
        } catch {
          customConfig = null;
        }
      }

      return {
        state,
        isConnected:
          state === "connected_chatgpt" ||
          state === "connected_api_key" ||
          state === "connected_custom_config",
        rawOutput: effectiveRawOutput,
        exitCode: result.exitCode,
        customConfig,
      };
    } catch (err) {
      return {
        state: "unknown",
        isConnected: false,
        rawOutput: err?.message || String(err),
        exitCode: null,
        customConfig: null,
      };
    }
  });

  ipcMain.handle("netcatty:ai:codex:start-login", async (event) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const existingSession = getActiveCodexLoginSession();
    if (existingSession) {
      return { ok: true, session: toCodexLoginSessionResponse(existingSession) };
    }

    try {
      const shellEnv = await getShellEnv();
      const codexCliPath = resolveCliFromPath("codex", shellEnv) || "codex";
      const sessionId = `codex_login_${randomUUID()}`;
      const spawnSpec = prepareCommandForSpawn(codexCliPath, ["login"]);
      const child = spawn(spawnSpec.command, spawnSpec.args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: shellEnv,
        shell: spawnSpec.shell,
        windowsHide: true,
      });

      const session = {
        id: sessionId,
        process: child,
        state: "running",
        output: "",
        url: null,
        error: null,
        exitCode: null,
      };

      const handleChunk = (chunk) => {
        appendCodexLoginOutput(session, chunk.toString("utf8"));
      };

      child.stdout.on("data", handleChunk);
      child.stderr.on("data", handleChunk);

      child.once("error", (error) => {
        session.state = "error";
        session.error = `[codex] Failed to start login flow: ${error.message}`;
        session.process = null;
      });

      child.once("close", (exitCode) => {
        session.exitCode = exitCode;
        session.process = null;

        if (session.state === "cancelled") {
          return;
        }

        if (exitCode === 0) {
          session.state = "success";
          session.error = null;
        } else {
          session.state = "error";
          session.error = session.error || `Codex login exited with code ${exitCode ?? "unknown"}`;
        }
      });

      codexLoginSessions.set(sessionId, session);
      invalidateCodexValidationCache();
      return { ok: true, session: toCodexLoginSessionResponse(session) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("netcatty:ai:codex:get-login-session", async (event, { sessionId }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const session = codexLoginSessions.get(sessionId);
    if (!session) {
      return { ok: false, error: "Codex login session not found" };
    }
    return { ok: true, session: toCodexLoginSessionResponse(session) };
  });

  ipcMain.handle("netcatty:ai:codex:cancel-login", async (event, { sessionId }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const session = codexLoginSessions.get(sessionId);
    if (!session) {
      return { ok: true, found: false };
    }

    session.state = "cancelled";
    session.error = null;
    if (session.process && !session.process.killed) {
      session.process.kill("SIGTERM");
    }

    invalidateCodexValidationCache();
    return { ok: true, found: true, session: toCodexLoginSessionResponse(session) };
  });

  ipcMain.handle("netcatty:ai:codex:logout", async (event) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    try {
      const logoutResult = await runCodexCli(["logout"]);
      invalidateCodexValidationCache();
      const statusResult = await runCodexCli(["login", "status"]);
      const rawOutput = [statusResult.stdout, statusResult.stderr]
        .filter((chunk) => chunk.trim().length > 0)
        .join("\n")
        .trim();
      const state = normalizeCodexIntegrationState(rawOutput);

      return {
        ok: true,
        state,
        isConnected:
          state === "connected_chatgpt" ||
          state === "connected_api_key" ||
          state === "connected_custom_config",
        rawOutput,
        logoutOutput: [logoutResult.stdout, logoutResult.stderr]
          .filter((chunk) => chunk.trim().length > 0)
          .join("\n")
          .trim(),
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
  }
}

module.exports = { registerAgentDiscoveryHandlers };
