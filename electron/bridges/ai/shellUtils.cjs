/**
 * Shell utility functions shared across AI bridge modules.
 *
 * Provides ANSI stripping, URL extraction, CLI resolution, path helpers,
 * stream chunk serialization, and cached shell environment resolution.
 */
"use strict";

const { execFile, execFileSync } = require("node:child_process");
const { existsSync, readFileSync, statSync } = require("node:fs");
const path = require("node:path");

// ── ANSI / URL regexes ──

const ANSI_ESCAPE_REGEX = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_REGEX = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const URL_CANDIDATE_REGEX = /https?:\/\/[^\s]+/g;
const WINDOWS_RUNNABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"];
const MAX_PROMPT_TRACK_TAIL = 4096;

function execFileAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// ── ANSI stripping ──

function stripAnsi(input) {
  return String(input || "").replace(ANSI_OSC_REGEX, "").replace(ANSI_ESCAPE_REGEX, "");
}

// ── Synthetic command echo ──
//
// The agent's typed command is not echoed by the PTY as-is (the wrapper
// line is filtered out in preload), so exec bridges emit a synthetic echo
// for the user to see. xterm.js treats a bare \n as "move down, keep
// column", which renders multi-line commands as a staircase. Normalize
// every line break to \r\n so each line starts at column 0.
function formatSyntheticEcho(command) {
  return `${String(command ?? "").replace(/\r?\n/g, "\r\n")}\r\n`;
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

function resolveWindowsShimToNativeExe(command, platform = process.platform) {
  if (platform !== "win32") return null;
  const normalized = String(command || "").trim();
  if (!normalized) return null;
  const ext = path.extname(normalized).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return null;
  if (!existsSync(normalized)) return null;
  try {
    const contents = readFileSync(normalized, "utf8");
    const shimDir = path.dirname(normalized);
    // Match patterns like: "%~dp0\..\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*
    // or: "%~dp0\..\@openai\codex\bin\codex.exe"
    const exeRefs = [...contents.matchAll(/"%~dp0\\([^"]+\.exe)"/gi)];
    for (const [, relativePath] of exeRefs) {
      const candidate = path.resolve(shimDir, relativePath.replace(/\\/g, "/"));
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

function prepareCommandForSpawn(command, args) {
  const spawnArgs = Array.isArray(args) ? args : [];
  if (!shouldUseShellForCommand(command)) {
    return { command, args: spawnArgs, shell: false };
  }

  const nativeExePath = resolveWindowsShimToNativeExe(command);
  if (nativeExePath) {
    return { command: nativeExePath, args: spawnArgs, shell: false };
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

  // Native binary check: Claude Code >= 2.1.169 ships as native exe with no cli.js
  const nativeExeCandidates = [
    path.join(baseDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    path.join(baseDir, "..", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
  ];
  for (const exePath of nativeExeCandidates) {
    if (existsSync(exePath)) return exePath;
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

const CODEX_WIN32_PLATFORM_PACKAGES = {
  x64: { triple: "x86_64-pc-windows-msvc", package: "@openai/codex-win32-x64" },
  arm64: { triple: "aarch64-pc-windows-msvc", package: "@openai/codex-win32-arm64" },
};

function resolveCodexNativeExecutableWin32(moduleSearchDirs, arch = process.arch) {
  const archKey = arch === "arm64" ? "arm64" : "x64";
  const { triple, package: platformPackage } = CODEX_WIN32_PLATFORM_PACKAGES[archKey];

  for (const dir of moduleSearchDirs) {
    if (!dir) continue;
    const candidates = [
      path.join(dir, "node_modules", platformPackage, "vendor", triple, "bin", "codex.exe"),
      path.join(dir, "node_modules", platformPackage, "vendor", triple, "codex", "codex.exe"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function getNvmdHomeFromShimDir(shimDir) {
  const normalized = String(shimDir || "").trim();
  if (!normalized) return null;
  if (path.basename(normalized).toLowerCase() !== "bin") return null;
  const home = path.dirname(normalized);
  // nvm-desktop / nvmd-command layout: $NVMD_HOME/{bin,versions,default,packages.json}
  if (
    existsSync(path.join(home, "versions")) ||
    existsSync(path.join(home, "packages.json")) ||
    existsSync(path.join(home, "default"))
  ) {
    return home;
  }
  return null;
}

function readNvmdDefaultVersion(nvmdHome) {
  try {
    const raw = readFileSync(path.join(nvmdHome, "default"), "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

function readNvmdPackageVersions(nvmdHome, packageBinName) {
  try {
    const raw = readFileSync(path.join(nvmdHome, "packages.json"), "utf8");
    const data = JSON.parse(raw);
    const versions = data && data[packageBinName];
    if (!Array.isArray(versions)) return [];
    return versions.map((v) => String(v || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function getNvmdVersionsDirectory(nvmdHome) {
  try {
    const raw = readFileSync(path.join(nvmdHome, "setting.json"), "utf8");
    const data = JSON.parse(raw);
    const custom = data && typeof data.directory === "string" ? data.directory.trim() : "";
    if (custom) return custom;
  } catch {
    // Fall back to the default versions/ directory.
  }
  return path.join(nvmdHome, "versions");
}

function getNvmdCodexVersionRoots(nvmdHome) {
  if (!nvmdHome) return [];
  const versionsDir = getNvmdVersionsDirectory(nvmdHome);
  const candidates = [
    ...readNvmdPackageVersions(nvmdHome, "codex").reverse(),
    readNvmdDefaultVersion(nvmdHome),
  ].filter(Boolean);

  const roots = [];
  const seen = new Set();
  for (const version of candidates) {
    const root = path.join(versionsDir, version);
    if (seen.has(root) || !existsSync(root)) continue;
    seen.add(root);
    roots.push(root);
  }
  return roots;
}

function getCodexNativeSearchDirsForShim(shimDir) {
  const dirs = [shimDir];
  const parentDir = path.dirname(shimDir);
  if (
    path.basename(shimDir).toLowerCase() === ".bin" &&
    path.basename(parentDir).toLowerCase() === "node_modules"
  ) {
    dirs.push(path.dirname(parentDir));
  }
  dirs.push(path.join(shimDir, "node_modules", "@openai", "codex"));

  // nvm-desktop installs global CLIs under $NVMD_HOME/versions/<ver>/, while
  // $NVMD_HOME/bin/codex{.cmd,.exe} are only nvmd router shims. Expand search
  // into the active/recorded Node version roots so the SDK can spawn the real
  // native codex.exe (codexPathOverride) instead of falling back to bundled
  // optional deps that Netcatty deliberately does not ship.
  const nvmdHome = getNvmdHomeFromShimDir(shimDir);
  for (const versionRoot of getNvmdCodexVersionRoots(nvmdHome)) {
    dirs.push(versionRoot);
    dirs.push(path.join(versionRoot, "node_modules", "@openai", "codex"));
  }
  return dirs;
}

function getCodexNativePathDirsWin32(nativeExecutablePath) {
  const normalized = String(nativeExecutablePath || "").trim();
  if (!normalized || path.basename(normalized).toLowerCase() !== "codex.exe") {
    return [];
  }

  const executableDir = path.dirname(normalized);
  const packageRoot = path.dirname(executableDir);
  const dirs = [];
  if (path.basename(executableDir).toLowerCase() === "bin") {
    dirs.push(path.join(packageRoot, "codex-path"));
  } else if (path.basename(executableDir).toLowerCase() === "codex") {
    dirs.push(path.join(packageRoot, "path"));
  }
  return dirs.filter((dir) => existsSync(dir));
}

function getPathEnvKey(env, platform = process.platform) {
  if (platform !== "win32") return "PATH";
  const keys = Object.keys(env || {}).filter((key) => key.toLowerCase() === "path");
  return keys.includes("Path") ? "Path" : keys.at(-1) || "PATH";
}

function addCodexExecutableEnvForSdk(env, codexExecutablePath, platform = process.platform) {
  if (platform !== "win32" || !codexExecutablePath) return env;
  const pathDirs = getCodexNativePathDirsWin32(codexExecutablePath);
  if (pathDirs.length === 0) return env;

  const nextEnv = { ...(env || {}) };
  const pathKey = getPathEnvKey(nextEnv, platform);
  for (const key of Object.keys(nextEnv)) {
    if (key.toLowerCase() === "path" && key !== pathKey) {
      delete nextEnv[key];
    }
  }
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const existingEntries = String(nextEnv[pathKey] || "")
    .split(delimiter)
    .filter((entry) => entry && !pathDirs.includes(entry));
  nextEnv[pathKey] = [...pathDirs, ...existingEntries].join(delimiter);
  return nextEnv;
}

function resolveCodexExecutableForSdk(codexExecutablePath, platform = process.platform) {
  const normalized = String(codexExecutablePath || "").trim();
  if (!normalized) return null;
  if (platform !== "win32") return normalized;

  const ext = path.extname(normalized).toLowerCase();
  const baseDir = path.dirname(normalized);
  const moduleSearchDirs = getCodexNativeSearchDirsForShim(baseDir);
  const nvmdHome = getNvmdHomeFromShimDir(baseDir);

  // nvmd's Windows package shim is a copy of nvmd.exe named codex.exe. Prefer
  // the real native binary under versions/<ver>/ when that layout is present.
  if (ext === ".exe") {
    if (nvmdHome) {
      const nativeExe = resolveCodexNativeExecutableWin32(moduleSearchDirs);
      if (nativeExe) return nativeExe;
    }
    return normalized;
  }

  if (ext === ".js" && /[\\/]codex\.js$/i.test(normalized)) {
    const codexPackageRoot = path.dirname(path.dirname(normalized));
    const globalPrefix = path.resolve(codexPackageRoot, "..", "..", "..");
    const nativeExe = resolveCodexNativeExecutableWin32([
      globalPrefix,
      codexPackageRoot,
      ...moduleSearchDirs,
    ]);
    if (nativeExe) return nativeExe;
  }

  if (ext && ext !== ".cmd" && ext !== ".bat" && ext !== ".ps1") {
    return normalized;
  }

  const nativeExe = resolveCodexNativeExecutableWin32(moduleSearchDirs);
  if (nativeExe) return nativeExe;

  const shimCandidates = [normalized];
  if (!ext) {
    shimCandidates.push(`${normalized}.cmd`, `${normalized}.bat`);
  }

  for (const shimPath of shimCandidates) {
    try {
      if (!existsSync(shimPath)) continue;
      const contents = readFileSync(shimPath, "utf8");
      if (!/@openai[\\/]codex[\\/]bin[\\/]codex\.js/i.test(contents)) {
        continue;
      }
      const resolved = resolveCodexNativeExecutableWin32(moduleSearchDirs);
      if (resolved) return resolved;
    } catch {
      // Fall back to the original executable path below.
    }
  }

  return ext === ".cmd" || ext === ".bat" || ext === ".ps1" ? null : normalized;
}

function resolveCodebuddyExecutableForSdk(codebuddyExecutablePath, platform = process.platform) {
  const normalized = String(codebuddyExecutablePath || "").trim();
  if (!normalized) return null;
  if (platform !== "win32") return normalized;

  const ext = path.extname(normalized).toLowerCase();
  // A native exe or an explicit .js entry can be launched by the Agent SDK as-is.
  if (ext === ".exe" || ext === ".js") return normalized;
  // Any other concrete, non-shim extension: leave it untouched.
  if (ext && ext !== ".cmd" && ext !== ".bat" && ext !== ".ps1") return normalized;

  // Windows npm globals expose `codebuddy.cmd` / `codebuddy.ps1` shims (and an
  // extensionless POSIX shim). The Agent SDK launches the CLI through `node`
  // (electron-as-node in a packaged app), which cannot parse a batch/POSIX shim
  // as JavaScript — the spawned process exits immediately and the SDK surfaces
  // "CLI process stdout closed unexpectedly". Resolve the shim to the package's
  // real `bin/codebuddy` JS entry so the SDK runs it exactly as on macOS/Linux.
  const baseDir = path.dirname(normalized);
  const packageRoots = [
    path.join(baseDir, "node_modules", "@tencent-ai", "codebuddy-code"),
    path.join(baseDir, "..", "node_modules", "@tencent-ai", "codebuddy-code"),
  ];
  for (const root of packageRoots) {
    const binJs = path.join(root, "bin", "codebuddy");
    if (existsSync(binJs)) return binJs;
  }

  // Fall back to parsing the shim for the bin/codebuddy path it references.
  const shimCandidates = [normalized];
  if (!ext) shimCandidates.push(`${normalized}.cmd`, `${normalized}.bat`);
  for (const shimPath of shimCandidates) {
    try {
      if (!existsSync(shimPath)) continue;
      const contents = readFileSync(shimPath, "utf8");
      const match = contents.match(/([^"\s]*codebuddy-code[\\/]bin[\\/]codebuddy)/i);
      if (match) {
        const ref = match[1].replace(/^%~dp0[\\/]?/i, "").replace(/[\\/]+/g, path.sep);
        const binJs = path.isAbsolute(ref) ? ref : path.resolve(path.dirname(shimPath), ref);
        if (existsSync(binJs)) return binJs;
      }
    } catch {
      // Try the next shim candidate.
    }
  }

  // Could not locate the JS entry — return null so the caller falls back to the
  // SDK's bundled CLI rather than handing `node` an unrunnable shim.
  return ext === ".cmd" || ext === ".bat" || ext === ".ps1" ? null : normalized;
}

function resolveSdkBinPath(command, shellEnv, platform = process.platform) {
  const raw = resolveCliFromPath(command, shellEnv);
  if (!raw) return null;
  if (platform !== "win32") return raw;
  if (command === "codex") {
    return resolveCodexExecutableForSdk(raw, platform);
  }
  if (command === "claude") {
    return resolveClaudeCodeExecutableForSdk(raw, platform);
  }
  return raw;
}

async function resolveSdkBinPathAsync(command, shellEnv, platform = process.platform) {
  const raw = await resolveCliFromPathAsync(command, shellEnv);
  if (!raw) return null;
  if (platform !== "win32") return raw;
  if (command === "codex") {
    return resolveCodexExecutableForSdk(raw, platform);
  }
  if (command === "claude") {
    return resolveClaudeCodeExecutableForSdk(raw, platform);
  }
  return raw;
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

async function resolveCliFromPathAsync(command, shellEnv) {
  // Validate command: only allow valid binary names (alphanumeric, hyphens, underscores, dots)
  if (!command || !/^[a-zA-Z0-9._-]+$/.test(command)) {
    return null;
  }

  if (shellEnv) {
    try {
      const whichCmd = process.platform === "win32" ? "where" : "which";
      const { stdout } = await execFileAsync(whichCmd, [command], {
        encoding: "utf8",
        timeout: 3000,
        env: shellEnv,
      });
      const resolved = String(stdout || "").trim();
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
let _shellEnvPromise = null;
let _shellEnvGeneration = 0;

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

async function defaultRunLoginShellPathAsync() {
  let shell = process.env.SHELL || "/bin/zsh";
  if (!path.isAbsolute(shell) || !existsSync(shell)) {
    shell = "/bin/zsh";
  }
  const { stdout } = await execFileAsync(shell, ["-ilc", 'echo -n "$PATH"'], {
    encoding: "utf8",
    timeout: 4000,
    env: { ...process.env, HOME: process.env.HOME || "" },
  });
  return stdout;
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

// ── Windows live PATH refresh ──
//
// A GUI-launched Electron process freezes process.env at launch. When a CLI is
// installed *after* Netcatty starts (its installer appends to the user/system
// PATH in the registry), a freshly opened cmd/PowerShell sees it but Netcatty
// does not — and clicking "Refresh" can't help, because process.env never
// changes for the life of the process. So on Windows we re-read the authoritative
// PATH from the registry (the value a brand-new shell would inherit) and merge it
// with the in-process PATH. This mirrors the login-shell PATH probe used on
// macOS/Linux and fixes CLIs (e.g. CodeBuddy) that "work in cmd" but don't scan.

function parseRegQueryPath(stdout) {
  // `reg query` prints e.g.: "    Path    REG_EXPAND_SZ    C:\\a;C:\\b"
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = line.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*\S)\s*$/i);
    if (match) return match[1];
  }
  return "";
}

function expandWindowsEnvRefs(value, env = process.env) {
  return String(value || "").replace(/%([^%]+)%/g, (whole, name) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === String(name).toLowerCase());
    return key && typeof env[key] === "string" ? env[key] : whole;
  });
}

function mergeWindowsPath(...pathStrings) {
  const seen = new Set();
  const out = [];
  for (const str of pathStrings) {
    for (const part of String(str || "").split(";")) {
      const trimmed = part.trim().replace(/^"|"$/g, "");
      if (!trimmed) continue;
      const dedupeKey = trimmed.toLowerCase().replace(/[\\/]+$/, "");
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push(trimmed);
    }
  }
  return out.join(";");
}

function getWindowsKnownCliPathDirs(env = process.env) {
  const dirs = [];
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, "npm"));
  if (env.LOCALAPPDATA) {
    dirs.push(path.join(env.LOCALAPPDATA, "pnpm"));
    dirs.push(path.join(env.LOCALAPPDATA, "Yarn", "bin"));
  }
  return dirs.filter((dir) => existsSync(dir));
}

async function readWindowsRegistryPath({ exec = execFileAsync, env = process.env } = {}) {
  const hives = [
    "HKCU\\Environment",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  ];
  const parts = [];
  for (const hive of hives) {
    try {
      const { stdout } = await exec("reg", ["query", hive, "/v", "Path"], {
        encoding: "utf8",
        timeout: 3000,
      });
      const raw = parseRegQueryPath(stdout);
      if (raw) parts.push(expandWindowsEnvRefs(raw, env));
    } catch {
      // Hive unreadable / value missing — skip and rely on other sources.
    }
  }
  return parts.join(";");
}

async function getShellEnv() {
  if (_cachedShellEnv) return _cachedShellEnv;
  if (_shellEnvPromise) return _shellEnvPromise;

  const generation = _shellEnvGeneration;
  _shellEnvPromise = (async () => {
    const home = process.env.HOME || "";
    const extraPaths = [
      `${home}/.local/bin`,
      `${home}/.npm-global/bin`,
      "/usr/local/bin",
      "/opt/homebrew/bin",
    ];

    if (process.platform === "win32") {
      // Re-read the live PATH from the registry so CLIs installed after launch
      // (e.g. CodeBuddy) are discoverable without restarting Netcatty, then fold
      // in well-known npm/pnpm/yarn global bin dirs as a belt-and-suspenders.
      let registryPath = "";
      try {
        registryPath = await readWindowsRegistryPath();
      } catch {
        registryPath = "";
      }
      const knownDirs = getWindowsKnownCliPathDirs().join(path.delimiter);
      const nextEnv = {
        ...process.env,
        PATH: mergeWindowsPath(registryPath, knownDirs, process.env.PATH || ""),
      };
      if (generation === _shellEnvGeneration) {
        _cachedShellEnv = nextEnv;
      }
      return nextEnv;
    }

    // On macOS/Linux, spawn a login shell to capture the real environment.
    try {
      let shell = process.env.SHELL || "/bin/zsh";
      if (!path.isAbsolute(shell) || !existsSync(shell)) {
        shell = "/bin/zsh";
      }
      const { stdout: envOutput } = await execFileAsync(shell, ['-ilc', 'env'], {
        encoding: "utf8",
        timeout: 10000,
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
      const nextEnv = {
        ...envMap,
        ...process.env,
        PATH: mergeLoginShellPath({ basePath: mergedPath, runLoginShellPath: () => shellPath }),
      };
      if (generation === _shellEnvGeneration) {
        _cachedShellEnv = nextEnv;
      }
      return nextEnv;
    } catch {
      // `-ilc env` failed — try a lighter login-shell PATH probe as a fallback so
      // GUI-launch PATH stripping still doesn't break CLI discovery (layer-0).
      const basePath = [...extraPaths, process.env.PATH || ""].join(path.delimiter);
      let loginShellPath = "";
      try {
        loginShellPath = await defaultRunLoginShellPathAsync();
      } catch {
        loginShellPath = "";
      }
      const nextEnv = {
        ...process.env,
        PATH: mergeLoginShellPath({
          basePath,
          runLoginShellPath: () => loginShellPath,
        }),
      };
      if (generation === _shellEnvGeneration) {
        _cachedShellEnv = nextEnv;
      }
      return nextEnv;
    }
  })().finally(() => {
    if (generation === _shellEnvGeneration) {
      _shellEnvPromise = null;
    }
  });

  return _shellEnvPromise;
}

/**
 * Drop the shell-env cache so the next getShellEnv() call re-spawns the
 * login shell. Useful when the user has just exported a new variable in
 * their rc file and clicks "Refresh Status" without restarting the app.
 */
function invalidateShellEnvCache() {
  _shellEnvGeneration += 1;
  _cachedShellEnv = null;
  _shellEnvPromise = null;
}

module.exports = {
  stripAnsi,
  formatSyntheticEcho,
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
  resolveWindowsShimToNativeExe,
  resolveClaudeCodeExecutableForSdk,
  normalizeClaudeCodeExecutableEnvForSdk,
  resolveCodexExecutableForSdk,
  addCodexExecutableEnvForSdk,
  resolveCodebuddyExecutableForSdk,
  resolveSdkBinPath,
  resolveSdkBinPathAsync,
  resolveCliFromPath,
  resolveCliFromPathAsync,
  toUnpackedAsarPath,
  isPlausibleCliVersionOutput,
  mergeLoginShellPath,
  parseRegQueryPath,
  expandWindowsEnvRefs,
  mergeWindowsPath,
  readWindowsRegistryPath,
  getShellEnv,
  invalidateShellEnvCache,
};
