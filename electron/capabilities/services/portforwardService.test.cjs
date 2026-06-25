"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createPortForwardService } = require("./portforwardService.cjs");

test("portforward service lists active tunnels from main bridge", async () => {
  const service = createPortForwardService({
    invokeVaultAgent: async () => ({ ok: true, rules: [] }),
  });
  const result = await service.listTunnels();
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.tunnels));
});

test("portforward start delegates to vault agent bridge after approval path", async () => {
  let invokedOp = null;
  const service = createPortForwardService({
    invokeVaultAgent: async (op, params) => {
      invokedOp = op;
      return { ok: true, ruleId: params.ruleId };
    },
  });
  const result = await service.start({ ruleId: "rule-1", chatSessionId: "chat-1" });
  assert.equal(invokedOp, "portforward.start");
  assert.equal(result.ok, true);
});
