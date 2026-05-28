/* eslint-disable no-undef */
function registerAgentProcessHandlers(ctx) {
  with (ctx) {
  // Known agent command names (must match knownAgents in discover handler)
  const ALLOWED_AGENT_COMMANDS = new Set([
    "claude",
    "codex", "codex-acp",
    "copilot",
  ]);

  ipcMain.handle("netcatty:ai:agent:spawn", async (event, { agentId, command, args, env, closeStdin }) => {
    // Validate IPC sender (Issue #17)
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }
    // Validate command against known agent binaries (Issue #1)
    if (typeof command !== "string" || !command.trim()) {
      return { ok: false, error: "Invalid command" };
    }
    // Reject absolute/relative paths — only bare command names allowed
    if (command.includes("/") || command.includes("\\")) {
      return { ok: false, error: "Absolute or relative paths are not allowed. Use a known agent command name." };
    }
    if (!ALLOWED_AGENT_COMMANDS.has(command)) {
      return { ok: false, error: `Unknown agent command: ${command}. Allowed: ${[...ALLOWED_AGENT_COMMANDS].join(", ")}` };
    }
    if (agentProcesses.has(agentId)) {
      return { ok: false, error: "Agent already running" };
    }
    if (agentProcesses.size >= MAX_CONCURRENT_AGENTS) {
      return { ok: false, error: `Concurrent agent limit reached (max ${MAX_CONCURRENT_AGENTS})` };
    }

    try {
      const shellEnv = await getShellEnv();
      const stdinMode = closeStdin ? "ignore" : "pipe";

      // Blocklist of dangerous environment variable names that could be used for code injection
      const DANGEROUS_ENV_KEYS = new Set([
        "LD_PRELOAD", "LD_LIBRARY_PATH",
        "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
        "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE",
        "PYTHONPATH", "RUBYLIB", "PERL5LIB",
        "BASH_ENV", "ENV", "CDPATH", "PROMPT_COMMAND",
      ]);

      // Also block BASH_FUNC_* prefix keys (Issue #16)
      const isDangerousEnvKey = (k) =>
        DANGEROUS_ENV_KEYS.has(k) || k.startsWith("BASH_FUNC_");

      // Filter dangerous keys from user-provided env before merging
      const filteredUserEnv = {};
      if (env && typeof env === "object") {
        for (const [k, v] of Object.entries(env)) {
          if (!isDangerousEnvKey(k)) {
            filteredUserEnv[k] = v;
          }
        }
      }

      // Only pass safe environment variables to agent processes
      const SAFE_ENV_KEYS = new Set([
        "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
        "TERM", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
        // NODE_PATH omitted: can redirect module resolution (code injection vector)
        // CODEX_API_KEY omitted: injected separately at spawn site for Codex only
      ]);
      const safeEnv = {};
      for (const [k, v] of Object.entries(shellEnv)) {
        if (SAFE_ENV_KEYS.has(k) || k.startsWith("LC_") || k.startsWith("XDG_")) {
          safeEnv[k] = v;
        }
      }

      const proc = spawn(command, args || [], {
        stdio: [stdinMode, "pipe", "pipe"],
        env: { ...filteredUserEnv, ...safeEnv },
      });

      proc.stdout.on("data", (data) => {
        safeSend(event.sender, "netcatty:ai:agent:stdout", {
          agentId,
          data: data.toString(),
        });
      });

      proc.stderr.on("data", (data) => {
        safeSend(event.sender, "netcatty:ai:agent:stderr", {
          agentId,
          data: data.toString(),
        });
      });

      proc.on("exit", (code) => {
        agentProcesses.delete(agentId);
        safeSend(event.sender, "netcatty:ai:agent:exit", { agentId, code });
      });

      proc.on("error", (err) => {
        agentProcesses.delete(agentId);
        safeSend(event.sender, "netcatty:ai:agent:error", {
          agentId,
          error: err.message,
        });
      });

      agentProcesses.set(agentId, proc);

      return { ok: true, pid: proc.pid };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Send data to agent's stdin
  ipcMain.handle("netcatty:ai:agent:write", async (event, { agentId, data }) => {
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }
    const proc = agentProcesses.get(agentId);
    if (!proc) return { ok: false, error: "Agent not found" };
    try {
      if (!proc.stdin || proc.stdin.destroyed) {
        return { ok: false, error: "stdin not available" };
      }
      proc.stdin.write(data);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Close agent's stdin (signal EOF)
  ipcMain.handle("netcatty:ai:agent:close-stdin", async (event, { agentId }) => {
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }
    const proc = agentProcesses.get(agentId);
    if (!proc) return { ok: false, error: "Agent not found" };
    try {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.end();
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // ── MCP Server session metadata ──

  ipcMain.handle("netcatty:ai:mcp:update-sessions", async (event, { sessions: sessionList, chatSessionId }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    mcpServerBridge.updateSessionMetadata(sessionList || [], chatSessionId);
    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:mcp:set-command-blocklist", async (event, { blocklist }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    // Validate: must be an array of strings, each a valid regex pattern
    if (!Array.isArray(blocklist)) {
      return { ok: false, error: "blocklist must be an array" };
    }
    const validPatterns = [];
    for (const pattern of blocklist) {
      if (typeof pattern !== "string") continue;
      try {
        new RegExp(pattern, "i"); // Validate regex
        validPatterns.push(pattern);
      } catch {
        // Skip invalid regex patterns silently
      }
    }
    mcpServerBridge.setCommandBlocklist(validPatterns);
    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:mcp:set-command-timeout", async (event, { timeout }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const value = Number(timeout);
    if (!Number.isFinite(value) || value < 1 || value > 3600) {
      return { ok: false, error: "timeout must be a number between 1 and 3600" };
    }
    mcpServerBridge.setCommandTimeout(value);
    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:mcp:set-max-iterations", async (event, { maxIterations }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const value = Number(maxIterations);
    if (!Number.isFinite(value) || value < 1 || value > 100) {
      return { ok: false, error: "maxIterations must be a number between 1 and 100" };
    }
    mcpServerBridge.setMaxIterations(value);
    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:mcp:set-permission-mode", async (event, { mode }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const validModes = ["observer", "confirm", "autonomous"];
    if (!validModes.includes(mode)) {
      return { ok: false, error: `mode must be one of: ${validModes.join(", ")}` };
    }
    mcpServerBridge.setPermissionMode(mode);
    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:mcp:set-tool-integration-mode", async (event, { mode }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const validModes = ["mcp", "skills"];
    if (!validModes.includes(mode)) {
      return { ok: false, error: `mode must be one of: ${validModes.join(", ")}` };
    }
    setToolIntegrationMode(mode);
    return { ok: true };
  });

  // ── MCP Approval response (renderer → main) ──
  ipcMain.handle("netcatty:ai:mcp:approval-response", async (event, { approvalId, approved }) => {
    if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
    mcpServerBridge.resolveApprovalFromRenderer(approvalId, approved);
    return { ok: true };
  });
  }
}

module.exports = { registerAgentProcessHandlers };
