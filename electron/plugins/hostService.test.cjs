"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createPluginHostService } = require("./hostService.cjs");

function createOptions(root, configureRpcRegistry) {
  return {
    app: {
      getAppPath: () => process.cwd(),
      getPath: () => root,
      getVersion: () => "0.0.0",
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    electron: {},
    configureRpcRegistry,
  };
}

function transportContext() {
  return {
    signal: new AbortController().signal,
    logger: { write: async () => {} },
  };
}

test("host-drawn views are available without a development gate", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-preview-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preview = createPluginHostService(createOptions(path.join(root, "preview")));
  const normal = createPluginHostService({ ...createOptions(path.join(root, "normal")), env: {} });
  context.after(() => { preview.database.close(); normal.database.close(); });
  for (const service of [preview, normal]) {
    const expected = true;
    assert.equal(service.runtimeSupervisor.supportedFeatures.includes("views.host-drawn"), expected);
    assert.equal(service.packageStore.supportedFeatures.includes("views.host-drawn"), expected);
  }
});

test("host RPC registry configuration is complete before runtime initialization", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createPluginHostService(createOptions(root, (registry) => {
    registry.registerRequest("custom.test", () => null);
  }));
  context.after(() => service.database.close());
  const routes = service.rpcRegistry.createRoutes({
    pluginId: "com.example.service",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "browser",
  });
  assert.equal(typeof routes.requestHandlers["custom.test"], "function");
  assert.equal(typeof service.terminalProviderService.provide, "function");
});

test("async host RPC registry configuration fails before a service can start", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => createPluginHostService(createOptions(root, async () => {})),
    /must be synchronous/,
  );
});

test("host service forwards the transport quota guard to the runtime supervisor", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let guarded;
  const runtimeMessageGuard = (identity, message) => { guarded = { identity, message }; };
  const service = createPluginHostService({
    ...createOptions(root),
    runtimeMessageGuard,
  });
  context.after(() => service.database.close());
  const identity = { runtimeId: "runtime-1" };
  const message = { jsonrpc: "2.0" };
  service.runtimeSupervisor.runtimeMessageGuard(identity, message);
  assert.deepEqual(guarded, { identity, message });
});

test("host service seeds the latest contribution environment before runtime activation", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createPluginHostService(createOptions(root));
  context.after(() => service.manager.shutdown());
  const environment = { locale: "zh-CN", theme: "dark", reducedMotion: true, highContrast: false };

  await service.contributionService.setEnvironment(environment);

  assert.deepEqual(service.runtimeSupervisor.getInitialEnvironment(), environment);
});

test("runtime cleanup revokes leases before awaiting companion teardown", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createPluginHostService(createOptions(root));
  context.after(() => service.manager.shutdown());
  const events = [];
  let releaseCompanions;
  service.leaseStore.revokeRuntime = (runtimeId) => {
    events.push(`revoke:${runtimeId}`);
  };
  service.companionSupervisor.releaseRuntime = async (runtimeId) => {
    events.push(`release:${runtimeId}`);
    await new Promise((resolve) => {
      releaseCompanions = resolve;
    });
  };

  let settled = false;
  const cleanup = service.runtimeSupervisor.runtimeCleanup({ runtimeId: "runtime-1" })
    .finally(() => {
      settled = true;
    });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ["revoke:runtime-1", "release:runtime-1"]);
  assert.equal(settled, false);
  releaseCompanions();
  await cleanup;
  assert.equal(settled, true);
});

