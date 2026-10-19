"use strict";

/**
 * SSH_ASKPASS bridge for FIDO2 (ssh-keygen / ssh-add / ssh-sk-helper).
 *
 * OpenSSH invokes SSH_ASKPASS as a subprocess with the prompt text as argv.
 * The helper connects to a Netcatty-owned IPC socket; main process shows a
 * native PIN/touch modal and returns the response on stdout of the helper.
 */

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const fidoPromptHandler = require("./fidoPromptHandler.cjs");

const FIDO_ASKPASS_SCRIPT = String.raw`#!/usr/bin/env node
"use strict";
const net = require("node:net");
const fs = require("node:fs");

const sockPath = process.env.NETCATTY_FIDO_ASKPASS_SOCK;
const leaseId = process.env.NETCATTY_FIDO_ASKPASS_LEASE || "";
const prompt = process.argv.slice(2).join(" ") || process.env.SSH_ASKPASS_PROMPT || "";

function fail(code) {
  process.exit(code == null ? 1 : code);
}

if (!sockPath) fail(1);

const payload = JSON.stringify({ prompt, type: "askpass", leaseId,
  mode: process.env.SSH_ASKPASS_PROMPT || "" }) + "\n";
const client = net.createConnection(sockPath);

let buf = "";
let settled = false;

function finish(ok, text) {
  if (settled) return;
  settled = true;
  try { client.end(); } catch { /* ignore */ }
  if (!ok) fail(1);
  process.stdout.write(text == null ? "" : String(text));
  process.stdout.write("\n");
  process.exit(0);
}

client.setEncoding("utf8");
client.on("connect", () => {
  client.write(payload);
});
client.on("data", (chunk) => {
  buf += chunk;
  const nl = buf.indexOf("\n");
  if (nl === -1) return;
  let msg;
  try {
    msg = JSON.parse(buf.slice(0, nl));
  } catch {
    finish(false);
    return;
  }
  if (msg && msg.ok === true) finish(true, msg.response || "");
  else finish(false);
});
client.on("error", () => finish(false));
client.on("end", () => {
  if (!settled) finish(false);
});
setTimeout(() => finish(false), 170000);
`;

/** @type {net.Server|null} */
let askpassServer = null;
/** @type {string|null} */
let askpassSocketPath = null;
/** @type {string|null} */
let askpassScriptPath = null;
/** @type {string|null} */
let askpassWrapperPath = null;
/** @type {(() => import("electron").WebContents|null)|null} */
let resolveWebContents = null;
/** @type {Map<string, () => import("electron").WebContents|null>} */
const askpassLeases = new Map();
/**
 * Last resolver that successfully handled a caller-bound (leased) askpass
 * prompt. Agent-spawned ssh-sk-helper has no lease after we strip the starter
 * lease from the shared agent env; route those prompts to this signing window
 * instead of the sticky last-acquire global resolver (wrong under multi-window
 * / terminal-worker where BrowserWindow focus is unavailable).
 * @type {(() => import("electron").WebContents|null)|null}
 */
let lastLeasedSigningResolver = null;
/** @type {string|null} Lease id that last marked lastLeasedSigningResolver. */
let lastLeasedSigningLeaseId = null;
let activeSigningLeaseId = null;
const signingQueue = [];
let helperTimeoutMs = 30000;

function setHelperTimeoutForTests(value) {
  if (value != null && (!Number.isFinite(value) || value <= 0)) throw new Error("Invalid FIDO helper timeout");
  helperTimeoutMs = value == null ? 30000 : value;
}

