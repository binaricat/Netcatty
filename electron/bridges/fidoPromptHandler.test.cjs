"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyAskpassPrompt,
  requestFidoPrompt,
  cancelFidoPromptRequestsForLease,
  handleResponse,
  getRequests,
} = require("./fidoPromptHandler.cjs");

test("classifyAskpassPrompt maps OpenSSH sk-helper prompts", () => {
  assert.equal(classifyAskpassPrompt("Enter PIN for authenticator:"), "pin");
  assert.equal(classifyAskpassPrompt("Confirm user presence for key ED25519-SK"), "touch");
  assert.equal(classifyAskpassPrompt("Touch your security key"), "touch");
  assert.equal(classifyAskpassPrompt("请触摸你的安全密钥"), "touch");
  assert.equal(classifyAskpassPrompt("Something unknown"), "pin");
});

test("requestFidoPrompt delivers IPC payload and resolves on respond", async () => {
  const sent = [];
  const sender = {
    id: 42,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };

  const pending = requestFidoPrompt(sender, {
    kind: "pin",
    message: "Enter PIN for authenticator:",
    keyName: "yubi",
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "netcatty:fido-prompt-request");
  assert.equal(sent[0].payload.kind, "pin");
  assert.equal(getRequests().size, 1);

  const requestId = sent[0].payload.requestId;
  const result = handleResponse(
    { sender: { id: 42 } },
    { requestId, response: "123456", cancelled: false },
  );
  assert.equal(result.success, true);

  const resolved = await pending;
  assert.deepEqual(resolved, { response: "123456" });
  assert.equal(getRequests().size, 0);
});

test("requestFidoPrompt cancel path", async () => {
  const sent = [];
  const sender = {
    id: 7,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  const pending = requestFidoPrompt(sender, { kind: "touch", message: "Touch key" });
  const requestId = sent[0].payload.requestId;
  handleResponse({ sender: { id: 7 } }, { requestId, cancelled: true });
  const resolved = await pending;
  assert.deepEqual(resolved, { cancelled: true });
});

test("cancelFidoPromptRequestsForLease settles owned prompts and notifies renderer", async () => {
  const sent = [];
  const sender = {
    id: 11,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  const pending = requestFidoPrompt(sender, {
    kind: "pin",
    message: "Enter PIN",
    leaseId: "lease-abc",
  });
  const other = requestFidoPrompt(sender, {
    kind: "touch",
    message: "Touch key",
    leaseId: "lease-other",
  });
  const otherRequestId = sent.find((entry) => (
    entry.channel === "netcatty:fido-prompt-request" && entry.payload.kind === "touch"
  )).payload.requestId;

  assert.equal(cancelFidoPromptRequestsForLease("lease-abc", "lease-released"), 1);
  assert.deepEqual(await pending, { cancelled: true });
  assert.equal(getRequests().size, 1);
  assert.ok(sent.some((entry) => (
    entry.channel === "netcatty:fido-prompt-cancelled"
    && entry.payload.reason === "lease-released"
  )));

  handleResponse({ sender: { id: 11 } }, { requestId: otherRequestId, cancelled: true });
  await other;
});
