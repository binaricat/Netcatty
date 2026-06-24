"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createVaultService } = require("./vaultService.cjs");

test("vault service skeleton returns not-implemented for all handlers", async () => {
  const service = createVaultService();
  const result = await service.getHostNotes({ hostId: "host-1" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "CAPABILITY_NOT_IMPLEMENTED");
});