function observeSkHelper(socket, entry, initial = "") {
  if (!entry) { socket.end('{"ack":true}\n'); return; }
  if (entry.controller.signal.aborted) { socket.end('{"cancel":true}\n'); return; }
  let buffer = initial;
  const timer = setTimeout(() => {
    entry.timedOut = true;
    if (!socket.destroyed) socket.write('{"cancel":true}\n');
  }, helperTimeoutMs);
  const cancelHelper = () => {
    if (!socket.destroyed) socket.write('{"cancel":true}\n');
  };
  const onAbort = cancelHelper;
  entry.controller.signal.addEventListener("abort", onAbort, { once: true });
  const consume = chunk => {
    buffer += chunk;
    const nl = buffer.indexOf("\n");
    if (nl === -1) return;
    let result;
    try { result = JSON.parse(buffer.slice(0, nl)); } catch { socket.destroy(); return; }
    if (result.phase !== "result") return;
    clearTimeout(timer);
    entry.helperError = Number.isInteger(result.errorCode) ? result.errorCode : null;
    socket.end('{"ack":true}\n');
  };
  socket.on("data", consume);
  socket.once("close", () => {
    clearTimeout(timer);
    entry.controller.signal.removeEventListener("abort", onAbort);
  });
  if (buffer) consume("");
}

// A shared OpenSSH agent cannot pass a per-request lease to its helper.
// Serialize hardware signatures and bind each prompt to its calling window
// until that signature's callback settles.
function runWithFidoSigningLease(leaseId, operation) {
  signingQueue.push({ leaseId, operation, controller: new AbortController() });
  if (signingQueue.length > 1) return;
  const next = () => {
    const entry = signingQueue[0];
    if (!entry) return;
    activeSigningLeaseId = entry.leaseId;
    let finished = false;
    entry.operation(() => {
      if (finished) return;
      finished = true;
      entry.attemptController?.abort();
      entry.controller.abort();
      activeSigningLeaseId = null;
      signingQueue.shift();
      if (signingQueue.length) queueMicrotask(next);
    }, entry);
  };
  next();
}

function getTempBase() {
  const tempDirBridge = require("./tempDirBridge.cjs");
  if (typeof tempDirBridge.getTempDir !== "function") {
    throw new Error("FIDO askpass requires Netcatty temp directory (tempDirBridge unavailable).");
  }
  return tempDirBridge.getTempDir();
}

function isWindowsNamedPipePath(socketPath) {
  return typeof socketPath === "string"
    && /^\\\\[.,]\\pipe\\/i.test(socketPath);
}

/**
 * Askpass IPC address. Windows Node `net.Server` only binds named pipes under
 * `\\.\pipe\...` — a filesystem `askpass.sock` path fails to listen.
 * @param {string} baseDir
 * @param {NodeJS.Platform} [platform]
 */
function resolveFidoAskpassSocketPath(baseDir, platform = process.platform) {
  if (platform === "win32") {
    return `\\\\.\\pipe\\netcatty-fido-askpass-${randomUUID().slice(0, 8)}`;
  }
  return path.posix.join(baseDir, "askpass.sock");
}

function writeSecureFile(filePath, contents, mode = 0o700) {
  fs.writeFileSync(filePath, contents, { mode });
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Windows may ignore mode
  }
}

function defaultResolveWebContents() {
  try {
    const { BrowserWindow } = require("electron");
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed()) return focused.webContents;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        return win.webContents;
      }
    }
  } catch {
    // not in electron
  }
  return null;
}

function liveSenderFromResolver(resolver) {
  if (typeof resolver !== "function") return null;
  try {
    const sender = resolver();
    if (sender && !sender.isDestroyed?.()) return sender;
  } catch {
    // ignore dead resolvers
  }
  return null;
}

/**
 * Resolve the WebContents for agent-spawned (leaseless) askpass prompts.
 * Prefer the window that most recently completed a leased signing prompt, then
 * focus / any open window, then the sticky global fallback.
 */
function resolveSharedAgentPromptSender() {
  // An active but released/dead caller must not fall through to another window.
  if (activeSigningLeaseId) {
    return liveSenderFromResolver(askpassLeases.get(activeSigningLeaseId));
  }
  const fromLastLease = liveSenderFromResolver(lastLeasedSigningResolver);
  if (fromLastLease) return fromLastLease;

  for (const resolver of askpassLeases.values()) {
    const sender = liveSenderFromResolver(resolver);
    if (sender) return sender;
  }

  return defaultResolveWebContents()
    || liveSenderFromResolver(resolveWebContents);
}

