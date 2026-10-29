"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { HostDrawnViewHost } = require("./hostDrawnViewHost.cjs");
function fixture(resources) {
  const sender = new EventEmitter(); sender.sent = []; sender.send = (channel, value) => sender.sent.push([channel, value]); sender.isDestroyed = () => false;
  const other = new EventEmitter(); const owner = new EventEmitter(); owner.webContents = sender; owner.isDestroyed = () => false;
  const identity = { pluginId: "com.test.plugin", pluginVersion: "1.0.0", runtimeId: "run", runtimeKind: "browser", securityPrincipal: "local" };
  let onMessage, onChange, locked = false, valid = true; const notifications = [];
  const contributions = {
    onDidPostViewMessage(fn) { onMessage = fn; return { dispose() {} }; }, onDidChange(fn) { onChange = fn; return { dispose() {} }; },
    async activateView() { return { plugin: { id: identity.pluginId, activeVersion: identity.pluginVersion }, view: { id: "com.test.plugin.view" }, identity }; },
    assertViewActivationCurrent() { if (!valid) throw new Error("stale"); return { plugin: { id: identity.pluginId } }; },
    runtimeSupervisor: { async notify(...args) { notifications.push(args); } },
  };
  const host = new HostDrawnViewHost({ electron: { BrowserWindow: { fromWebContents: (s) => s === sender ? owner : null } }, contributionService: contributions, resources, isLocked: () => locked });
  return { host, sender, other, owner, notifications, message: (message, overrides = {}) => onMessage({ pluginId: identity.pluginId, viewId: "com.test.plugin.view", message, ...overrides }), change: (event) => onChange(event), lock() { locked = true; }, stale() { valid = false; } };
}
const open = (f) => f.host.open({ viewId: "com.test.plugin.view", instanceId: "instance-1", scopeId: "scope", context: {} }, f.sender);
const update = (sequence = 1) => ({ kind: "host-ui.update", instanceId: "instance-1", sequence, css: '.x{display:grid}', mutations: [[0, "~", { id: "1", type: 1, element: "div", attributes: {}, children: [] }, 0]] });

test("logical views route validated updates only to their owning window", async () => {
  const f = fixture(); assert.deepEqual(await open(f), { instanceId: "instance-1" });
  f.message(update(), { pluginId: "com.evil.plugin" }); assert.equal(f.sender.sent.length, 0);
  f.message(update()); assert.equal(f.sender.sent[0][0], "netcatty:plugins:host-ui-update");
  await assert.rejects(f.host.event("instance-1", { nodeId: "1", type: "click" }, f.other), /another window/);
  await f.host.event("instance-1", { nodeId: "1", type: "click" }, f.sender);
  assert.equal(f.notifications.at(-1)[2].message.kind, "host-ui.event");
  await f.host.close("instance-1", f.sender);
  assert.equal(f.notifications.at(-1)[2].message.kind, "host-ui.close");
  f.message(update(2)); assert.equal(f.sender.sent.filter(([channel]) => channel === "netcatty:plugins:host-ui-update").length, 1);
  await f.host.shutdown();
});

test("invalid updates and replay close the logical view without forwarding them", async () => {
  for (const message of [update(2), { ...update(), css: '@import "https://example.invalid";' }, { ...update(), mutations: [[0, "~", { id: "1", type: 1, element: "script", attributes: {}, children: [] }, 0]] }]) {
    const f = fixture(); await open(f); f.message(message);
    assert.equal(f.sender.sent.some(([channel]) => channel === "netcatty:plugins:host-ui-update"), false);
    assert.equal(f.host.instances.size, 0); await f.host.shutdown();
  }
});

test("withdrawal and lock reject events and close the view", async () => {
  const f = fixture(); await open(f); f.lock();
  await assert.rejects(f.host.event("instance-1", { nodeId: "1", type: "click" }, f.sender), /Invalid/);
  f.stale(); f.change({ reason: "context-key" }); assert.equal(f.host.instances.size, 0);
  await f.host.shutdown();
});

test("package resources require the same window and survive no close or revocation race", async () => {
  let complete; let calls = 0;
  const f = fixture({ image: async () => { calls++; return new Promise((resolve) => { complete = resolve; }); } });
  await open(f);
  await assert.rejects(f.host.resource('instance-1', 'mark.svg', f.other), /another window/);
  const pending = f.host.resource('instance-1', 'mark.svg', f.sender);
  const duplicate = f.host.resource('instance-1', 'mark.svg', f.sender);
  assert.equal(calls, 1);
  await f.host.close('instance-1', f.sender);
  complete({ url: 'data:image/png;base64,AAAA' });
  await assert.rejects(pending, /closed/); await assert.rejects(duplicate, /closed/);
  await f.host.shutdown();
});
test("disable and owner navigation invalidate every retained view", async () => {
  for (const reason of ['plugin-disabled', 'runtime-stopped', 'runtime-error', 'runtime-quarantined']) {
    const f = fixture(); await open(f); f.change({ reason, pluginId: 'com.test.plugin' });
    assert.equal(f.host.instances.size, 0); await f.host.shutdown();
  }
  const f = fixture(); await open(f); f.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(f.host.instances.size, 0); await f.host.shutdown();
});
test("updates are rate limited and resource caches are bounded", async () => {
  const f = fixture({ image: async () => ({ url: 'data:image/png;base64,AAAA' }) }); await open(f);
  for (let i = 0; i < 32; i++) await f.host.resource('instance-1', `image-${i}.png`, f.sender);
  await assert.rejects(f.host.resource('instance-1', 'extra.png', f.sender), /limit/);
  for (let i = 1; i <= 121; i++) f.message({ ...update(i), mutations: [] });
  assert.equal(f.host.instances.size, 0); await f.host.shutdown();
});
