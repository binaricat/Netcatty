"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PluginAITrustedHostAdapter, PLUGIN_AI_HOST_CHANNELS: CHANNELS } = require("./trustedHostAdapter.cjs");

function fixture(options = {}) {
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false });
  const messages = [];
  sender.send = (channel, payload) => messages.push({ channel, payload: structuredClone(payload) });
  const window = Object.assign(new EventEmitter(), { webContents: sender, isDestroyed: () => false, isVisible: () => true, isFocused: () => true });
  let currentWindow = window; let locked = false;
  const adapter = new PluginAITrustedHostAdapter({ getWindow: () => currentWindow, isLocked: () => locked,
    // Domain tests isolate nonce/owner lifecycle. Canonical schema validation is
    // exercised separately when the shared contract is integrated.
    cancelProviderStreams: () => {},
    validateRequest: () => true, validateResponse: () => true, timeoutMs: 1_000,
    dialog: { showMessageBox: async () => ({ response: 0 }) }, ...options });
  const context = { runtimeId: "r", pluginId: "plugin", pluginVersion: "1", assertActive: async () => {} };
  adapter.setReady(sender, true);
  return { adapter, sender, window, context, messages, lockedTo: (v) => { locked = v; }, ownerTo: (v) => { currentWindow = v; } };
}
const tick = () => new Promise(setImmediate);

test("trusted renderer replies require the exact owner and one-use nonce", async (t) => {
  const f = fixture(); t.after(() => f.adapter.shutdown());
  const selecting = f.adapter.selectModel(f.context); await tick();
  const request = f.messages.at(-1).payload;
  const response = { requestId: request.requestId, actionToken: request.actionToken, result: { hostHandle: "model", label: "Synthetic model" } };
  await assert.rejects(f.adapter.respond({ id: 2 }, response));
  assert.equal(await f.adapter.respond(f.sender, { ...response, actionToken: "wrong" }), false);
  assert.equal(await f.adapter.respond(f.sender, response), true);
  assert.equal(await f.adapter.respond(f.sender, response), false);
  assert.equal((await selecting).label, "Synthetic model");
});

test("owner navigation/hide, runtime release, cancellation and timeout discard pending replies", async () => {
  for (const action of ["navigate", "hide", "runtime", "abort", "timeout"]) {
    const f = fixture(action === "timeout" ? { timeoutMs: 20 } : {}); const controller = new AbortController();
    const selecting = f.adapter.selectModel({ ...f.context, signal: controller.signal });
    const rejected = assert.rejects(selecting); await tick();
    const request = f.messages.at(-1).payload;
    if (action === "navigate") f.sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    if (action === "hide") f.window.emit("hide");
    if (action === "runtime") f.adapter.releaseRuntime("r");
    if (action === "abort") controller.abort();
    await rejected; assert.equal(f.adapter.pending.size, 0);
    if (action !== "navigate") assert.equal(await f.adapter.respond(f.sender, { ...request, result: {} }), false);
    f.adapter.shutdown();
  }
});

test("main window replacement and lock cannot reuse a previous renderer owner", async () => {
  const f = fixture(); f.ownerTo({ ...f.window, webContents: { id: 3 } });
  await assert.rejects(f.adapter.selectModel(f.context));
  assert.throws(() => f.adapter.setReady(f.sender, true)); f.adapter.shutdown();
  const next = fixture(); next.lockedTo(true); await assert.rejects(next.adapter.selectModel(next.context)); next.adapter.shutdown();
});

test("selected text review is Cancel by default and cannot approve after cancellation", async () => {
  let resolve; let options;
  const f = fixture({ dialog: { showMessageBox: (_window, value) => { options = value; return new Promise((r) => { resolve = r; }); } } });
  const controller = new AbortController();
  const review = f.adapter.reviewText({ scope: "note", title: "Synthetic", version: "v1", pluginId: "plugin", text: "Synthetic text" }, { ...f.context, signal: controller.signal });
  await tick(); assert.equal(options.defaultId, options.cancelId); assert.equal(options.cancelId, 1);
  controller.abort(); resolve({ response: 0 }); await assert.rejects(review); f.adapter.shutdown();
});

test("text review tolerates native permission focus restoration without focusing a window", async () => {
  const f = fixture(); let focused = false; let focusCalls = 0;
  f.window.isFocused = () => focused; f.window.focus = () => { focusCalls++; };
  const timer = setTimeout(() => { focused = true; }, 25);
  try {
    assert.equal(await f.adapter.reviewText({ title: "Synthetic", scope: "note", version: "1", text: "Synthetic", pluginId: "plugin" }, f.context), true);
    assert.equal(focusCalls, 0);
  } finally { clearTimeout(timer); f.adapter.shutdown(); }
});

test("canonical trusted envelopes reject unknown requests, keys and provider diagnostics", async () => {
  const { createDefinitionValidator } = require("../contractValidator.cjs");
  const requestValid = createDefinitionValidator("PluginAIHostRequest");
  const responseValid = createDefinitionValidator("PluginAIHostResponse");
  const identity = { requestId: "00000000-0000-4000-8000-000000000001", actionToken: "A".repeat(32), runtimeId: "runtime" };
  assert.equal(requestValid({ ...identity, kind: "model.select", payload: {} }), true);
  assert.equal(requestValid({ ...identity, kind: "model.select", payload: { providerId: "arbitrary" } }), false);
  assert.equal(requestValid({ ...identity, kind: "terminal.execute", payload: {} }), false);
  assert.equal(responseValid({ requestId: identity.requestId, actionToken: identity.actionToken,
    result: { hostHandle: identity.requestId, label: "Synthetic", apiKey: "forbidden" } }), false);
  assert.equal(responseValid({ requestId: identity.requestId, actionToken: identity.actionToken, error: "raw diagnostics" }), false);
  const handlers = new Map(); const f = fixture({ validateRequest: requestValid, validateResponse: responseValid });
  f.adapter.registerIpc({ handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) });
  const pending = f.adapter.selectModel(f.context); await tick(); const request = f.messages.at(-1).payload;
  assert.equal(await f.adapter.respond(f.sender, { requestId: request.requestId, actionToken: request.actionToken,
    result: { hostHandle: identity.requestId, label: "Synthetic" } }), true);
  assert.equal((await pending).label, "Synthetic"); f.adapter.shutdown(); assert.equal(handlers.size, 0);
});