test("runtime trust placement and default Allow require no install permission ceremony", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [];
  const service = createPluginHostService({
    ...createOptions(root),
    resolveRuntimeKind: async () => {
      events.push("placement");
      return "utility";
    },
    requestPermissionDecision: async (request) => {
      events.push(`permission:${request.permission}`);
      return { requestId: request.requestId, decision: "allow", scope: "application" };
    },
  });
  context.after(() => service.manager.shutdown());
  const manifest = {
    manifestVersion: 1,
    id: "com.example.advanced",
    name: "advanced",
    version: "1.0.0",
    publisher: "example",
    engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal <0.2.0" },
    main: { node: "index.js" },
    permissions: { required: ["runtime.advanced", "storage"] },
  };
  assert.equal(await service.runtimeSupervisor.resolveRuntimeKind({
    plugin: { id: manifest.id, activeVersion: manifest.version, manifest },
    availableKinds: ["utility"],
    securityPrincipal: "verified:test-publisher-key",
    signal: new AbortController().signal,
  }), "utility");
  assert.deepEqual(events, ["placement"]);
});

test("first-party placement selects the utility runtime for companion manifests", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requested = [];
  const service = createPluginHostService({
    ...createOptions(root),
    requestPermissionDecision: async (request) => {
      requested.push(request.permission);
      return { requestId: request.requestId, decision: "allow", scope: "application" };
    },
  });
  context.after(() => service.manager.shutdown());
  const manifest = {
    manifestVersion: 1,
    id: "com.example.companion-placement",
    name: "companion-placement",
    version: "1.0.0",
    publisher: "example",
    engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal <0.2.0" },
    main: { browser: "browser.js", node: "node.js" },
    permissions: {
      required: [
        "runtime.advanced",
        {
          permission: "companion.execute",
          resources: ["com.example.companion-placement.helper"],
        },
      ],
    },
    companionExecutables: [{
      id: "com.example.companion-placement.helper",
      variants: [{
        path: "bin/helper",
        platforms: [`${process.platform}-${process.arch}`],
        sha256: "0".repeat(64),
      }],
    }],
  };

  assert.equal(await service.runtimeSupervisor.resolveRuntimeKind({
    plugin: { id: manifest.id, activeVersion: manifest.version, manifest },
    availableKinds: ["browser", "utility"],
    securityPrincipal: "unsigned-package:companion-placement",
    signal: new AbortController().signal,
  }), "utility");
  assert.deepEqual(requested, []);
});

test("first-party placement selects utility for dual-entrypoint terminal interceptors", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requested = [];
  const service = createPluginHostService({
    ...createOptions(root),
    requestPermissionDecision: async (request) => {
      requested.push(request);
      return { requestId: request.requestId, decision: "allow", scope: "application" };
    },
  });
  context.after(() => service.manager.shutdown());
  const manifest = {
    manifestVersion: 1,
    id: "com.example.interceptor-placement",
    name: "interceptor-placement",
    version: "1.0.0",
    publisher: "example",
    engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal <0.2.0" },
    main: { browser: "browser.js", node: "node.js" },
    permissions: {
      required: ["runtime.advanced", "provider.terminal", "terminal.intercept.input"],
    },
    contributes: {
      providers: [{
        id: "com.example.interceptor-placement.input",
        label: "Input filter",
        kind: "terminal.interceptor.input",
      }],
    },
  };
  assert.equal(await service.runtimeSupervisor.resolveRuntimeKind({
    plugin: { id: manifest.id, activeVersion: manifest.version, manifest },
    availableKinds: ["browser", "utility"],
    securityPrincipal: "unsigned-package:interceptor-placement",
    signal: new AbortController().signal,
  }), "utility");
  assert.deepEqual(requested, []);
});

test("secure host methods fail closed without an approver while public logging remains available", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createPluginHostService(createOptions(root));
  context.after(() => service.manager.shutdown());
  service.database.getPermissionMode = () => "ask";
  const routes = service.rpcRegistry.createRoutes({
    pluginId: "com.example.service",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "browser",
    manifest: {
      id: "com.example.service",
      name: "service",
      publisher: "example",
      permissions: { required: ["storage"] },
    },
  });
  await assert.rejects(
    routes.requestHandlers["storage.set"]({ key: "answer", value: 42 }, transportContext()),
    /decision provider failed/,
  );
  await routes.notificationHandlers["log.write"]({ level: "info", message: "hello" }, transportContext());
  assert.equal(service.database.getValue("com.example.service", "answer"), undefined);
});

