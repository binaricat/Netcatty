"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { signWithRecovery } = require("./fidoSignFlow.cjs");
const prompts = require("./fidoPromptHandler.cjs");

test("a signature arriving after cancellation is never returned to SSH", async () => {
  const context = { leaseId: "cancelled-sign", controller: new AbortController() };
  const result = await signWithRecovery(context, {}, callback => {
    context.controller.abort();
    callback(null, Buffer.from("late signature"));
  });
  assert.equal(result.error.code, "ERR_FIDO_CANCELLED");
  assert.equal(result.signature, undefined);
});

test("a device result after the deadline requires recovery even if its signature is valid", async () => {
  const context = { leaseId: "late-sign", controller: new AbortController() };
  const received = [];
  const sender = { id: 311, isDestroyed: () => false, send(channel, request) {
    if (channel !== "netcatty:fido-prompt-request") return;
    received.push(request);
    queueMicrotask(() => prompts.handleResponse({ sender }, { requestId: request.requestId, cancelled: true }));
  } };
  const result = await signWithRecovery(context, { resolveWebContents: () => sender }, callback => {
    context.timedOut = true;
    callback(null, Buffer.from("late signature"));
  });
  assert.equal(received[0].reason, "timeout");
  assert.equal(result.error.code, "ERR_FIDO_CANCELLED");
  assert.equal(result.signature, undefined);
});

test("losing the prompt window fails closed instead of choosing a saved password", async () => {
  const context = { leaseId: "missing-window", controller: new AbortController() };
  const result = await signWithRecovery(context, { password: "test-only", resolveWebContents: () => null }, callback => {
    callback(new Error("agent refused"));
  });
  assert.equal(result.error.code, "ERR_FIDO_CANCELLED");
});
