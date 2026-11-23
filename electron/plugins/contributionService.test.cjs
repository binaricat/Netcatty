"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { assertJsonValue, MAX_SETTING_BYTES, PluginContributionService } = require("./contributionService.cjs");
const { PluginDatabase } = require("./database.cjs");
const { PluginHostRpcRegistry } = require("./hostRpcRegistry.cjs");
const { PluginPermissionEngine } = require("./permissionEngine.cjs");

function manifest(id = "com.example.contributions", activationEvents = []) {
  return {
    manifestVersion: 1,
    id,
    name: "contributions",
    displayName: { en: "Contributions", "zh-CN": "贡献" },
    version: "1.0.0",
    publisher: "example",
    engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal <0.2.0" },
    main: { browser: "index.js" },
    activationEvents,
    contributes: {
      settings: [{
        id: `${id}.greeting`,
        label: { en: "Greeting", "zh-CN": "问候" },
        control: "text",
        scope: "application",
        default: "hello",
      }, {
        id: `${id}.token`,
        label: "Token",
        control: "password",
        scope: "application",
        secret: true,
      }],
      commands: [{ id: `${id}.hello`, title: { en: "Say hello", "zh-CN": "打招呼" }, enablement: `${id}.ready` }],
      menus: [{ command: `${id}.hello`, location: "commandPalette", when: `${id}.visible` }],
      keybindings: [{ command: `${id}.hello`, key: "ctrl+shift+h", when: `${id}.visible` }],
      views: [{ id: `${id}.view`, title: "Example view", location: "aside", entry: "view.html" }],
    },
  };
}

function installPlugin(database, pluginManifest) {
  database.installVersion({
    pluginId: pluginManifest.id,
    version: pluginManifest.version,
    manifest: pluginManifest,
    archiveSha256: "a".repeat(64),
    packageRelativePath: `${pluginManifest.id}/${pluginManifest.version}/package`,
  }, { enable: true });
}

function setup(context, pluginManifest, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-contributions-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const database = new PluginDatabase(path.join(root, "plugins.sqlite"));
  context.after(() => database.close());
  installPlugin(database, pluginManifest);
  const secrets = new Map();
  const secretStore = {
    getReference(pluginId, key) { return secrets.has(`${pluginId}:${key}`) ? secrets.get(`${pluginId}:${key}`).ref : null; },
    set(pluginId, key, value) {
      const ref = { kind: "secret", id: `secret-${"x".repeat(24)}`, key };
      secrets.set(`${pluginId}:${key}`, { ref, value });
      return ref;
    },
    delete(pluginId, key) { secrets.delete(`${pluginId}:${key}`); },
  };
  const calls = [];
  const runtimeSupervisor = options.runtimeSupervisor ?? {
    async start(pluginId) {
      calls.push(`start:${pluginId}`);
      return { runtimeId: `runtime:${pluginId}`, pluginVersion: pluginManifest.version };
    },
    async request(pluginId, method, params) { calls.push(`request:${pluginId}:${method}`); return params; },
    async notify(pluginId, method) { calls.push(`notify:${pluginId}:${method}`); },
    getRuntimeIdentity(pluginId) {
      return { runtimeId: `runtime:${pluginId}`, pluginVersion: pluginManifest.version };
    },
  };
  const service = new PluginContributionService({
    database,
    runtimeSupervisor,
    secretStore,
    getLocale: () => "zh-CN",
    onCommandFinished: options.onCommandFinished,
  });
  return { calls, database, secretStore, service, secrets };
}

