"use strict";

/**
 * Simulated FIDO askpass verification (no hardware).
 *
 * Exercises the OpenSSH SSH_ASKPASS helper → Netcatty IPC socket → prompt
 * handler → PIN response path that real ssh-sk-helper would trigger.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const tempDirBridge = require("./tempDirBridge.cjs");
// Keep the managed temp path short: Unix domain sockets reject long sun_path.
const managedTemp = fs.mkdtempSync(path.join(path.resolve(__dirname, "../.."), "nc-fido-"));
const originalGetTempDir = tempDirBridge.getTempDir;
tempDirBridge.getTempDir = () => managedTemp;
const {
  buildFidoAskpassEnv,
  ensureFidoAskpass,
  shutdownFidoAskpass,
  setResolveWebContentsForTests,
} = require("./fidoAskpass.cjs");
const fidoPromptHandler = require("./fidoPromptHandler.cjs");

test.after(() => {
  tempDirBridge.getTempDir = originalGetTempDir;
  try { fs.rmSync(managedTemp, { recursive: true, force: true }); } catch { /* ignore */ }
});

function runAskpassHelper({ wrapperPath, socketPath, prompt, timeoutMs = 5000, envExtra = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(wrapperPath, [prompt], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NETCATTY_FIDO_ASKPASS_SOCK: socketPath,
        SSH_ASKPASS_REQUIRE: "force",
        ...envExtra,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("askpass helper timed out"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("simulated FIDO askpass returns PIN through helper subprocess", async () => {
  const pending = new Map();
  const sender = {
    id: 4242,
    isDestroyed: () => false,
    send(_channel, payload) {
      pending.set(payload.requestId, payload);
      // Auto-respond like the renderer FidoPromptModal would.
      queueMicrotask(() => {
        fidoPromptHandler.handleResponse(
          { sender: { id: 4242 } },
          { requestId: payload.requestId, response: "sim-pin-1234", cancelled: false },
        );
      });
    },
  };

  setResolveWebContentsForTests(() => sender);
  try {
    const env = buildFidoAskpassEnv({ resolveWebContents: () => sender });
    const artifacts = ensureFidoAskpass({ resolveWebContents: () => sender });
    assert.equal(artifacts.socketPath, env.NETCATTY_FIDO_ASKPASS_SOCK);
    assert.ok(env.NETCATTY_FIDO_ASKPASS_LEASE);

    // Give the listen() a tick — Node can accept before the event loop settles.
    await new Promise((r) => setTimeout(r, 50));

    const result = await runAskpassHelper({
      wrapperPath: artifacts.wrapperPath,
      socketPath: artifacts.socketPath,
      prompt: "Enter PIN for authenticator:",
      envExtra: { NETCATTY_FIDO_ASKPASS_LEASE: env.NETCATTY_FIDO_ASKPASS_LEASE },
    });

    assert.equal(result.code, 0, `stderr=${result.stderr}`);
    assert.equal(result.stdout.trim(), "sim-pin-1234");
    assert.ok(pending.size >= 1, "expected a prompt request to be delivered");
    const delivered = [...pending.values()][0];
    assert.equal(delivered.kind, "pin");
  } finally {
    setResolveWebContentsForTests(null);
    shutdownFidoAskpass();
  }
});

test("askpass leases route prompts to the originating resolver", async () => {
  const seen = [];
  const senderA = {
    id: 100,
    isDestroyed: () => false,
    send(_channel, payload) {
      seen.push(100);
      queueMicrotask(() => {
        fidoPromptHandler.handleResponse(
          { sender: { id: 100 } },
          { requestId: payload.requestId, response: "pin-a", cancelled: false },
        );
      });
    },
  };
  const senderB = {
    id: 200,
    isDestroyed: () => false,
    send(_channel, payload) {
      seen.push(200);
      queueMicrotask(() => {
        fidoPromptHandler.handleResponse(
          { sender: { id: 200 } },
          { requestId: payload.requestId, response: "pin-b", cancelled: false },
        );
      });
    },
  };

  // Last global resolver would be B; lease must still deliver to A.
  setResolveWebContentsForTests(() => senderB);
  try {
    const envA = buildFidoAskpassEnv({ resolveWebContents: () => senderA });
    buildFidoAskpassEnv({ resolveWebContents: () => senderB });
    const artifacts = ensureFidoAskpass();
    await new Promise((r) => setTimeout(r, 50));

    const result = await runAskpassHelper({
      wrapperPath: artifacts.wrapperPath,
      socketPath: artifacts.socketPath,
      prompt: "Enter PIN for authenticator:",
      // Override lease to A's env lease id.
      envExtra: {
        NETCATTY_FIDO_ASKPASS_LEASE: envA.NETCATTY_FIDO_ASKPASS_LEASE,
      },
    });
    assert.equal(result.code, 0, `stderr=${result.stderr}`);
    assert.equal(result.stdout.trim(), "pin-a");
    assert.deepEqual(seen, [100]);
  } finally {
    setResolveWebContentsForTests(null);
    shutdownFidoAskpass();
  }
});

test("simulated FIDO askpass touch prompt returns empty confirmation", async () => {
  const sender = {
    id: 4243,
    isDestroyed: () => false,
    send(_channel, payload) {
      queueMicrotask(() => {
        fidoPromptHandler.handleResponse(
          { sender: { id: 4243 } },
          { requestId: payload.requestId, response: "", cancelled: false },
        );
      });
    },
  };

  setResolveWebContentsForTests(() => sender);
  try {
    const env = buildFidoAskpassEnv({ resolveWebContents: () => sender });
    const artifacts = ensureFidoAskpass({ resolveWebContents: () => sender });
    await new Promise((r) => setTimeout(r, 50));

    const result = await runAskpassHelper({
      wrapperPath: artifacts.wrapperPath,
      socketPath: artifacts.socketPath,
      prompt: "Confirm user presence for key ED25519-SK",
      envExtra: { NETCATTY_FIDO_ASKPASS_LEASE: env.NETCATTY_FIDO_ASKPASS_LEASE },
    });

    assert.equal(result.code, 0, `stderr=${result.stderr}`);
    assert.equal(result.stdout.trim(), "");
  } finally {
    setResolveWebContentsForTests(null);
    shutdownFidoAskpass();
  }
});

test("leaseless agent prompts route to the last leased signing window", async () => {
  const seen = [];
  const senderA = {
    id: 501,
    isDestroyed: () => false,
    send(_channel, payload) {
      seen.push(501);
      queueMicrotask(() => {
        fidoPromptHandler.handleResponse(
          { sender: { id: 501 } },
          { requestId: payload.requestId, response: "pin-a", cancelled: false },
        );
      });
    },
  };
  const senderB = {
    id: 502,
    isDestroyed: () => false,
    send(_channel, payload) {
      seen.push(502);
      queueMicrotask(() => {
        fidoPromptHandler.handleResponse(
          { sender: { id: 502 } },
          { requestId: payload.requestId, response: "pin-b", cancelled: false },
        );
      });
    },
  };

  // Global / last-acquire resolver is B (terminal-worker has no BrowserWindow).
  setResolveWebContentsForTests(() => senderB);
  try {
    const envA = buildFidoAskpassEnv({ resolveWebContents: () => senderA });
    buildFidoAskpassEnv({ resolveWebContents: () => senderB });
    const artifacts = ensureFidoAskpass();
    await new Promise((r) => setTimeout(r, 50));

    // First: leased ssh-add prompt binds the active signing window to A.
    const leased = await runAskpassHelper({
      wrapperPath: artifacts.wrapperPath,
      socketPath: artifacts.socketPath,
      prompt: "Enter PIN for authenticator:",
      envExtra: { NETCATTY_FIDO_ASKPASS_LEASE: envA.NETCATTY_FIDO_ASKPASS_LEASE },
    });
    assert.equal(leased.code, 0, `stderr=${leased.stderr}`);
    assert.equal(leased.stdout.trim(), "pin-a");

    // Then: agent-spawned ssh-sk-helper has no lease; must still reach A, not B.
    const leaseless = await runAskpassHelper({
      wrapperPath: artifacts.wrapperPath,
      socketPath: artifacts.socketPath,
      prompt: "Enter PIN for authenticator:",
      envExtra: { NETCATTY_FIDO_ASKPASS_LEASE: "" },
    });
    assert.equal(leaseless.code, 0, `stderr=${leaseless.stderr}`);
    assert.equal(leaseless.stdout.trim(), "pin-a");
    assert.deepEqual(seen, [501, 501]);
  } finally {
    setResolveWebContentsForTests(null);
    shutdownFidoAskpass();
  }
});