function handleAskpassClient(socket, platform = process.platform) {
  let buf = "";
  let handled = false;
  const controller = new AbortController();
  // OpenSSH kills its notification helper as soon as the token is touched.
  // Dismiss that prompt even when the renderer has not clicked Continue.
  socket.once("close", () => controller.abort());
  socket.on("error", () => controller.abort());
  socket.setEncoding("utf8");
  socket.on("data", async (chunk) => {
    if (handled) return;
    buf += chunk;
    const nl = buf.indexOf("\n");
    if (nl === -1) return;
    handled = true;
    let msg;
    try {
      msg = JSON.parse(buf.slice(0, nl));
    } catch {
      socket.end(`${JSON.stringify({ ok: false, error: "bad_json" })}\n`);
      return;
    }
    if (msg?.type === "sk-helper") {
      observeSkHelper(socket, signingQueue[0], buf.slice(nl + 1));
      return;
    }
    const prompt = String(msg?.prompt || "");
    // OpenSSH notify_start() uses mode=none: hardware completion, not a UI
    // answer, authorizes the signature. Exiting this helper only hides the hint.
    const notificationOnly = msg?.mode === "none";
    const kind = notificationOnly ? "touch"
      : msg?.mode === "confirm" ? "confirm"
      : fidoPromptHandler.classifyAskpassPrompt(prompt);
    const leaseId = typeof msg?.leaseId === "string" ? msg.leaseId : "";
    const leaseResolver = leaseId ? askpassLeases.get(leaseId) : null;
    // Caller-bound leases (ssh-add) win and mark the active signing window.
    // Agent-spawned ssh-sk-helper has no lease (shared agent must not inherit a
    // starter lease) — route to that signing window, not the last acquire.
    // Tag leaseless prompts with the last signing lease so teardown can cancel.
    let sender = null;
    /** @type {string} */
    let ownerLeaseId = "";
    if (leaseResolver) {
      sender = liveSenderFromResolver(leaseResolver);
      if (sender) {
        lastLeasedSigningResolver = leaseResolver;
        lastLeasedSigningLeaseId = leaseId;
        ownerLeaseId = leaseId;
      }
    } else {
      sender = resolveSharedAgentPromptSender();
      ownerLeaseId = activeSigningLeaseId || lastLeasedSigningLeaseId || "";
    }
    if (!sender) {
      socket.end(`${JSON.stringify({ ok: false, error: "no_window" })}\n`);
      return;
    }
    const signing = signingQueue[0]?.leaseId === ownerLeaseId ? signingQueue[0] : null;
    try {
      const detachedNotification = notificationOnly && platform === "win32";
      if (kind === "pin" && platform === "win32") {
        fidoPromptHandler.cancelFidoPromptRequestsForLease(ownerLeaseId, "pin-requested", true);
      }
      const pending = fidoPromptHandler.requestFidoPrompt(sender, {
        kind,
        notificationOnly,
        message: prompt,
        keyName: signing?.keyName || "",
        leaseId: ownerLeaseId,
        signal: detachedNotification
          ? (signing?.attemptController || signing?.controller)?.signal : controller.signal,
      });
      if (detachedNotification) {
        // MSYS cannot reliably terminate a native Node notification helper.
        // Acknowledge this non-authorizing notification immediately; retain the
        // hint under the signing attempt (or key-generation lease) instead.
        void pending;
        socket.end('{"ok":true,"response":""}\n');
        return;
      }
      const result = await pending;
      if (socket.destroyed) return;
      if (!result || result.cancelled) {
        if (kind === "pin" && signing) signing.cancelled = true;
        socket.end(`${JSON.stringify({ ok: false, error: "cancelled" })}\n`);
        return;
      }
      // Touch/confirm: empty string is fine; PIN: return entered secret.
      const response = kind === "pin" ? (result.response || "") : "";
      if (kind === "pin" && signing) signing.pinSubmitted = true;
      if (kind === "pin" && response
          && (platform === "win32" || /user presence|touch|tap/i.test(prompt))
          && ((signing?.leaseId === ownerLeaseId && !signing.controller.signal.aborted)
            || (platform === "win32" && ownerLeaseId))) {
        // ssh-agent ends its initial notification before asking for a PIN and
        // does not restart it on retry. Keep a device-only waiting hint visible
        // after PIN submission until the actual signature callback completes.
        void fidoPromptHandler.requestFidoPrompt(sender, {
          kind: "touch", notificationOnly: true, message: prompt, keyName: signing?.keyName || "",
          leaseId: ownerLeaseId, signal: (signing?.attemptController || signing?.controller)?.signal,
        });
      }
      socket.end(`${JSON.stringify({ ok: true, response })}\n`);
    } catch (err) {
      socket.end(`${JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })}\n`);
    }
  });
}

