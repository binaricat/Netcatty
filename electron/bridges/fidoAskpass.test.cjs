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
