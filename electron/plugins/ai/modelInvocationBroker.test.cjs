"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { ModelInvocationBroker } = require("./modelInvocationBroker.cjs");
const { SelectedContextAuthority } = require("../context/selectedContextAuthority.cjs");
const { PluginAISourceBinding } = require("./sourceBinding.cjs");
const { RPC_ERRORS } = require("../rpcRouter.cjs");
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const denied = (error) => error.code === RPC_ERRORS.permissionDenied;
function fixture(options = {}) {
  const owner = { budgetOwner: "synthetic-source-a" }; let currentOwner = owner; let current = true; let active = true; let now = 0;
  const request = new AbortController();
  const context = { pluginId: "same-id", pluginVersion: "1", runtimeId: "r1", signal: request.signal,
    assertActive: async () => { request.signal.throwIfAborted(); if (!active) throw Error("stopped"); } };
  const calls = [];
  const model = { label: "Host selected model", isCurrent: () => current,
    invoke: (input) => { calls.push(input); return (async function* () { yield { kind: "text", text: "Summary" };
      yield { kind: "usage", inputTokens: 7, outputTokens: 2, totalTokens: 9, secret: "DO_NOT_SERIALIZE" }; })(); }, ...options.model };
  const resolveDataOwner = async () => currentOwner;
  const contexts = new SelectedContextAuthority({ resolveDataOwner, clock: () => now });
  const broker = new ModelInvocationBroker({ resolveDataOwner, resolveBudgetOwner: (binding) => binding.budgetOwner,
    selectModel: async () => model, contexts,
    clock: () => now, limits: options.limits });
  return { broker, context, contexts, calls, request, owner, model, setOwner: (value) => { currentOwner = value; },
    setCurrent: (value) => { current = value; }, setActive: (value) => { active = value; }, setTime: (value) => { now = value; } };
}

test("selected synthetic Note traverses actual broker; text/usage are projected without configuration or secrets", async (t) => {
  const f = fixture(); t.after(() => f.broker.shutdown());
  const note = await f.contexts.share({ scope: "note", title: "Synthetic note", version: "v1",
    readText: () => "Synthetic release: add retry button", isCurrent: () => true }, f.context);
  assert.equal(f.calls.length, 0);
  const chat = await f.broker.open(f.context);
  const turn = await f.broker.start({ chatHandle: chat.chatHandle, prompt: "Summarize", contexts: [{ handle: note.handle, version: note.version }] }, f.context);
  assert.deepEqual(f.calls[0].contexts, ["Synthetic release: add retry button"]);
  assert.equal(f.calls[0].tools, undefined);
  const events = [await f.broker.read(turn.turnHandle, f.context), await f.broker.read(turn.turnHandle, f.context), await f.broker.read(turn.turnHandle, f.context)];
  assert.equal(events[0].text, "Summary");
  assert.deepEqual(events[1], { kind: "usage", sequence: 1, inputTokens: 7, outputTokens: 2, totalTokens: 9 });
  assert.equal(events[2].kind, "end");
  assert.doesNotMatch(JSON.stringify({ chat, turn, events, note }), /apiKey|config|DO_NOT_SERIALIZE/);
});

test("same pluginId with another source owner, runtime or version cannot use handles or stop victim turns", async (t) => {
  const f = fixture(); t.after(() => f.broker.shutdown());
  const chat = await f.broker.open(f.context);
  const turn = await f.broker.start({ chatHandle: chat.chatHandle, prompt: "Hi" }, f.context);
  for (const changed of [{ runtimeId: "r2" }, { pluginVersion: "2" }]) {
    await assert.rejects(f.broker.read(turn.turnHandle, { ...f.context, ...changed }), denied);
    await assert.rejects(f.broker.stop(turn.turnHandle, { ...f.context, ...changed }), denied);
  }
  f.setOwner({});
  await assert.rejects(f.broker.read(turn.turnHandle, f.context), denied);
  await assert.rejects(f.broker.close(chat.chatHandle, f.context), denied);
  f.setOwner(f.owner);
  assert.equal((await f.broker.read(turn.turnHandle, f.context)).text, "Summary");
});

test("pending read cancels promptly and a provider's late result never escapes", async (t) => {
  const pending = deferred(); let signal;
  const f = fixture({ model: { invoke: (input) => { signal = input.signal; return { next: () => pending.promise }; } } });
  t.after(() => f.broker.shutdown());
  const chat = await f.broker.open(f.context);
  const turn = await f.broker.start({ chatHandle: chat.chatHandle, prompt: "Hi" }, f.context);
  const reading = f.broker.read(turn.turnHandle, f.context);
  await new Promise(setImmediate);
  assert.equal(await f.broker.stop(turn.turnHandle, f.context), true);
  await assert.rejects(reading, (e) => e.code === RPC_ERRORS.cancelled);
  assert.equal(signal.aborted, true);
  pending.resolve({ value: { kind: "text", text: "Late output" } });
  await assert.rejects(f.broker.read(turn.turnHandle, f.context), denied);
});

