"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PluginDatabase } = require("./database.cjs");
const { PluginHostRpcRegistry } = require("./hostRpcRegistry.cjs");
const { createPluginPaths } = require("./paths.cjs");
const { RPC_ERRORS } = require("./rpcRouter.cjs");
const { RuntimeSupervisor } = require("./runtimeSupervisor.cjs");
const { createContainmentError } = require("./utilityPluginRuntime.cjs");
const { PluginContributionService } = require("./contributionService.cjs");

function pluginManifest(overrides = {}) {
  return {
    manifestVersion: 1,
    id: "com.example.runtime-test",
    name: "runtime-test",
    version: "1.0.0",
    publisher: "example",
    engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal <0.2.0" },
    main: { browser: "dist/browser.js", node: "dist/node.js" },
    ...overrides,
  };
}

function createFixture(context, runtimeFactory, supervisorOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-supervisor-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = createPluginPaths(root);
  fs.mkdirSync(paths.logs, { recursive: true });
  const database = new PluginDatabase(paths.database);
  context.after(() => {
    try { database.close(); } catch {}
  });
  const manifest = pluginManifest();
  database.installVersion({
    pluginId: manifest.id,
    version: manifest.version,
    manifest,
    archiveSha256: "a".repeat(64),
    packageRelativePath: `${manifest.id}/${manifest.version}/package`,
  }, { enable: true });
  const packageRoot = path.join(paths.packages, manifest.id, manifest.version, "package");
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  const runtimeOptions = [];
  const factory = (options) => {
    runtimeOptions.push(options);
    return runtimeFactory(options);
  };
  const supervisor = new RuntimeSupervisor({
    electron: {},
    database,
    packageStore: { async preparePackageRoot() { return packageRoot; } },
    protocol: {},
    paths,
    netcattyVersion: "0.0.0",
    apiVersion: "0.1.0-internal",
    runtimeDirectory: path.join(root, "runtime"),
    appRoot: process.cwd(),
    runtimeFactories: { browser: factory, utility: factory },
    ...supervisorOptions,
  });
  return { database, manifest, runtimeOptions, supervisor };
}

test("ordinary command activation A cannot dispatch on replacement runtime B", async (t) => {
  let executed = 0, activation;
  const fixture = createFixture(t, () => ({ async start(config) { return { pluginId: config.pluginId, pluginVersion: config.pluginVersion,
    apiVersion: config.apiVersion, enabledFeatures: config.enabledFeatures }; }, async stop() {}, async request() { executed++; return null; } }));
  t.after(() => fixture.supervisor.shutdown());
  const manifest = { ...fixture.manifest, contributes: { commands: [{ id: `${fixture.manifest.id}.ordinary`, title: "Ordinary" }] } };
  const finished = [];
  const service = new PluginContributionService({
    database: { listPlugins: () => [{ id: manifest.id, manifest, activeVersion: manifest.version, enabled: true, runtime: {} }] },
    onCommandFinished: (runtimeId) => finished.push(runtimeId),
    runtimeSupervisor: {
      async start(pluginId) {
        activation = await fixture.supervisor.start(pluginId);
        await fixture.supervisor.restart(pluginId);
        return activation;
      },
      request: (...args) => fixture.supervisor.request(...args),
    },
  });
  await assert.rejects(service.executeCommand(`${manifest.id}.ordinary`), /no longer matches the authorized activation/);
  assert.notEqual(fixture.supervisor.getRuntimeIdentity(manifest.id).runtimeId, activation.runtimeId);
  assert.equal(executed, 0, "replacement B receives no stale command");
  assert.deepEqual(finished, [activation.runtimeId]);
});

test("supervisor prefers the ordinary browser runtime and enforces negotiated identity", async (context) => {
  const calls = [];
  const initialEnvironment = { locale: "en", theme: "light", reducedMotion: false, highContrast: false };
  const activationEnvironment = { locale: "zh-CN", theme: "dark", reducedMotion: true, highContrast: true };
  let environment = initialEnvironment;
  const fixture = createFixture(context, () => ({
    async start(config, options) {
      calls.push(["start", config]);
      environment = activationEnvironment;
      assert.deepEqual(options.getActivationEnvironment(), activationEnvironment);
      return {
        pluginId: config.pluginId,
        pluginVersion: config.pluginVersion,
        apiVersion: config.apiVersion,
        enabledFeatures: config.enabledFeatures,
      };
    },
    async stop() { calls.push(["stop"]); },
  }), {
    getInitialEnvironment(identity) {
      assert.equal(identity.pluginId, "com.example.runtime-test");
      assert.match(identity.runtimeId, /^[0-9a-f-]+$/u);
      return environment;
    },
  });

  const started = await fixture.supervisor.start(fixture.manifest.id);
  assert.deepEqual(started, fixture.supervisor.getRuntimeIdentity(fixture.manifest.id));
  assert.match(started.securityPrincipal, /^unsigned-package:/u);
  assert.equal(Object.hasOwn(started, "request"), false);
  assert.equal(Object.hasOwn(started, "stop"), false);
  assert.equal(fixture.runtimeOptions[0].plugin.manifest.main.browser, "dist/browser.js");
  assert.equal(fixture.database.getActivePlugin(fixture.manifest.id).runtime.kind, "browser");
  assert.equal(fixture.database.getActivePlugin(fixture.manifest.id).runtime.status, "running");
  assert.deepEqual(calls[0][1].environment, initialEnvironment);
  assert.equal(Object.isFrozen(calls[0][1].environment), true);
  await fixture.supervisor.stop(fixture.manifest.id);
  assert.deepEqual(calls.map(([kind]) => kind), ["start", "stop"]);
});

