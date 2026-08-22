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

const payload = JSON.stringify({ prompt, type: "askpass", leaseId }) + "\n";
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
  return path.join(baseDir, "askpass.sock");
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
  const fromLastLease = liveSenderFromResolver(lastLeasedSigningResolver);
  if (fromLastLease) return fromLastLease;

  for (const resolver of askpassLeases.values()) {
    const sender = liveSenderFromResolver(resolver);
    if (sender) return sender;
  }

  return defaultResolveWebContents()
    || liveSenderFromResolver(resolveWebContents);
}

function handleAskpassClient(socket) {
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", async (chunk) => {
    buf += chunk;
    const nl = buf.indexOf("\n");
    if (nl === -1) return;
    let msg;
    try {
      msg = JSON.parse(buf.slice(0, nl));
    } catch {
      socket.end(`${JSON.stringify({ ok: false, error: "bad_json" })}\n`);
      return;
    }
    const prompt = String(msg?.prompt || "");
    const kind = fidoPromptHandler.classifyAskpassPrompt(prompt);
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
      ownerLeaseId = lastLeasedSigningLeaseId || "";
    }
    if (!sender) {
      socket.end(`${JSON.stringify({ ok: false, error: "no_window" })}\n`);
      return;
    }
    try {
      const result = await fidoPromptHandler.requestFidoPrompt(sender, {
        kind,
        message: prompt,
        keyName: "FIDO2",
        leaseId: ownerLeaseId,
      });
      if (!result || result.cancelled) {
        socket.end(`${JSON.stringify({ ok: false, error: "cancelled" })}\n`);
        return;
      }
      // Touch/confirm: empty string is fine; PIN: return entered secret.
      const response = kind === "pin" ? (result.response || "") : "";
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

  if (process.platform === "win32") {
    askpassWrapperPath = path.join(base, "netcatty-fido-askpass.cmd");
    writeSecureFile(
      askpassWrapperPath,
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath.replace(/"/g, '""')}" "${askpassScriptPath.replace(/"/g, '""')}" %*\r\n`,
      0o700,
    );
  } else {
    askpassWrapperPath = path.join(base, "netcatty-fido-askpass.sh");
    const electronExec = JSON.stringify(process.execPath);
    const scriptExec = JSON.stringify(askpassScriptPath);
    writeSecureFile(
      askpassWrapperPath,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${electronExec} ${scriptExec} "$@"\n`,
      0o700,
    );
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

/**
 * Environment for ssh-agent / ssh-add / ssh-keygen so PIN/touch use Netcatty UI.
 * @param {{ resolveWebContents?: () => import("electron").WebContents|null }} [options]
 */
function buildFidoAskpassEnv(options = {}) {
  const artifacts = ensureFidoAskpass(options);
  const leaseId = randomUUID().slice(0, 12);
  if (typeof options.resolveWebContents === "function") {
    askpassLeases.set(leaseId, options.resolveWebContents);
  }
  const env = {
    SSH_ASKPASS: artifacts.wrapperPath,
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
  releaseFidoAskpassLease,
  shutdownFidoAskpass,
  classifyAskpassPrompt: fidoPromptHandler.classifyAskpassPrompt,
  resolveFidoAskpassSocketPath,
  isWindowsNamedPipePath,
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