test("runtime teardown, owner revoke and request abort discard pending results", async () => {
  for (const action of ["runtime", "owner", "abort"]) {
    const pending = deferred();
    const f = fixture({ model: { invoke: () => ({ next: () => pending.promise }) } });
    const chat = await f.broker.open(f.context);
    const turn = await f.broker.start({ chatHandle: chat.chatHandle, prompt: "Hi" }, f.context);
    const reading = f.broker.read(turn.turnHandle, f.context);
    await new Promise(setImmediate);
    if (action === "runtime") f.broker.releaseRuntime("r1");
    if (action === "owner") f.broker.releaseOwner(f.owner);
    if (action === "abort") f.request.abort();
    await assert.rejects(reading);
    pending.resolve({ value: { kind: "text", text: "Late" } });
    assert.equal(f.broker.turns.size, 0); f.broker.shutdown();
  }
});

test("deadline also aborts providers that ignore AbortSignal", async () => {
  const f = fixture({ model: { invoke: () => ({ next: () => new Promise(() => {}) }) }, limits: { turnMs: 20 } });
  const chat = await f.broker.open(f.context);
  const turn = await f.broker.start({ chatHandle: chat.chatHandle, prompt: "Hi" }, f.context);
  await assert.rejects(f.broker.read(turn.turnHandle, f.context), (e) => e.code === RPC_ERRORS.deadlineExceeded);
  assert.equal(f.broker.turns.size, 0); f.broker.shutdown();
});

test("model switch and chat expiration reject results", async () => {
  for (const action of ["model", "expiry"]) {
    const pending = deferred(); const f = fixture({ model: { invoke: () => ({ next: () => pending.promise }) } });
    const chat = await f.broker.open(f.context);
    const turn = await f.broker.start({ chatHandle: chat.chatHandle, prompt: "Hi" }, f.context);
    const reading = f.broker.read(turn.turnHandle, f.context); await new Promise(setImmediate);
    if (action === "model") f.setCurrent(false); else f.setTime(300_001);
    pending.resolve({ value: { kind: "text", text: "Late" } });
    await assert.rejects(reading, denied); f.broker.shutdown();
  }
});

test("bounds cover request rate, output bytes/tokens, concurrent read and raw error serialization", async () => {
  const f = fixture({ limits: { requestsPerMinute: 1 } });
  const chat = await f.broker.open(f.context);
  const turn = await f.broker.start({ chatHandle: chat.chatHandle, prompt: "Hi" }, f.context);
  await f.broker.stop(turn.turnHandle, f.context);
  await assert.rejects(f.broker.start({ chatHandle: chat.chatHandle, prompt: "Hi" }, f.context), (e) => e.code === RPC_ERRORS.resourceExhausted);
  f.broker.releaseRuntime("r1");
  const again = await f.broker.open(f.context);
  await assert.rejects(f.broker.start({ chatHandle: again.chatHandle, prompt: "Hi" }, f.context), (e) => e.code === RPC_ERRORS.resourceExhausted);
  f.broker.shutdown();
  for (const event of [{ kind: "text", text: "X".repeat(4097) }, { kind: "usage", outputTokens: 2049 }, { kind: "tool-call", command: "rm -rf /" }]) {
    const instance = fixture({ model: { invoke: () => (async function* () { yield event; })() } });
    const selected = await instance.broker.open(instance.context);
    const started = await instance.broker.start({ chatHandle: selected.chatHandle, prompt: "Hi" }, instance.context);
    await assert.rejects(instance.broker.read(started.turnHandle, instance.context));
    assert.equal(instance.broker.turns.size, 0); instance.broker.shutdown();
  }
  const broken = fixture({ model: { invoke: () => { throw Error("api-key secret request body"); } } });
  const selected = await broken.broker.open(broken.context);
  await assert.rejects(broken.broker.start({ chatHandle: selected.chatHandle, prompt: "Hi" }, broken.context), (e) => !/secret|api-key/.test(e.message));
  broken.broker.shutdown();
});

test("revoking selected context aborts an in-flight turn; changing its version suppresses late output", async () => {
  for (const action of ["revoke", "version"]) {
    let current = true; const pending = deferred();
    const f = fixture({ model: { invoke: () => ({ next: () => pending.promise }) } });
    const note = await f.contexts.share({ scope: "note", title: "Synthetic", version: "1",
      readText: () => "Synthetic", isCurrent: () => current }, f.context);
    const chat = await f.broker.open(f.context);
    const turn = await f.broker.start({ chatHandle: chat.chatHandle, prompt: "Hi", contexts: [{ handle: note.handle, version: note.version }] }, f.context);
    const reading = f.broker.read(turn.turnHandle, f.context); await new Promise(setImmediate);
    if (action === "revoke") f.contexts.release(note.handle); else current = false;
    pending.resolve({ value: { kind: "text", text: "Late" } });
    await assert.rejects(reading); f.broker.shutdown();
  }
});

