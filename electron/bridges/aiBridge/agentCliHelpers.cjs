/* eslint-disable no-undef */
function createAgentCliHelpers(ctx) {
  with (ctx) {
  async function runCommand(command, args, options) {
    return await new Promise((resolve, reject) => {
      const spawnSpec = prepareCommandForSpawn(command, args || []);
      const child = spawn(spawnSpec.command, spawnSpec.args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: options?.cwd || undefined,
        env: options?.env || process.env,
        shell: spawnSpec.shell,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      const MAX_BUFFER = 10 * 1024 * 1024; // 10MB

      child.stdout.on("data", (chunk) => {
        if (stdout.length < MAX_BUFFER) {
          stdout += chunk.toString("utf8");
        }
      });

      child.stderr.on("data", (chunk) => {
        if (stderr.length < MAX_BUFFER) {
          stderr += chunk.toString("utf8");
        }
      });

      child.once("error", (error) => {
        reject(error);
      });

      child.once("close", (exitCode) => {
        resolve({
          stdout: stripAnsi(stdout),
          stderr: stripAnsi(stderr),
          exitCode,
        });
      });
    });
  }

  function getCommandOutput(result) {
    return [result?.stdout, result?.stderr]
      .filter((chunk) => typeof chunk === "string" && chunk.length > 0)
      .join("\n")
      .trim();
  }

  function getFirstCommandOutputLine(result) {
    return getCommandOutput(result).split(/\r?\n/)[0] || "";
  }

  async function probeCliVersion(probeCmd, probeArgs, env) {
    try {
      const result = await runCommand(probeCmd, probeArgs, { env });
      return {
        launched: true,
        exitCode: result.exitCode,
        output: getCommandOutput(result),
        version: getFirstCommandOutputLine(result),
      };
    } catch {
      return {
        launched: false,
        exitCode: null,
        output: "",
        version: "",
      };
    }
  }

  async function runCodexCli(args, options) {
    const shellEnv = await getShellEnv();
    const codexCliPath = resolveCliFromPath("codex", shellEnv) || "codex";
    return await runCommand(codexCliPath, args, {
      cwd: options?.cwd?.trim() || undefined,
      env: shellEnv,
    });
  }

  async function runCodexCliChecked(args, options) {
    const result = await runCodexCli(args, options);
    if (result.exitCode === 0) {
      return result;
    }

    const errorText =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `Codex command failed with exit code ${result.exitCode ?? "unknown"}`;
    throw new Error(errorText);
  }

  async function validateCodexChatGptAuth(options) {
    const maxAgeMs = options?.maxAgeMs ?? 30000;
    const now = Date.now();
    const cached = getCodexValidationCache();
    if (cached && now - cached.checkedAt < maxAgeMs) return cached;

    const shellEnv = await getShellEnv();
    const codexPath = resolveCliFromPath("codex", shellEnv);
    if (!codexPath) {
      const result = { ok: false, checkedAt: now, error: "codex binary not found", code: "ENOENT" };
      setCodexValidationCache(result);
      return result;
    }
    try {
      // Minimal read-only probe turn through the SDK to confirm auth works.
      const { Codex } = await import("@openai/codex-sdk");
      const codex = new Codex({ codexPathOverride: codexPath, env: shellEnv });
      const thread = codex.startThread({ skipGitRepoCheck: true });
      const { events } = await thread.runStreamed("ping", { sandbox: "read-only" });
      let failed = null;
      for await (const event of events) {
        if (event?.type === "turn.failed") { failed = event.error; break; }
        if (event?.type === "turn.completed") break;
        if (event?.type === "item.completed") break; // got a response, auth fine
      }
      if (failed) {
        const result = { ok: false, checkedAt: now, error: failed.message || "Codex auth failed", code: undefined };
        setCodexValidationCache(result);
        return result;
      }
      const result = { ok: true, checkedAt: now, error: null };
      setCodexValidationCache(result);
      return result;
    } catch (error) {
      const normalized = extractCodexError(error);
      const result = { ok: false, checkedAt: now, error: normalized.message, code: normalized.code };
      setCodexValidationCache(result);
      return result;
    }
  }

  function objectToPairs(value) {
    if (!value || typeof value !== "object") return [];
    return Object.entries(value)
      .filter(([name, val]) => typeof name === "string" && typeof val === "string")
      .map(([name, val]) => ({ name, value: val }));
  }

  function resolveCodexStdioEnv(transport, shellEnv) {
    const merged = {};

    if (transport?.env && typeof transport.env === "object") {
      for (const [name, value] of Object.entries(transport.env)) {
        if (typeof name === "string" && typeof value === "string") {
          merged[name] = value;
        }
      }
    }

    if (Array.isArray(transport?.env_vars)) {
      for (const envName of transport.env_vars) {
        const value = shellEnv[envName] || process.env[envName];
        if (typeof value === "string" && value.length > 0 && !merged[envName]) {
          merged[envName] = value;
        }
      }
    }

    return merged;
  }

  function resolveCodexHttpHeaders(transport, shellEnv) {
    const merged = {};

    if (transport?.http_headers && typeof transport.http_headers === "object") {
      for (const [name, value] of Object.entries(transport.http_headers)) {
        if (typeof name === "string" && typeof value === "string") {
          merged[name] = value;
        }
      }
    }

    if (transport?.env_http_headers && typeof transport.env_http_headers === "object") {
      for (const [headerName, envName] of Object.entries(transport.env_http_headers)) {
        if (typeof headerName !== "string" || typeof envName !== "string") continue;
        const value = shellEnv[envName] || process.env[envName];
        if (typeof value === "string" && value.length > 0) {
          merged[headerName] = value;
        }
      }
    }

    const bearerEnvVar = typeof transport?.bearer_token_env_var === "string"
      ? transport.bearer_token_env_var.trim()
      : "";
    if (bearerEnvVar && !merged.Authorization) {
      const token = shellEnv[bearerEnvVar] || process.env[bearerEnvVar];
      if (typeof token === "string" && token.trim()) {
        merged.Authorization = `Bearer ${token.trim()}`;
      }
    }

    return merged;
  }

  async function resolveCodexMcpSnapshot(cwd) {
    const empty = { mcpServers: [], fingerprint: getCodexMcpFingerprint([]) };

    try {
      const result = await runCodexCliChecked(["mcp", "list", "--json"], {
        cwd: cwd || undefined,
      });
      const parsed = JSON.parse(result.stdout);
      if (!Array.isArray(parsed)) {
        return empty;
      }

      const shellEnv = await getShellEnv();
      const mcpServers = [];

      for (const entry of parsed) {
        if (!entry?.enabled || !entry?.transport || typeof entry?.name !== "string") {
          continue;
        }

        const transportType = String(entry.transport.type || "").trim().toLowerCase();

        if (transportType === "stdio") {
          const command = String(entry.transport.command || "").trim();
          if (!command) continue;
          mcpServers.push({
            name: entry.name,
            type: "stdio",
            command,
            args: Array.isArray(entry.transport.args)
              ? entry.transport.args.filter((arg) => typeof arg === "string")
              : [],
            env: objectToPairs(resolveCodexStdioEnv(entry.transport, shellEnv)),
          });
          continue;
        }

        if (transportType === "streamable_http" || transportType === "http" || transportType === "sse") {
          const url = String(entry.transport.url || "").trim();
          if (!url) continue;
          mcpServers.push({
            name: entry.name,
            type: "http",
            url,
            headers: objectToPairs(resolveCodexHttpHeaders(entry.transport, shellEnv)),
          });
        }
      }

      return {
        mcpServers,
        fingerprint: getCodexMcpFingerprint(mcpServers),
      };
    } catch (err) {
      console.error("[Codex] Failed to resolve MCP servers:", err?.message || err);
      return empty;
    }
  }


    return {
      runCommand,
      getCommandOutput,
      getFirstCommandOutputLine,
      probeCliVersion,
      runCodexCli,
      runCodexCliChecked,
      validateCodexChatGptAuth,
      objectToPairs,
      resolveCodexStdioEnv,
      resolveCodexHttpHeaders,
      resolveCodexMcpSnapshot,
    };
  }
}

module.exports = { createAgentCliHelpers };