/**
 * Ensure askpass server + helper scripts exist.
 * @param {{ resolveWebContents?: () => import("electron").WebContents|null }} [options]
 */
function ensureFidoAskpass(options = {}) {
  if (options.resolveWebContents) resolveWebContents = options.resolveWebContents;

  if (askpassServer && askpassSocketPath && askpassWrapperPath) {
    return {
      socketPath: askpassSocketPath,
      scriptPath: askpassScriptPath,
      wrapperPath: askpassWrapperPath,
    };
  }

  const base = path.join(getTempBase(), `netcatty-fido-askpass-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  askpassSocketPath = resolveFidoAskpassSocketPath(base);
  askpassScriptPath = path.join(base, "netcatty-fido-askpass.cjs");
  writeSecureFile(askpassScriptPath, FIDO_ASKPASS_SCRIPT, 0o700);

  const posixWrapperPath = path.join(base, "netcatty-fido-askpass.sh");
  const shellQuote = value => `'${value.replace(/'/g, "'\\''")}'`;
  const shellPath = value => process.platform === "win32" ? value.replace(/\\/g, "/") : value;
  writeSecureFile(posixWrapperPath,
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(shellPath(process.execPath))} ${shellQuote(shellPath(askpassScriptPath))} "$@"\n`,
    0o700);
  if (process.platform === "win32") {
    askpassWrapperPath = path.join(base, "netcatty-fido-askpass.cmd");
    writeSecureFile(
      askpassWrapperPath,
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath.replace(/"/g, '""')}" "${askpassScriptPath.replace(/"/g, '""')}" %*\r\n`,
      0o700,
    );
  } else {
    askpassWrapperPath = posixWrapperPath;
  }

  if (!isWindowsNamedPipePath(askpassSocketPath) && fs.existsSync(askpassSocketPath)) {
    try { fs.unlinkSync(askpassSocketPath); } catch { /* ignore */ }
  }

  askpassServer = net.createServer(handleAskpassClient);
  askpassServer.on("error", (err) => {
    console.error("[FidoAskpass] server error:", err instanceof Error ? err.message : err);
  });
  askpassServer.listen(askpassSocketPath);
  if (!isWindowsNamedPipePath(askpassSocketPath)) {
    try {
      fs.chmodSync(askpassSocketPath, 0o600);
    } catch {
      // ignore
    }
  }

  return {
    socketPath: askpassSocketPath,
    scriptPath: askpassScriptPath,
    wrapperPath: askpassWrapperPath,
  };
}

function isWindowsPosixSsh(binaryPath, platform = process.platform, env = process.env, exists = fs.existsSync) {
  if (platform !== "win32" || !binaryPath) return false;
  const binary = /\.exe$/i.test(binaryPath) ? binaryPath : `${binaryPath}.exe`;
  const candidates = /[\\/]/.test(binaryPath) ? [binary]
    : (env.PATH || env.Path || "").split(";").map(dir => path.win32.join(dir, binary));
  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
    const dir = path.win32.dirname(candidate);
    if (exists(path.win32.join(dir, "msys-2.0.dll")) || exists(path.win32.join(dir, "cygwin1.dll"))) {
      return true;
    }
    break;
  }
  return false;
}