test("input, aggregate output, reserved token and concurrent read bounds", async () => {
  const cases = [
    { limits: { inputBytes: 2 }, prompt: "too big", start: true },
    { limits: { reservedTokensPerMinute: 1 }, prompt: "Hi", start: true },
    { limits: { outputBytes: 2 }, prompt: "Hi", start: false },
  ];
  for (const scenario of cases) {
    const f = fixture({ limits: scenario.limits }); const chat = await f.broker.open(f.context);
    const start = () => f.broker.start({ chatHandle: chat.chatHandle, prompt: scenario.prompt }, f.context);
    if (scenario.start) await assert.rejects(start());
    else { const turn = await start(); await assert.rejects(f.broker.read(turn.turnHandle, f.context)); }
    assert.equal(f.broker.turns.size, 0); f.broker.shutdown();
  }
  const pending = deferred(); const f = fixture({ model: { invoke: () => ({ next: () => pending.promise }) } });
  const chat = await f.broker.open(f.context); const turn = await f.broker.start({ chatHandle: chat.chatHandle, prompt: "Hi" }, f.context);
  const reading = f.broker.read(turn.turnHandle, f.context); await new Promise(setImmediate);
  await assert.rejects(f.broker.read(turn.turnHandle, f.context), (e) => e.code === RPC_ERRORS.resourceExhausted);
  pending.resolve({ value: { kind: "text", text: "OK" } }); assert.equal((await reading).text, "OK"); f.broker.shutdown();
});

test("the owner can stop or close after a model switch; read request cancellation aborts the provider", async () => {
  const f = fixture(); const chat = await f.broker.open(f.context);
  const turn = await f.broker.start({ chatHandle: chat.chatHandle, prompt: "Hi" }, f.context);
  f.setCurrent(false); assert.equal(await f.broker.stop(turn.turnHandle, f.context), true);
  assert.equal(await f.broker.close(chat.chatHandle, f.context), true); f.broker.shutdown();
  const pending = deferred(); const instance = fixture({ model: { invoke: () => ({ next: () => pending.promise }) } });
  const selected = await instance.broker.open(instance.context);
  const started = await instance.broker.start({ chatHandle: selected.chatHandle, prompt: "Hi" }, instance.context);
  const controller = new AbortController();
  const reading = instance.broker.read(started.turnHandle, { ...instance.context, signal: controller.signal });
  await new Promise(setImmediate); controller.abort(); await assert.rejects(reading);
  assert.equal(instance.broker.turns.size, 0); pending.resolve({ done: true }); instance.broker.shutdown();
});

test("event and handle caps prevent cheap empty streams and unbounded allocation", async () => {
  const f = fixture({ limits: { perRuntime: 1, events: 1 }, model: { invoke: () => (async function* () {
    yield { kind: "text", text: "" }; yield { kind: "text", text: "" };
  })() } });
  const chat = await f.broker.open(f.context); await assert.rejects(f.broker.open(f.context));
  const turn = await f.broker.start({ chatHandle: chat.chatHandle, prompt: "Hi" }, f.context);
  assert.equal((await f.broker.read(turn.turnHandle, f.context)).text, "");
  await assert.rejects(f.broker.read(turn.turnHandle, f.context), (e) => e.code === RPC_ERRORS.resourceExhausted); f.broker.shutdown();
});

test("malformed context cannot publish a turn or interrupt two-handle runtime revocation", async (t) => {
  const entered = deferred(); const resume = deferred(); let checks = 0;
  const f = fixture({ model: { isCurrent: async () => { if (++checks === 3) { entered.resolve(); await resume.promise; } return true; } } });
  t.after(() => { resume.resolve(); f.broker.shutdown(); });
  const selection = { scope: "note", title: "Synthetic", version: "1", readText: () => "Synthetic", isCurrent: () => true };
  await f.contexts.share(selection, f.context); await f.contexts.share(selection, f.context);
  const chat = await f.broker.open(f.context);
  const start = f.broker.start({ chatHandle: chat.chatHandle, prompt: "Hi", contexts: [null] }, f.context);
  const outcome = start.then(() => "accepted", (error) => error);
  // On the old implementation, reach the reported post-publication model guard.
  // On the fixed implementation, validation rejects before that await exists.
  await Promise.race([entered.promise, outcome]);
  assert.doesNotThrow(() => f.contexts.releaseRuntime("r1"));
  assert.equal(f.contexts.handles.size, 0);
  resume.resolve();
  const error = await outcome;
  assert.equal(error.code, RPC_ERRORS.invalidArgument);
  assert.equal(f.broker.turns.size, 0);
  assert.equal(f.calls.length, 0);
  f.broker.shutdown();
});

