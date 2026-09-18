"use strict";

const { runBoundedCliCommand } = require("./boundedCliCommand.cjs");
const {
  getNetcattySkillStatus,
  installNetcattySkill,
  resolveGrokHomeDir,
  resolveUserHomeDir,
} = require("./netcattySkillInstaller.cjs");

const EXTERNAL_MCP_GROK_NAME = "netcatty-external";
const {
  formatDiscoveryEnvCliFlags,
} = require("../../cli/externalMcpDiscoveryPath.cjs");

function loadShellUtils() {
  return require("../ai/shellUtils.cjs");
}

function formatGrokCommandText(args) {
  return ["grok", ...args.map(quoteCommandArg)].join(" ");
}

function quoteCommandArg(value) {
  if (typeof value !== "string" || value.length === 0) return '""';
  // Match ExternalMcpCard quoteShellArg so copyable commands stay shell-safe
  // for paths with spaces, quotes, apostrophes, or backslashes.
  if (!/[\s"'\\]/u.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function formatExistingCommand(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.transport && typeof entry.transport === "object") {
    const transport = entry.transport;
    if (transport.type === "stdio" || transport.command) {
      const command = typeof transport.command === "string" ? transport.command.trim() : "";
      const args = Array.isArray(transport.args)
        ? transport.args.filter((arg) => typeof arg === "string" && arg.trim())
        : [];
      return [command, ...args].filter(Boolean).join(" ").trim() || null;
    }
    if (typeof transport.url === "string" && transport.url.trim()) {
      return transport.url.trim();
    }
  }
  if (typeof entry.command === "string" && entry.command.trim()) {
    const args = Array.isArray(entry.args)
      ? entry.args.filter((arg) => typeof arg === "string" && arg.trim())
      : [];
    return [entry.command.trim(), ...args].filter(Boolean).join(" ").trim() || null;
  }
  if (typeof entry.url === "string" && entry.url.trim()) {
    return entry.url.trim();
  }
  return null;
}

function parseGrokMcpList(rawOutput) {
  const text = String(rawOutput || "").trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((entry) => entry && typeof entry === "object")
        .map(normalizeGrokListEntry);
    }
    if (parsed && typeof parsed === "object") {
      const servers = parsed.servers || parsed.mcp_servers || parsed.mcpServers || parsed;
      if (Array.isArray(servers)) {
        return servers
          .filter((entry) => entry && typeof entry === "object")
          .map(normalizeGrokListEntry);
      }
      if (servers && typeof servers === "object") {
        return Object.entries(servers).map(([name, value]) => normalizeGrokListEntry({
          ...(value && typeof value === "object" ? value : {}),
          name,
        }));
      }
    }
  } catch {
    // Fall through to line-oriented parsing for non-JSON list output.
  }

  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const colonIndex = line.indexOf(":");
      if (colonIndex > 0) {
        return {
          name: line.slice(0, colonIndex).trim(),
          command: line.slice(colonIndex + 1).trim() || null,
        };
      }
      const parts = line.split(/\s+/u);
      return {
        name: parts[0] || "",
        command: parts.slice(1).join(" ").trim() || null,
      };
    })
    .filter((entry) => entry.name);
}

