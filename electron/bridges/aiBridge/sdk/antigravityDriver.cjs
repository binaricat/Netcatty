"use strict";

const { execFile: defaultExecFile } = require("node:child_process");
const defaultSpawn = require("cross-spawn");
const fs = require("node:fs");
const path = require("node:path");
const tempDirBridge = require("../../tempDirBridge.cjs");
const { mcpEnvPairsToObject } = require("./injectMcp.cjs");

const DEFAULT_PRINT_TIMEOUT = "5m";
const DEFAULT_TURN_TIMEOUT_MS = 6 * 60 * 1000;
const DEFAULT_MODEL_TIMEOUT_MS = 10_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const MAX_PROMPT_BYTES = 24 * 1024;
// cross-spawn escapes cmd.exe metacharacters, which can expand arbitrary prompt
// text. Keep enough headroom below cmd.exe's 8191-character command limit for
// the executable path and Agy's remaining flags.
const WINDOWS_SHIM_MAX_PROMPT_BYTES = 5 * 1024;
const WINDOWS_CMD_SAFE_COMMAND_CHARS = 7_600;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const WINDOWS_CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function escapeWindowsCmdArgument(value, doubleEscapeMetaChars) {
  let escaped = String(value ?? "")
    .replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"")
    .replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`.replace(WINDOWS_CMD_META_CHARS, "^$1");
  return doubleEscapeMetaChars
    ? escaped.replace(WINDOWS_CMD_META_CHARS, "^$1")
    : escaped;
}

function windowsShimCommandLength(binPath, args) {
  const command = String(binPath || "").replace(WINDOWS_CMD_META_CHARS, "^$1");
  const doubleEscape = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i.test(String(binPath || ""));
  const shellCommand = [
    command,
    ...args.map((arg) => escapeWindowsCmdArgument(arg, doubleEscape)),
  ].join(" ");
  return shellCommand.length + 14; // cmd.exe /d /s /c plus outer quotes
}

function getAntigravityPromptByteLimit(binPath) {
  return /\.(?:cmd|bat)$/i.test(String(binPath || "").trim())
    ? WINDOWS_SHIM_MAX_PROMPT_BYTES
    : MAX_PROMPT_BYTES;
}

function buildAntigravityCliArgs({ prompt, model, permissionMode, cwd, binPath } = {}) {
  const promptText = String(prompt || "");
  const promptBytes = Buffer.byteLength(promptText);
  const promptByteLimit = getAntigravityPromptByteLimit(binPath);
  if (promptBytes > promptByteLimit) {
    throw new Error(`Antigravity prompt is too large for safe command-line delivery (${promptBytes} bytes; maximum ${promptByteLimit})`);
  }
  const args = [`--print=${promptText}`, "--print-timeout", DEFAULT_PRINT_TIMEOUT];
  if (String(model || "").trim()) args.push("--model", String(model).trim());
  if (String(cwd || "").trim()) args.push("--add-dir", String(cwd).trim());

  const mode = String(permissionMode || "confirm").toLowerCase();
  if (mode === "auto") {
    args.push("--dangerously-skip-permissions");
  } else {
    // Headless Agy cannot show native permission prompts. Keep its own tools in
    // read-only plan+sandbox mode; Netcatty MCP tools retain bridge approvals.
    args.push("--mode", "plan", "--sandbox");
  }
  if (
    /\.(?:cmd|bat)$/i.test(String(binPath || "").trim())
    && windowsShimCommandLength(binPath, args) > WINDOWS_CMD_SAFE_COMMAND_CHARS
  ) {
    throw new Error("Antigravity prompt contains too many Windows command-shell characters for safe delivery");
  }
  return args;
}

function createAntigravityTurnDirectory() {
  return fs.mkdtempSync(path.join(tempDirBridge.getTempDir(), "agy-turn-"));
}

function writePrivateMcpConfig(turnDirectory, injectedMcpServers) {
  const servers = {};
  for (const server of injectedMcpServers || []) {
    if (!server?.name || !server?.command) continue;
    const entry = {
      command: server.command,
      args: Array.isArray(server.args) ? server.args : [],
    };
    const env = mcpEnvPairsToObject(server.env);
    if (Object.keys(env).length > 0) entry.env = env;
    servers[server.name] = entry;
  }
  if (Object.keys(servers).length === 0) return null;
  const configDirectory = path.join(turnDirectory, ".agents");
  fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  const configPath = path.join(configDirectory, "mcp_config.json");
  fs.writeFileSync(configPath, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, { mode: 0o600 });
  return configPath;
}

function cleanupAntigravityTurnDirectory(turnDirectory) {
  if (!turnDirectory) return;
  try { fs.rmSync(turnDirectory, { recursive: true, force: true }); } catch {}
}

function appendBounded(current, chunk, maxBytes = MAX_OUTPUT_BYTES) {
  const next = current + String(chunk || "");
  if (Buffer.byteLength(next) <= maxBytes) return next;
  throw new Error("Antigravity CLI output exceeded the safe capture limit");
}

function stripAnsi(value) {
  return String(value || "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function formatAntigravityCliFailure(stderr, code, signal) {
  const detail = stripAnsi(stderr).trim();
  if (/not authenticated|not signed in|sign[- ]?in|authentication required/i.test(detail)) {
    return "Antigravity is not signed in. Run `agy` in a terminal, complete Google Sign-In, then try again.";
  }
  if (detail) return detail;
  if (signal) return `Antigravity CLI stopped by ${signal}`;
  return `Antigravity CLI exited with code ${code ?? "unknown"}`;
}

async function signalAntigravityProcessTree(child, signal, deps = {}) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    try { child?.kill?.(signal); } catch {}
    return;
  }
  const platform = deps.platform || process.platform;
  if (platform === "win32") {
    const execFile = deps.execFile || defaultExecFile;
    await new Promise((resolve) => {
      try {
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
      } catch {
        try { child.kill(signal); } catch {}
        resolve();
      }
    });
    return;
  }
  const kill = deps.kill || process.kill.bind(process);
  try { kill(-pid, signal); } catch {
    try { child.kill(signal); } catch {}
  }
}

async function runAntigravityTurn(options, deps = {}) {
  const cliPath = String(options.binPath || "").trim();
  if (!cliPath) throw new Error("Antigravity CLI was not found. Install `agy` 1.1.4 or newer and reconnect it in Settings.");
  const userCwd = String(options.cwd || "").trim();
  const args = buildAntigravityCliArgs({ ...options, cwd: userCwd || undefined });
  if (options.signal?.aborted) return { sessionId: null };

  const createTurnDirectory = deps.createTurnDirectory || createAntigravityTurnDirectory;
  const writeMcpConfig = deps.writeMcpConfig || writePrivateMcpConfig;
  const cleanupTurnDirectory = deps.cleanupTurnDirectory || cleanupAntigravityTurnDirectory;
  const turnDirectory = createTurnDirectory();
  let child;
  try {
    writeMcpConfig(turnDirectory, options.injectedMcpServers || []);
    child = (deps.spawn || defaultSpawn)(cliPath, args, {
      cwd: turnDirectory,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: true,
    });
  } catch (error) {
    cleanupTurnDirectory(turnDirectory);
    throw error;
  }

  const signalProcessTree = deps.signalProcessTree
    || ((target, signal) => signalAntigravityProcessTree(target, signal, deps));
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_TURN_TIMEOUT_MS;
  const killGraceMs = Number.isFinite(deps.killGraceMs) ? deps.killGraceMs : DEFAULT_KILL_GRACE_MS;
  const maxOutputBytes = Number.isFinite(deps.maxOutputBytes) ? deps.maxOutputBytes : MAX_OUTPUT_BYTES;
  const platform = deps.platform || process.platform;
  let stdout = "";
  let stderr = "";
  let failure = null;
  let timedOut = false;
  let settled = false;
  let childClosed = false;
  let terminationPromise = null;
  let forceFinish = null;

  const terminate = () => {
    if (settled) return Promise.resolve();
    if (terminationPromise) return terminationPromise;
    // Defer the body so terminationPromise is visible if SIGTERM synchronously
    // triggers the child's close handler.
    terminationPromise = Promise.resolve().then(async () => {
      await signalProcessTree(child, "SIGTERM");
      if (settled || (platform === "win32" && childClosed)) return;
      await new Promise((resolve) => {
        setTimeout(resolve, killGraceMs);
      });
      if (settled) return;
      if (platform !== "win32" || !childClosed) {
        await signalProcessTree(child, "SIGKILL");
      }
      if (options.signal?.aborted) forceFinish?.resolve();
      else forceFinish?.reject(failure || new Error(`Antigravity CLI timed out after ${Math.ceil(timeoutMs / 1000)} seconds`));
    });
    return terminationPromise;
  };

  const capture = (kind, chunk) => {
    if (failure) return;
    try {
      if (kind === "stdout") stdout = appendBounded(stdout, chunk, maxOutputBytes);
      else stderr = appendBounded(stderr, chunk, maxOutputBytes);
    } catch (error) {
      failure = error;
      void terminate();
    }
  };
  child.stdout?.on("data", (chunk) => capture("stdout", chunk));
  child.stderr?.on("data", (chunk) => capture("stderr", chunk));

  const abortHandler = () => { void terminate(); };
  if (options.signal?.aborted) abortHandler();
  else options.signal?.addEventListener?.("abort", abortHandler, { once: true });
  const timeoutTimer = setTimeout(() => {
    if (settled) return;
    timedOut = true;
    failure ||= new Error(`Antigravity CLI timed out after ${Math.ceil(timeoutMs / 1000)} seconds`);
    void terminate();
  }, timeoutMs);

  try {
    await new Promise((resolve, reject) => {
      forceFinish = { resolve, reject };
      child.once("error", (error) => options.signal?.aborted ? resolve() : reject(error));
      child.once("close", async (code, signal) => {
        childClosed = true;
        if (terminationPromise) await terminationPromise;
        if (options.signal?.aborted) return resolve();
        if (failure) return reject(failure);
        if (timedOut) return reject(new Error(`Antigravity CLI timed out after ${Math.ceil(timeoutMs / 1000)} seconds`));
        if (code !== 0) return reject(new Error(formatAntigravityCliFailure(stderr, code, signal)));
        if (!stdout.trim()) return reject(new Error(formatAntigravityCliFailure(stderr || "Antigravity CLI returned an empty response", code, signal)));
        resolve();
      });
    });
  } finally {
    settled = true;
    clearTimeout(timeoutTimer);
    options.signal?.removeEventListener?.("abort", abortHandler);
    try { cleanupTurnDirectory(turnDirectory); } catch {}
  }

  if (!options.signal?.aborted) {
    options.emitter.text?.(stripAnsi(stdout));
    options.emitter.emitDone?.();
  }
  return { sessionId: null };
}

async function listAntigravityModels(options = {}, deps = {}) {
  const cliPath = String(options.binPath || "").trim();
  if (!cliPath) return { currentModelId: null, models: [] };
  const child = (deps.spawn || defaultSpawn)(cliPath, ["models"], {
    env: options.env || process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: true,
  });
  let stdout = "";
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_MODEL_TIMEOUT_MS;
  const killGraceMs = Number.isFinite(deps.killGraceMs) ? deps.killGraceMs : DEFAULT_KILL_GRACE_MS;
  const signalProcessTree = deps.signalProcessTree
    || ((target, signal) => signalAntigravityProcessTree(target, signal, deps));
  const platform = deps.platform || process.platform;
  await new Promise((resolve, reject) => {
    let settled = false;
    let childClosed = false;
    let timer = null;
    let terminationPromise = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener?.("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const terminate = (error = null) => {
      if (terminationPromise) return terminationPromise;
      // Publish the promise before signaling so a synchronous close waits for
      // process-group escalation instead of finishing cleanup early.
      terminationPromise = Promise.resolve().then(async () => {
        await signalProcessTree(child, "SIGTERM");
        if (platform !== "win32" || !childClosed) {
          await new Promise((done) => {
            setTimeout(done, killGraceMs);
          });
        }
        if (platform !== "win32" || !childClosed) {
          await signalProcessTree(child, "SIGKILL");
        }
        finish(error);
      });
      return terminationPromise;
    };
    const abort = () => { void terminate(); };
    child.stdout?.on("data", (chunk) => {
      if (settled) return;
      try { stdout = appendBounded(stdout, chunk, 1024 * 1024); } catch (error) {
        void terminate(error);
      }
    });
    child.once("error", (error) => finish(options.signal?.aborted ? null : error));
    child.once("close", async (code) => {
      childClosed = true;
      if (terminationPromise) {
        await terminationPromise;
        return;
      }
      finish(code === 0 || options.signal?.aborted
        ? null
        : new Error(`Antigravity model discovery exited with code ${code}`));
    });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener?.("abort", abort, { once: true });
    timer = setTimeout(() => {
      void terminate(new Error("Antigravity model discovery timed out"));
    }, timeoutMs);
  });
  const seen = new Set();
  const models = stdout.split(/\r?\n/).map((line) => line.trim())
    .filter((id) => /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !seen.has(id) && seen.add(id))
    .map((id) => ({ id, name: id }));
  return { currentModelId: null, models };
}

module.exports = {
  buildAntigravityCliArgs,
  cleanupAntigravityTurnDirectory,
  createAntigravityTurnDirectory,
  formatAntigravityCliFailure,
  getAntigravityPromptByteLimit,
  listAntigravityModels,
  runAntigravityTurn,
  signalAntigravityProcessTree,
  writePrivateMcpConfig,
};
