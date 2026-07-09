"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createVaultService } = require("./vaultService.cjs");

test("vault service delegates host notes read to vault agent bridge", async () => {
  let invokedOp = null;
  const service = createVaultService({
    invokeVaultAgent: async (op, params) => {
      invokedOp = op;
      return { ok: true, hostId: params.hostId, notes: "hello" };
    },
  });
  const result = await service.getHostNotes({ hostId: "host-1" });
  assert.equal(invokedOp, "host.notes.get");
  assert.equal(result.ok, true);
  assert.equal(result.notes, "hello");
});

test("vault service returns bridge unavailable when renderer bridge missing", async () => {
  const service = createVaultService({});
  const result = await service.listSnippets();
  assert.equal(result.ok, false);
  assert.match(result.error, /unavailable/i);
});

test("vault service delegates host open to vault agent bridge", async () => {
  let invokedOp = null;
  let invokedParams = null;
  const service = createVaultService({
    invokeVaultAgent: async (op, params) => {
      invokedOp = op;
      invokedParams = params;
      return { ok: true, sessionId: "sess-1", hostId: params.hostId, status: "connecting" };
    },
  });
  const result = await service.openHost({ hostId: "host-1", chatSessionId: "chat-1" });
  assert.equal(invokedOp, "host.open");
  assert.equal(invokedParams.hostId, "host-1");
  assert.equal(invokedParams.chatSessionId, "chat-1");
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "sess-1");
});
