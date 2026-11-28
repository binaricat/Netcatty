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
  for (let i = 0; i < 256; i++) await f.host.resource('instance-1', `image-${i}.png`, f.sender);
  await assert.rejects(f.host.resource('instance-1', 'extra.png', f.sender), /limit/);
  for (let i = 1; i <= 121; i++) f.message({ ...update(i), mutations: [] });
  assert.equal(f.host.instances.size, 0); await f.host.shutdown();
});

test("unchanged CSS is deduplicated over internal host-to-renderer IPC", async () => {
  const f = fixture(); await open(f);
  f.message(update(1));
  f.message(update(2));
  assert.equal(f.sender.sent.length, 2);
  assert.equal(f.sender.sent[0][1].css, ".x{display:grid}");
  assert.equal(f.sender.sent[0][1].cssUnchanged, undefined);
  assert.equal(f.sender.sent[1][1].css, "");
  assert.equal(f.sender.sent[1][1].cssUnchanged, true);
  await f.host.shutdown();
});

test("prewarm warms the standby pool and starts only eligible non-prompting browser-only view plugins", async () => {
  let poolWarms = 0;
  const started = [];
  const prepared = [];
  const sender = new EventEmitter(); sender.isDestroyed = () => false;
  const other = new EventEmitter(); other.isDestroyed = () => false;
  const owner = new EventEmitter(); owner.webContents = sender; owner.isDestroyed = () => false;
  let locked = false;
  const askPlugins = new Set(["com.test.ask"]);
  const contributions = {
    onDidPostViewMessage() { return { dispose() {} }; },
    database: {
      listPlugins: () => [
        {
          id: "com.test.browser",
          enabled: true,
          runtime: { quarantinedAt: null },
          manifest: {
            main: { browser: "dist/index.js" },
            activationEvents: ["onView:com.test.browser.main"],
            contributes: { views: [{ id: "com.test.browser.main" }] },
          },
        },
        {
          id: "com.test.undeclared",
          enabled: true,
          runtime: { quarantinedAt: null },
          manifest: {
            main: { browser: "dist/index.js" },
            activationEvents: [],
            contributes: { views: [{ id: "com.test.undeclared.main" }] },
          },
        },
        {
          id: "com.test.ask",
          enabled: true,
          runtime: { quarantinedAt: null },
          manifest: {
            main: { browser: "dist/index.js" },
            activationEvents: ["onView:com.test.ask.main"],
            contributes: { views: [{ id: "com.test.ask.main" }] },
          },
        },
        {
          id: "com.test.advanced",
          enabled: true,
          runtime: { quarantinedAt: null },
          manifest: {
            main: { node: "dist/node.js" },
            activationEvents: ["onView:com.test.advanced.main"],
            permissions: { required: ["runtime.advanced"] },
            contributes: { views: [{ id: "com.test.advanced.main" }] },
          },
        },
      ],
    },
    runtimeSupervisor: {
      getRuntimeIdentity: () => null,
      start: async (id) => { started.push(id); },
    },
  };
  const host = new HostDrawnViewHost({
    electron: { BrowserWindow: { fromWebContents: (s) => (s === sender ? owner : null) } },
    contributionService: contributions,
    packageStore: { preparePackageRoot: async (plugin) => { prepared.push(plugin.id); } },
    permissionEngine: {
      describePolicies: (plugin) => (askPlugins.has(plugin.id)
        ? [{ permission: "network", resources: ["*"], mode: "ask" }]
        : [{ permission: "views", resources: ["*"], mode: "allow" }]),
    },
    runtimePool: { warm: () => { poolWarms += 1; } },
    isLocked: () => locked,
  });
  assert.equal(host.prewarm("com.test.browser.main", other), false);
  assert.equal(poolWarms, 0);
  assert.deepEqual(started, []);

  assert.equal(host.prewarm("com.test.browser.main", sender), true);
  assert.equal(poolWarms, 1);
  assert.deepEqual(started, ["com.test.browser"]);

  // Views without declared onView:<id> stay strictly passive (preparePackageRoot only, no runtime start).
  assert.equal(host.prewarm("com.test.undeclared.main", sender), true);
  assert.deepEqual(started, ["com.test.browser"]);
  assert.deepEqual(prepared, ["com.test.undeclared"]);

  // Plugins with any permission in Ask mode stay strictly passive so hover can never trigger a prompt.
  assert.equal(host.prewarm("com.test.ask.main", sender), true);
  assert.deepEqual(started, ["com.test.browser"]);
  assert.deepEqual(prepared, ["com.test.undeclared", "com.test.ask"]);

  // Advanced Node/utility plugins must never be prewarmed on hover.
  assert.equal(host.prewarm("com.test.advanced.main", sender), true);
  assert.deepEqual(started, ["com.test.browser"]);
  assert.deepEqual(prepared, ["com.test.undeclared", "com.test.ask"]);

  locked = true;
  assert.equal(host.prewarm("com.test.browser.main", sender), false);
  await host.shutdown();
});

test("extended surface and widget events validate schema and bound detail payload size", async () => {
  const f = fixture(); await open(f);
  await f.host.event("instance-1", { nodeId: "1", type: "contextmenu", x: 42, y: 84 }, f.sender);
  await f.host.event("instance-1", { nodeId: "1", type: "dblclick", x: 10, y: 20 }, f.sender);
  await f.host.event("instance-1", { nodeId: "1", type: "scroll", scrollTop: 100, scrollLeft: 0, clientHeight: 400, clientWidth: 600 }, f.sender);
  await f.host.event("instance-1", { nodeId: "1", type: "widget", widgetEvent: "execute", detail: { value: "SELECT 1;", currentStatement: "SELECT 1" } }, f.sender);
  assert.equal(f.notifications.at(-1)[2].message.event.widgetEvent, "execute");
  await assert.rejects(
    f.host.event("instance-1", { nodeId: "1", type: "widget", widgetEvent: "change", detail: { value: "x".repeat(260 * 1024) } }, f.sender),
    /exceeds limits/,
  );
  await f.host.shutdown();
});

test("transient resource decode failures are evicted so retries can succeed", async () => {
  let calls = 0;
  const f = fixture({
    image: async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary decode failure");
      return { url: "data:image/png;base64,AAAA" };
    },
  });
  await open(f);
  await assert.rejects(f.host.resource("instance-1", "icon.png", f.sender), /temporary decode failure/);
  const recovered = await f.host.resource("instance-1", "icon.png", f.sender);
  assert.equal(recovered.url, "data:image/png;base64,AAAA");
  assert.equal(calls, 2);
  await f.host.shutdown();
});
