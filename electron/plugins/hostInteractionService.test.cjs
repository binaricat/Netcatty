"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { PluginHostInteractionService, assertInteractionRequest, interactionAuthorization, PROMPT_CHANNEL } = require("./hostInteractionService.cjs");

function fixture(t, options = {}) {
  const messages = [], audit = [], writes = [], charges = [];
  let reads = 0, locked = false, focused = true, active = true;
  const sender = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false, send: (channel, message) => { assert.equal(channel, PROMPT_CHANNEL); messages.push(message); } });
  const window = Object.assign(new EventEmitter(), { webContents: sender, isFocused: () => focused, isVisible: () => true, isDestroyed: () => false });
  const signal = new AbortController();
  let onRevoke;
  const service = new PluginHostInteractionService({
    getWindow: () => window, isLocked: () => locked,
    permissionEngine: { onDidRevoke(fn) { onRevoke = fn; return { dispose() {} }; } },
    database: { recordSecurityAudit(...args) { audit.push(args); } },
    quotaManager: { chargeBytes(...args) { charges.push(args); } },
    clipboard: { readText() { reads++; return "synthetic clipboard"; }, writeText(text) { writes.push(text); } },
    ...options,
  });
  service.setReady(sender, true);
  t.after(() => service.shutdown());
  const context = {
    pluginId: "com.example.synthetic", pluginVersion: "1.0.0", runtimeId: "runtime-synthetic", signal: signal.signal,
    async assertActive() { signal.signal.throwIfAborted(); if (!active) throw new Error("stale runtime"); },
  };
  const begin = async (params) => {
    const promise = service.request(assertInteractionRequest(params), context);
    void promise.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    return { promise, prompt: messages.filter((message) => !message.closed).at(-1) };
  };
  const respond = (prompt, action, value) => service.respond(sender, { requestId: prompt.requestId, actionToken: prompt.actionToken, action, ...(value === undefined ? {} : { value }) });
  return { service, sender, window, context, messages, audit, writes, charges, begin, respond, signal,
    get reads() { return reads; }, revoke() { onRevoke({ pluginId: context.pluginId }); },
    lock() { locked = true; }, blur() { focused = false; window.emit("blur"); }, focus() { focused = true; window.emit("focus"); }, stale() { active = false; },
  };
}

test("normal input and quick pick return only an approved bounded value", async (t) => {
  const f = fixture(t);
  const input = await f.begin({ kind: "input", title: "Synthetic input", initialValue: "draft" });
  assert.equal(await f.respond(input.prompt, "submit", "approved"), true);
  assert.deepEqual(await input.promise, { cancelled: false, value: "approved" });
  const choice = await f.begin({ kind: "quickPick", title: "Pick", items: [{ id: "one", label: "One" }] });
  assert.equal(await f.respond(choice.prompt, "submit", "one"), true);
  assert.deepEqual(await choice.promise, { cancelled: false, value: "one" });
  assert.equal(JSON.stringify(f.audit).includes("approved"), false);
  assert.equal(f.reads, 0); assert.deepEqual(f.writes, []);
});

test("ending a host command cancels pending native actions without resetting its quota", async (t) => {
  const f = fixture(t);
  const request = await f.begin({ kind: "clipboard.write", title: "Synthetic", text: "must not copy" });
  const count = f.service.rates.get(f.context.runtimeId).count;
  f.service.cancelRuntimeRequests(f.context.runtimeId);
  await assert.rejects(request.promise, /command finished/);
  assert.equal(await f.respond(request.prompt, "submit"), false);
  assert.deepEqual(f.writes, []);
  assert.equal(f.service.rates.get(f.context.runtimeId).count, count);
});

test("old command completion cannot invalidate a replacement runtime's host-owned admission", async (t) => {
  const f = fixture(t);
  let authorize;
  f.service.registerRpcCapabilities({ registerRequest(_name, _handler, options) { authorize = options.authorization; } });
  const old = assertInteractionRequest({ kind: "input", title: "Old" });
  authorize(old, f.context);
  f.service.cancelRuntimeRequests(f.context.runtimeId);
  await assert.rejects(f.service.request(old, f.context), /revoked/);
  const nextContext = { ...f.context, runtimeId: "runtime-replacement" };
  const next = assertInteractionRequest({ kind: "input", title: "New" });
  authorize(next, nextContext);
  f.service.cancelRuntimeRequests(f.context.runtimeId);
  const request = f.service.request(next, nextContext);
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = f.messages.find((message) => !message.closed);
  assert.ok(prompt);
  await f.respond(prompt, "submit", "synthetic new input");
  assert.deepEqual(await request, { cancelled: false, value: "synthetic new input" });
});