test("approved host capabilities reuse application grants through the registry", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let prompts = 0;
  const service = createPluginHostService({
    ...createOptions(root),
    requestPermissionDecision: async (request) => {
      prompts += 1;
      return { requestId: request.requestId, decision: "allow", scope: "application" };
    },
  });
  context.after(() => service.manager.shutdown());
  const pluginManifest = {
    manifestVersion: 1,
    id: "com.example.service",
    name: "service",
    version: "1.0.0",
    publisher: "example",
    engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal <0.2.0" },
    main: { browser: "index.js" },
    permissions: { required: ["storage"] },
  };
  service.database.installVersion({
    pluginId: pluginManifest.id,
    version: pluginManifest.version,
    manifest: pluginManifest,
    archiveSha256: "a".repeat(64),
    packageRelativePath: "com.example.service/1.0.0/package",
  });
  service.permissionEngine.setMode({ id: pluginManifest.id, manifest: pluginManifest }, "storage", "ask");
  const routes = service.rpcRegistry.createRoutes({
    pluginId: "com.example.service",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "browser",
    manifest: pluginManifest,
  });
  await routes.requestHandlers["storage.set"]({ key: "answer", value: 42 }, transportContext());
  assert.deepEqual(
    await routes.requestHandlers["storage.get"]({ key: "answer" }, transportContext()),
    { found: true, value: 42 },
  );
  assert.equal(prompts, 1);
});

test("host service wires a handle-bound directory adapter without changing the RPC seam", async (context) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-")));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directoryPath = path.join(root, "enumerate");
  await fsp.mkdir(directoryPath);
  await fsp.writeFile(path.join(directoryPath, "entry.txt"), "entry");
  const service = createPluginHostService({
    ...createOptions(root),
    requestPermissionDecision: async (request) => ({
      requestId: request.requestId,
      decision: "allow",
      scope: "once",
    }),
    openPluginDirectoryHandle: async (directoryPath) => {
      const stats = await fsp.stat(directoryPath);
      const directory = await fsp.opendir(directoryPath);
      return {
        stat: async () => stats,
        read: () => directory.read(),
        close: async () => {
          try { await directory.close(); }
          catch (error) { if (error?.code !== "ERR_DIR_CLOSED") throw error; }
        },
      };
    },
  });
  context.after(() => service.manager.shutdown());
  assert.ok(service.runtimeSupervisor.supportedFeatures.includes("filesystem.directory-enumeration"));
  assert.ok(service.packageStore.supportedFeatures.includes("filesystem.directory-enumeration"));
  const pluginManifest = {
    id: "com.example.directory",
    name: "directory",
    version: "1.0.0",
    publisher: "example",
    permissions: { optional: [{ permission: "filesystem.read", resources: [directoryPath] }] },
  };
  const routes = service.rpcRegistry.createRoutes({
    pluginId: pluginManifest.id,
    pluginVersion: pluginManifest.version,
    runtimeId: "runtime-1",
    runtimeKind: "browser",
    manifest: pluginManifest,
  });
  assert.deepEqual(
    await routes.requestHandlers["filesystem.readDirectory"](
      { path: directoryPath },
      transportContext(),
    ),
    { entries: [{ name: "entry.txt", kind: "file" }] },
  );
});

test("custom host methods without an explicit authorization classification are denied", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createPluginHostService(createOptions(root, (registry) => {
    registry.registerRequest("custom.unclassified", () => ({ value: true }));
  }));
  context.after(() => service.manager.shutdown());
  const routes = service.rpcRegistry.createRoutes({
    pluginId: "com.example.service",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "browser",
    manifest: { permissions: { optional: ["settings.read"] } },
  });
  await assert.rejects(
    routes.requestHandlers["custom.unclassified"]({}, transportContext()),
    /no authorization policy/,
  );
});