test("supervisor verifies immutable package contents before runtime placement", async (context) => {
  let placementCalls = 0;
  const fixture = createFixture(context, () => {
    throw new Error("runtime factory must not run");
  }, {
    packageStore: {
      async preparePackageRoot() {
        throw new Error("installed package integrity check failed");
      },
    },
    resolveRuntimeKind() {
      placementCalls += 1;
      return "browser";
    },
  });

  await assert.rejects(
    fixture.supervisor.start(fixture.manifest.id),
    /installed package integrity check failed/,
  );
  assert.equal(placementCalls, 0);
  assert.deepEqual(fixture.runtimeOptions, []);
});

test("supervisor attaches the runtime quota monitor before activation completes", async (context) => {
  const events = [];
  let releaseActivation;
  let signalProcessReady;
  const activation = new Promise((resolve) => { releaseActivation = resolve; });
  const processReady = new Promise((resolve) => { signalProcessReady = resolve; });
  const fixture = createFixture(context, (options) => ({
    async start(config) {
      events.push("start");
      options.onProcessReady();
      events.push("process-ready");
      signalProcessReady();
      await activation;
      return {
        pluginId: config.pluginId,
        pluginVersion: config.pluginVersion,
        apiVersion: config.apiVersion,
        enabledFeatures: config.enabledFeatures,
      };
    },
    async stop() {},
  }), {
    runtimeResourceMonitor: {
      trackRuntime() {
        events.push("monitor");
        return { dispose() {} };
      },
      releaseRuntime() {},
    },
  });
  const starting = fixture.supervisor.start(fixture.manifest.id);
  await processReady;
  try {
    assert.deepEqual(events, ["start", "monitor", "process-ready"]);
  } finally {
    releaseActivation();
  }
  await starting;
  assert.equal(events.filter((event) => event === "monitor").length, 1);
  await fixture.supervisor.stop(fixture.manifest.id);
});

test("repeated activation failures quarantine after the third crash window event", async (context) => {
  const fixture = createFixture(context, () => ({
    async start() { throw new Error("activation failed"); },
    async stop() {},
  }));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(fixture.supervisor.start(fixture.manifest.id), /activation failed/);
  }
  const plugin = fixture.database.getActivePlugin(fixture.manifest.id);
  assert.equal(plugin.runtime.status, "quarantined");
  assert.ok(plugin.runtime.quarantinedAt != null);
  await assert.rejects(fixture.supervisor.start(fixture.manifest.id), /quarantined/);
});

test("unexpected process exit is contained and recorded without touching other runtimes", async (context) => {
  let exit;
  const fixture = createFixture(context, (options) => {
    exit = options.onExit;
    return {
      async start(config) {
        return {
          pluginId: config.pluginId,
          pluginVersion: config.pluginVersion,
          apiVersion: config.apiVersion,
          enabledFeatures: config.enabledFeatures,
        };
      },
      async stop() {},
    };
  });
  await fixture.supervisor.start(fixture.manifest.id);
  exit({ expected: false, error: new Error("process crashed") });
  await new Promise((resolve) => setImmediate(resolve));
  const plugin = fixture.database.getActivePlugin(fixture.manifest.id);
  assert.equal(plugin.runtime.status, "error");
  assert.match(plugin.runtime.lastError, /process crashed/);
});

test("a startup exit and its rejected start count as one crash", async (context) => {
  let attempts = 0;
  const fixture = createFixture(context, (options) => ({
    async start() {
      attempts += 1;
      options.onExit({ expected: false, error: new Error("startup process exit") });
      throw new Error("startup rejected");
    },
    async stop() {},
  }));

  await assert.rejects(fixture.supervisor.start(fixture.manifest.id), /startup rejected/);
  await assert.rejects(fixture.supervisor.start(fixture.manifest.id), /startup rejected/);
  assert.equal(attempts, 2);
  assert.equal(fixture.database.getActivePlugin(fixture.manifest.id).runtime.status, "error");
  await assert.rejects(fixture.supervisor.start(fixture.manifest.id), /startup rejected/);
  assert.equal(fixture.database.getActivePlugin(fixture.manifest.id).runtime.status, "quarantined");
});

