/* eslint-disable no-undef */
function registerAgentDiscoveryHandlers(ctx) {
  with (ctx) {
  ipcMain.handle("netcatty:ai:agents:discover", async (event) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const agents = [];
    const knownAgents = [
      { command: "claude", name: "Claude Code", icon: "claude",
        description: "Anthropic's agentic coding assistant", sdkBackend: "claude", args: [] },
      { command: "codex", name: "Codex CLI", icon: "openai",
        description: "OpenAI's coding agent", sdkBackend: "codex", args: [] },
      { command: "copilot", name: "GitHub Copilot CLI", icon: "copilot",
        description: "GitHub's coding agent CLI", sdkBackend: "copilot", args: [] },
    ];

    const shellEnv = await getShellEnv();
    const seenPaths = new Set();

    for (const agent of knownAgents) {
      const resolvedPath = resolveCliFromPath(agent.command, shellEnv); // Layer-1: locate
      if (!resolvedPath || seenPaths.has(resolvedPath)) continue;

      const probe = await probeCliVersion(resolvedPath, ["--version"], shellEnv); // Layer-2: version
      const hasPlausibleVersion = probe.exitCode === 0 && isPlausibleCliVersionOutput(probe.version);
      if (!hasPlausibleVersion) continue;

      // Layer-3: authentication (best-effort; never blocks discovery).
      let auth = { authenticated: false, authSource: null };
      try {
        if (agent.command === "claude") {
          auth = probeClaudeAuth({ env: shellEnv });
        } else if (agent.command === "copilot") {
          auth = probeCopilotAuth({});
        } else if (agent.command === "codex") {
          // codex login status is async; resolve it then inject synchronously.
          const codexStatus = await runCodexCli(["login", "status"]).catch(() => null);
          auth = probeCodexAuth({ runLoginStatus: () => codexStatus || { exitCode: 1, stdout: "" } });
        }
      } catch { /* auth probe is best-effort */ }

      agents.push({
        command: agent.command,
        name: agent.name,
        icon: agent.icon,
        description: agent.description,
        sdkBackend: agent.sdkBackend,
        args: agent.args,
        path: resolvedPath,
        binPath: resolvedPath,
        version: probe.version,
        installed: true,
        available: true,
        authenticated: auth.authenticated,
        authSource: auth.authSource,
      });
      seenPaths.add(resolvedPath);
    }

    return agents;
  });

  // Resolve a CLI binary path (auto-detect or validate custom path)
  ipcMain.handle("netcatty:ai:resolve-cli", async (event, { command, customPath }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const shellEnv = await getShellEnv();

    let resolvedPath;
    if (customPath) {
      // Normalize Windows shim paths like `codex` -> `codex.cmd` when present.
      // Fall back to PATH search if the stored path no longer exists
      // (e.g. CLI reinstalled to a different location).
      resolvedPath = normalizeCliPathForPlatform(customPath) || resolveCliFromPath(command, shellEnv);
    } else {
      resolvedPath = resolveCliFromPath(command, shellEnv);
    }

    if (!resolvedPath) {
      return { path: null, binPath: null, version: null, available: false, installed: false };
    }

    const probe = await probeCliVersion(resolvedPath, ["--version"], shellEnv);
    const hasPlausibleVersion = probe.exitCode === 0 && isPlausibleCliVersionOutput(probe.version);
    if (!hasPlausibleVersion) {
      return { path: resolvedPath, binPath: resolvedPath, version: null, available: false, installed: true };
    }

    return { path: resolvedPath, binPath: resolvedPath, version: probe.version, available: true, installed: true };
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