test("plugin contribution values enforce the exact JSON value boundary", () => {
  assert.deepEqual(assertJsonValue({ nested: [null, true, 1, "ok"] }), {
    nested: [null, true, 1, "ok"],
  });
  for (const value of [new Date(), new Map(), Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    assert.throws(() => assertJsonValue(value), /bounded JSON value/u);
  }
});

test("only explicitly declared interactive commands receive the fixed budget and command completion is runtime-bound", async (t) => {
  const pluginManifest = manifest();
  delete pluginManifest.contributes.commands[0].enablement;
  pluginManifest.features = { required: ["commands.interactive"] };
  pluginManifest.contributes.commands.push({ id: `${pluginManifest.id}.interactive`, title: "Interactive", interactive: true });
  const optionsSeen = [], finished = [];
  const runtimeId = "runtime-budget";
  const { service } = setup(t, pluginManifest, {
    onCommandFinished: (id) => finished.push(id),
    runtimeSupervisor: {
      async start() { return { runtimeId, pluginVersion: pluginManifest.version }; },
      async request(_id, _method, _params, options) { optionsSeen.push(options); return null; },
    },
  });
  await service.executeCommand(`${pluginManifest.id}.hello`);
  await service.executeCommand(`${pluginManifest.id}.interactive`);
  assert.equal(Object.hasOwn(optionsSeen[0], "timeoutMs"), false, "ordinary commands retain the existing router deadline");
  assert.equal(optionsSeen[0].expectedIdentity.runtimeId, runtimeId);
  assert.equal(optionsSeen[1].timeoutMs, 180_000);
  assert.equal(optionsSeen[1].expectedIdentity.runtimeId, runtimeId);
  assert.deepEqual(finished, [runtimeId, runtimeId]);
  assert.equal(service.activeCommandCalls.size, 0);
});

test("concurrent successful commands retain the runtime interaction until the last ends, while a failed command cancels it", async (t) => {
  const pluginManifest = manifest(); delete pluginManifest.contributes.commands[0].enablement;
  const pending = [], finished = [];
  const { service } = setup(t, pluginManifest, { onCommandFinished: (id) => finished.push(id),
    runtimeSupervisor: { async start() { return { runtimeId: "runtime-concurrent" }; },
      request() { return new Promise((resolve, reject) => pending.push({ resolve, reject })); } },
  });
  const first = service.executeCommand(`${pluginManifest.id}.hello`);
  const second = service.executeCommand(`${pluginManifest.id}.hello`);
  await new Promise((resolve) => setImmediate(resolve));
  pending[0].resolve(null); await first;
  assert.deepEqual(finished, []);
  pending[1].reject(new Error("synthetic timeout"));
  await assert.rejects(second, /synthetic timeout/);
  assert.deepEqual(finished, ["runtime-concurrent"]);
  assert.equal(service.activeCommandCalls.size, 0);
});

test("only onStartupFinished plugins activate during contribution initialization", async (context) => {
  const pluginManifest = manifest("com.example.startup", ["onStartupFinished"]);
  const { calls, service } = setup(context, pluginManifest);
  await service.initialize();
  assert.deepEqual(calls, ["start:com.example.startup"]);

  const lazyManifest = manifest("com.example.lazy", ["onCommand:com.example.lazy.hello"]);
  const lazy = setup(context, lazyManifest);
  await lazy.service.initialize();
  assert.deepEqual(lazy.calls, []);
});

test("commands activate lazily and Context Keys are evaluated by the host", async (context) => {
  const pluginManifest = manifest(undefined, ["onCommand:com.example.contributions.hello"]);
  const { calls, service } = setup(context, pluginManifest);
  const registry = new PluginHostRpcRegistry();
  service.registerRpcCapabilities(registry);
  const routes = registry.createRoutes({
    pluginId: pluginManifest.id,
    pluginVersion: pluginManifest.version,
    runtimeId: "runtime-1",
    runtimeKind: "browser",
    manifest: pluginManifest,
  });
  const transport = { signal: new AbortController().signal };
  await routes.requestHandlers["contextKeys.set"]({ key: `${pluginManifest.id}.ready`, value: true }, transport);
  await routes.requestHandlers["contextKeys.set"]({ key: `${pluginManifest.id}.visible`, value: true }, transport);

  const snapshot = service.snapshot();
  assert.equal(snapshot.plugins[0].displayName, "贡献");
  assert.equal(snapshot.plugins[0].commands[0].enabled, true);
  assert.equal(snapshot.plugins[0].menus[0].visible, true);
  assert.equal(snapshot.plugins[0].menus[0].checked, undefined);
  assert.equal(snapshot.plugins[0].menus[0].shortcut, "ctrl+shift+h");
  assert.equal(snapshot.plugins[0].keybindings[0].enabled, true);

  const result = await service.executeCommand(`${pluginManifest.id}.hello`, { name: "Catty" });
  assert.equal(result.command, `${pluginManifest.id}.hello`);
  assert.deepEqual(calls.slice(-2), [
    `start:${pluginManifest.id}`,
    `request:${pluginManifest.id}:plugin.command.execute`,
  ]);
});

test("Context Keys remain available without an unrelated menus permission", async (context) => {
  const pluginManifest = manifest("com.example.command-only", ["onCommand:com.example.command-only.hello"]);
  pluginManifest.permissions = { required: ["commands"] };
  pluginManifest.contributes.settings = [];
  pluginManifest.contributes.menus = [];
  pluginManifest.contributes.views = [];
  const { database, service } = setup(context, pluginManifest);
  const registry = new PluginHostRpcRegistry();
  registry.use(new PluginPermissionEngine({ database }).createMiddleware());
  service.registerRpcCapabilities(registry);
  const routes = registry.createRoutes({
    pluginId: pluginManifest.id,
    pluginVersion: pluginManifest.version,
    runtimeId: "runtime-command-only",
    runtimeKind: "browser",
    manifest: pluginManifest,
  });

  await routes.requestHandlers["contextKeys.set"]({
    key: `${pluginManifest.id}.ready`,
    value: true,
  }, { signal: new AbortController().signal });

  assert.equal(service.snapshot().plugins[0].commands[0].enabled, true);
  await assert.rejects(
    routes.requestHandlers["contextKeys.set"]({
      key: "com.example.other.ready",
      value: true,
    }, { signal: new AbortController().signal }),
    /must be namespaced to/u,
  );
});

test("Context Key ownership stays exact for plugin IDs that share a prefix", async (context) => {
  const shorter = manifest("com.example");
  const longer = manifest("com.example.foo");
  const { database, service } = setup(context, shorter);
  installPlugin(database, longer);
  const registry = new PluginHostRpcRegistry();
  service.registerRpcCapabilities(registry);
  const transport = { signal: new AbortController().signal };
  const longerRoutes = registry.createRoutes({
    pluginId: longer.id,
    pluginVersion: longer.version,
    runtimeId: "runtime-longer",
    runtimeKind: "browser",
    manifest: longer,
  });
  const shorterRoutes = registry.createRoutes({
    pluginId: shorter.id,
    pluginVersion: shorter.version,
    runtimeId: "runtime-shorter",
    runtimeKind: "browser",
    manifest: shorter,
  });

  await longerRoutes.requestHandlers["contextKeys.set"]({
    key: `${longer.id}.ready`,
    value: true,
  }, transport);
  await assert.rejects(
    shorterRoutes.requestHandlers["contextKeys.set"]({
      key: `${longer.id}.ready`,
      value: false,
    }, transport),
    /must be namespaced to/u,
  );

  service.onRuntimeStateChanged({ pluginId: shorter.id, status: "stopped" });
  const longerSnapshot = service.snapshot().plugins.find((plugin) => plugin.id === longer.id);
  assert.equal(longerSnapshot.commands[0].enabled, true);
});

test("secret settings enforce patterns and size bounds before safeStorage", async (context) => {
  const pluginManifest = manifest("com.example.secret-constraints");
  const secretSetting = pluginManifest.contributes.settings.find((setting) => setting.secret);
  secretSetting.pattern = "^[A-Z]{4}$";
  const { secrets, service } = setup(context, pluginManifest);

  await service.updateSetting(pluginManifest.id, secretSetting.id, "ABCD");
  assert.equal([...secrets.values()][0].value, "ABCD");
  await assert.rejects(
    service.updateSetting(pluginManifest.id, secretSetting.id, "invalid"),
    /does not match its pattern/u,
  );
  assert.equal([...secrets.values()][0].value, "ABCD");

  delete secretSetting.pattern;
  await assert.rejects(
    service.updateSetting(pluginManifest.id, secretSetting.id, "x".repeat(MAX_SETTING_BYTES)),
    /bounded JSON value/u,
  );
  assert.equal([...secrets.values()][0].value, "ABCD");
});

test("host invocation context cannot override plugin-owned Context Keys", async (context) => {
  const pluginManifest = manifest(undefined, ["onCommand:com.example.contributions.hello"]);
  const { service } = setup(context, pluginManifest);
  const registry = new PluginHostRpcRegistry();
  service.registerRpcCapabilities(registry);
  const routes = registry.createRoutes({
    pluginId: pluginManifest.id,
    pluginVersion: pluginManifest.version,
    runtimeId: "runtime-1",
    runtimeKind: "browser",
    manifest: pluginManifest,
  });
  await routes.requestHandlers["contextKeys.set"]({
    key: `${pluginManifest.id}.ready`,
    value: false,
  }, { signal: new AbortController().signal });

  await assert.rejects(service.executeCommand(`${pluginManifest.id}.hello`, undefined, {
    context: { [`${pluginManifest.id}.ready`]: true },
  }), /command is disabled/u);
});

test("quarantined plugins are excluded from snapshots and contribution lookup", async (context) => {
  const pluginManifest = manifest(undefined, ["onCommand:com.example.contributions.hello"]);
  const { database, service } = setup(context, pluginManifest);
  database.recordCrash(pluginManifest.id, pluginManifest.version, 300_000, 3);
  database.recordCrash(pluginManifest.id, pluginManifest.version, 300_000, 3);
  database.recordCrash(pluginManifest.id, pluginManifest.version, 300_000, 3);

  assert.deepEqual(service.snapshot().plugins, []);
  await assert.rejects(
    service.executeCommand(`${pluginManifest.id}.hello`),
    /contribution was not found/u,
  );
  await assert.rejects(
    service.getSetting(pluginManifest.id, `${pluginManifest.id}.greeting`),
    /Plugin is not enabled/u,
  );
});

test("runtime quarantine clears owned Context Keys and publishes contribution removal", async (context) => {
  const pluginManifest = manifest();
  const { database, service } = setup(context, pluginManifest);
  const registry = new PluginHostRpcRegistry();
  service.registerRpcCapabilities(registry);
  const routes = registry.createRoutes({
    pluginId: pluginManifest.id,
    pluginVersion: pluginManifest.version,
    runtimeId: "runtime-1",
    runtimeKind: "browser",
    manifest: pluginManifest,
  });
  const transport = { signal: new AbortController().signal };
  await routes.requestHandlers["contextKeys.set"]({ key: `${pluginManifest.id}.ready`, value: true }, transport);
  await routes.requestHandlers["contextKeys.set"]({ key: `${pluginManifest.id}.visible`, value: true }, transport);
  const changes = [];
  service.onDidChange((event) => changes.push(event));

  database.recordCrash(pluginManifest.id, pluginManifest.version, 300_000, 3);
  database.recordCrash(pluginManifest.id, pluginManifest.version, 300_000, 3);
  database.recordCrash(pluginManifest.id, pluginManifest.version, 300_000, 3);
  service.onRuntimeStateChanged({
    pluginId: pluginManifest.id,
    status: "quarantined",
  });

  assert.equal(changes.at(-1).reason, "runtime-quarantined");
  assert.equal(changes.at(-1).pluginId, pluginManifest.id);
  assert.deepEqual(service.snapshot().plugins, []);
  database.clearQuarantine(pluginManifest.id, pluginManifest.version);
  const snapshot = service.snapshot();
  assert.equal(snapshot.plugins[0].commands[0].enabled, false);
  assert.equal(snapshot.plugins[0].menus[0].visible, false);
});

test("every terminal runtime state clears runtime-owned Context Keys", async (context) => {
  const pluginManifest = manifest();
  const { service } = setup(context, pluginManifest);
  const registry = new PluginHostRpcRegistry();
  service.registerRpcCapabilities(registry);
  const routes = registry.createRoutes({
    pluginId: pluginManifest.id,
    pluginVersion: pluginManifest.version,
    runtimeId: "runtime-terminal",
    runtimeKind: "browser",
    manifest: pluginManifest,
  });
  const changes = [];
  service.onDidChange((event) => changes.push(event));
  for (const status of ["stopped", "error"]) {
    await routes.requestHandlers["contextKeys.set"]({
      key: `${pluginManifest.id}.ready`,
      value: true,
    }, { signal: new AbortController().signal });
    assert.equal(service.snapshot().plugins[0].commands[0].enabled, true);

    service.onRuntimeStateChanged({ pluginId: pluginManifest.id, status });

    assert.equal(changes.at(-1).reason, `runtime-${status}`);
    assert.equal(changes.at(-1).pluginId, pluginManifest.id);
    assert.equal(service.snapshot().plugins[0].commands[0].enabled, false);
  }
});

test("menu and keybinding enablement include the target command state", async (context) => {
  const pluginManifest = manifest();
  pluginManifest.contributes.menus[0].enablement = `${pluginManifest.id}.paletteEnabled`;
  const { service } = setup(context, pluginManifest);
  const registry = new PluginHostRpcRegistry();
  service.registerRpcCapabilities(registry);
  const routes = registry.createRoutes({
    pluginId: pluginManifest.id,
    pluginVersion: pluginManifest.version,
    runtimeId: "runtime-1",
    runtimeKind: "browser",
    manifest: pluginManifest,
  });
  const transport = { signal: new AbortController().signal };
  await routes.requestHandlers["contextKeys.set"]({ key: `${pluginManifest.id}.visible`, value: true }, transport);
  await routes.requestHandlers["contextKeys.set"]({ key: `${pluginManifest.id}.ready`, value: true }, transport);

  let snapshot = service.snapshot();
  assert.equal(snapshot.plugins[0].commands[0].enabled, true);
  assert.equal(snapshot.plugins[0].menus[0].enabled, false);
  assert.equal(snapshot.plugins[0].keybindings[0].enabled, true);

  await routes.requestHandlers["contextKeys.set"]({ key: `${pluginManifest.id}.ready`, value: false }, transport);
  snapshot = service.snapshot();
  assert.equal(snapshot.plugins[0].keybindings[0].enabled, false);
});

test("menu shortcut display uses the current platform and honors explicit suppression", async (context) => {
  const pluginManifest = manifest();
  pluginManifest.contributes.keybindings[0].mac = "cmd+shift+h";
  const { service } = setup(context, pluginManifest);

  assert.equal(service.snapshot({ platform: "darwin" }).plugins[0].menus[0].shortcut, undefined);
  const registry = new PluginHostRpcRegistry();
  service.registerRpcCapabilities(registry);
  const routes = registry.createRoutes({
    pluginId: pluginManifest.id,
    pluginVersion: pluginManifest.version,
    runtimeId: "runtime-1",
    runtimeKind: "browser",
    manifest: pluginManifest,
  });
  const transport = { signal: new AbortController().signal };
  await routes.requestHandlers["contextKeys.set"]({ key: `${pluginManifest.id}.visible`, value: true }, transport);
  await routes.requestHandlers["contextKeys.set"]({ key: `${pluginManifest.id}.ready`, value: true }, transport);

  const visible = service.snapshot({ platform: "darwin" });
  assert.equal(visible.plugins[0].menus[0].shortcut, "cmd+shift+h");

  const suppressedManifest = manifest("com.example.shortcut-suppressed");
  delete suppressedManifest.contributes.commands[0].enablement;
  delete suppressedManifest.contributes.keybindings[0].when;
  suppressedManifest.contributes.menus[0].showKeybinding = false;
  const suppressed = setup(context, suppressedManifest);
  assert.equal(suppressed.service.snapshot({ platform: "darwin" }).plugins[0].menus[0].shortcut, undefined);
});

test("surface-specific view conditions are evaluated from the requesting host context", (context) => {
  const pluginManifest = manifest();
  pluginManifest.contributes.views[0].when = "netcatty.surface == 'settings'";
  const { service } = setup(context, pluginManifest);

  assert.equal(service.snapshot().plugins[0].views[0].visible, false);
  assert.equal(service.snapshot({
    context: { "netcatty.surface": "commandPalette" },
  }).plugins[0].views[0].visible, false);
  assert.equal(service.snapshot({
    context: { "netcatty.surface": "settings" },
  }).plugins[0].views[0].visible, true);
});

test("menu placements use their own source-specific host contexts", (context) => {
  const pluginManifest = manifest("com.example.menu-contexts");
  pluginManifest.contributes.commands = [{
    id: `${pluginManifest.id}.toolbar`,
    title: "Toolbar command",
    enablement: "netcatty.surface == 'terminal/toolbar' && terminal.sessionId == 'session-1'",
  }, {
    id: `${pluginManifest.id}.status`,
    title: "Status command",
    enablement: "netcatty.surface == 'statusBar' && terminal.sessionId == 'session-1'",
  }];
  pluginManifest.contributes.menus = [{
    command: `${pluginManifest.id}.toolbar`,
    location: "terminal/toolbar",
    when: "netcatty.surface == 'terminal/toolbar'",
  }, {
    command: `${pluginManifest.id}.status`,
    location: "statusBar",
    when: "netcatty.surface == 'statusBar'",
  }];
  const { service } = setup(context, pluginManifest);
  const toolbarContext = { "netcatty.surface": "terminal/toolbar", "terminal.sessionId": "session-1" };
  const statusBarContext = { "netcatty.surface": "statusBar", "terminal.sessionId": "session-1" };

  const snapshot = service.snapshot({
    context: toolbarContext,
    menuContexts: {
      "terminal/toolbar": toolbarContext,
      statusBar: statusBarContext,
    },
  });

  assert.deepEqual(snapshot.plugins[0].menus.map((menu) => ({
    command: menu.command,
    visible: menu.visible,
    enabled: menu.enabled,
  })), [{
    command: `${pluginManifest.id}.toolbar`,
    visible: true,
    enabled: true,
  }, {
    command: `${pluginManifest.id}.status`,
    visible: true,
    enabled: true,
  }]);
});

test("lazy activation receives the latest host environment before its first contribution call", async (context) => {
  const pluginManifest = manifest("com.example.environment", ["onView:com.example.environment.view"]);
  const calls = [];
  const runtimeSupervisor = {
    async start(pluginId) {
      calls.push(["start", pluginId]);
      return { runtimeId: "runtime-environment-1" };
    },
    async notify(pluginId, method, params) {
      calls.push(["notify", pluginId, method, params]);
    },
    async request() { return null; },
    getRuntimeIdentity() { return { runtimeId: "runtime-environment-1", pluginVersion: pluginManifest.version }; },
  };
  const { service } = setup(context, pluginManifest, { runtimeSupervisor });
  const environment = { locale: "zh-CN", theme: "dark", reducedMotion: true, highContrast: false };
  await service.setEnvironment(environment);
  assert.deepEqual(service.getEnvironment(), environment);
  assert.deepEqual(calls, []);

  await service.activateView(`${pluginManifest.id}.view`);
  assert.deepEqual(calls, [
    ["start", pluginManifest.id],
    ["notify", pluginManifest.id, "plugin.environment.changed", environment],
  ]);
});

test("view activation identity fails closed after version or runtime replacement", async (context) => {
  const pluginManifest = manifest("com.example.view-identity", ["onView:com.example.view-identity.view"]);
  let runtimeId = "runtime-view-1";
  const runtimeSupervisor = {
    async start() { return { runtimeId, pluginVersion: pluginManifest.version }; },
    async request() { return null; },
    async notify() {},
    getRuntimeIdentity() { return { runtimeId, pluginVersion: pluginManifest.version }; },
  };
  const { database, service } = setup(context, pluginManifest, { runtimeSupervisor });
  const activated = await service.activateView(`${pluginManifest.id}.view`);
  const expected = {
    pluginId: activated.plugin.id,
    pluginVersion: activated.plugin.activeVersion,
    viewId: activated.view.id,
    runtimeId: activated.identity.runtimeId,
  };
  assert.equal(service.assertViewActivationCurrent(expected).view.id, activated.view.id);

  runtimeId = "runtime-view-2";
  assert.throws(() => service.assertViewActivationCurrent(expected), /runtime ownership changed/u);

  runtimeId = "runtime-view-1";
  database.setEnabled(pluginManifest.id, false);
  assert.throws(() => service.assertViewActivationCurrent(expected), /contribution was not found/u);
});

test("settings validate declared controls and secrets never enter settings storage", async (context) => {
  const pluginManifest = manifest();
  const { database, secrets, service } = setup(context, pluginManifest);
  assert.equal(await service.getSetting(pluginManifest.id, `${pluginManifest.id}.greeting`), "hello");
  await service.updateSetting(pluginManifest.id, `${pluginManifest.id}.greeting`, "bonjour");
  assert.equal(await service.getSetting(pluginManifest.id, `${pluginManifest.id}.greeting`), "bonjour");
  await assert.rejects(
    service.updateSetting(pluginManifest.id, `${pluginManifest.id}.greeting`, 42),
    /must be a string/u,
  );

  await service.updateSetting(pluginManifest.id, `${pluginManifest.id}.token`, "plaintext");
  const reference = await service.getSetting(pluginManifest.id, `${pluginManifest.id}.token`);
  assert.equal(reference.kind, "secret");
  assert.equal(database.listSettings(pluginManifest.id).some((entry) => entry.settingId.endsWith(".token")), false);
  assert.equal([...secrets.values()][0].value, "plaintext");
  await service.resetSetting(pluginManifest.id, `${pluginManifest.id}.greeting`);
  assert.equal(await service.getSetting(pluginManifest.id, `${pluginManifest.id}.greeting`), "hello");
});

test("numeric setting writes enforce the declared range and step", async (context) => {
  const pluginManifest = manifest("com.example.numeric-setting");
  pluginManifest.contributes.settings.push({
    id: `${pluginManifest.id}.opacity`,
    label: "Opacity",
    control: "slider",
    scope: "application",
    minimum: 0.1,
    maximum: 1,
    step: 0.1,
    default: 0.5,
  });
  const { service } = setup(context, pluginManifest);

  await service.updateSetting(pluginManifest.id, `${pluginManifest.id}.opacity`, 0.3);
  await assert.rejects(
    service.updateSetting(pluginManifest.id, `${pluginManifest.id}.opacity`, 0.35),
    /align to its step/u,
  );
  await assert.rejects(
    service.updateSetting(pluginManifest.id, `${pluginManifest.id}.opacity`, 1.1),
    /above its maximum/u,
  );
});

test("contextual settings expose values only for an explicit host-owned scope", async (context) => {
  const pluginManifest = manifest("com.example.scoped-settings");
  pluginManifest.contributes.settings.push({
    id: `${pluginManifest.id}.workspace-label`,
    label: "Workspace label",
    control: "text",
    scope: "workspace",
    default: "default-label",
  });
  const { service } = setup(context, pluginManifest);
  await service.updateSetting(
    pluginManifest.id,
    `${pluginManifest.id}.workspace-label`,
    "production",
    "workspace-1",
  );

  const withoutScope = service.snapshot().plugins[0].settings
    .find((setting) => setting.id.endsWith(".workspace-label"));
  assert.equal(withoutScope.scopeId, null);
  assert.equal(withoutScope.value, "default-label");

  const withScope = service.snapshot({ scopeIds: { workspace: "workspace-1" } }).plugins[0].settings
    .find((setting) => setting.id.endsWith(".workspace-label"));
  assert.equal(withScope.scopeId, "workspace-1");
  assert.equal(withScope.value, "production");
});

test("user settings and view state survive package removal", async (context) => {
  const pluginManifest = manifest();
  const { database, service } = setup(context, pluginManifest);
  await service.updateSetting(pluginManifest.id, `${pluginManifest.id}.greeting`, "preserved");
  database.setViewState(pluginManifest.id, `${pluginManifest.id}.view`, "window-1", { selected: 2 });
  database.removePlugin(pluginManifest.id);
  assert.equal(database.getSetting(pluginManifest.id, `${pluginManifest.id}.greeting`, "application", "application"), "preserved");
  assert.deepEqual(database.getViewState(pluginManifest.id, `${pluginManifest.id}.view`, "window-1"), { selected: 2 });
});

test("structured settings use the host restricted schema and unsafe text patterns fail closed", async (context) => {
  const pluginManifest = manifest();
  pluginManifest.contributes.settings.push({
    id: `${pluginManifest.id}.servers`,
    label: "Servers",
    control: "table",
    scope: "application",
    valueSchema: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 32 },
          port: { type: "integer", minimum: 1, maximum: 65_535 },
        },
        required: ["name", "port"],
        additionalProperties: false,
      },
    },
  }, {
    id: `${pluginManifest.id}.patterned`,
    label: "Patterned",
    control: "text",
    scope: "application",
    pattern: "^[a-z]+$",
  }, {
    id: `${pluginManifest.id}.unsafe-pattern`,
    label: "Unsafe pattern",
    control: "text",
    scope: "application",
    pattern: "^(a+)+$",
  });
  const { service } = setup(context, pluginManifest);
  await service.updateSetting(pluginManifest.id, `${pluginManifest.id}.servers`, [{ name: "ssh", port: 22 }]);
  await assert.rejects(
    service.updateSetting(pluginManifest.id, `${pluginManifest.id}.servers`, [{ name: "ssh", port: 70_000 }]),
    /does not match/u,
  );
  await service.updateSetting(pluginManifest.id, `${pluginManifest.id}.patterned`, "netcatty");
  await assert.rejects(
    service.updateSetting(pluginManifest.id, `${pluginManifest.id}.unsafe-pattern`, "aaaa"),
    /unsafe pattern/u,
  );
});