test("pending model selections reserve capacity and cannot publish after revocation", async () => {
  const f = fixture({ limits: { perRuntime: 1 } }); const pending = deferred(); let disposed = 0;
  f.broker.selectModel = () => pending.promise;
  const opening = f.broker.open(f.context); const rejected = assert.rejects(opening);
  await new Promise(setImmediate);
  await assert.rejects(f.broker.open(f.context), (error) => error.code === RPC_ERRORS.resourceExhausted);
  f.broker.releaseRuntime("r1");
  pending.resolve({ ...f.model, dispose: () => { disposed++; } });
  await rejected; assert.equal(f.broker.chats.size, 0); assert.equal(f.broker.openings.size, 0); assert.equal(disposed, 1); f.broker.shutdown();
});

test("same-source runtime replacement preserves minute budgets while distinct sources stay isolated", async (t) => {
  for (const limits of [{ requestsPerMinute: 1 }, { reservedTokensPerMinute: 3_074 }]) {
    await t.test(Object.keys(limits)[0], async (t) => {
      let now = 1_000; let sourceId = "source-a"; let runtimeId = "runtime-1"; let invocations = 0;
      const pluginId = "com.example.assistant";
      const context = () => ({ pluginId, pluginVersion: "1", runtimeId, assertActive: async () => {} });
      const source = () => ({ id: sourceId, kind: "third-party", origin: `https://${sourceId}.example` });
      const binding = new PluginAISourceBinding({
        database: {
          getActivePlugin: () => ({ enabled: true, activeVersion: "1", runtime: { status: "running" }, source: source() }),
          getRetainedPluginSource: source,
          privateOwner: () => `opaque:${sourceId}:assistant`,
          publicPluginId: (owner) => owner === `opaque:${sourceId}:assistant` ? pluginId : null,
        },
        getRuntimeIdentity: () => ({ ...context(), runtimeKind: "browser" }),
      });
      const broker = new ModelInvocationBroker({
        resolveDataOwner: (caller) => binding.resolve(caller),
        resolveBudgetOwner: (owner) => JSON.stringify([owner.sourceKey, owner.privateOwner]),
        selectModel: () => ({ label: "Synthetic model", isCurrent: () => true, invoke: () => {
          invocations++; return (async function* () {})();
        } }), clock: () => now, limits,
      });
      t.after(() => { broker.shutdown(); binding.shutdown(); });
      const start = (chat) => broker.start({ chatHandle: chat.chatHandle, prompt: "Hi" }, context());
      const replace = (nextSource) => {
        broker.releaseRuntime(runtimeId); binding.releaseRuntime(runtimeId);
        sourceId = nextSource; runtimeId = `${runtimeId}-next`;
      };
      const firstOwner = await binding.resolve(context());
      const first = await broker.open(context()); const firstTurn = await start(first);
      await broker.stop(firstTurn.turnHandle, context());
      replace("source-a");
      assert.notEqual(await binding.resolve(context()), firstOwner);
      const restarted = await broker.open(context());
      await assert.rejects(start(restarted), (error) => error.code === RPC_ERRORS.resourceExhausted);
      assert.equal(invocations, 1);
      assert.equal(await broker.close(first.chatHandle, context()), false);
      replace("source-b");
      const other = await broker.open(context()); const otherTurn = await start(other);
      await broker.stop(otherTurn.turnHandle, context()); assert.equal(invocations, 2);
      replace("source-a");
      const returned = await broker.open(context());
      now = 60_999;
      await assert.rejects(start(returned), (error) => error.code === RPC_ERRORS.resourceExhausted);
      now = 61_000;
      const afterWindow = await start(returned); assert.equal(invocations, 3);
      await broker.stop(afterWindow.turnHandle, context());
    });
  }
});

test("budget ownership requires an explicit host adapter and never falls back to the plugin ID", async (t) => {
  assert.throws(() => new ModelInvocationBroker({ resolveDataOwner: () => ({}), selectModel: () => ({}) }), /Host adapters required/);
  for (const budgetOwner of [undefined, "", {}, "x".repeat(8_193)]) {
    const f = fixture(); t.after(() => f.broker.shutdown());
    f.broker.resolveBudgetOwner = () => budgetOwner;
    await assert.rejects(f.broker.open(f.context), denied);
    assert.equal(f.calls.length, 0); assert.equal(f.broker.chats.size, 0);
  }
});
