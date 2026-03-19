/**
 * Shell utility functions shared across AI bridge modules.
 *
 * Provides ANSI stripping, URL extraction, CLI resolution, path helpers,
 * stream chunk serialization, and cached shell environment resolution.
 */
"use strict";

const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

// ── ANSI / URL regexes ──

const ANSI_ESCAPE_REGEX = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_REGEX = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const URL_CANDIDATE_REGEX = /https?:\/\/[^\s]+/g;

// ── ANSI stripping ──

function stripAnsi(input) {
  return String(input || "").replace(ANSI_OSC_REGEX, "").replace(ANSI_ESCAPE_REGEX, "");
}

// ── URL helpers ──

function isLocalhostHostname(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost")
  );
}

function extractFirstNonLocalhostUrl(output) {
  const { URL } = require("node:url");
  const matches = stripAnsi(output).match(URL_CANDIDATE_REGEX);
  if (!matches) return null;

  for (const match of matches) {
    try {
      const parsedUrl = new URL(match.trim().replace(/[),.;!?]+$/, ""));
      if (!isLocalhostHostname(parsedUrl.hostname)) {
        return parsedUrl.toString();
      }
    } catch {
      // Ignore invalid URL candidates.
    }
  }

  return null;
}

// ── CLI / path helpers ──

function resolveCliFromPath(command, shellEnv) {
  // Validate command: only allow valid binary names (alphanumeric, hyphens, underscores, dots)
  if (!command || !/^[a-zA-Z0-9._-]+$/.test(command)) {
    return null;
  }

  if (shellEnv) {
    try {
      const whichCmd = process.platform === "win32" ? "where" : "which";
      const resolved = execFileSync(whichCmd, [command], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["pipe", "pipe", "pipe"],
        env: shellEnv,
      }).trim().split("\n")[0].trim();
      if (resolved && existsSync(resolved)) return resolved;
    } catch {
      // Not found on PATH
    }
  }
  return null;
}

function toUnpackedAsarPath(filePath) {
  const unpackedPath = filePath.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  if (unpackedPath !== filePath && existsSync(unpackedPath)) {
    return unpackedPath;
  }
  return filePath;
}

// ── Shell environment (cached) ──

let _cachedShellEnv = null;

async function getShellEnv() {
  if (_cachedShellEnv) return _cachedShellEnv;

  const home = process.env.HOME || "";
  const extraPaths = [
    `${home}/.local/bin`,
    `${home}/.npm-global/bin`,
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];

  if (process.platform === "win32") {
    _cachedShellEnv = {
      ...process.env,
      PATH: [...extraPaths, process.env.PATH || ""].join(path.delimiter),
    };
    return _cachedShellEnv;
  }

  // On macOS/Linux, spawn a login shell to capture the real environment.
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const envOutput = execFileSync(shell, ['-ilc', 'env'], {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: home },
    });
    const envMap = {};
    for (const line of envOutput.split("\n")) {
      const idx = line.indexOf("=");
      if (idx > 0) {
        envMap[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }
    const shellPath = envMap.PATH || "";
    _cachedShellEnv = {
      ...envMap,
      ...process.env,
      PATH: [...extraPaths, shellPath, process.env.PATH || ""].join(path.delimiter),
    };
  } catch {
    _cachedShellEnv = {
      ...process.env,
      PATH: [...extraPaths, process.env.PATH || ""].join(path.delimiter),
    };
  }
  return _cachedShellEnv;
}

// ── Claude Code ACP binary resolution ──

/**
 * Resolve the Claude ACP binary, returning { command, prependArgs }.
 *
 * On macOS/Linux a shebang-based .js script can be spawned directly, but on
 * Windows `child_process.spawn` does not interpret shebangs — so when the
 * resolved path is a JS file we invoke it via the system Node runtime.
 */
function resolveClaudeAcpBinaryPath(shellEnv, electronModule) {
  const binaryName = "claude-agent-acp";

  // Dev mode: prefer system PATH (npm creates platform-appropriate wrappers)
  const isPackaged = electronModule?.app?.isPackaged;
  if (!isPackaged && shellEnv) {
    const systemPath = resolveCliFromPath(binaryName, shellEnv);
    if (systemPath) return { command: systemPath, prependArgs: [] };
  }

  // Packaged build (or dev fallback): use npm-bundled binary
  try {
    const resolved = require.resolve("@zed-industries/claude-agent-acp/dist/index.js");
    const scriptPath = toUnpackedAsarPath(resolved);

    // On Windows, .js files cannot be spawned directly (no shebang support) —
    // invoke via Node.  In packaged Electron builds process.execPath is the
    // app binary (e.g. Netcatty.exe), not a Node runtime, so we must resolve
    // the real `node` from PATH.  If Node is not installed, fall back to the
    // bare command name and let the system find the npm-generated .cmd wrapper.
    if (process.platform === "win32") {
      const nodePath = resolveCliFromPath("node", shellEnv);
      if (nodePath) {
        return { command: nodePath, prependArgs: [scriptPath] };
      }
      return { command: binaryName, prependArgs: [] };
    }
    return { command: scriptPath, prependArgs: [] };
  } catch {
    return { command: binaryName, prependArgs: [] };
  }
}

// ── Stream chunk serialization ──

function serializeStreamChunk(chunk) {
  if (!chunk || !chunk.type) return null;
  switch (chunk.type) {
    case "text-delta":
      return { type: "text-delta", textDelta: chunk.text ?? chunk.textDelta ?? "" };
    case "reasoning-delta":
      return { type: "reasoning-delta", delta: chunk.text ?? chunk.delta ?? "" };
    case "reasoning-start":
      return { type: "reasoning-start", id: chunk.id ?? undefined };
    case "reasoning-end":
      return { type: "reasoning-end", id: chunk.id ?? undefined };
    case "tool-call": {
      // ACP wraps all tools as "acp.acp_provider_agent_dynamic_tool" —
      // the real tool name and args are inside chunk.args
      const isAcpWrapper = chunk.toolName === "acp.acp_provider_agent_dynamic_tool";
      const acpInput = isAcpWrapper ? chunk.input : null;
      let realToolName = isAcpWrapper ? (acpInput?.toolName || chunk.toolName) : chunk.toolName;
      const realArgs = isAcpWrapper ? (acpInput?.args || chunk.args) : chunk.args;
      const realToolCallId = isAcpWrapper ? (acpInput?.toolCallId || chunk.toolCallId) : chunk.toolCallId;
      // Simplify MCP tool names: "mcp__netcatty-remote-hosts__get_environment" → "get_environment"
      if (realToolName && realToolName.includes("__")) {
        realToolName = realToolName.split("__").pop();
      }
      return {
        type: "tool-call",
        toolCallId: realToolCallId,
        toolName: realToolName,
        args: realArgs,
      };
    }
    case "tool-result":
      return {
        type: "tool-result",
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        result: chunk.result,
        output: chunk.output,
      };
    case "error":
      return { type: "error", error: chunk.error };
    default:
      try {
        return JSON.parse(JSON.stringify(chunk));
      } catch {
        return { type: chunk.type };
      }
  }
}

module.exports = {
  stripAnsi,
  isLocalhostHostname,
  extractFirstNonLocalhostUrl,
  resolveCliFromPath,
  resolveClaudeAcpBinaryPath,
  toUnpackedAsarPath,
  getShellEnv,
  serializeStreamChunk,
};
