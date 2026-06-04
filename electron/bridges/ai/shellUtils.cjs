/**
 * Shell utility functions shared across AI bridge modules.
 *
 * Provides ANSI stripping, URL extraction, CLI resolution, path helpers,
 * stream chunk serialization, and cached shell environment resolution.
 */
"use strict";

const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync, statSync } = require("node:fs");
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

// bash and csh/tcsh print a banner to the terminal right before exiting due to
// the shell's TMOUT idle-timeout setting ("timed out waiting for input:
// auto-logout" / "auto-logout"). That exit is a clean shell exit — numeric
// code, no signal — so it is indistinguishable from a user-typed `exit` by
// exit code alone (verified: bash auto-logout exits 0). The banner is the only
// reliable discriminator, letting the SSH bridge keep the tab open for
// reconnect instead of auto-closing it (#1062, regression of #977).
const IDLE_AUTO_LOGOUT_PATTERN = /(?:timed out waiting for input:\s*)?auto-?logout$/i;

function looksLikeIdleAutoLogout(outputTail) {
  if (typeof outputTail !== "string" || !outputTail) return false;
  // The shell prints this banner on its own line as the very last thing before
  // it exits, so anchor on the final non-empty line rather than a loose
  // substring. Otherwise unrelated output that merely mentions "auto-logout"
  // (e.g. `grep auto-logout /etc/profile`) followed by an intentional `exit`
  // would be misclassified as a timeout and wrongly keep the tab open.
  const lines = stripAnsi(outputTail.slice(-512)).replace(/\r/g, "\n").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    // Drop control bytes (e.g. the BEL bash rings before the banner) and trim.
    const line = lines[i].replace(/[\x00-\x1f\x7f]/g, "").trim();
    if (!line) continue;
    return IDLE_AUTO_LOGOUT_PATTERN.test(line);
  }
  return false;
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

function quoteWindowsShellArg(value) {
  const arg = String(value ?? "");
  if (!arg) return "\"\"";
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function buildWindowsShellCommandLine(command, args) {
  return [command, ...(args || [])].map(quoteWindowsShellArg).join(" ");
}

function prepareCommandForSpawn(command, args) {
  const spawnArgs = Array.isArray(args) ? args : [];
  if (!shouldUseShellForCommand(command)) {
    return { command, args: spawnArgs, shell: false };
  }

  return {
    command: buildWindowsShellCommandLine(command, spawnArgs),
    args: [],
    shell: true,
  };
}

function resolveClaudeCodeExecutableForSdk(claudeExecutablePath, platform = process.platform) {
  const normalized = String(claudeExecutablePath || "").trim();
  if (!normalized) return null;
  if (platform !== "win32") return normalized;

  const ext = path.extname(normalized).toLowerCase();
  if (ext && ext !== ".cmd" && ext !== ".bat") return normalized;

  const baseDir = path.dirname(normalized);
  const packageCliPath = path.join(baseDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  if (existsSync(packageCliPath)) {
    return packageCliPath;
  }

  const shimCandidates = [normalized];
  if (!ext) {
    shimCandidates.push(`${normalized}.cmd`, `${normalized}.bat`);
  }

  for (const shimPath of shimCandidates) {
    try {
      if (!existsSync(shimPath)) continue;
      const contents = readFileSync(shimPath, "utf8");
      if (!/node_modules[\\/]+@anthropic-ai[\\/]+claude-code[\\/]+cli\.js/i.test(contents)) {
        continue;
      }
      if (existsSync(packageCliPath)) {
        return packageCliPath;
      }
    } catch {
      // Fall back to the original executable path below.
    }
  }

  return normalized;
}

function normalizeClaudeCodeExecutableEnvForSdk(env, platform = process.platform) {
  if (!env?.CLAUDE_CODE_EXECUTABLE) return env;
  const resolved = resolveClaudeCodeExecutableForSdk(env.CLAUDE_CODE_EXECUTABLE, platform);
  if (!resolved || resolved === env.CLAUDE_CODE_EXECUTABLE) return env;
  return {
    ...env,
    CLAUDE_CODE_EXECUTABLE: resolved,
  };
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

/**
 * Run the user's login shell once to print its PATH. Used as a fallback when
 * the main `-ilc env` capture in getShellEnv fails (layer-0 fix-path).
 */
function defaultRunLoginShellPath() {
  let shell = process.env.SHELL || "/bin/zsh";
  if (!path.isAbsolute(shell) || !existsSync(shell)) {
    shell = "/bin/zsh";
  }
  return execFileSync(shell, ["-ilc", 'echo -n "$PATH"'], {
    encoding: "utf8",
    timeout: 4000,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, HOME: process.env.HOME || "" },
  });
}

/**
 * Union a login-shell PATH ahead of basePath and de-duplicate, so a GUI launch
 * (Finder/Dock) with a stripped PATH still discovers user-installed CLIs.
 * Returns basePath unchanged on win32 or if the login-shell probe fails.
 */
function mergeLoginShellPath({
  basePath,
  runLoginShellPath = defaultRunLoginShellPath,
  platform = process.platform,
  delimiter = path.delimiter,
}) {
  if (platform === "win32") return basePath;
  let shellPath = "";
  try {
    shellPath = String(runLoginShellPath() || "").trim();
  } catch {
    return basePath;
  }
  if (!shellPath) return basePath;
  const seen = new Set();
  const out = [];
  for (const part of [...shellPath.split(delimiter), ...String(basePath || "").split(delimiter)]) {
    const p = part.trim();
    if (p && !seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out.join(delimiter);
}

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
    const mergedPath = [...extraPaths, shellPath, process.env.PATH || ""].join(path.delimiter);
    // Layer-0 fix-path: front-load + de-duplicate the login-shell PATH we just
    // captured (reuse the `-ilc env` result above — no second shell spawn).
    _cachedShellEnv = {
      ...envMap,
      ...process.env,
      PATH: mergeLoginShellPath({ basePath: mergedPath, runLoginShellPath: () => shellPath }),
    };
  } catch {
    // `-ilc env` failed — try a lighter login-shell PATH probe as a fallback so
    // GUI-launch PATH stripping still doesn't break CLI discovery (layer-0).
    const basePath = [...extraPaths, process.env.PATH || ""].join(path.delimiter);
    _cachedShellEnv = {
      ...process.env,
      PATH: mergeLoginShellPath({ basePath }),
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

module.exports = {
  stripAnsi,
  extractTrailingIdlePrompt,
  getFreshIdlePrompt,
  isDefaultPowerShellPromptLine,
  trackSessionIdlePrompt,
  looksLikeIdleAutoLogout,
  isLocalhostHostname,
  extractFirstNonLocalhostUrl,
  normalizeCliPathForPlatform,
  shouldUseShellForCommand,
  quoteWindowsShellArg,
  buildWindowsShellCommandLine,
  prepareCommandForSpawn,
  resolveClaudeCodeExecutableForSdk,
  normalizeClaudeCodeExecutableEnvForSdk,
  resolveCliFromPath,
  toUnpackedAsarPath,
  isPlausibleCliVersionOutput,
  mergeLoginShellPath,
  getShellEnv,
  invalidateShellEnvCache,
};
