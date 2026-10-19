"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyAskpassPrompt,
  buildFidoAskpassEnv,
  ensureFidoAskpass,
  releaseFidoAskpassLease,
  shutdownFidoAskpass,
  getTempBase,
} = require("./fidoAskpass.cjs");
const fidoPromptHandler = require("./fidoPromptHandler.cjs");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");

test("buildFidoAskpassEnv creates helper artifacts", () => {
  const env = buildFidoAskpassEnv();
  assert.ok(env.SSH_ASKPASS);
  assert.equal(env.SSH_ASKPASS_REQUIRE, "force");
  assert.ok(env.NETCATTY_FIDO_ASKPASS_SOCK);
  assert.ok(fs.existsSync(env.SSH_ASKPASS));
  const artifacts = ensureFidoAskpass();
  assert.equal(artifacts.wrapperPath, env.SSH_ASKPASS);
  shutdownFidoAskpass();
});

test("getTempBase uses Netcatty managed temp dir (no os.tmpdir fallback)", () => {
  const tempDirBridge = require("./tempDirBridge.cjs");
  const managed = tempDirBridge.getTempDir();
  assert.equal(getTempBase(), managed);
  assert.match(managed, /Netcatty/i);
});

test("classifyAskpassPrompt re-export works", () => {
  assert.equal(classifyAskpassPrompt("Enter PIN for authenticator"), "pin");
  assert.equal(classifyAskpassPrompt("Confirm user presence"), "touch");
});

test("releaseFidoAskpassLease cancels outstanding FIDO prompts for that lease", async () => {
  const sent = [];
  const sender = {
    id: 77,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  const leaseId = "lease-release-cancel-test";
  const pending = fidoPromptHandler.requestFidoPrompt(sender, {
    kind: "pin",
    message: "Enter PIN",
    leaseId,
  });
  releaseFidoAskpassLease(leaseId);
  assert.deepEqual(await pending, { cancelled: true });
  assert.equal(fidoPromptHandler.getRequests().size, 0);
  assert.ok(sent.some((entry) => entry.channel === "netcatty:fido-prompt-cancelled"));
});

test("Windows notification helpers exit immediately while hints follow PIN and lease ownership", async () => {
  class Socket extends EventEmitter {
    setEncoding() {}
    end(data) { this.reply = JSON.parse(data); this.emit("close"); }
  }
  const sender = { id: 2823, isDestroyed: () => false, send() {} };
  const env = buildFidoAskpassEnv({ resolveWebContents: () => sender });
  const leaseId = env.NETCATTY_FIDO_ASKPASS_LEASE;
  const { handleAskpassClient } = require("./fidoAskpass.cjs");
  try {
    const notification = new Socket();
    handleAskpassClient(notification, "win32");
    notification.emit("data", `${JSON.stringify({ mode: "none", leaseId, prompt: "Touch security key" })}\n`);
    assert.equal(notification.reply.ok, true, "native helper must not block device-failure replies");
    assert.equal(fidoPromptHandler.getRequests().size, 1, "helper exit must not dismiss the independent hint");
    const pin = new Socket();
    handleAskpassClient(pin, "win32");
    pin.emit("data", `${JSON.stringify({ leaseId, prompt: "Enter PIN for authenticator:" })}\n`);
    const requests = [...fidoPromptHandler.getRequests()];
    assert.equal(requests.length, 1, "a stale touch hint must not block PIN input");
    assert.equal(requests[0][1].kind, "pin");
    fidoPromptHandler.handleResponse({ sender }, { requestId: requests[0][0], response: "fixture-pin" });
    await new Promise(setImmediate);
    assert.equal(pin.reply.response, "fixture-pin");
    const hints = [...fidoPromptHandler.getRequests().values()];
    assert.equal(hints.length, 1);
    assert.equal(hints[0].kind, "touch");
    releaseFidoAskpassLease(leaseId);
    assert.equal(fidoPromptHandler.getRequests().size, 0);
  } finally { releaseFidoAskpassLease(leaseId); shutdownFidoAskpass(); }
});
