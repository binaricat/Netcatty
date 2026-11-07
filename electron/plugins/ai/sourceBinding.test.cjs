"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { PluginAISourceBinding } = require("./sourceBinding.cjs");
function fixture() {
  let source = { id: "source-a", kind: "third-party", origin: "https://registry.example" };
  let owner = "source:opaque-a:com.example.assistant"; let active = true; let runtimeId = "r1"; let reads = 0;
  const context = { pluginId: "com.example.assistant", pluginVersion: "1", runtimeId: "r1", assertActive: async () => { if (!active) throw Error("Inactive"); } };
  const database = {
    getActivePlugin: () => { reads++; return { source, enabled: true, activeVersion: "1", runtime: { status: "running" } }; },
    getRetainedPluginSource: () => source,
    privateOwner: () => owner,
    publicPluginId: (value) => value === owner ? context.pluginId : null,
  };
  const binding = new PluginAISourceBinding({ database, getRuntimeIdentity: () => ({ ...context, runtimeId, runtimeKind: "browser" }) });
  return { binding, context, database, reads: () => reads, activeTo: (v) => { active = v; }, runtimeTo: (v) => { runtimeId = v; },
    sourceTo: (v) => { source = v; }, ownerTo: (v) => { owner = v; } };
}

test("host authentication precedes database access; forged runtime and missing provenance fail closed", async () => {
  const f = fixture(); f.activeTo(false); await assert.rejects(f.binding.resolve(f.context)); assert.equal(f.reads(), 0);
  f.activeTo(true); f.runtimeTo("different"); await assert.rejects(f.binding.resolve(f.context)); assert.equal(f.reads(), 0);
  f.runtimeTo("r1"); f.database.getRetainedPluginSource = () => null; await assert.rejects(f.binding.resolve(f.context));
  assert.throws(() => new PluginAISourceBinding({ database: {}, getRuntimeIdentity: () => null }));
});

test("opaque host owner remains stable and source changes cannot resume the old runtime", async () => {
  const f = fixture(); const owner = await f.binding.resolve({ ...f.context, source: "attacker", privateOwner: "attacker" });
  assert.equal(owner.privateOwner, "source:opaque-a:com.example.assistant");
  assert.equal(await f.binding.resolve(f.context), owner);
  f.sourceTo({ id: "source-b", kind: "third-party", origin: "https://other.example" });
  f.ownerTo("source:opaque-b:com.example.assistant"); await assert.rejects(f.binding.resolve(f.context));
  // A fresh authenticated runtime may acquire its own distinct binding.
  f.binding.releaseRuntime("r1"); const next = await f.binding.resolve(f.context); assert.notEqual(next, owner);
});

test("source/owner changes during asynchronous authentication cannot commit a binding", async () => {
  const f = fixture(); let checks = 0;
  const context = { ...f.context, assertActive: async () => { if (++checks === 2) f.ownerTo("changed-owner"); } };
  await assert.rejects(f.binding.resolve(context)); assert.equal(f.binding.bindings.size, 0);
});

test("final dispatch checks require the exact authenticated binding and current host provenance", async () => {
  const f = fixture(); const binding = await f.binding.resolve(f.context);
  assert.doesNotThrow(() => f.binding.assertCurrent(binding));
  assert.throws(() => f.binding.assertCurrent({ ...binding }));
  f.ownerTo("changed-owner"); assert.throws(() => f.binding.assertCurrent(binding));
  f.ownerTo("source:opaque-a:com.example.assistant");
  f.binding.releaseRuntime("r1"); assert.throws(() => f.binding.assertCurrent(binding));
});
