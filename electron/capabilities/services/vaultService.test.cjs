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