test("Provider contributions expose a PR 5 lazy activation seam", async (context) => {
  const pluginManifest = manifest("com.example.provider", ["onProvider:com.example.provider.completion"]);
  pluginManifest.contributes.providers = [{
    id: "com.example.provider.completion",
    label: { en: "Completion", "zh-CN": "补全" },
    description: { en: "Complete input", "zh-CN": "补全输入" },
    kind: "terminal.completion",
  }, {
    id: "com.example.provider.connection",
    label: "Connection",
    kind: "connection",
  }];
  const calls = [];
  const identity = { pluginId: pluginManifest.id, runtimeId: "runtime-provider-1" };
  const { service } = setup(context, pluginManifest, {
    runtimeSupervisor: {
      async start(pluginId) { calls.push(`start:${pluginId}`); return identity; },
      async notify() {},
      async request() { return null; },
    },
  });
  assert.deepEqual(service.listProviders({ kind: "terminal.completion" }), [{
    pluginId: pluginManifest.id,
    pluginVersion: pluginManifest.version,
    pluginDisplayName: "贡献",
    provider: {
      id: "com.example.provider.completion",
      label: "补全",
      description: "补全输入",
      kind: "terminal.completion",
    },
  }]);
  const result = await service.activateProvider("com.example.provider.completion");
  assert.equal(result.provider.id, "com.example.provider.completion");
  assert.deepEqual(result.identity, identity);
  assert.deepEqual(calls, ["start:com.example.provider"]);
});


test("host settings groups are localized and preferences persist without activating UI code", async (t) => {
  const pluginManifest = manifest();
  pluginManifest.contributes.settings[0].group = { en: "General", "zh-CN": "常规" };
  const { service, database, calls } = setup(t, pluginManifest);
  const settingId = `${pluginManifest.id}.greeting`;
  const snapshot = () => service.snapshot().plugins[0].settings[0];
  assert.equal(snapshot().group, "常规");
  await service.updateSetting(pluginManifest.id, settingId, "persisted preference");
  assert.equal(database.getSetting(pluginManifest.id, settingId, "application", "application"), "persisted preference");
  assert.equal(snapshot().value, "persisted preference");
  assert.ok(!calls.some(call => call.startsWith("start:")), "editing host settings does not start plugin UI");
  await service.resetSetting(pluginManifest.id, settingId);
  assert.equal(snapshot().value, "hello");
});