function normalizeGrokListEntry(entry) {
  const name = typeof entry.name === "string"
    ? entry.name
    : (typeof entry.id === "string" ? entry.id : "");
  return {
    name,
    enabled: entry.enabled !== false,
    command: typeof entry.command === "string" ? entry.command : null,
    args: Array.isArray(entry.args) ? entry.args : null,
    transport: entry.transport && typeof entry.transport === "object" ? entry.transport : null,
    url: typeof entry.url === "string" ? entry.url : null,
    env: entry.env && typeof entry.env === "object" ? entry.env : null,
  };
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

function extractCommandExecutable(commandText) {
  if (typeof commandText !== "string") return "";
  const trimmed = commandText.trim();
  if (!trimmed) return "";
  const dashDashIndex = trimmed.lastIndexOf(" -- ");
  const candidate = dashDashIndex >= 0
    ? trimmed.slice(dashDashIndex + 4).trim()
    : trimmed;
  const match = candidate.match(/("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)/u);
  if (!match) return candidate;
  const remainder = candidate.slice(match[0].length).trim();
  if (remainder) return "";
  return match[1];
}

function getEntryCommand(entry) {
  if (!entry) return null;
  if (entry.transport?.type === "stdio" || entry.transport?.command) {
    const command = String(entry.transport.command || "").trim();
    const args = Array.isArray(entry.transport.args) ? entry.transport.args : [];
    if (command && args.length === 0) return command;
    return null;
  }
  if (typeof entry.command === "string" && entry.command.trim()) {
    const args = Array.isArray(entry.args) ? entry.args : [];
    if (args.length === 0) return entry.command.trim();
    return null;
  }
  return formatExistingCommand(entry);
}

function hasRequiredDiscoveryEnv(entryEnv, discoveryEnv) {
  const required = discoveryEnv && typeof discoveryEnv === "object" ? discoveryEnv : {};
  const keys = Object.keys(required).filter((key) => typeof required[key] === "string" && required[key]);
  if (keys.length === 0) return true;
  if (!entryEnv || typeof entryEnv !== "object") return false;
  return keys.every((key) => String(entryEnv[key] || "") === String(required[key]));
}

function getGrokEntryEnv(entry) {
  if (entry?.env && typeof entry.env === "object") return entry.env;
  if (entry?.transport?.env && typeof entry.transport.env === "object") return entry.transport.env;
  return null;
}

function buildGrokAddArgs(launcherPath, discoveryEnv) {
  return [
    "mcp",
    "add",
    EXTERNAL_MCP_GROK_NAME,
    ...formatDiscoveryEnvCliFlags(discoveryEnv, "grok"),
    "--",
    launcherPath,
  ];
}

function classifyGrokExternalMcpStatus({ entries, launcherPath, grokPath, discoveryEnv }) {
  const commandArgs = buildGrokAddArgs(launcherPath, discoveryEnv || {});
  const base = {
    ok: true,
    grokPath: grokPath || null,
    launcherPath: launcherPath || null,
    command: formatGrokCommandText(commandArgs),
    existingCommand: null,
    error: null,
  };

  const entry = Array.isArray(entries)
    ? entries.find((item) => item?.name === EXTERNAL_MCP_GROK_NAME)
    : null;

  if (!entry) {
    return {
      ...base,
      state: grokPath ? "not_configured" : "grok_not_found",
    };
  }

  const existingCommand = getEntryCommand(entry);
  if (entry.enabled === false) {
    return {
      ...base,
      state: "not_configured",
      existingCommand: existingCommand || launcherPath || EXTERNAL_MCP_GROK_NAME,
    };
  }

  if (!existingCommand) {
    // Present but not a plain launcher command (extra args / non-stdio).
    return {
      ...base,
      state: "conflict",
      existingCommand: formatExistingCommand(entry) || EXTERNAL_MCP_GROK_NAME,
    };
  }

  if (pathsMatch(extractCommandExecutable(existingCommand), launcherPath)) {
    if (!hasRequiredDiscoveryEnv(getGrokEntryEnv(entry), discoveryEnv)) {
      return {
        ...base,
        state: "not_configured",
        existingCommand,
      };
    }
    return {
      ...base,
      state: "configured",
      existingCommand,
    };
  }

  return {
    ...base,
    state: "conflict",
    existingCommand,
  };
}

function createExternalMcpGrokSetup(options = {}) {
  const deps = {
    launcherPath: options.launcherPath || null,
    discoveryEnv: options.discoveryEnv && typeof options.discoveryEnv === "object"
      ? options.discoveryEnv
      : {},
    getShellEnv: options.getShellEnv || loadShellUtils().getShellEnv,
    resolveCliFromPath: options.resolveCliFromPath || loadShellUtils().resolveCliFromPath,
    prepareCommandForSpawn: options.prepareCommandForSpawn || loadShellUtils().prepareCommandForSpawn,
    spawn: options.spawn || require("node:child_process").spawn,
    stripAnsi: options.stripAnsi || loadShellUtils().stripAnsi,
    runGrokCommand: options.runGrokCommand || null,
    getSkillStatus: options.getSkillStatus || getNetcattySkillStatus,
    installSkill: options.installSkill || installNetcattySkill,
  };

  function getManualCommand() {
    return formatGrokCommandText(buildGrokAddArgs(deps.launcherPath, deps.discoveryEnv));
  }

  async function resolveGrok() {
    const shellEnv = await deps.getShellEnv();
    const grokPath = deps.resolveCliFromPath("grok", shellEnv);
    return {
      shellEnv,
      grokPath: grokPath || null,
    };
  }

  async function runGrok(grokPath, shellEnv, args) {
    if (deps.runGrokCommand) {
      return await deps.runGrokCommand(grokPath, shellEnv, args);
    }
    return await runBoundedCliCommand(deps, grokPath, args, { env: shellEnv });
  }

  async function combineSkillStatus(status, shellEnv) {
    if (status.state !== "configured") {
      return {
        ...status,
        command: getManualCommand(),
        mcpConfigured: false,
        skillInstalled: false,
      };
    }
    const homeDir = resolveUserHomeDir(shellEnv);
    const skillStatus = await deps.getSkillStatus({
      client: "grok",
      homeDir,
      grokHomeDir: resolveGrokHomeDir(shellEnv),
    });
    return {
      ...status,
      command: getManualCommand(),
      mcpConfigured: true,
      skillInstalled: skillStatus.installed,
      skillPath: skillStatus.skillPath,
      state: skillStatus.installed ? "configured" : "not_configured",
      ...(!skillStatus.installed && skillStatus.reason
        ? { skillError: skillStatus.reason }
        : {}),
    };
  }

  function summarizeFailure(result, fallback) {
    return String(result?.stderr || result?.stdout || fallback || "Grok command failed").trim();
  }

  async function getStatus() {
    const { shellEnv, grokPath } = await resolveGrok();
    if (!grokPath) {
      return {
        ok: true,
        state: "grok_not_found",
        grokPath: null,
        launcherPath: deps.launcherPath,
        command: getManualCommand(),
        existingCommand: null,
        error: null,
      };
    }

    try {
      const result = await runGrok(grokPath, shellEnv, ["mcp", "list", "--json"]);
      if (result.exitCode !== 0) {
        // Some builds may not support --json; fall back to plain list.
        const fallback = await runGrok(grokPath, shellEnv, ["mcp", "list"]);
        if (fallback.exitCode !== 0) {
          return {
            ok: true,
            state: "error",
            grokPath,
            launcherPath: deps.launcherPath,
            command: getManualCommand(),
            existingCommand: null,
            error: summarizeFailure(fallback, `Grok exited with code ${fallback.exitCode ?? "unknown"}`),
          };
        }
        const status = classifyGrokExternalMcpStatus({
          entries: parseGrokMcpList(fallback.stdout),
          launcherPath: deps.launcherPath,
          grokPath,
          discoveryEnv: deps.discoveryEnv,
        });
        return await combineSkillStatus(status, shellEnv);
      }
      const status = classifyGrokExternalMcpStatus({
        entries: parseGrokMcpList(result.stdout),
        launcherPath: deps.launcherPath,
        grokPath,
        discoveryEnv: deps.discoveryEnv,
      });
      return await combineSkillStatus(status, shellEnv);
    } catch (error) {
      return {
        ok: true,
        state: "error",
        grokPath,
        launcherPath: deps.launcherPath,
        command: getManualCommand(),
        existingCommand: null,
        error: error?.message || String(error),
      };
    }
  }

  async function addToGrok() {
    const status = await getStatus();
    if (status.state === "grok_not_found" || status.state === "conflict" || status.state === "configured") {
      return status;
    }
    if (status.state === "error") {
      return status;
    }

    const { shellEnv, grokPath } = await resolveGrok();
    if (!grokPath) {
      return {
        ...status,
        state: "grok_not_found",
        grokPath: null,
      };
    }

    let installingSkill = false;
    let mcpConfigured = Boolean(status.mcpConfigured);
    try {
      if (status.mcpConfigured) {
        installingSkill = true;
        const homeDir = resolveUserHomeDir(shellEnv);
        await deps.installSkill({
          client: "grok",
          homeDir,
          grokHomeDir: resolveGrokHomeDir(shellEnv),
        });
        return await getStatus();
      }
      if (status.existingCommand) {
        await runGrok(grokPath, shellEnv, ["mcp", "remove", EXTERNAL_MCP_GROK_NAME]);
      }
      const addResult = await runGrok(
        grokPath,
        shellEnv,
        buildGrokAddArgs(deps.launcherPath, deps.discoveryEnv),
      );
      if (addResult.exitCode !== 0) {
        return {
          ok: true,
          state: "error",
          grokPath,
          launcherPath: deps.launcherPath,
          command: getManualCommand(),
          existingCommand: null,
          error: summarizeFailure(addResult, `Grok exited with code ${addResult.exitCode ?? "unknown"}`),
        };
      }
      mcpConfigured = true;
      installingSkill = true;
      const homeDir = resolveUserHomeDir(shellEnv);
      await deps.installSkill({
        client: "grok",
        homeDir,
        grokHomeDir: resolveGrokHomeDir(shellEnv),
      });
      return await getStatus();
    } catch (error) {
      return {
        ok: true,
        state: "error",
        grokPath,
        launcherPath: deps.launcherPath,
        command: getManualCommand(),
        existingCommand: null,
        mcpConfigured,
        skillInstalled: false,
        error: installingSkill
          ? `Failed to install the Netcatty Grok skill: ${error?.message || String(error)}`
          : (error?.message || String(error)),
      };
    }
  }

  return {
    getStatus,
    addToGrok,
  };
}

module.exports = {
  EXTERNAL_MCP_GROK_NAME,
  createExternalMcpGrokSetup,
  parseGrokMcpList,
  classifyGrokExternalMcpStatus,
};
