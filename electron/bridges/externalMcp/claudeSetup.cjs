"use strict";

const { runBoundedCliCommand } = require("./boundedCliCommand.cjs");
const {
  getNetcattySkillStatus,
  installNetcattySkill,
  resolveUserHomeDir,
} = require("./netcattySkillInstaller.cjs");

const EXTERNAL_MCP_CLAUDE_NAME = "netcatty-external";
const {
  formatDiscoveryEnvCliFlags,
} = require("../../cli/externalMcpDiscoveryPath.cjs");

function loadShellUtils() {
  return require("../ai/shellUtils.cjs");
}

function loadDesktopCliResolver() {
  return require("./desktopCliResolver.cjs");
}

function formatClaudeCommandText(args, cliPath = "claude") {
  const executable = typeof cliPath === "string" && cliPath.trim()
    ? cliPath.trim()
    : "claude";
  return [quoteCommandArg(executable), ...args.map(quoteCommandArg)].join(" ");
}

function quoteCommandArg(value) {
  if (typeof value !== "string" || value.length === 0) return '""';
  // Match ExternalMcpCard quoteShellArg so copyable commands stay shell-safe
  // for paths with spaces, quotes, apostrophes, or backslashes.
  if (!/[\s"'\\]/u.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function getCombinedOutput(result) {
  return String(`${result?.stdout || ""}\n${result?.stderr || ""}`).trim();
}

function isMissingClaudeServer(result) {
  const output = getCombinedOutput(result);
  return /No MCP server (?:found with name:|named)\s*["']?netcatty-external["']?/i.test(output);
}

function normalizePathForCompare(value) {
  if (typeof value !== "string") return "";
  let normalized = value.trim().replace(/^["']|["']$/gu, "");
  if (process.platform === "win32") {
    normalized = normalized.replace(/\.cmd$/iu, "");
  }
  return normalized;
}

function pathsMatch(left, right) {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

function extractExistingCommand(result) {
  const output = getCombinedOutput(result);
  if (!output) return null;

  const commandLine = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /^Command:\s*/iu.test(line));
  if (commandLine) {
    return commandLine.replace(/^Command:\s*/iu, "").trim() || null;
  }

  const matchingLine = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.includes(EXTERNAL_MCP_CLAUDE_NAME));
  if (!matchingLine) return output;

  const colonIndex = matchingLine.indexOf(":");
  const afterName = colonIndex >= 0 ? matchingLine.slice(colonIndex + 1).trim() : matchingLine;
  const statusSeparatorIndex = afterName.lastIndexOf(" - ");
  if (statusSeparatorIndex >= 0 && /connected/i.test(afterName.slice(statusSeparatorIndex + 3))) {
    return afterName.slice(0, statusSeparatorIndex).trim() || output;
  }
  return afterName || output;
}

function extractExistingArgs(result) {
  const output = getCombinedOutput(result);
  if (!output) return [];
  const argsLine = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /^Args?:\s*/iu.test(line));
  if (!argsLine) return [];
  const raw = argsLine.replace(/^Args?:\s*/iu, "").trim();
  if (!raw || raw === "[]" || raw === "(none)" || raw === "none") return [];
  return raw.split(/\s+/u).filter(Boolean);
}

function extractExistingScope(result) {
  const output = getCombinedOutput(result);
  if (!output) return null;
  const scopeLine = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /^Scope:\s*/iu.test(line));
  if (scopeLine) {
    const scopeText = scopeLine.replace(/^Scope:\s*/iu, "").trim().toLowerCase();
    if (scopeText.startsWith("user")) return "user";
    if (scopeText.startsWith("local")) return "local";
    if (scopeText.startsWith("project")) return "project";
  }
  const removeHint = output.match(/claude\s+mcp\s+remove[^\n]*?-s\s+(user|local|project)/iu);
  if (removeHint) return removeHint[1].toLowerCase();
  return null;
}

function buildClaudeAddArgs(launcherPath, discoveryEnv) {
  return [
    "mcp",
    "add",
    "-s",
    "user",
    EXTERNAL_MCP_CLAUDE_NAME,
    ...formatDiscoveryEnvCliFlags(discoveryEnv, "claude"),
    "--",
    launcherPath,
  ];
}

function extractCommandExecutable(commandText) {
  if (typeof commandText !== "string") return "";
  const trimmed = commandText.trim();
  if (!trimmed) return "";
  // Prefer the last path-like token so env flags before `--` do not confuse matching.
  const dashDashIndex = trimmed.lastIndexOf(" -- ");
  const candidate = dashDashIndex >= 0
    ? trimmed.slice(dashDashIndex + 4).trim()
    : trimmed;
  const match = candidate.match(/("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)/u);
  if (!match) return candidate;
  // Extra args after the executable mean a different launch command.
  const remainder = candidate.slice(match[0].length).trim();
  if (remainder) return "";
  return match[1];
}

function extractExistingEnv(result) {
  const output = getCombinedOutput(result);
  if (!output) return null;
  const env = {};
  const lines = output.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const header = line.match(/^\s*(?:Env|Environment|env)\s*[:=]\s*(.*)\s*$/iu);
    if (header) {
      const inline = String(header[1] || "").trim();
      if (inline) {
        const inlinePair = inline.match(/^([A-Z0-9_]+)\s*=\s*(.+)$/u);
        if (inlinePair) {
          env[inlinePair[1]] = inlinePair[2].trim().replace(/^["']|["']$/gu, "");
        }
      }
      // Claude prints indented KEY=VALUE lines under an Environment: header.
      for (let j = i + 1; j < lines.length; j += 1) {
        const nested = lines[j].match(/^\s+([A-Z0-9_]+)\s*=\s*(.+)\s*$/u);
        if (!nested) break;
        env[nested[1]] = nested[2].trim().replace(/^["']|["']$/gu, "");
        i = j;
      }
      continue;
    }
    const pair = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/u);
    if (pair) {
      env[pair[1]] = pair[2].trim().replace(/^["']|["']$/gu, "");
    }
  }
  // Also accept inline -e KEY=VALUE fragments in the Command line.
  const command = extractExistingCommand(result) || "";
  for (const match of command.matchAll(/(?:^|\s)-e\s+([A-Z0-9_]+)=("[^"]*"|'[^']*'|[^\s]+)/gu)) {
    env[match[1]] = match[2].replace(/^["']|["']$/gu, "");
  }
  return Object.keys(env).length > 0 ? env : null;
}

function hasRequiredDiscoveryEnv(entryEnv, discoveryEnv) {
  const required = discoveryEnv && typeof discoveryEnv === "object" ? discoveryEnv : {};
  const keys = Object.keys(required).filter((key) => typeof required[key] === "string" && required[key]);
  if (keys.length === 0) return true;
  if (!entryEnv || typeof entryEnv !== "object") return false;
  return keys.every((key) => String(entryEnv[key] || "") === String(required[key]));
}

function classifyClaudeExternalMcpStatus({
  getResult,
  launcherPath,
  claudePath,
  discoveryEnv,
  commandExecutable,
}) {
  const commandArgs = buildClaudeAddArgs(launcherPath, discoveryEnv || {});
  const base = {
    ok: true,
    claudePath: claudePath || null,
    launcherPath: launcherPath || null,
    command: formatClaudeCommandText(commandArgs, commandExecutable || claudePath),
    existingCommand: null,
    error: null,
  };

  if (getResult?.exitCode !== 0) {
    if (isMissingClaudeServer(getResult)) {
      return {
        ...base,
        state: claudePath ? "not_configured" : "claude_not_found",
      };
    }
    return {
      ...base,
      state: "error",
      error: summarizeFailure(getResult, `Claude exited with code ${getResult?.exitCode ?? "unknown"}`),
    };
  }

  const existingCommand = extractExistingCommand(getResult);
  const existingArgs = extractExistingArgs(getResult);
  const existingScope = extractExistingScope(getResult);
  if (pathsMatch(extractCommandExecutable(existingCommand), launcherPath)) {
    if (existingArgs.length > 0) {
      return {
        ...base,
        state: "conflict",
        existingCommand,
        existingScope,
      };
    }
    if (!hasRequiredDiscoveryEnv(extractExistingEnv(getResult), discoveryEnv)) {
      return {
        ...base,
        state: "not_configured",
        existingCommand,
        existingScope,
      };
    }
    // One-click setup targets user scope. Local/project matches still need
    // remove+re-add so the entry is available across projects.
    if (existingScope && existingScope !== "user") {
      return {
        ...base,
        state: "not_configured",
        existingCommand,
        existingScope,
      };
    }
    return {
      ...base,
      state: "configured",
      existingCommand,
      existingScope,
    };
  }

  return {
    ...base,
    state: "conflict",
    existingCommand,
    existingScope,
  };
}

function summarizeFailure(result, fallback) {
  return String(result?.stderr || result?.stdout || fallback || "Claude command failed").trim();
}

function createExternalMcpClaudeSetup(options = {}) {
  const deps = {
    launcherPath: options.launcherPath || null,
    discoveryEnv: options.discoveryEnv && typeof options.discoveryEnv === "object"
      ? options.discoveryEnv
      : {},
    getShellEnv: options.getShellEnv || loadShellUtils().getShellEnv,
    resolveCliFromPath: options.resolveCliFromPath || loadShellUtils().resolveCliFromPath,
    resolveDesktopManagedCli: options.resolveDesktopManagedCli
      || loadDesktopCliResolver().resolveDesktopManagedCli,
    prepareCommandForSpawn: options.prepareCommandForSpawn || loadShellUtils().prepareCommandForSpawn,
    spawn: options.spawn || require("node:child_process").spawn,
    stripAnsi: options.stripAnsi || loadShellUtils().stripAnsi,
    runClaudeCommand: options.runClaudeCommand || null,
    getSkillStatus: options.getSkillStatus || getNetcattySkillStatus,
    installSkill: options.installSkill || installNetcattySkill,
  };

  function getManualCommand(cliPath) {
    return formatClaudeCommandText(
      buildClaudeAddArgs(deps.launcherPath, deps.discoveryEnv),
      cliPath,
    );
  }

  async function resolveClaude() {
    const shellEnv = await deps.getShellEnv();
    // PATH installs keep the bare `claude` copyable command (portable across
    // shells). Desktop-managed absolute paths only appear when PATH misses.
    const pathResolved = deps.resolveCliFromPath("claude", shellEnv) || null;
    const desktopResolved = pathResolved
      ? null
      : (deps.resolveDesktopManagedCli("claude") || null);
    const claudePath = pathResolved || desktopResolved;
    return {
      shellEnv,
      claudePath,
      commandExecutable: pathResolved ? "claude" : (desktopResolved || "claude"),
    };
  }

  async function runClaude(claudePath, shellEnv, args) {
    if (deps.runClaudeCommand) {
      return await deps.runClaudeCommand(claudePath, shellEnv, args);
    }
    return await runBoundedCliCommand(deps, claudePath, args, { env: shellEnv });
  }

  async function getStatus() {
    const { shellEnv, claudePath, commandExecutable } = await resolveClaude();
    if (!claudePath) {
      return {
        ok: true,
        state: "claude_not_found",
        claudePath: null,
        launcherPath: deps.launcherPath,
        command: getManualCommand(),
        existingCommand: null,
        error: null,
      };
    }

    try {
      // `claude mcp get` does not accept `-s`; user-scope entries are still
      // returned by the default get lookup after `mcp add -s user`.
      const result = await runClaude(claudePath, shellEnv, [
        "mcp",
        "get",
        EXTERNAL_MCP_CLAUDE_NAME,
      ]);
      const status = classifyClaudeExternalMcpStatus({
        getResult: result,
        launcherPath: deps.launcherPath,
        claudePath,
        discoveryEnv: deps.discoveryEnv,
        commandExecutable,
      });
      if (status.state === "configured") {
        const skillStatus = await deps.getSkillStatus({
          client: "claude",
          homeDir: resolveUserHomeDir(shellEnv),
          claudeConfigDir: shellEnv.CLAUDE_CONFIG_DIR,
        });
        return {
          ...status,
          command: getManualCommand(commandExecutable),
          mcpConfigured: true,
          skillInstalled: skillStatus.installed,
          skillPath: skillStatus.skillPath,
          state: skillStatus.installed ? "configured" : "not_configured",
          ...(!skillStatus.installed && skillStatus.reason
            ? { skillError: skillStatus.reason }
            : {}),
        };
      }
      return {
        ...status,
        command: getManualCommand(commandExecutable),
        mcpConfigured: false,
        skillInstalled: false,
      };
    } catch (error) {
      return {
        ok: true,
        state: "error",
        claudePath,
        launcherPath: deps.launcherPath,
        command: getManualCommand(commandExecutable),
        existingCommand: null,
        error: error?.message || String(error),
      };
    }
  }

  async function addToClaude() {
    const status = await getStatus();
    if (status.state === "claude_not_found" || status.state === "conflict" || status.state === "configured") {
      return status;
    }
    if (status.state === "error") {
      return status;
    }

    const { shellEnv, claudePath, commandExecutable } = await resolveClaude();
    if (!claudePath) {
      return {
        ...status,
        state: "claude_not_found",
        claudePath: null,
      };
    }

    let installingSkill = false;
    let mcpConfigured = Boolean(status.mcpConfigured);
    try {
      if (status.mcpConfigured) {
        installingSkill = true;
        await deps.installSkill({
          client: "claude",
          homeDir: resolveUserHomeDir(shellEnv),
          claudeConfigDir: shellEnv.CLAUDE_CONFIG_DIR,
        });
        return await getStatus();
      }
      if (status.existingCommand) {
        const scopes = status.existingScope
          ? [status.existingScope]
          : ["local", "user", "project"];
        for (const nextScope of scopes) {
          await runClaude(claudePath, shellEnv, [
            "mcp",
            "remove",
            "-s",
            nextScope,
            EXTERNAL_MCP_CLAUDE_NAME,
          ]);
        }
      }
      const addResult = await runClaude(
        claudePath,
        shellEnv,
        buildClaudeAddArgs(deps.launcherPath, deps.discoveryEnv),
      );
      if (addResult.exitCode !== 0) {
        return {
          ok: true,
          state: "error",
          claudePath,
          launcherPath: deps.launcherPath,
          command: getManualCommand(commandExecutable),
          existingCommand: null,
          error: summarizeFailure(addResult, `Claude exited with code ${addResult.exitCode ?? "unknown"}`),
        };
      }
      mcpConfigured = true;
      installingSkill = true;
      await deps.installSkill({
        client: "claude",
        homeDir: resolveUserHomeDir(shellEnv),
        claudeConfigDir: shellEnv.CLAUDE_CONFIG_DIR,
      });
      return await getStatus();
    } catch (error) {
      return {
        ok: true,
        state: "error",
        claudePath,
        launcherPath: deps.launcherPath,
        command: getManualCommand(commandExecutable),
        existingCommand: null,
        mcpConfigured,
        skillInstalled: false,
        error: installingSkill
          ? `Failed to install the Netcatty Claude Code skill: ${error?.message || String(error)}`
          : (error?.message || String(error)),
      };
    }
  }

  return {
    getStatus,
    addToClaude,
  };
}

module.exports = {
  EXTERNAL_MCP_CLAUDE_NAME,
  createExternalMcpClaudeSetup,
  classifyClaudeExternalMcpStatus,
};