test("deactivation failure still leaves the runtime stopped", async (context) => {
  const fixture = createFixture(context, () => ({
    async start(config) {
      return {
        pluginId: config.pluginId,
        pluginVersion: config.pluginVersion,
        apiVersion: config.apiVersion,
        enabledFeatures: config.enabledFeatures,
      };
    },
    async stop() { throw new Error("deactivation timed out"); },
  }));
  await fixture.supervisor.start(fixture.manifest.id);
  await fixture.supervisor.stop(fixture.manifest.id);
  const plugin = fixture.database.getActivePlugin(fixture.manifest.id);
  assert.equal(plugin.runtime.status, "stopped");
  assert.match(plugin.runtime.lastError, /deactivation timed out/);
});

test("supervisor composes host routes with immutable activation identity for downstream capabilities", async (context) => {
  const registry = new PluginHostRpcRegistry();
  registry.registerRequest("settings.get", async (_params, identity) => ({
    manifestFrozen: Object.isFrozen(identity.manifest) && Object.isFrozen(identity.manifest.main),
    pluginId: identity.pluginId,
    pluginVersion: identity.pluginVersion,
    runtimeId: identity.runtimeId,
  }));
  let runtimeOptions;
  const fixture = createFixture(context, (options) => {
    runtimeOptions = options;
    return {
      async start(config) {
        return {
          pluginId: config.pluginId,
          pluginVersion: config.pluginVersion,
          apiVersion: config.apiVersion,
          enabledFeatures: config.enabledFeatures,
        };
      },
      async stop() {},
    };
  }, { rpcRegistry: registry });
  await fixture.supervisor.start(fixture.manifest.id);
  const result = await runtimeOptions.requestHandlers["settings.get"]({}, {
    requestId: 1,
    signal: AbortSignal.timeout(100),
  });
  assert.equal(result.pluginId, fixture.manifest.id);
  assert.equal(result.manifestFrozen, true);
  assert.equal(result.pluginVersion, "1.0.0");
  assert.equal(typeof result.runtimeId, "string");
  assert.equal(result.runtimeId, fixture.supervisor.getRuntimeIdentity(fixture.manifest.id).runtimeId);
});

test("supervisor binds the raw transport guard to the host-owned activation identity", async (context) => {
  const guarded = [];
  const fixture = createFixture(context, () => ({
    async start(config) {
      return {
        pluginId: config.pluginId,
        pluginVersion: config.pluginVersion,
        apiVersion: config.apiVersion,
        enabledFeatures: config.enabledFeatures,
      };
    },
    async stop() {},
  }), {
    runtimeMessageGuard(identity, message) {
      guarded.push({ identity, message });
    },
  });
  await fixture.supervisor.start(fixture.manifest.id);
  const message = { jsonrpc: "2.0", method: "$/progress" };
  fixture.runtimeOptions[0].onBeforeMessage(message);

  assert.equal(guarded.length, 1);
  assert.equal(guarded[0].message, message);
  assert.equal(guarded[0].identity.pluginId, fixture.manifest.id);
  assert.equal(guarded[0].identity.runtimeId, fixture.supervisor.getRuntimeIdentity(fixture.manifest.id).runtimeId);
  assert.equal(Object.isFrozen(guarded[0].identity), true);
  assert.equal(Object.isFrozen(guarded[0].identity.manifest), true);
});

test("supervisor exposes bounded host-to-plugin calls and rejects stale active versions", async (context) => {
  const calls = [];
  let runtimeOptions;
  const fixture = createFixture(context, (options) => {
    runtimeOptions = options;
    return {
      async start(config) {
        return {
          pluginId: config.pluginId,
          pluginVersion: config.pluginVersion,
          apiVersion: config.apiVersion,
          enabledFeatures: config.enabledFeatures,
        };
      },
      async stop() {},
      async request(method, params, requestOptions) {
        calls.push(["request", method, params, requestOptions]);
        return { status: "ok" };
      },
      notify(method, params) { calls.push(["notify", method, params]); },
      async openStream(streamId, windowBytes) {
        calls.push(["stream", streamId, windowBytes]);
        return { streamId };
      },
    };
  });
  await fixture.supervisor.start(fixture.manifest.id);
  const currentIdentity = fixture.supervisor.getRuntimeIdentity(fixture.manifest.id);
  assert.deepEqual(
    await fixture.supervisor.request(fixture.manifest.id, "commands.execute", { command: "run" }),
    { status: "ok" },
  );
  await fixture.supervisor.notify(fixture.manifest.id, "settings.changed", { key: "theme" });
  assert.deepEqual(
    await fixture.supervisor.openStream(fixture.manifest.id, "provider-output", 1024, {
      expectedIdentity: currentIdentity,
    }),
    { streamId: "provider-output" },
  );
  assert.deepEqual(calls.map(([kind]) => kind), ["request", "notify", "stream"]);
  const staleIdentity = { ...currentIdentity, runtimeId: "runtime:stale" };
  await assert.rejects(
    fixture.supervisor.request(fixture.manifest.id, "provider.invoke", {}, {
      expectedIdentity: staleIdentity,
    }),
    (error) => error?.code === RPC_ERRORS.unavailable,
  );
  await assert.rejects(
    fixture.supervisor.notify(fixture.manifest.id, "plugin.terminal.event", {}, {
      expectedIdentity: staleIdentity,
    }),
    (error) => error?.code === RPC_ERRORS.unavailable,
  );
  await assert.rejects(
    fixture.supervisor.openStream(fixture.manifest.id, "stale-output", 1024, {
      expectedIdentity: staleIdentity,
    }),
    (error) => error?.code === RPC_ERRORS.unavailable,
  );
  assert.deepEqual(calls.map(([kind]) => kind), ["request", "notify", "stream"]);
  await assert.rejects(
    fixture.supervisor.request(fixture.manifest.id, "plugin.activate", {}),
    /reserved/,
  );

  const replacement = pluginManifest({ version: "2.0.0" });
  fixture.database.installVersion({
    pluginId: replacement.id,
    version: replacement.version,
    manifest: replacement,
    archiveSha256: "b".repeat(64),
    packageRelativePath: `${replacement.id}/${replacement.version}/package`,
  });
  await assert.rejects(
    fixture.supervisor.request(fixture.manifest.id, "commands.execute", {}),
    /stale or inactive/,
  );
  await assert.rejects(
    runtimeOptions.requestHandlers["storage.keys"]({}, { signal: AbortSignal.timeout(100) }),
    (error) => error?.code === -32014,
  );
});

