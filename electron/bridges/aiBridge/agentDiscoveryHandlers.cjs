/* eslint-disable no-undef */
function getCursorPlatformPackageName(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return `@cursor/sdk-darwin-${arch}`;
  if (platform === "linux" && (arch === "arm64" || arch === "x64")) return `@cursor/sdk-linux-${arch}`;
  if (platform === "win32" && arch === "x64") return "@cursor/sdk-win32-x64";
  return null;
}

// Bundled @cursor/sdk is importable in every Netcatty build. "installed" is the
// user's Cursor Agent CLI, not that bundled package.
function computeCursorInstallState({ sdkInstalled, cliBinPath, cliLoginOk } = {}) {
  return {
    sdkInstalled: Boolean(sdkInstalled),
    installed: Boolean(cliBinPath) || Boolean(cliLoginOk),
  };
}

async function probeCursorSdkAvailability(shellEnv, options = {}) {
  const platformPackageName = getCursorPlatformPackageName();

  let sdkInstalled = false;
  if (platformPackageName) {
    try {
      await import("@cursor/sdk");
      require.resolve(`${platformPackageName}/package.json`);
      sdkInstalled = true;
    } catch {
      sdkInstalled = false;
    }
  }

  const hasEnvApiKey = Boolean(shellEnv?.CURSOR_API_KEY);
  const hasSettingsApiKey = Boolean(options?.apiKeyPresent);
  const apiKeyOk = hasSettingsApiKey || hasEnvApiKey;
  const probeCli = typeof options?.probeCursorCliAuth === "function"
    ? options.probeCursorCliAuth
    : null;
  let cliAuth = { authenticated: false, authSource: null, email: null, binPath: null };
  try {
    if (probeCli) {
      cliAuth = probeCli({ env: shellEnv }) || cliAuth;
    }
  } catch {
    cliAuth = { authenticated: false, authSource: null, email: null, binPath: null };
  }

  const cliLoginOk = Boolean(cliAuth.authenticated);
  const authenticated = apiKeyOk || cliLoginOk;
  // authSource describes the primary credential for display priority; CLI UI
  // must use cliLoginOk, not this field alone.
  let authSource = null;
  if (hasSettingsApiKey) authSource = "settings";
  else if (hasEnvApiKey) authSource = "CURSOR_API_KEY";
  else if (cliLoginOk) authSource = "cli-login";

  const installState = computeCursorInstallState({
    sdkInstalled,
    cliBinPath: cliAuth.binPath,
    cliLoginOk,
  });
  sdkInstalled = installState.sdkInstalled;
  // Available if either mode can run a turn (API key + SDK, or CLI login).
  const available = (apiKeyOk && sdkInstalled) || cliLoginOk;
  const installed = installState.installed;
  return {
    installed,
    sdkInstalled,
    available,
    authenticated,
    authSource,
    apiKeyOk,
    cliLoginOk,
    version: sdkInstalled ? "Cursor SDK" : (cliLoginOk || cliAuth.binPath ? "Cursor Agent CLI" : null),
    cliBinPath: cliAuth.binPath || null,
    cliEmail: cliAuth.email || null,
  };
}