test("input workflow is shown directly without a separate capability prompt", async (t) => {
  const { PluginHostRpcRegistry } = require("./hostRpcRegistry.cjs");
  const { PluginPermissionEngine } = require("./permissionEngine.cjs");
  const f = fixture(t);
  let decisions = 0;
  const engine = new PluginPermissionEngine({
    database: { listPermissionGrants: () => [], recordSecurityAudit() {} },
    requestDecision: async (request) => {
      decisions++;
      f.blur();
      setTimeout(() => f.focus(), 30);
      return { requestId: request.requestId, decision: "allow", scope: "once" };
    },
  });
  t.after(() => engine.shutdown());
  const registry = new PluginHostRpcRegistry();
  registry.use(engine.createMiddleware());
  f.service.registerRpcCapabilities(registry);
  const route = registry.createRoutes({ ...f.context, runtimeKind: "browser", assertCurrent() {},
    manifest: { id: f.context.pluginId, publisher: "example", permissions: { optional: ["ui.interact"] } },
  }).requestHandlers["ui.interact"];
  const result = route({ kind: "input", title: "Synthetic input", initialValue: "visible" }, { signal: f.context.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.messages.filter((message) => !message.closed).length, 1);
  await new Promise((resolve) => setTimeout(resolve, 45));
  const prompt = f.messages.find((message) => !message.closed);
  assert.ok(prompt);
  await f.respond(prompt, "submit", "visible");
  assert.deepEqual(await result, { cancelled: false, value: "visible" });
  assert.equal(decisions, 0);
  assert.equal(f.reads, 0); assert.deepEqual(f.writes, []);
});

test("focus restoration is bounded and admission cannot survive owner or access lifecycle changes", async (t) => {
  for (const action of ["timeout", "hide", "revoke", "runtime", "window", "lock", "signal", "stale"]) {
    const f = fixture(t, { focusRestoreMs: 35 });
    let authorize;
    f.service.registerRpcCapabilities({ registerRequest(_name, _handler, options) { authorize = options.authorization; } });
    const params = assertInteractionRequest({ kind: "clipboard.write", title: "Never copied", text: "synthetic" });
    authorize(params, f.context); // admission is host-owned and originally foregrounded
    f.blur();
    const result = f.service.request(params, f.context);
    void result.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (action === "hide") f.window.emit("hide");
    if (action === "revoke") f.revoke();
    if (action === "runtime") f.service.releaseRuntime(f.context.runtimeId);
    if (action === "window") { f.sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }); f.service.setReady(f.sender, true); }
    if (action === "lock") f.lock();
    if (action === "signal") f.signal.abort();
    if (action === "stale") f.stale();
    if (action !== "timeout") f.focus();
    await assert.rejects(result, /focused unlocked|revoked|unavailable|abort|stale/i, action);
    assert.equal(f.messages.length, 0, action);
    assert.deepEqual(f.writes, []); assert.equal(f.reads, 0);
  }
  const background = fixture(t);
  background.blur();
  await assert.rejects(background.service.request(assertInteractionRequest({ kind: "input", title: "Background" }), background.context), /focused unlocked/);
});

test("Ask clipboard read has one scoped preview and a single-use sharing decision", async (t) => {
  const f = fixture(t);
  const request = await f.begin({ kind: "clipboard.read", title: "Share text" });
  const preview = request.prompt;
  assert.equal(preview.phase, "preview"); assert.equal(preview.previewText, "synthetic clipboard");
  assert.equal(f.reads, 1);
  assert.equal(await f.respond(preview, "submit"), true);
  assert.deepEqual(await request.promise, { cancelled: false, value: "synthetic clipboard" });
  assert.equal(await f.respond(preview, "submit"), false, "no replay");
  assert.equal(f.reads, 1); assert.equal(JSON.stringify(f.audit).includes("synthetic clipboard"), false);
});