function selectFidoAskpassWrapper(wrapperPath, binaryPath, platform = process.platform, env = process.env, exists = fs.existsSync) {
  // MSYS uses its own shell/shebang execution so spaces in helper paths survive.
  return isWindowsPosixSsh(binaryPath, platform, env, exists)
    ? wrapperPath.replace(/\.cmd$/i, ".sh").replace(/\\/g, "/") : wrapperPath;
}

/**
 * Environment for ssh-agent / ssh-add / ssh-keygen so PIN/touch use Netcatty UI.
 * @param {{ resolveWebContents?: () => import("electron").WebContents|null, sshBinaryPath?: string, env?: NodeJS.ProcessEnv }} [options]
 */
function buildFidoAskpassEnv(options = {}) {
  const artifacts = ensureFidoAskpass(options);
  const leaseId = randomUUID().slice(0, 12);
  if (typeof options.resolveWebContents === "function") {
    askpassLeases.set(leaseId, options.resolveWebContents);
  }
  const env = {
    SSH_ASKPASS: selectFidoAskpassWrapper(artifacts.wrapperPath, options.sshBinaryPath, process.platform, options.env),
    SSH_ASKPASS_REQUIRE: "force",
    NETCATTY_FIDO_ASKPASS_SOCK: artifacts.socketPath,
    NETCATTY_FIDO_ASKPASS_LEASE: leaseId,
    // OpenSSH only runs askpass when no TTY unless REQUIRE=force; still set DISPLAY on Linux.
    ...(process.platform === "linux" && !process.env.DISPLAY
      ? { DISPLAY: process.env.DISPLAY || ":0" }
      : {}),
  };
  return env;
}

function releaseFidoAskpassLease(leaseId) {
  if (typeof leaseId !== "string" || !leaseId) return;
  const released = askpassLeases.get(leaseId);
  askpassLeases.delete(leaseId);
  for (const entry of signingQueue) {
    if (entry.leaseId === leaseId) entry.controller.abort();
  }
  try {
    fidoPromptHandler.cancelFidoPromptRequestsForLease(leaseId, "lease-released");
  } catch {
    // ignore
  }
  if (released && lastLeasedSigningResolver === released) {
    lastLeasedSigningResolver = null;
    lastLeasedSigningLeaseId = null;
    for (const [otherLeaseId, resolver] of askpassLeases.entries()) {
      if (liveSenderFromResolver(resolver)) {
        lastLeasedSigningResolver = resolver;
        lastLeasedSigningLeaseId = otherLeaseId;
        break;
      }
    }
  } else if (lastLeasedSigningLeaseId === leaseId) {
    lastLeasedSigningLeaseId = null;
  }
}

function shutdownFidoAskpass() {
  try {
    askpassServer?.close();
  } catch {
    // ignore
  }
  askpassServer = null;
  askpassSocketPath = null;
  askpassScriptPath = null;
  askpassWrapperPath = null;
  const outstandingLeaseIds = [...askpassLeases.keys()];
  askpassLeases.clear();
  lastLeasedSigningResolver = null;
  lastLeasedSigningLeaseId = null;
  for (const leaseId of outstandingLeaseIds) {
    try {
      fidoPromptHandler.cancelFidoPromptRequestsForLease(leaseId, "askpass-shutdown");
    } catch {
      // ignore
    }
  }
}

module.exports = {
  ensureFidoAskpass,
  buildFidoAskpassEnv,
  runWithFidoSigningLease,
  setHelperTimeoutForTests,
  releaseFidoAskpassLease,
  shutdownFidoAskpass,
  classifyAskpassPrompt: fidoPromptHandler.classifyAskpassPrompt,
  resolveFidoAskpassSocketPath,
  isWindowsNamedPipePath,
  selectFidoAskpassWrapper,
  isWindowsPosixSsh,
  // exposed for tests
  getTempBase,
  handleAskpassClient,
  FIDO_ASKPASS_SCRIPT,
  setResolveWebContentsForTests(resolver) {
    resolveWebContents = typeof resolver === "function" ? resolver : null;
  },
  getAskpassLeaseCountForTests() {
    return askpassLeases.size;
  },
};
