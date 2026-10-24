"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createPortForwardService } = require("./portforwardService.cjs");

test("portforward service lists active tunnels through the configured runtime", async () => {
  const calls = [];
  const service = createPortForwardService({
    invokeVaultAgent: async () => ({ ok: true, rules: [] }),
    listPortForwards: async () => {
      calls.push("list");
      return [{ tunnelId: "worker-tunnel", status: "active" }];
    },
  });
  const result = await service.listTunnels();
  assert.equal(result.ok, true);
  assert.deepEqual(result.tunnels, [{ tunnelId: "worker-tunnel", status: "active" }]);
  assert.deepEqual(calls, ["list"]);
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

test("portforward rule mutations delegate to the renderer vault", async () => {
  const calls = [];
  const service = createPortForwardService({
    invokeVaultAgent: async (op, params) => {
      calls.push({ op, params });
      return { ok: true };
    },
  });
  await service.createRule({ label: "Web" });
  await service.updateRule({ ruleId: "rule-1", localPort: 8081 });
  await service.duplicateRule({ ruleId: "rule-1" });
  await service.deleteRule({ ruleId: "rule-1" });
  assert.deepEqual(calls.map((call) => call.op), [
    "portforward.rules.create", "portforward.rules.update", "portforward.rules.duplicate", "portforward.rules.delete",
  ]);
});

test("portforward rule mutations pass mappings through to the renderer vault", async () => {
  const calls = [];
  const service = createPortForwardService({
    invokeVaultAgent: async (op, params) => {
      calls.push({ op, params });
      return { ok: true };
    },
  });
  const mappings = JSON.stringify([
    { localPort: 8080, remotePort: 80 },
    { localPort: 9090, remotePort: 90 },
  ]);
  await service.createRule({ label: "Multi", type: "local", localPort: 8080, remotePort: 80, hostId: "host-1", mappings });
  await service.updateRule({ ruleId: "rule-1", mappings });
  assert.equal(calls[0].params.mappings, mappings);
  assert.equal(calls[1].params.mappings, mappings);
});