test("runtime placement and state events are injectable without changing lifecycle ownership", async (context) => {
  const events = [];
  const fixture = createFixture(context, () => ({
    async start(config) {
      return {
        pluginId: config.pluginId,
        pluginVersion: config.pluginVersion,
        apiVersion: config.apiVersion,
        enabledFeatures: config.enabledFeatures,
      };
    },
    async stop() {},
  }), {
    resolveRuntimeKind({ availableKinds, plugin }) {
      assert.deepEqual(availableKinds, ["browser", "utility"]);
      assert.equal(Object.isFrozen(plugin), true);
      assert.equal(Object.isFrozen(plugin.manifest), true);
      return "utility";
    },
  });
  const disposable = fixture.supervisor.onDidChangeRuntime((event) => events.push(event));
  await fixture.supervisor.start(fixture.manifest.id);
  await fixture.supervisor.stop(fixture.manifest.id);
  disposable.dispose();
  assert.deepEqual(events.map(({ status }) => status), ["starting", "running", "stopped"]);
  assert.equal(events[0].runtimeKind, "utility");
  assert.equal(events[0].runtimeId, events[2].runtimeId);
});

test("supervisor transfers privileged terminal ports only to the exact utility runtime identity", async (context) => {
  const attached = [];
  let releaseAttachment;
  const fixture = createFixture(context, () => ({
    async start(config) {
      return {
        pluginId: config.pluginId,
        pluginVersion: config.pluginVersion,
        apiVersion: config.apiVersion,
        enabledFeatures: config.enabledFeatures,
      };
    },
    async stop() {},
    attachTerminalInterceptor(descriptor, port) {
      attached.push({ descriptor, port });
      return new Promise((resolve) => { releaseAttachment = resolve; });
    },
  }), {
    resolveRuntimeKind: () => "utility",
  });
  await fixture.supervisor.start(fixture.manifest.id);
  const identity = fixture.supervisor.getRuntimeIdentity(fixture.manifest.id);
  const port = { close() {} };
  let attachmentFinished = false;
  const attachment = fixture.supervisor.attachTerminalInterceptor(
    fixture.manifest.id,
    { providerId: "com.example.input", direction: "input" },
    port,
    { expectedIdentity: identity },
  ).then(() => { attachmentFinished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attached[0].port, port);
  assert.equal(attachmentFinished, false);
  releaseAttachment();
  await attachment;
  assert.equal(attachmentFinished, true);
  await assert.rejects(
    fixture.supervisor.attachTerminalInterceptor(
      fixture.manifest.id,
      { providerId: "com.example.input", direction: "input" },
      port,
      { expectedIdentity: { ...identity, runtimeId: "stale-runtime" } },
    ),
    (error) => error?.code === RPC_ERRORS.unavailable,
  );
});

test("progress events carry immutable activation identity for downstream provider correlation", async (context) => {
  let runtimeOptions;
  const fixture = createFixture(context, (options) => {
    runtimeOptions = options;
    return {
      async start(config) {
        return {
          pluginId: config.pluginId,
          pluginVersion: config.pluginVersion,
          apiVersion: config.apiVersion,
          enabledFeatures: config.enabledFeatures,
        };
      },
      async stop() {},
    };
  });
  const events = [];
  const disposable = fixture.supervisor.onDidReportProgress((event) => events.push(event));
  await fixture.supervisor.start(fixture.manifest.id);
  const value = { kind: "report", message: "Parsing", percentage: 25 };
  runtimeOptions.onProgress({ token: "import-1", value });
  value.message = "spoofed";
  disposable.dispose();
  assert.equal(events.length, 1);
  assert.equal(events[0].runtimeId, fixture.supervisor.getRuntimeIdentity(fixture.manifest.id).runtimeId);
  assert.equal(events[0].token, "import-1");
  assert.deepEqual(events[0].value, { kind: "report", message: "Parsing", percentage: 25 });
  assert.equal(Object.isFrozen(events[0].value), true);
});

test("host-to-plugin results are discarded when the active runtime changes in flight", async (context) => {
  let resolveRequest;
  const fixture = createFixture(context, () => ({
    async start(config) {
      return {
        pluginId: config.pluginId,
        pluginVersion: config.pluginVersion,
        apiVersion: config.apiVersion,
        enabledFeatures: config.enabledFeatures,
      };
    },
    async stop() {},
    async request() {
      return new Promise((resolve) => { resolveRequest = resolve; });
    },
  }));
  await fixture.supervisor.start(fixture.manifest.id);
  const pending = fixture.supervisor.request(fixture.manifest.id, "provider.invoke", {});
  await new Promise((resolve) => setImmediate(resolve));
  const replacement = pluginManifest({ version: "2.0.0" });
  fixture.database.installVersion({
    pluginId: replacement.id,
    version: replacement.version,
    manifest: replacement,
    archiveSha256: "b".repeat(64),
    packageRelativePath: `${replacement.id}/${replacement.version}/package`,
  });
  resolveRequest({ status: "ok", stale: true });
  await assert.rejects(pending, (error) => error?.code === -32014);
});

test("a host stream is cancelled when the active runtime changes while it opens", async (context) => {
  let resolveOpen;
  let cancelled = 0;
  const fixture = createFixture(context, () => ({
    async start(config) {
      return {
        pluginId: config.pluginId,
        pluginVersion: config.pluginVersion,
        apiVersion: config.apiVersion,
        enabledFeatures: config.enabledFeatures,
      };
    },
    async stop() {},
    async openStream() {
      return new Promise((resolve) => { resolveOpen = resolve; });
    },
  }));
  await fixture.supervisor.start(fixture.manifest.id);
  const pending = fixture.supervisor.openStream(fixture.manifest.id, "import-output", 1024);
  await new Promise((resolve) => setImmediate(resolve));
  const replacement = pluginManifest({ version: "2.0.0" });
  fixture.database.installVersion({
    pluginId: replacement.id,
    version: replacement.version,
    manifest: replacement,
    archiveSha256: "b".repeat(64),
    packageRelativePath: `${replacement.id}/${replacement.version}/package`,
  });
  resolveOpen({ cancel() { cancelled += 1; } });
  await assert.rejects(pending, (error) => error?.code === -32014);
  assert.equal(cancelled, 1);
});

test("runtime placement cannot start a version replaced while policy is pending", async (context) => {
  let resolvePlacement;
  let factoryCalls = 0;
  let markPlacementEntered;
  const placementEntered = new Promise((resolve) => { markPlacementEntered = resolve; });
  const fixture = createFixture(context, () => {
    factoryCalls += 1;
    return {};
  }, {
    resolveRuntimeKind: async () => {
      markPlacementEntered();
      return new Promise((resolve) => { resolvePlacement = resolve; });
    },
  });
  const pending = fixture.supervisor.start(fixture.manifest.id);
  await placementEntered;
  const replacement = pluginManifest({ version: "2.0.0" });
  fixture.database.installVersion({
    pluginId: replacement.id,
    version: replacement.version,
    manifest: replacement,
    archiveSha256: "b".repeat(64),
    packageRelativePath: `${replacement.id}/${replacement.version}/package`,
  });
  resolvePlacement("browser");
  await assert.rejects(pending, (error) => error?.code === -32014);
  assert.equal(factoryCalls, 0);
  assert.equal(fixture.database.getActivePlugin(fixture.manifest.id).activeVersion, "2.0.0");
  assert.equal(fixture.database.getActivePlugin(fixture.manifest.id).runtime.lastError, null);
});

test("stop cancels a pending runtime placement decision before a process is created", async (context) => {
  let placementSignal;
  let markPlacementEntered;
  const placementEntered = new Promise((resolve) => { markPlacementEntered = resolve; });
  let factoryCalls = 0;
  const fixture = createFixture(context, () => {
    factoryCalls += 1;
    return {};
  }, {
    resolveRuntimeKind({ signal }) {
      placementSignal = signal;
      markPlacementEntered();
      return new Promise(() => {});
    },
  });
  const pending = fixture.supervisor.start(fixture.manifest.id);
  await placementEntered;
  await fixture.supervisor.stop(fixture.manifest.id);
  await assert.rejects(pending, (error) => error?.code === -32001);
  assert.equal(placementSignal.aborted, true);
  assert.equal(factoryCalls, 0);
  assert.equal(fixture.database.getActivePlugin(fixture.manifest.id).runtime.status, "stopped");
});

test("stop cancels activation without recording a plugin crash", async (context) => {
  let rejectActivation;
  let markActivationEntered;
  const activationEntered = new Promise((resolve) => { markActivationEntered = resolve; });
  const fixture = createFixture(context, () => ({
    start() {
      markActivationEntered();
      return new Promise((_resolve, reject) => { rejectActivation = reject; });
    },
    async stop() {
      rejectActivation(new Error("activation stopped"));
    },
  }));
  const pending = fixture.supervisor.start(fixture.manifest.id);
  await activationEntered;
  await fixture.supervisor.stop(fixture.manifest.id);
  await assert.rejects(pending, (error) => error?.code === -32001);
  const active = fixture.database.getActivePlugin(fixture.manifest.id);
  assert.equal(active.runtime.status, "stopped");
  assert.equal(active.runtime.lastError, null);
  assert.equal(Number(fixture.database.db.prepare(
    "SELECT COUNT(*) AS count FROM plugin_crashes WHERE plugin_id = ?",
  ).get(fixture.manifest.id).count), 0);
});

test("stop finishes even when plugin activation never settles", async (context) => {
  let markActivationEntered;
  const activationEntered = new Promise((resolve) => { markActivationEntered = resolve; });
  let stops = 0;
  const fixture = createFixture(context, () => ({
    start() {
      markActivationEntered();
      return new Promise(() => {});
    },
    async stop() { stops += 1; },
  }));
  const pending = fixture.supervisor.start(fixture.manifest.id);
  await activationEntered;
  await fixture.supervisor.stop(fixture.manifest.id);
  await assert.rejects(pending, (error) => error?.code === -32001);
  assert.equal(stops, 1);
  assert.equal(fixture.supervisor.getRuntimeIdentity(fixture.manifest.id), null);
  assert.equal(fixture.database.getActivePlugin(fixture.manifest.id).runtime.status, "stopped");
});

test("lazy activation waits until the previous runtime has fully stopped", async (context) => {
  let factoryCalls = 0;
  let releaseFirstStop;
  let markFirstStopEntered;
  const firstStopEntered = new Promise((resolve) => { markFirstStopEntered = resolve; });
  const fixture = createFixture(context, () => {
    const instance = factoryCalls;
    factoryCalls += 1;
    return {
      async start(config) {
        return {
          pluginId: config.pluginId,
          pluginVersion: config.pluginVersion,
          apiVersion: config.apiVersion,
          enabledFeatures: config.enabledFeatures,
        };
      },
      async stop() {
        if (instance !== 0) return;
        markFirstStopEntered();
        await new Promise((resolve) => { releaseFirstStop = resolve; });
      },
    };
  });
  const firstIdentity = await fixture.supervisor.start(fixture.manifest.id);
  const stopping = fixture.supervisor.stop(fixture.manifest.id);
  await firstStopEntered;
  const restarting = fixture.supervisor.start(fixture.manifest.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(factoryCalls, 1);
  releaseFirstStop();
  await stopping;
  const secondIdentity = await restarting;
  assert.equal(factoryCalls, 2);
  assert.notEqual(secondIdentity.runtimeId, firstIdentity.runtimeId);
});

test("runtime stop waits for companion cleanup before it resolves", async (context) => {
  const events = [];
  let markCleanupEntered;
  let releaseCleanup;
  const cleanupEntered = new Promise((resolve) => { markCleanupEntered = resolve; });
  const cleanupReleased = new Promise((resolve) => { releaseCleanup = resolve; });
  const fixture = createFixture(context, () => ({
    async start(config) {
      return {
        pluginId: config.pluginId,
        pluginVersion: config.pluginVersion,
        apiVersion: config.apiVersion,
        enabledFeatures: config.enabledFeatures,
      };
    },
    async stop() { events.push("runtime-stop"); },
  }), {
    async runtimeCleanup(identity) {
      events.push(`cleanup:${identity.runtimeId}`);
      markCleanupEntered(identity);
      await cleanupReleased;
    },
  });
  const identity = await fixture.supervisor.start(fixture.manifest.id);
  let settled = false;
  const stopping = fixture.supervisor.stop(fixture.manifest.id).finally(() => { settled = true; });
  const cleanupIdentity = await cleanupEntered;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(cleanupIdentity, identity);
  assert.deepEqual(events, ["runtime-stop", `cleanup:${identity.runtimeId}`]);
  releaseCleanup();
  await stopping;
  assert.equal(fixture.database.getActivePlugin(fixture.manifest.id).runtime.status, "stopped");
});

test("companion cleanup containment failure is persisted and blocks restart", async (context) => {
  const fixture = createFixture(context, () => ({
    async start(config) {
      return {
        pluginId: config.pluginId,
        pluginVersion: config.pluginVersion,
        apiVersion: config.apiVersion,
        enabledFeatures: config.enabledFeatures,
      };
    },
    async stop() {},
  }), {
    async runtimeCleanup() { throw new Error("companion process tree survived"); },
  });
  await fixture.supervisor.start(fixture.manifest.id);

  await assert.rejects(
    fixture.supervisor.stop(fixture.manifest.id),
    /companion process tree survived/,
  );
  const plugin = fixture.database.getActivePlugin(fixture.manifest.id);
  assert.equal(plugin.enabled, false);
  assert.equal(plugin.runtime.status, "quarantined");
  assert.match(plugin.runtime.lastError, /companion process tree survived/);
  assert.notEqual(plugin.runtime.quarantinedAt, null);
  fixture.database.setEnabled(fixture.manifest.id, true);
  fixture.database.clearQuarantine(fixture.manifest.id);
  await assert.rejects(
    fixture.supervisor.start(fixture.manifest.id),
    /restart Netcatty before starting it again/,
  );
});

test("containment failure disables the plugin and blocks replacement activation until restart", async (context) => {
  let factoryCalls = 0;
  const fixture = createFixture(context, () => {
    factoryCalls += 1;
    return {
      async start(config) {
        return {
          pluginId: config.pluginId,
          pluginVersion: config.pluginVersion,
          apiVersion: config.apiVersion,
          enabledFeatures: config.enabledFeatures,
        };
      },
      async stop() {
        throw createContainmentError("advanced process was not reaped");
      },
    };
  });
  await fixture.supervisor.start(fixture.manifest.id);

  await assert.rejects(
    fixture.supervisor.stop(fixture.manifest.id),
    /advanced process was not reaped/,
  );
  const plugin = fixture.database.getActivePlugin(fixture.manifest.id);
  assert.equal(plugin.enabled, false);
  assert.equal(plugin.runtime.status, "quarantined");
  assert.notEqual(plugin.runtime.quarantinedAt, null);
  fixture.database.setEnabled(fixture.manifest.id, true);
  fixture.database.clearQuarantine(fixture.manifest.id);
  await assert.rejects(
    fixture.supervisor.start(fixture.manifest.id),
    /restart Netcatty before starting it again/,
  );
  assert.equal(factoryCalls, 1);
  const stillQuarantined = fixture.database.getActivePlugin(fixture.manifest.id);
  assert.equal(stillQuarantined.enabled, false);
  assert.equal(stillQuarantined.runtime.status, "quarantined");
  assert.notEqual(stillQuarantined.runtime.quarantinedAt, null);
});

test("startup cleanup containment failure blocks replacement activation", async (context) => {
  let factoryCalls = 0;
  const fixture = createFixture(context, () => {
    factoryCalls += 1;
    return {
      async start() {
        throw new Error("activation failed");
      },
      async stop() {
        throw createContainmentError("failed startup process was not reaped");
      },
    };
  });

  await assert.rejects(
    fixture.supervisor.start(fixture.manifest.id),
    /failed startup process was not reaped/,
  );
  let plugin = fixture.database.getActivePlugin(fixture.manifest.id);
  assert.equal(plugin.enabled, false);
  assert.equal(plugin.runtime.status, "quarantined");
  assert.match(plugin.runtime.lastError, /failed startup process was not reaped/);
  assert.notEqual(plugin.runtime.quarantinedAt, null);

  fixture.database.setEnabled(fixture.manifest.id, true);
  fixture.database.clearQuarantine(fixture.manifest.id);
  await assert.rejects(
    fixture.supervisor.start(fixture.manifest.id),
    /restart Netcatty before starting it again/,
  );
  assert.equal(factoryCalls, 1);
  plugin = fixture.database.getActivePlugin(fixture.manifest.id);
  assert.equal(plugin.enabled, false);
  assert.equal(plugin.runtime.status, "quarantined");
  assert.notEqual(plugin.runtime.quarantinedAt, null);
});

test("shutdown cancels unresolved placement and waits for startup cleanup", async (context) => {
  let signal;
  let markPlacementEntered;
  const placementEntered = new Promise((resolve) => { markPlacementEntered = resolve; });
  const fixture = createFixture(context, () => {
    throw new Error("runtime must not be created after shutdown");
  }, {
    resolveRuntimeKind(contextValue) {
      signal = contextValue.signal;
      markPlacementEntered();
      return new Promise(() => {});
    },
  });
  const pending = fixture.supervisor.start(fixture.manifest.id);
  await placementEntered;
  await fixture.supervisor.shutdown();
  await assert.rejects(pending, (error) => error?.code === -32014);
  assert.equal(signal.aborted, true);
  assert.equal(fixture.supervisor.getRuntimeIdentity(fixture.manifest.id), null);
});

test("concurrent supervisor shutdown callers share complete runtime teardown", async (context) => {
  let releaseStop;
  let stopCalls = 0;
  const stopReleased = new Promise((resolve) => { releaseStop = resolve; });
  const fixture = createFixture(context, () => ({
    async start(config) {
      return {
        pluginId: config.pluginId,
        pluginVersion: config.pluginVersion,
        apiVersion: config.apiVersion,
        enabledFeatures: config.enabledFeatures,
      };
    },
    async stop() {
      stopCalls += 1;
      await stopReleased;
    },
  }));
  await fixture.supervisor.start(fixture.manifest.id);

  const first = fixture.supervisor.shutdown();
  const second = fixture.supervisor.shutdown();
  assert.equal(first, second);
  let secondSettled = false;
  void second.finally(() => { secondSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);

  releaseStop();
  await Promise.all([first, second]);
  assert.equal(stopCalls, 1);
  assert.equal(fixture.supervisor.getRuntimeIdentity(fixture.manifest.id), null);
});

test("a stale runtime crash cannot quarantine or overwrite a replacement version", async (context) => {
  let exit;
  const fixture = createFixture(context, (options) => {
    exit = options.onExit;
    return {
      async start(config) {
        return {
          pluginId: config.pluginId,
          pluginVersion: config.pluginVersion,
          apiVersion: config.apiVersion,
          enabledFeatures: config.enabledFeatures,
        };
      },
      async stop() {},
    };
  });
  await fixture.supervisor.start(fixture.manifest.id);
  const replacement = pluginManifest({ version: "2.0.0" });
  fixture.database.installVersion({
    pluginId: replacement.id,
    version: replacement.version,
    manifest: replacement,
    archiveSha256: "b".repeat(64),
    packageRelativePath: `${replacement.id}/${replacement.version}/package`,
  });
  await assert.rejects(
    fixture.supervisor.start(fixture.manifest.id),
    (error) => error?.code === -32014,
  );
  exit({ expected: false, error: new Error("stale process crashed") });
  await new Promise((resolve) => setImmediate(resolve));
  const active = fixture.database.getActivePlugin(fixture.manifest.id);
  assert.equal(active.activeVersion, "2.0.0");
  assert.equal(active.runtime.lastError, null);
  assert.equal(active.runtime.quarantinedAt, null);
  fixture.database.installVersion({
    pluginId: fixture.manifest.id,
    version: fixture.manifest.version,
    manifest: fixture.manifest,
    archiveSha256: "a".repeat(64),
    packageRelativePath: `${fixture.manifest.id}/${fixture.manifest.version}/package`,
  });
  const priorVersion = fixture.database.getActivePlugin(fixture.manifest.id);
  assert.equal(priorVersion.runtime.status, "error");
  assert.match(priorVersion.runtime.lastError, /stale process crashed/);
});

test('new host initializes an exact legacy API plugin with its negotiated legacy revision', async (context) => {
  const observed = [];
  const fixture = createFixture(context, () => ({
    async start(config) { observed.push(config.apiVersion); return { pluginId: config.pluginId, pluginVersion: config.pluginVersion, apiVersion: config.apiVersion, enabledFeatures: config.enabledFeatures }; },
    async stop() {},
  }), { apiVersion: '0.1.0-internal.1', supportedFeatures: ['metadata.brand-icon'] });
  fixture.database.installVersion({
    pluginId: fixture.manifest.id, version: fixture.manifest.version,
    manifest: { ...fixture.manifest, engines: { netcatty: '>=0.0.0', api: '0.1.0-internal' } },
    archiveSha256: 'a'.repeat(64), packageRelativePath: `${fixture.manifest.id}/${fixture.manifest.version}/package`,
  }, { enable: true });
  await fixture.supervisor.start(fixture.manifest.id);
  assert.deepEqual(observed, ['0.1.0-internal']);
  await fixture.supervisor.stop(fixture.manifest.id);
});

test('data-only themes never create a runtime on startup or explicit start',async(t)=>{
 const fixture=createFixture(t,()=>{throw new Error('data pack must not execute');});
 const manifest={...fixture.manifest,main:{data:'theme'},activationEvents:[],features:{required:['appearance.theme-packs']},contributes:{themes:[{id:fixture.manifest.id+'.light',label:'Light',variant:'light',entry:'light.json'}]}};
 fixture.database.installVersion({pluginId:manifest.id,version:manifest.version,manifest,archiveSha256:'a'.repeat(64),packageRelativePath:'theme'}, {enable:true});
 await fixture.supervisor.startEnabled();assert.equal(fixture.runtimeOptions.length,0);
 await assert.rejects(fixture.supervisor.start(manifest.id),/no executable runtime/);assert.equal(fixture.runtimeOptions.length,0);
 await fixture.supervisor.shutdown();
});

test("runtime cleanup closes diagnostic loggers before stale runtime callbacks can write", async (t) => {
  const { PluginLogger } = require("./pluginLogger.cjs");
  const loggers = [];
  const events = [];
  const fixture = createFixture(t, () => ({
    async start(config) { return { pluginId: config.pluginId, pluginVersion: config.pluginVersion, apiVersion: config.apiVersion, enabledFeatures: config.enabledFeatures }; },
    async stop() {},
  }), { logService: {
    createLogger(identity) {
      const logger = new PluginLogger({ identity });
      loggers.push(logger);
      return logger;
    },
    audit(_identity, event) { events.push(event.operation); },
  } });
  t.after(() => fixture.supervisor.shutdown());
  await fixture.supervisor.start(fixture.manifest.id);
  assert.equal(loggers[0].closed, false);
  await fixture.supervisor.stop(fixture.manifest.id);
  assert.equal(loggers[0].closed, true);
  assert.deepEqual(events.slice(0, 3), ["runtime.starting", "runtime.running", "runtime.stopped"]);
  await fixture.runtimeOptions[0].logger.write("info", "synthetic stale callback");
  await fixture.supervisor.start(fixture.manifest.id);
  await fixture.supervisor.shutdown();
  assert.equal(loggers[1].closed, true);
});