function registerAgentDiscoveryHandlers(ctx) {
  with (ctx) {
  ipcMain.handle("netcatty:ai:agents:discover", async (event, options = {}) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    if (options?.refreshShellEnv) {
      invalidateShellEnvCache();
    }
    const agents = [];
    const knownAgents = [
      { command: "claude", name: "Claude Code", icon: "claude",
        description: "Anthropic's agentic coding assistant", sdkBackend: "claude", args: [] },
      { command: "codex", name: "Codex CLI", icon: "openai",
        description: "OpenAI's coding agent", sdkBackend: "codex", args: [] },
      { command: "copilot", name: "GitHub Copilot CLI", icon: "copilot",
        description: "GitHub's coding agent CLI", sdkBackend: "copilot", args: [] },
      { command: "cursor", name: "Cursor", icon: "cursor",
        description: "Cursor's coding agent via Cursor SDK", sdkBackend: "cursor", args: [] },
      { command: "codebuddy", name: "CodeBuddy Code", icon: "codebuddy",
        description: "Tencent's coding agent CLI (Agent SDK)", sdkBackend: "codebuddy", args: [] },
      { command: "opencode", name: "OpenCode", icon: "opencode",
        description: "Open source coding agent via the official OpenCode SDK", sdkBackend: "opencode", args: [] },
      { command: "grok", name: "Grok Build", icon: "grok",
        description: "xAI's Grok Build coding agent CLI", sdkBackend: "grok", args: [] },
    ];

    const shellEnv = await getShellEnv();
    const seenPaths = new Set();

    for (const agent of knownAgents) {
      let cursorSdkStatus = null;
      if (agent.command === "cursor") {
        cursorSdkStatus = await probeCursorSdkAvailability(shellEnv, {
          apiKeyPresent: Boolean(options?.apiKeyPresent),
          probeCursorCliAuth,
        });
        if (!cursorSdkStatus.available) continue;
      }

      const resolvedPath = agent.command === "cursor"
        ? (cursorSdkStatus.cliLoginOk
          ? (cursorSdkStatus.cliBinPath || "cursor")
          : (cursorSdkStatus.sdkInstalled ? "cursor" : (cursorSdkStatus.cliBinPath || "cursor")))
        : await resolveCliFromPathAsync(agent.command, shellEnv); // Layer-1: locate
      if (!resolvedPath || seenPaths.has(resolvedPath)) continue;

      const probe = agent.command === "cursor"
        ? { exitCode: 0, version: cursorSdkStatus.version }
        : await probeCliVersion(resolvedPath, ["--version"], shellEnv); // Layer-2: version
      const hasPlausibleVersion = agent.command === "cursor"
        ? probe.exitCode === 0
        : probe.exitCode === 0 && isPlausibleCliVersionOutput(probe.version);
      if (!hasPlausibleVersion) continue;

      // Layer-3: authentication (best-effort; never blocks discovery).
      let auth = { authenticated: false, authSource: null };
      try {
        if (agent.command === "claude") {
          auth = probeClaudeAuth({ env: shellEnv });
        } else if (agent.command === "copilot") {
          auth = probeCopilotAuth({});
        } else if (agent.command === "codex") {
          auth = { authenticated: false, authSource: null };
        } else if (agent.command === "cursor") {
          auth = {
            authenticated: cursorSdkStatus.authenticated,
            authSource: cursorSdkStatus.authSource,
          };
        } else if (agent.command === "codebuddy") {
          auth = probeCodebuddyAuth({ env: shellEnv });
        } else if (agent.command === "opencode") {
          auth = { authenticated: true, authSource: "opencode-config" };
        } else if (agent.command === "grok") {
          auth = probeGrokAuth({ env: shellEnv });
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
        installed: agent.command === "cursor" ? Boolean(cursorSdkStatus.installed) : true,
        available: true,
        authenticated: auth.authenticated,
        authSource: auth.authSource,
        ...(agent.command === "cursor" ? {
          cliEmail: cursorSdkStatus.cliEmail || null,
          cliBinPath: cursorSdkStatus.cliBinPath || null,
          cliLoginOk: Boolean(cursorSdkStatus.cliLoginOk),
          apiKeyOk: Boolean(cursorSdkStatus.apiKeyOk),
          sdkInstalled: Boolean(cursorSdkStatus.sdkInstalled),
        } : {}),
      });
      seenPaths.add(resolvedPath);
    }

    return agents;
  });

  ipcMain.handle("netcatty:ai:shell-env:prewarm", async (event) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    try {
      await getShellEnv();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Resolve a CLI binary path (auto-detect or validate custom path)
  ipcMain.handle("netcatty:ai:resolve-cli", async (event, { command, customPath, refreshShellEnv, apiKeyPresent }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    if (refreshShellEnv) {
      invalidateShellEnvCache();
    }
    const shellEnv = await getShellEnv();
    const hasCustomPath = command !== "cursor" && Boolean(String(customPath || "").trim());

    let resolvedPath;
    if (hasCustomPath) {
      // Normalize Windows shim paths like `codex` -> `codex.cmd` when present.
      // A user-supplied path must be validated as-is; falling back to PATH would
      // make Settings appear to accept one binary while actually using another.
      resolvedPath = normalizeCliPathForPlatform(customPath);
    } else {
      resolvedPath = await resolveCliFromPathAsync(command, shellEnv);
    }

    if (command === "cursor") {
      const cursorSdkStatus = await probeCursorSdkAvailability(shellEnv, {
        apiKeyPresent: Boolean(apiKeyPresent),
        probeCursorCliAuth,
      });
      // Prefer CLI bin only when CLI login is proven. Otherwise do not use a
      // PATH `agent` binary (generic name) for API-key/SDK path identity.
      const resolvedSdkPath = await resolveCliFromPathAsync(command, shellEnv);
      const cursorPath = cursorSdkStatus.cliLoginOk
        ? (cursorSdkStatus.cliBinPath || resolvedSdkPath || "cursor")
        : (resolvedSdkPath || "cursor");
      // Keep the SDK sentinel path when the bundled SDK is importable so
      // API-key mode still has an identity without Cursor.app / Agent CLI.
      const hasCursorPath = cursorSdkStatus.sdkInstalled
        || cursorSdkStatus.installed
        || cursorSdkStatus.available;
      return {
        path: hasCursorPath ? cursorPath : null,
        binPath: hasCursorPath ? cursorPath : null,
        version: cursorSdkStatus.version,
        available: cursorSdkStatus.available,
        installed: cursorSdkStatus.installed,
        authenticated: cursorSdkStatus.authenticated,
        authSource: cursorSdkStatus.authSource,
        cliEmail: cursorSdkStatus.cliEmail || null,
        cliBinPath: cursorSdkStatus.cliBinPath || null,
        cliLoginOk: Boolean(cursorSdkStatus.cliLoginOk),
        apiKeyOk: Boolean(cursorSdkStatus.apiKeyOk),
        sdkInstalled: Boolean(cursorSdkStatus.sdkInstalled),
      };
    }

    if (!resolvedPath) {
      return { path: null, binPath: null, version: null, available: false, installed: false };
    }

    const probe = await probeCliVersion(resolvedPath, ["--version"], shellEnv);
    const hasPlausibleVersion = command === "cursor"
      ? probe.exitCode === 0
      : probe.exitCode === 0 && isPlausibleCliVersionOutput(probe.version);
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
      const codexCliOptions = { codexPath: options?.codexPath };
      const result = await runCodexCli(["login", "status"], codexCliOptions);
      const rawOutput = [result.stdout, result.stderr]
        .filter((chunk) => chunk.trim().length > 0)
        .join("\n")
        .trim();
      let state = normalizeCodexIntegrationState(rawOutput);
      let effectiveRawOutput = rawOutput;

      if (state === "connected_chatgpt" && options?.validateChatGptAuth === true) {
        const validation = await validateCodexChatGptAuth({ maxAgeMs: 10000, codexPath: options?.codexPath });
        if (!validation.ok) {
          if (isCodexAuthError(validation)) {
            try {
              await runCodexCli(["logout"], codexCliOptions);
            } catch {
              // Ignore logout failures; we still want to surface the invalid state.
            }
            invalidateCodexValidationCache();
            state = "not_logged_in";
          }

          effectiveRawOutput = appendCodexChatGptValidationFailure(
            rawOutput,
            validation.error || "Unknown validation error",
          );
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

  ipcMain.handle("netcatty:ai:codex:start-login", async (event, options = {}) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const requestedPath = String(options?.codexPath || "").trim();
    const requestedCodexPath = requestedPath ? normalizeCliPathForPlatform?.(requestedPath) : null;
    if (requestedPath && !requestedCodexPath) {
      return { ok: false, error: `Codex CLI path not found: ${requestedPath}` };
    }

    try {
      const shellEnv = await getShellEnv();
      const codexCliPath = requestedCodexPath
        || await resolveCliFromPathAsync("codex", shellEnv)
        || "codex";
      const existingSession = getActiveCodexLoginSession();
      if (existingSession) {
        const existingPath = existingSession.codexPath || null;
        if (existingPath && codexCliPath !== existingPath) {
          return { ok: false, error: "A Codex login is already running for a different CLI path." };
        }
        return { ok: true, session: toCodexLoginSessionResponse(existingSession) };
      }

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
        codexPath: codexCliPath,
      };

      const stdoutDecoder = createCodexLoginOutputDecoder(session);
      const stderrDecoder = createCodexLoginOutputDecoder(session);
      let outputEnded = false;
      const endOutput = () => {
        if (outputEnded) return;
        outputEnded = true;
        stdoutDecoder.end();
        stderrDecoder.end();
      };

      child.stdout.on("data", (chunk) => stdoutDecoder.write(chunk));
      child.stderr.on("data", (chunk) => stderrDecoder.write(chunk));

      child.once("error", (error) => {
        endOutput();
        clearCodexLoginKillTimer(session);
        session.state = "error";
        session.error = `[codex] Failed to start login flow: ${error.message}`;
        session.process = null;
        recordCodexLoginSession(session);
      });

      child.once("close", (exitCode) => {
        endOutput();
        clearCodexLoginKillTimer(session);
        session.exitCode = exitCode;
        session.process = null;

        if (session.state === "cancelled") {
          recordCodexLoginSession(session);
          return;
        }

        if (exitCode === 0) {
          session.state = "success";
          session.error = null;
        } else {
          session.state = "error";
          session.error = session.error || `Codex login exited with code ${exitCode ?? "unknown"}`;
        }
        recordCodexLoginSession(session);
      });

      recordCodexLoginSession(session);
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
    stopCodexLoginProcess(session);
    recordCodexLoginSession(session);

    invalidateCodexValidationCache();
    return { ok: true, found: true, session: toCodexLoginSessionResponse(session) };
  });

  ipcMain.handle("netcatty:ai:codex:logout", async (event, options = {}) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    try {
      const codexCliOptions = { codexPath: options?.codexPath };
      const logoutResult = await runCodexCli(["logout"], codexCliOptions);
      invalidateCodexValidationCache();
      const statusResult = await runCodexCli(["login", "status"], codexCliOptions);
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

module.exports = { registerAgentDiscoveryHandlers, computeCursorInstallState };