test("normal release blocks a custom utility placement before permission prompts", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-normal-mode-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let prompts = 0;
  const service = createPluginHostService({ ...createOptions(root), env: {}, resolveRuntimeKind: () => "utility", requestPermissionDecision: () => { prompts++; } });
  context.after(() => service.database.close());
  await assert.rejects(service.runtimeSupervisor.resolveRuntimeKind({
    plugin: { id: "com.example.safe", manifest: { main: { browser: "index.js" } } },
    availableKinds: ["browser", "utility"],
    signal: new AbortController().signal,
  }), /requires developer mode/);
  assert.equal(prompts, 0);
});

test("host service logs revocation with injected provenance and drains through manager shutdown", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-synthetic-log-host-"));
  let seen;
  const service = createPluginHostService({ ...createOptions(root), resolvePluginProvenance(input) {
    seen = input;
    return { sourceId: "synthetic-host-source", namespace: "test", sourceKind: "local" };
  } });
  t.after(async () => { await service.manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const manifest = { manifestVersion: 1, id: "com.example.synthetic-audit", version: "1.0.0", name: "Synthetic", publisher: "example", engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal <0.2.0" }, main: { browser: "index.js" } };
  service.database.installVersion({ pluginId: manifest.id, version: manifest.version, manifest, archiveSha256: "b".repeat(64), packageRelativePath: `${manifest.id}/${manifest.version}/package` }, { enable: true });
  await service.logService.ready;
  assert.equal(service.logService.status().saveToDisk, false);
  await service.logService.configure({ saveToDisk: true, verbose: false });
  service.permissionEngine.revokeAll(manifest.id);
  await service.logService.sink.flush();
  const record = JSON.parse(await fsp.readFile(service.logService.sink.file(0), "utf8"));
  assert.equal(record.operation, "permission.revoked");
  assert.equal(record.sourceId, "synthetic-host-source");
  assert.equal(record.archiveSha256, "b".repeat(64));
  assert.equal(record.pluginVersion, "1.0.0");
  assert.equal(record.runtimeId, null);
  assert.equal(seen.pluginId, manifest.id);
  assert.equal(seen.archiveSha256, "b".repeat(64));
  await service.manager.shutdown();
  assert.equal(service.logService.sink.closed, true);
});

test("logging always drains before database close when another shutdown stage rejects", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-synthetic-log-shutdown-failure-"));
  const host = createPluginHostService(createOptions(root));
  t.after(async () => { await host.manager.shutdown().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  await host.logService.ready;
  await host.logService.configure({ saveToDisk: true, verbose: false });
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  host.logService.sink.queue = host.logService.sink.queue.then(() => gate);
  const logger = host.logService.createLogger({ pluginId: "com.example.synthetic", pluginVersion: "1.0.0", runtimeId: "host-shutdown", runtimeKind: "browser" }, {});
  logger.audit({ operation: "synthetic.before-shutdown", result: "ok" });
  host.companionSupervisor.shutdown = async () => { throw new Error("synthetic companion shutdown failure"); };
  let settled = false;
  const shutdown = host.manager.shutdown().finally(() => { settled = true; });
  // Attach the rejection assertion before yielding so the expected failure is handled.
  const rejected = assert.rejects(shutdown, /synthetic companion shutdown failure/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.doesNotThrow(() => host.database.db.prepare("SELECT 1").get());
  resume();
  await rejected;
  assert.equal(host.logService.sink.closed, true);
  assert.equal(host.logService.retentionTimer._destroyed, true);
  const record = JSON.parse(await fsp.readFile(host.logService.sink.file(0), "utf8"));
  assert.equal(record.operation, "synthetic.before-shutdown");
});

test("required browser capabilities activate without a permission ceremony", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-synthetic-activation-"));
  let prompts = 0;
  const host = createPluginHostService({ ...createOptions(root), requestPermissionDecision: () => { prompts++; throw new Error("Unexpected install prompt"); } });
  t.after(async () => { await host.manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const manifest = { id: "com.example.synthetic-activation", version: "1.0.0", publisher: "example", main: { browser: "index.js" }, permissions: { required: ["commands"] } };
  assert.equal(await host.runtimeSupervisor.resolveRuntimeKind({ plugin: { id: manifest.id, activeVersion: manifest.version, manifest }, availableKinds: ["browser"], signal: new AbortController().signal }), "browser");
  assert.equal(prompts, 0);
});

test("Deny for the privileged development runtime stops its activation through the manager queue", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-advanced-policy-"));
  const service = createPluginHostService(createOptions(root));
  t.after(async () => { await service.manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  await service.manager.initialize();
  const manifest = { id: "com.example.advanced-policy", version: "1.0.0", publisher: "example", main: { node: "index.js" }, permissions: { required: ["runtime.advanced"] } };
  service.database.installVersion({ pluginId: manifest.id, version: manifest.version, manifest, archiveSha256: "a".repeat(64), packageRelativePath: "synthetic/package" }, { enable: true });
  const identity = { pluginId: manifest.id, pluginVersion: manifest.version, runtimeId: "synthetic-utility", runtimeKind: "utility" };
  let current = identity, stops = 0;
  service.runtimeSupervisor.getRuntimeIdentity = () => current;
  service.runtimeSupervisor.stop = async (pluginId) => { assert.equal(pluginId, manifest.id); stops++; current = null; };
  await service.permissionEngine.setMode(service.database.getActivePlugin(manifest.id), "runtime.advanced", "deny");
  assert.equal(stops, 1); assert.equal(current, null);
  assert.equal(service.database.getActivePlugin(manifest.id).enabled, false);
  assert.equal(service.database.getPermissionMode(manifest.id, "runtime.advanced"), "deny");
  await assert.rejects(service.permissionEngine.authorize({ ...identity, manifest }, { permission: "runtime.advanced" }), /disabled/);
  // A queued teardown for the old source must not disable its replacement.
  service.database.setEnabled(manifest.id, true); current = identity;
  const privateOwner = service.database.privateOwner.bind(service.database);
  const pending = service.permissionEngine.setMode(service.database.getActivePlugin(manifest.id), "runtime.advanced", "deny");
  service.database.privateOwner = () => "synthetic-replacement-owner";
  await assert.rejects(pending, /source changed/);
  assert.equal(stops, 1); assert.equal(current, identity); assert.equal(service.database.getActivePlugin(manifest.id).enabled, true);
  service.database.privateOwner = privateOwner;
});

test("production host composition does not advertise or prompt for unavailable directory enumeration", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-directory-availability-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let prompts = 0;
  const feature = "filesystem.directory-enumeration";
  // Same adapter-free composition as main/registerBridges; even an explicit extra
  // supportedFeatures entry cannot claim an adapter that was never supplied.
  const service = createPluginHostService({ ...createOptions(root), supportedFeatures: [feature],
    requestPermissionDecision: async () => { prompts++; throw new Error("must not prompt"); } });
  context.after(() => service.manager.shutdown());
  assert.equal(service.runtimeSupervisor.supportedFeatures.includes(feature), false);
  assert.equal(service.packageStore.supportedFeatures.includes(feature), false);
  let authorizations = 0, probes = 0;
  service.permissionEngine.authorize = async () => { authorizations++; throw new Error("must not authorize"); };
  service.filesystemBroker.fileSystem = new Proxy({}, { get() { probes++; throw new Error("must not probe"); } });
  const manifest = { id: "com.example.unavailable-directory", version: "1.0.0",
    permissions: { optional: [{ permission: "filesystem.read", resources: [root] }] } };
  const routes = service.rpcRegistry.createRoutes({ pluginId: manifest.id, pluginVersion: manifest.version,
    runtimeId: "runtime-unavailable", runtimeKind: "browser", manifest });
  await assert.rejects(routes.requestHandlers["filesystem.readDirectory"]({ path: root }, transportContext()),
    (error) => error.code === -32012 && /unavailable/.test(error.message));
  assert.equal(authorizations, 0); assert.equal(prompts, 0); assert.equal(probes, 0);
});
