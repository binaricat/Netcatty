"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { PluginAgentMcpDelegations } = require("./mcpDelegation.cjs");

const options = (turnTag, overrides = {}) => ({ turnTag, senderId: 7, tools: ["get_environment"],
  assertCurrent: () => {}, dispatch: (_method, _params, execute) => execute(), ...overrides });
function socket() {
  const value = new EventEmitter(); value.destroyed = false;
  value.destroy = () => { value.destroyed = true; value.emit("close"); }; return value;
}

test("old turn disposer, credentials and late cancellation registration cannot acquire replacement turn B", () => {
  const registry = new PluginAgentMcpDelegations(); const id = `plugin-agent:${randomUUID()}`;
  const a = randomUUID(); const b = randomUUID();
  const first = registry.register(id, options(a));
  const tokenA = registry.configuration(id, a).token; const connectionA = socket();
  assert.equal(registry.authenticate(tokenA, connectionA), true);
  let cancelledA = 0; let cancelledB = 0;
  registry.onRelease(id, a, () => cancelledA++); first.dispose();
  const second = registry.register(id, options(b)); registry.onRelease(id, b, () => cancelledB++);
  first.dispose(); assert.equal(cancelledB, 0); assert.equal(cancelledA, 1);
  assert.equal(connectionA.destroyed, true);
  assert.equal(registry.authenticate(tokenA, socket()), false);
  assert.throws(() => registry.configuration(id, a));
  assert.throws(() => registry.onRelease(id, a, () => cancelledB++));
  assert.throws(() => registry.assertCaller(id, 7, a));
  assert.throws(() => registry.assertCaller(id, 99, b));
  assert.doesNotThrow(() => registry.assertCaller(id, 7, b));
  assert.equal(cancelledB, 0); second.dispose(); assert.equal(cancelledB, 1);
});

test("discovered owner revocation aborts native work and one faulty callback cannot interrupt cleanup", () => {
  const registry = new PluginAgentMcpDelegations(); const id = `plugin-agent:${randomUUID()}`; const tag = randomUUID();
  let current = true;
  registry.register(id, options(tag, { assertCurrent: () => { if (!current) throw Error("Source revoked"); } }));
  const token = registry.configuration(id, tag).token; const connection = socket(); registry.authenticate(token, connection);
  const native = new AbortController();
  registry.onRelease(id, tag, () => { throw Error("Faulty cleanup listener"); });
  registry.onRelease(id, tag, () => native.abort());
  current = false; assert.throws(() => registry.assertCaller(id, 7, tag), /Source revoked/);
  assert.equal(native.signal.aborted, true); assert.equal(connection.destroyed, true);
  assert.equal(registry.has(id), false); assert.equal(registry.authenticate(token, socket()), false);
});

test("tool profile and trusted caller tag are enforced before invoking the host policy callback", async () => {
  const registry = new PluginAgentMcpDelegations(); const id = `plugin-agent:${randomUUID()}`; const tag = randomUUID();
  let decisions = 0; let effects = 0;
  registry.register(id, options(tag, { dispatch: (_method, _params, execute) => { decisions++; return execute(); } }));
  await assert.rejects(registry.dispatch("netcatty/getContext", { chatSessionId: id }, { trustedAgentSenderId: 7, trustedAgentTurnTag: randomUUID() }, () => effects++));
  await assert.rejects(registry.dispatch("netcatty/exec", { chatSessionId: id }, { trustedAgentSenderId: 7, trustedAgentTurnTag: tag }, () => effects++));
  assert.equal(decisions, 0); assert.equal(effects, 0);
  await registry.dispatch("netcatty/getContext", { chatSessionId: id }, { trustedAgentSenderId: 7, trustedAgentTurnTag: tag }, (context) => {
    assert.equal(registry.isApproved(context), true); context.beforeExecute(); effects++;
  });
  assert.equal(decisions, 1); assert.equal(effects, 1);
  registry.shutdown();
});

test("model request limits cannot be reset or consumed by a different turn or caller", () => {
  const registry = new PluginAgentMcpDelegations(); const id = `plugin-agent:${randomUUID()}`; const tag = randomUUID();
  registry.register(id, options(tag)); let cancelled = 0; registry.onRelease(id, tag, () => cancelled++);
  for (let i = 0; i < 32; i++) {
    assert.throws(() => registry.beginModelRequest(id, 8, tag));
    assert.throws(() => registry.beginModelRequest(id, 7, randomUUID()));
    registry.beginModelRequest(id, 7, tag);
  }
  assert.throws(() => registry.beginModelRequest(id, 7, tag), /budget/); assert.equal(cancelled, 1); assert.equal(registry.has(id), false);
});
