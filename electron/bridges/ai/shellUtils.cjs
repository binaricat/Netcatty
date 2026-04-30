/**
 * Shell utility functions shared across AI bridge modules.
 *
 * Provides ANSI stripping, URL extraction, CLI resolution, path helpers,
 * stream chunk serialization, and cached shell environment resolution.
 */
"use strict";

const { execFileSync } = require("node:child_process");
const { existsSync, statSync } = require("node:fs");
const path = require("node:path");

// ── ANSI / URL regexes ──

const ANSI_ESCAPE_REGEX = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_REGEX = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const URL_CANDIDATE_REGEX = /https?:\/\/[^\s]+/g;
const WINDOWS_RUNNABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"];
const MAX_PROMPT_TRACK_TAIL = 4096;

// ── ANSI stripping ──

function stripAnsi(input) {
  return String(input || "").replace(ANSI_OSC_REGEX, "").replace(ANSI_ESCAPE_REGEX, "");
}

// Default PowerShell prompt (e.g. `PS C:\Users\alice>`, `PS>`,
// `PS /home/alice>`). Anchored so command output that merely starts with
// `PS` (e.g. `PSO>`) doesn't match. The `\S` after `\s+` rejects literal
// `"PS >"` (which the default prompt never emits) so a script that prints
// such a line can't trick prompt-driven shell-kind selection.
const POWERSHELL_PROMPT_PATTERN = /^PS(?:\s+\S.*)?>$/;

function isDefaultPowerShellPromptLine(line) {
  return POWERSHELL_PROMPT_PATTERN.test(String(line || ""));
}

function extractTrailingIdlePrompt(output) {
  // Treat `\r` as a line break, not as a stripped character: PSReadLine /
  // ConPTY repaints emit bare `\r` to redraw the current line, and we
  // want only the redrawn line to be considered, not the concatenation
  // of every overwritten frame.
  const normalized = stripAnsi(output).replace(/\r/g, "\n");
  if (!normalized || normalized.endsWith("\n")) return "";

  const lastLine = normalized.split("\n").pop() || "";
  const rightTrimmed = lastLine.replace(/\s+$/, "");
  if (!rightTrimmed) return "";

  if (isDefaultPowerShellPromptLine(rightTrimmed)) {
    return lastLine;
  }

  if (/^[^\s@]+@[^\s:]+(?::[^\n\r]*)?[#$]$/.test(rightTrimmed)) {
    return lastLine;
  }

  return "";
}

function trackSessionIdlePrompt(session, chunk) {
  if (!session || typeof chunk !== "string" || !chunk) return "";

  const nextTail = `${session._promptTrackTail || ""}${chunk}`.slice(-MAX_PROMPT_TRACK_TAIL);
  session._promptTrackTail = nextTail;

  const prompt = extractTrailingIdlePrompt(nextTail);
  if (prompt) {
    session.lastIdlePrompt = prompt;
    session.lastIdlePromptAt = Date.now();
  }

  return prompt;
}

// Return `session.lastIdlePrompt` only if the PTY's recent rolling tail
// still ends with it. The cached prompt is updated only when
// extractTrailingIdlePrompt recognizes a known shape (PowerShell or
// `user@host[:path][#$]`); a remote shell switch into cmd.exe, an
// oh-my-posh / starship / custom PS1, or any unrecognized prompt would
// otherwise leave a stale value behind, which `resolveEffectiveShellKind`
// would then keep using to coerce future commands into a PowerShell
// wrapper. By re-checking the live tail we self-correct: if the visible
// last line no longer matches the cached prompt, the prompt is treated
// as expired and downstream wrapper selection / suffix matching falls
// back to `shellKind` alone.
function getFreshIdlePrompt(session) {
  if (!session) return "";
  const cached = session.lastIdlePrompt;
  if (!cached) return "";

  const tail = session._promptTrackTail;
  if (typeof tail !== "string" || !tail) return "";

  const normalizedTail = stripAnsi(tail).replace(/\r/g, "\n");
  const normalizedCached = stripAnsi(cached).replace(/\r/g, "\n");
  if (!normalizedCached) return "";

  return normalizedTail.endsWith(normalizedCached) ? cached : "";
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

function normalizeCliPathForPlatform(filePath) {
  const normalized = String(filePath || "").trim();
  if (!normalized) return null;

  if (process.platform !== "win32") {
    // Reject directories (e.g. /Applications/Codex.app) — must be a file
    try {
      if (existsSync(normalized) && statSync(normalized).isFile()) return normalized;
    } catch { /* stat failed */ }
    return null;
  }

  const ext = path.extname(normalized).toLowerCase();
  if (ext) {
    return existsSync(normalized) ? normalized : null;
  }

  // Windows npm globals often contain both a POSIX shim (`codex`) and the
  // actual runnable wrapper (`codex.cmd`). Prefer the wrapper when present.
  for (const suffix of WINDOWS_RUNNABLE_EXTENSIONS) {
    const candidate = `${normalized}${suffix}`;
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return existsSync(normalized) ? normalized : null;
}

function shouldUseShellForCommand(command) {
  if (process.platform !== "win32") return false;
  const normalized = String(command || "").trim().toLowerCase();
  return normalized.endsWith(".cmd") || normalized.endsWith(".bat");
}

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
      }).trim();
      for (const candidate of resolved.split(/\r?\n/)) {
        const normalized = normalizeCliPathForPlatform(candidate);
        if (normalized) return normalized;
      }
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

function isPlausibleCliVersionOutput(value) {
  const line = stripAnsi(String(value || "")).trim().split(/\r?\n/)[0]?.trim() || "";
  if (!line) return false;
  if (/^(?:file|node):\/\//i.test(line)) return false;
  if (/^\s*at\s+/i.test(line)) return false;
  if (/\b(?:Error|TypeError|ReferenceError|SyntaxError|ERR_[A-Z_]+)\b/.test(line)) return false;
  return /(?:^|[^\d])v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?(?:$|[^\d])/.test(line);
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
    let shell = process.env.SHELL || "/bin/zsh";
    if (!path.isAbsolute(shell) || !existsSync(shell)) {
      shell = "/bin/zsh";
    }
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

/**
 * Drop the shell-env cache so the next getShellEnv() call re-spawns the
 * login shell. Useful when the user has just exported a new variable in
 * their rc file and clicks "Refresh Status" without restarting the app.
 */
function invalidateShellEnvCache() {
  _cachedShellEnv = null;
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
  extractTrailingIdlePrompt,
  getFreshIdlePrompt,
  isDefaultPowerShellPromptLine,
  trackSessionIdlePrompt,
  isLocalhostHostname,
  extractFirstNonLocalhostUrl,
  normalizeCliPathForPlatform,
  shouldUseShellForCommand,
  resolveCliFromPath,
  resolveClaudeAcpBinaryPath,
  toUnpackedAsarPath,
  isPlausibleCliVersionOutput,
  getShellEnv,
  invalidateShellEnvCache,
  serializeStreamChunk,
};