test("clipboard copy is explicit and duplicate replies write once", async (t) => {
  const f = fixture(t);
  const request = await f.begin({ kind: "clipboard.write", title: "Copy", text: "synthetic output" });
  assert.deepEqual(f.writes, []);
  const first = f.respond(request.prompt, "submit");
  assert.equal(await f.respond(request.prompt, "submit"), false);
  assert.equal(await first, true);
  assert.deepEqual(await request.promise, { cancelled: false, value: true });
  assert.deepEqual(f.writes, ["synthetic output"]);
});

test("cancel, blur, revoke, runtime release, and incoming cancellation revoke pending action tokens", async (t) => {
  for (const action of ["cancel", "blur", "revoke", "runtime", "signal", "window"]) {
    const f = fixture(t);
    const request = await f.begin({ kind: "clipboard.write", title: "Copy", text: "never written" });
    if (action === "cancel") { await f.respond(request.prompt, "cancel"); assert.deepEqual(await request.promise, { cancelled: true }); }
    else {
      if (action === "blur") f.blur();
      if (action === "revoke") f.revoke();
      if (action === "runtime") f.service.releaseRuntime(f.context.runtimeId);
      if (action === "signal") f.signal.abort();
      if (action === "window") f.sender.emit("destroyed");
      await assert.rejects(request.promise, /cancelled|revoked|stopped|closed/);
    }
    assert.deepEqual(f.writes, []);
    assert.equal(f.service.pending.size, 0);
  }
});

test("wrong windows, forged tokens and stale runtimes cannot commit a native action", async (t) => {
  const f = fixture(t);
  const request = await f.begin({ kind: "clipboard.write", title: "Copy", text: "never written" });
  await assert.rejects(f.service.respond({ id: 9 }, { requestId: request.prompt.requestId, actionToken: request.prompt.actionToken, action: "submit" }), /focused unlocked/);
  assert.equal(await f.respond({ ...request.prompt, actionToken: "x".repeat(64) }, "submit"), false);
  f.stale();
  await assert.rejects(f.respond(request.prompt, "submit"), /stale runtime/);
  await assert.rejects(request.promise, /stale runtime/);
  assert.deepEqual(f.writes, []);
});

test("quota, deadline, locked host, unknown fields, duplicate choices and text bounds fail closed", async (t) => {
  // Keep quota ownership independent from the short expiry timer. Under load,
  // the original 20ms request could expire before the quota assertion ran.
  const quota = fixture(t);
  const held = await quota.begin({ kind: "input", title: "Input" });
  await assert.rejects(quota.service.request(assertInteractionRequest({ kind: "input", title: "Another" }), quota.context), /limit/);
  await quota.respond(held.prompt, "cancel");
  await held.promise;
  const f = fixture(t, { timeoutMs: 20 });
  const request = await f.begin({ kind: "input", title: "Input" });
  const keepAlive = setTimeout(() => {}, 100);
  await assert.rejects(request.promise, /expired/); clearTimeout(keepAlive);
  f.lock();
  await assert.rejects(f.service.request(assertInteractionRequest({ kind: "input", title: "Locked" }), f.context), /focused unlocked/);
  assert.throws(() => assertInteractionRequest({ kind: "clipboard.read", title: "Forged", userGesture: true }), /invalid/);
  assert.throws(() => assertInteractionRequest({ kind: "quickPick", title: "Duplicate", items: [{ id: "same", label: "A" }, { id: "same", label: "B" }] }), /unique/);
  assert.throws(() => assertInteractionRequest({ kind: "clipboard.write", title: "Too long", text: "文".repeat(1500) }), /limit/);
  assert.equal(interactionAuthorization({ kind: "clipboard.read" }).permission, "clipboard.read");
  assert.equal(interactionAuthorization({ kind: "clipboard.write" }).permission, "clipboard.write");
  assert.equal(interactionAuthorization({ kind: "input" }).permission, "ui.interact");
});

