"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { PluginPermissionDecisionHost } = require("./permissionDecisionHost.cjs");
function fixture(t) {
  const messages = [];
  let locked = false;
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: (_channel, event) => messages.push(event) });
  const window = Object.assign(new EventEmitter(), { webContents: sender, isVisible: () => true, isFocused: () => true, isDestroyed: () => false });
  const host = new PluginPermissionDecisionHost({ getWindow: () => window, isLocked: () => locked });
  host.setReady(sender, true); t.after(() => host.shutdown());
  const request = { requestId: "host-request", pluginId: "com.example.ask", permission: "network", resources: ["https://example.com"], reason: "Fixed host reason" };
  return { host, window, sender, messages, request, lock: () => { locked = true; } };
}
test("in-app Ask is owned by the main window with one scoped, single-use response token", async (t) => {
  const f = fixture(t); const pending = f.host.request(f.request);
  const prompt = f.messages[0];
  assert.throws(() => f.host.respond({ id: 2 }, { requestId: prompt.requestId, actionToken: prompt.actionToken, decision: "allow" }), /focused unlocked/);
  assert.equal(f.host.respond(f.sender, { requestId: prompt.requestId, actionToken: "forged", decision: "allow" }), false);
  const response = { requestId: prompt.requestId, actionToken: prompt.actionToken, decision: "allow" };
  assert.equal(f.host.respond(f.sender, response), true);
  assert.deepEqual(await pending, { requestId: prompt.requestId, decision: "allow", scope: "once" });
  assert.equal(f.host.respond(f.sender, response), false);
});
for (const lifecycle of ["abort", "hide", "blur", "reload", "crash", "unmount"]) test(`Ask ${lifecycle} closes pending authority and stale replies fail`, async (t) => {
  const f = fixture(t); const controller = new AbortController();
  const pending = f.host.request(f.request, { signal: controller.signal });
  const prompt = f.messages[0]; const outcome = pending.catch(() => ({ decision: "cancel" }));
  if (lifecycle === "abort") controller.abort();
  if (lifecycle === "hide" || lifecycle === "blur") f.window.emit(lifecycle);
  if (lifecycle === "reload") f.sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  if (lifecycle === "crash") f.sender.emit("render-process-gone");
  if (lifecycle === "unmount") f.host.setReady(f.sender, false);
  assert.equal((await outcome).decision, "cancel"); assert.equal(f.host.pending.size, 0);
  assert.equal(f.messages.at(-1).closed, true);
  const respond = () => f.host.respond(f.sender, { requestId: prompt.requestId, actionToken: prompt.actionToken, decision: "allow" });
  if (f.host.owner) assert.equal(respond(), false); else assert.throws(respond);
});
test("unsupported permission and locked host cannot open an Ask dialog", (t) => {
  const f = fixture(t);
  assert.throws(() => f.host.request({ ...f.request, permission: "unknown" }), /unavailable/);
  f.lock(); assert.throws(() => f.host.request(f.request), /focused unlocked/);
  assert.equal(f.messages.length, 0);
});

test("shutdown cannot be reopened by a late host-ready message", (t) => {
  const f = fixture(t); f.host.shutdown();
  assert.throws(() => f.host.setReady(f.sender, true), /closed/);
  assert.throws(() => f.host.request(f.request), /focused unlocked/);
  assert.equal(f.messages.length, 0);
});
