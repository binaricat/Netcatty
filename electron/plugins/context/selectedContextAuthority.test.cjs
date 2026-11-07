"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { SelectedContextAuthority } = require("./selectedContextAuthority.cjs");
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const owner = {}; let currentOwner = owner; let current = true; let version = "1"; let reads = 0; let now = 0;
  const context = { pluginId: "same", pluginVersion: "1", runtimeId: "r1", assertActive: async () => {} };
  const authority = new SelectedContextAuthority({ resolveDataOwner: async () => currentOwner, clock: () => now });
  const selection = { scope: "note", title: "Synthetic Note", version: "1", isCurrent: () => current && version === "1",
    readText: () => { reads++; return "synthetic content"; } };
  return { owner, context, authority, selection, reads: () => reads, ownerTo: (v) => { currentOwner = v; },
    versionTo: (v) => { version = v; }, currentTo: (v) => { current = v; }, timeTo: (v) => { now = v; } };
}

test("summaries enumerate only explicitly shared selection and never read content", async () => {
  const f = fixture(); assert.deepEqual(await f.authority.summaries(f.context), []);
  const note = await f.authority.share(f.selection, f.context);
  assert.deepEqual(await f.authority.summaries(f.context), [note]); assert.equal(f.reads(), 0);
  assert.equal((await f.authority.read(note, f.context)).text, "synthetic content");
  assert.equal(f.reads(), 1);
  assert.deepEqual(await f.authority.summaries({ ...f.context, runtimeId: "r2" }), []);
  f.ownerTo({}); assert.deepEqual(await f.authority.summaries(f.context), []);
  await assert.rejects(f.authority.read(note, f.context));
  f.ownerTo(f.owner); assert.equal((await f.authority.read(note, f.context)).text, "synthetic content");
});

test("scope, owner, expected version and resource lifetime are enforced before read", async () => {
  for (const action of ["version", "owner", "closed", "expiry", "release", "runtime"]) {
    const f = fixture(); const note = await f.authority.share(f.selection, f.context);
    if (action === "version") f.versionTo("2");
    if (action === "owner") f.currentTo(false);
    if (action === "closed") f.authority.shutdown();
    if (action === "expiry") f.timeTo(300_001);
    if (action === "release") f.authority.release(note.handle);
    if (action === "runtime") f.authority.releaseRuntime("r1");
    await assert.rejects(f.authority.read(note, f.context)); assert.equal(f.reads(), 0);
  }
  const f = fixture(); const note = await f.authority.share(f.selection, f.context);
  await assert.rejects(f.authority.read({ ...note, version: "2" }, f.context));
  await assert.rejects(f.authority.read({ handle: "menu-id", version: "1" }, f.context));
  await assert.rejects(f.authority.share({ ...f.selection, scope: "all" }, f.context));
});

test("revocation/version/owner replacement while reader awaits suppresses late content", async () => {
  for (const action of ["release", "version", "owner", "source"]) {
    const f = fixture(); const pending = deferred(); let started;
    const entered = new Promise((r) => { started = r; });
    const note = await f.authority.share({ ...f.selection, readText: () => { started(); return pending.promise; } }, f.context);
    const reading = f.authority.read(note, f.context); await entered;
    if (action === "release") f.authority.release(note.handle);
    if (action === "version") f.versionTo("2");
    if (action === "owner") f.currentTo(false);
    if (action === "source") f.ownerTo({});
    pending.resolve("late secret text"); await assert.rejects(reading);
  }
});

test("unknown Host fields, private keys and oversized content are excluded", async () => {
  const f = fixture();
  await assert.rejects(f.authority.share({ ...f.selection, password: "forbidden" }, f.context));
  await assert.rejects(f.authority.share({ ...f.selection, privateKey: "forbidden" }, f.context));
  for (const text of ["-----BEGIN OPENSSH PRIVATE KEY-----\nforbidden", "X".repeat(16_385)]) {
    const note = await f.authority.share({ ...f.selection, readText: () => text }, f.context);
    await assert.rejects(f.authority.read(note, f.context));
  }
});

test("content reader has a deadline and respects request cancellation", async () => {
  const owner = {}; const context = { runtimeId: "r", pluginVersion: "1", assertActive: async () => {} };
  const authority = new SelectedContextAuthority({ resolveDataOwner: () => owner, limits: { readMs: 20 } });
  const note = await authority.share({ scope: "note", title: "Synthetic", version: "1", isCurrent: () => true,
    readText: () => new Promise(() => {}) }, context);
  await assert.rejects(authority.read(note, context), /timed out/);
  const controller = new AbortController(); const reading = authority.read(note, { ...context, signal: controller.signal });
  controller.abort(); await assert.rejects(reading); authority.shutdown();
});

test("one failing invalidation listener cannot interrupt other listeners or handle cleanup", async () => {
  const f = fixture(); const first = await f.authority.share(f.selection, f.context); const second = await f.authority.share(f.selection, f.context);
  const notified = [];
  f.authority.onDidInvalidate(() => { throw Error("listener failed"); });
  f.authority.onDidInvalidate((handle) => notified.push(handle));
  assert.doesNotThrow(() => f.authority.releaseRuntime("r1"));
  assert.equal(f.authority.handles.size, 0);
  assert.deepEqual(notified, [first.handle, second.handle]);
});