test("manifest permission checks and interaction quota run before any host prompt", async (t) => {
  const { PluginHostRpcRegistry } = require("./hostRpcRegistry.cjs");
  const { PluginPermissionEngine } = require("./permissionEngine.cjs");
  const f = fixture(t);
  let decisions = 0;
  const engine = new PluginPermissionEngine({
    database: { getPermissionMode: () => "deny", listPermissionGrants: () => [], recordSecurityAudit() {} },
    requestDecision: async (request) => { decisions++; return { requestId: request.requestId, decision: "deny" }; },
  });
  t.after(() => engine.shutdown());
  const registry = new PluginHostRpcRegistry();
  registry.use(engine.createMiddleware());
  f.service.registerRpcCapabilities(registry);
  const base = { ...f.context, runtimeKind: "browser", manifest: { id: f.context.pluginId, publisher: "example", permissions: {} }, assertCurrent() {} };
  const denied = registry.createRoutes(base).requestHandlers["ui.interact"];
  await assert.rejects(denied({ kind: "input", title: "Undeclared" }, { signal: f.context.signal }), /declare/);
  assert.equal(decisions, 0); assert.equal(f.messages.length, 0);
  const route = registry.createRoutes({ ...base, manifest: { ...base.manifest, permissions: { optional: ["ui.interact"] } } }).requestHandlers["ui.interact"];
  for (let count = 1; count < 10; count++) {
    await assert.rejects(route({ kind: "input", title: "Denied" }, { signal: f.context.signal }), /disabled/);
  }
  const before = decisions;
  await assert.rejects(route({ kind: "input", title: "Over quota" }, { signal: f.context.signal }), /limit/);
  assert.equal(decisions, before, "over-quota work cannot open another permission prompt");
  assert.equal(f.messages.length, 0);
});

test("revoke during an asynchronous active guard and audit failure cannot write clipboard", async (t) => {
  const f = fixture(t);
  const request = await f.begin({ kind: "clipboard.write", title: "Copy", text: "never copied" });
  let resume;
  f.context.assertActive = () => new Promise((resolve) => { resume = resolve; });
  const reply = f.respond(request.prompt, "submit");
  f.revoke();
  resume();
  assert.equal(await reply, false);
  await assert.rejects(request.promise, /revoked/);
  assert.deepEqual(f.writes, []);
  const g = fixture(t, { database: { recordSecurityAudit() { throw new Error("synthetic audit failure"); } } });
  const failed = await g.begin({ kind: "clipboard.write", title: "Copy", text: "never copied" });
  await assert.rejects(g.respond(failed.prompt, "submit"), /audit is unavailable/);
  await assert.rejects(failed.promise, /audit is unavailable/);
  assert.deepEqual(g.writes, []);
});

test("same-document navigation keeps ownership, while document reload and renderer exit cancel it", async (t) => {
  for (const event of ["reload", "renderer"]) {
    const f = fixture(t);
    const request = await f.begin({ kind: "clipboard.read", title: "Share" });
    f.sender.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    f.sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    assert.equal(f.service.pending.size, 1);
    if (event === "reload") f.sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    else f.sender.emit("render-process-gone");
    await assert.rejects(request.promise, /window closed/);
    assert.equal(f.reads, 1); assert.equal(f.service.owner, null);
  }
});

test("host lock subscription cancels previewed text before it can be shared", async (t) => {
  let changed;
  const f = fixture(t, { subscribeLock(listener) { changed = listener; return () => {}; } });
  const request = await f.begin({ kind: "clipboard.read", title: "Share" });
  const preview = f.messages.filter((message) => !message.closed).at(-1);
  changed({ locked: true });
  await assert.rejects(request.promise, /cancelled/);
  assert.equal(await f.respond(preview, "submit"), false);
  assert.equal(f.reads, 1); assert.equal(f.service.pending.size, 0);
});

test("single-line inputs reject CR/LF before display and submission while clipboard text stays multiline", async (t) => {
  const f = fixture(t);
  for (const text of ["first\nsecond", "first\rsecond", "first\r\nsecond"]) {
    assert.throws(() => assertInteractionRequest({ kind: "input", title: "Single line", initialValue: text }), /invalid/);
    const request = await f.begin({ kind: "input", title: "Single line", initialValue: "first second" });
    await assert.rejects(f.respond(request.prompt, "submit", text), /single line/);
    await assert.rejects(request.promise, /single line/);
  }
  const copy = await f.begin({ kind: "clipboard.write", title: "Multiline clipboard", text: "first\nsecond" });
  await f.respond(copy.prompt, "submit");
  assert.deepEqual(await copy.promise, { cancelled: false, value: true });
  assert.deepEqual(f.writes, ["first\nsecond"]);
});
