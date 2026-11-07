"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { PluginManager } = require("./pluginManager.cjs");

test("failed activation leaves a newly installed plugin disabled", async () => {
  const plugin = { id: "com.example.activation-failure", enabled: true };
  let enabled = true;
  const manager = new PluginManager({
    database: {
      close() {},
      listPlugins: () => [],
      setEnabled(pluginId, nextEnabled) {
        assert.equal(pluginId, plugin.id);
        enabled = nextEnabled;
      },
    },
    packageStore: {
      async initialize() {},
      async install() { return plugin; },
    },
    runtimeSupervisor: {
      async start() { throw new Error("activation failed"); },
      async startEnabled() {},
      async stop() {},
    },
  });

  await assert.rejects(manager.install("/tmp/plugin.ncpkg", { enable: true }), /activation failed/);
  assert.equal(enabled, false);
});

test("management mutations are serialized in invocation order", async () => {
  const calls = [];
  let releaseInstall;
  const installBlocked = new Promise((resolve) => { releaseInstall = resolve; });
  const manager = new PluginManager({
    database: {
      close() {},
      getActivePlugin: (pluginId) => ({ id: pluginId, enabled: false }),
      listPlugins: () => [],
      setEnabled(pluginId, enabled) { calls.push(`enabled:${pluginId}:${enabled}`); },
    },
    packageStore: {
      async initialize() {},
      async install() {
        calls.push("install:start");
        await installBlocked;
        calls.push("install:end");
        return { id: "com.example.serial", enabled: false };
      },
    },
    runtimeSupervisor: {
      async startEnabled() {},
      async stop(pluginId) { calls.push(`stop:${pluginId}`); },
    },
  });

  const install = manager.install("/tmp/plugin.ncpkg");
  const disable = manager.setEnabled("com.example.serial", false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["install:start"]);
  releaseInstall();
  await Promise.all([install, disable]);
  assert.deepEqual(calls, [
    "install:start",
    "install:end",
    "enabled:com.example.serial:false",
    "stop:com.example.serial",
  ]);
});

test("explicit enable clears the active version quarantine before starting", async () => {
  const calls = [];
  const pluginId = "com.example.recover";
  const manager = new PluginManager({
    database: {
      close() {},
      getActivePlugin: () => ({
        id: pluginId,
        activeVersion: "1.0.0",
        enabled: false,
        runtime: { quarantinedAt: 123 },
      }),
      listPlugins: () => [],
      clearQuarantine(id, version) { calls.push(`recover:${id}@${version}`); },
      setEnabled(id, enabled) { calls.push(`enabled:${id}:${enabled}`); },
    },
    packageStore: { async initialize() {} },
    runtimeSupervisor: {
      async startEnabled() {},
      async start(id) { calls.push(`start:${id}`); },
    },
  });

  await manager.setEnabled(pluginId, true);
  assert.deepEqual(calls, [
    `recover:${pluginId}@1.0.0`,
    `enabled:${pluginId}:true`,
    `start:${pluginId}`,
  ]);
});

test("installing an enabled version replaces the active runtime", async () => {
  const calls = [];
  const plugin = { id: "com.example.upgrade", enabled: true };
  const manager = new PluginManager({
    database: {
      close() {},
      listPlugins: () => [],
      setEnabled(pluginId, enabled) { calls.push(`enabled:${pluginId}:${enabled}`); },
    },
    packageStore: {
      async initialize() {},
      async install(_archivePath, options) {
        await options.beforeActivate({
          pluginId: plugin.id,
          version: "2.0.0",
          previousPlugin: {
            id: plugin.id,
            enabled: true,
            activeVersion: "1.0.0",
          },
          reason: "switch-active-version",
        });
        calls.push("activate:2.0.0");
        return plugin;
      },
    },
    runtimeSupervisor: {
      async startEnabled() {},
      async stop(pluginId) { calls.push(`stop:${pluginId}`); },
      async start(pluginId) { calls.push(`start:${pluginId}`); },
    },
  });
  assert.equal(await manager.install("/tmp/upgrade.ncpkg"), plugin);
  assert.deepEqual(calls, [
    "enabled:com.example.upgrade:false",
    "stop:com.example.upgrade",
    "activate:2.0.0",
    "start:com.example.upgrade",
  ]);
});

test("failed version preparation restores the previously enabled runtime", async () => {
  const calls = [];
  const pluginId = "com.example.upgrade-rollback";
  let activePlugin = {
    id: pluginId,
    enabled: true,
    activeVersion: "1.0.0",
  };
  const manager = new PluginManager({
    database: {
      close() {},
      getActivePlugin: () => ({ ...activePlugin }),
      listPlugins: () => [],
      setEnabled(id, enabled) {
        assert.equal(id, pluginId);
        activePlugin = { ...activePlugin, enabled };
        calls.push(`enabled:${enabled}`);
      },
    },
    packageStore: {
      async initialize() {},
      async install(_archivePath, options) {
        await options.beforeActivate({
          pluginId,
          version: "2.0.0",
          previousPlugin: { ...activePlugin },
          reason: "switch-active-version",
        });
        calls.push("prepare:failed");
        throw new Error("database switch failed");
      },
    },
    runtimeSupervisor: {
      async startEnabled() {},
      async stop(id) { calls.push(`stop:${id}`); },
      async start(id) { calls.push(`start:${id}`); },
    },
  });

  await assert.rejects(manager.install("/tmp/upgrade.ncpkg"), /database switch failed/);
  assert.deepEqual(calls, [
    "enabled:false",
    `stop:${pluginId}`,
    "prepare:failed",
    "enabled:true",
    `start:${pluginId}`,
  ]);
  assert.equal(activePlugin.enabled, true);
});

test("failed upgraded-version activation restores and restarts the previous version", async () => {
  const calls = [];
  const pluginId = "com.example.upgrade-activation-rollback";
  let activePlugin = {
    id: pluginId,
    enabled: true,
    activeVersion: "1.0.0",
  };
  const manager = new PluginManager({
    database: {
      close() {},
      getActivePlugin: () => ({ ...activePlugin }),
      listPlugins: () => [],
      setActiveVersion(id, version, options) {
        assert.equal(id, pluginId);
        assert.deepEqual(options, { enabled: true, expectedActiveVersion: "2.0.0" });
        activePlugin = { ...activePlugin, activeVersion: version, enabled: options.enabled };
        calls.push(`active:${version}:${options.enabled}`);
      },
      setEnabled(id, enabled) {
        assert.equal(id, pluginId);
        activePlugin = { ...activePlugin, enabled };
        calls.push(`enabled:${enabled}`);
      },
    },
    packageStore: {
      async initialize() {},
      async install(_archivePath, options) {
        await options.beforeActivate({
          pluginId,
          version: "2.0.0",
          previousPlugin: { ...activePlugin },
          reason: "switch-active-version",
        });
        activePlugin = { ...activePlugin, activeVersion: "2.0.0", enabled: true };
        calls.push("active:2.0.0:true");
        return { ...activePlugin };
      },
    },
    runtimeSupervisor: {
      async startEnabled() {},
      async stop(id) { calls.push(`stop:${id}`); },
      async start(id) {
        calls.push(`start:${id}@${activePlugin.activeVersion}`);
        if (activePlugin.activeVersion === "2.0.0") throw new Error("new activation failed");
      },
    },
  });

  await assert.rejects(manager.install("/tmp/upgrade.ncpkg"), /new activation failed/);
  assert.deepEqual(calls, [
    "enabled:false",
    `stop:${pluginId}`,
    "active:2.0.0:true",
    `start:${pluginId}@2.0.0`,
    "enabled:false",
    "active:1.0.0:true",
    `start:${pluginId}@1.0.0`,
  ]);
  assert.deepEqual(activePlugin, { id: pluginId, enabled: true, activeVersion: "1.0.0" });
});

test("failed previous-version restart leaves the restored version disabled", async () => {
  const pluginId = "com.example.upgrade-rollback-fails";
  let activePlugin = { id: pluginId, enabled: true, activeVersion: "1.0.0" };
  const manager = new PluginManager({
    database: {
      close() {},
      getActivePlugin: () => ({ ...activePlugin }),
      listPlugins: () => [],
      setActiveVersion(_id, version, options) {
        activePlugin = { ...activePlugin, activeVersion: version, enabled: options.enabled };
      },
      setEnabled(_id, enabled) { activePlugin = { ...activePlugin, enabled }; },
    },
    packageStore: {
      async initialize() {},
      async install(_archivePath, options) {
        await options.beforeActivate({
          pluginId,
          version: "2.0.0",
          previousPlugin: { ...activePlugin },
          reason: "switch-active-version",
        });
        activePlugin = { ...activePlugin, activeVersion: "2.0.0", enabled: true };
        return { ...activePlugin };
      },
    },
    runtimeSupervisor: {
      async startEnabled() {},
      async stop() {},
      async start() { throw new Error("runtime unavailable"); },
    },
  });

  await assert.rejects(manager.install("/tmp/upgrade.ncpkg"), /runtime unavailable/);
  assert.deepEqual(activePlugin, { id: pluginId, enabled: false, activeVersion: "1.0.0" });
});

test("failed restoration leaves the previous plugin disabled", async () => {
  const calls = [];
  const pluginId = "com.example.upgrade-broken-rollback";
  let activePlugin = { id: pluginId, enabled: true, activeVersion: "1.0.0" };
  const manager = new PluginManager({
    database: {
      close() {},
      getActivePlugin: () => ({ ...activePlugin }),
      listPlugins: () => [],
      setEnabled(id, enabled) {
        assert.equal(id, pluginId);
        activePlugin = { ...activePlugin, enabled };
        calls.push(`enabled:${enabled}`);
      },
    },
    packageStore: {
      async initialize() {},
      async install(_archivePath, options) {
        await options.beforeActivate({
          pluginId,
          version: "2.0.0",
          previousPlugin: { ...activePlugin },
          reason: "replace-active-files",
        });
        throw new Error("replacement failed");
      },
    },
    runtimeSupervisor: {
      async startEnabled() {},
      async stop() { calls.push("stop"); },
      async start() {
        calls.push("start:failed");
        throw new Error("previous package is invalid");
      },
    },
  });

  await assert.rejects(manager.install("/tmp/upgrade.ncpkg"), /replacement failed/);
  assert.deepEqual(calls, [
    "enabled:false",
    "stop",
    "enabled:true",
    "start:failed",
    "enabled:false",
  ]);
  assert.equal(activePlugin.enabled, false);
});

test("uninstall disables lazy activation before stopping and removing code", async () => {
  const calls = [];
  const pluginId = "com.example.remove";
  const manager = new PluginManager({
    database: {
      close() {},
      getActivePlugin: () => ({ id: pluginId, enabled: true }),
      listPlugins: () => [],
      setEnabled(id, enabled) { calls.push(`enabled:${id}:${enabled}`); },
    },
    packageStore: {
      async initialize() {},
      async uninstall(id) {
        calls.push(`uninstall:${id}`);
        return true;
      },
    },
    runtimeSupervisor: {
      async startEnabled() {},
      async stop(id) { calls.push(`stop:${id}`); },
    },
  });
  assert.equal(await manager.uninstall(pluginId), true);
  assert.deepEqual(calls, [
    `enabled:${pluginId}:false`,
    `stop:${pluginId}`,
    `uninstall:${pluginId}`,
  ]);
});

test("uninstall never removes package code when runtime cleanup fails", async () => {
  let uninstallCalls = 0;
  const pluginId = "com.example.contained";
  const manager = new PluginManager({
    database: {
      close() {},
      getActivePlugin: () => ({ id: pluginId, enabled: true }),
      listPlugins: () => [],
      setEnabled() {},
    },
    packageStore: {
      async initialize() {},
      async uninstall() {
        uninstallCalls += 1;
        return true;
      },
    },
    runtimeSupervisor: {
      async startEnabled() {},
      async stop() { throw new Error("companion cleanup failed"); },
    },
  });

  await assert.rejects(manager.uninstall(pluginId), /companion cleanup failed/);
  assert.equal(uninstallCalls, 0);
});

test("concurrent shutdown callers share one complete shutdown operation", async () => {
  let databaseCloses = 0;
  let supervisorShutdowns = 0;
  let beforeCloses = 0;
  const manager = new PluginManager({
    database: {
      close() { databaseCloses += 1; },
      listPlugins: () => [],
    },
    packageStore: { async initialize() {} },
    runtimeSupervisor: {
      async startEnabled() {},
      async shutdown() { supervisorShutdowns += 1; },
    },
    async beforeClose() { beforeCloses += 1; },
  });
  await manager.initialize();

  const first = manager.shutdown();
  const second = manager.shutdown();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(supervisorShutdowns, 1);
  assert.equal(beforeCloses, 1);
  assert.equal(databaseCloses, 1);
});

test("shutdown closes the database even when secure-service cleanup fails", async () => {
  let databaseCloses = 0;
  const manager = new PluginManager({
    database: {
      close() { databaseCloses += 1; },
      listPlugins: () => [],
    },
    packageStore: { async initialize() {} },
    runtimeSupervisor: { async startEnabled() {}, async shutdown() {} },
    async beforeClose() { throw new Error("secure cleanup failed"); },
  });
  await manager.initialize();
  await assert.rejects(manager.shutdown(), /secure cleanup failed/);
  assert.equal(databaseCloses, 1);
});

test("shutdown cancels an in-flight runtime mutation before waiting for its queue", async () => {
  const calls = [];
  let rejectStart;
  let markStartEntered;
  const startEntered = new Promise((resolve) => { markStartEntered = resolve; });
  const pluginId = "com.example.shutdown-placement";
  const manager = new PluginManager({
    database: {
      close() { calls.push("database:close"); },
      getActivePlugin: () => ({
        id: pluginId,
        activeVersion: "1.0.0",
        enabled: false,
        runtime: { quarantinedAt: null },
      }),
      listPlugins: () => [],
      setEnabled(_id, enabled) { calls.push(`enabled:${enabled}`); },
    },
    packageStore: { async initialize() {} },
    runtimeSupervisor: {
      async startEnabled() {},
      start() {
        calls.push("runtime:start");
        markStartEntered();
        return new Promise((_resolve, reject) => { rejectStart = reject; });
      },
      async shutdown() {
        calls.push("runtime:shutdown");
        rejectStart(new Error("placement cancelled by shutdown"));
      },
    },
  });
  await manager.initialize();

  const enabling = manager.setEnabled(pluginId, true);
  await startEntered;
  const shuttingDown = manager.shutdown();
  await assert.rejects(enabling, /placement cancelled by shutdown/);
  await shuttingDown;
  assert.deepEqual(calls, [
    "enabled:true",
    "runtime:start",
    "runtime:shutdown",
    "enabled:false",
    "database:close",
  ]);
});

test("explicit enable checks compatibility before clearing quarantine or exposing lazy contributions", async () => {
  const calls = [];
  const plugin = { id: "com.example.incompatible", enabled: false, runtime: { quarantinedAt: 1 } };
  const manager = new PluginManager({
    database: {
      getActivePlugin: () => plugin,
      clearQuarantine: () => calls.push("clear"),
      setEnabled: () => calls.push("enable"),
    },
    packageStore: {
      async initialize() {},
      async assertCompatible() { throw new Error("Plugin is incompatible"); },
    },
    runtimeSupervisor: {},
    contributionService: {
      async initialize() {},
      onPluginEnabled: () => calls.push("contribute"),
    },
  });
  await assert.rejects(manager.setEnabled(plugin.id, true), /incompatible/);
  assert.deepEqual(calls, []);
});

test("permission revocation disables before clearing grants and waits for runtime cleanup", async () => {
  const calls = [];
  let releaseStop;
  const stopped = new Promise((resolve) => { releaseStop = resolve; });
  let enabled = true;
  const manager = new PluginManager({
    database: {
      getActivePlugin: (id) => ({ id, enabled }),
      setEnabled(_id, value) { enabled = value; calls.push("disable"); },
    },
    packageStore: { async initialize() {} },
    contributionService: {
      async initialize() {},
      onPluginDisabled() { calls.push("contributions"); },
    },
    permissionEngine: { revokeAll() { assert.equal(enabled, false); calls.push("revoke"); } },
    runtimeSupervisor: { async stop() { calls.push("stop"); await stopped; calls.push("clean"); } },
  });
  let complete = false;
  const revoke = manager.revokePermissions("com.example.revoke").then((value) => { complete = true; return value; });
  const enable = manager.setEnabled("com.example.revoke", false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["disable", "revoke", "contributions", "stop"]);
  assert.equal(complete, false);
  releaseStop();
  assert.equal((await revoke).enabled, false);
  await enable;
  assert.deepEqual(calls.slice(4), ["clean", "disable", "contributions", "stop", "clean"]);
});

test("failed runtime containment leaves the revoked plugin disabled and reports failure", async () => {
  let enabled = true;
  let revoked = false;
  const manager = new PluginManager({
    database: { getActivePlugin: () => ({ enabled }), setEnabled(_id, value) { enabled = value; } },
    packageStore: { async initialize() {} },
    contributionService: { async initialize() {}, onPluginDisabled() {} },
    permissionEngine: { revokeAll() { revoked = true; } },
    runtimeSupervisor: { async stop() { throw new Error("containment failed"); } },
  });
  await assert.rejects(manager.revokePermissions("com.example.revoke"), /containment failed/);
  assert.equal(enabled, false);
  assert.equal(revoked, true);
});

test("revocation attempts every cleanup stage and aggregates independent failures", async () => {
  for (const failedStages of [["revoke"], ["contributions"], ["disable"], ["stop"], ["disable", "revoke", "contributions", "stop"]]) {
    const calls = [];
    const fail = (stage) => {
      calls.push(stage);
      if (failedStages.includes(stage)) throw new Error(`${stage} failed`);
    };
    const manager = new PluginManager({
      database: {
        getActivePlugin: () => ({ id: "com.example.revoke", enabled: false }),
        setEnabled() { fail("disable"); },
      },
      packageStore: { async initialize() {} },
      contributionService: { async initialize() {}, onPluginDisabled() { fail("contributions"); } },
      permissionEngine: { revokeAll() { fail("revoke"); } },
      runtimeSupervisor: { async stop() { fail("stop"); } },
    });
    await assert.rejects(manager.revokePermissions("com.example.revoke"), (error) => {
      if (failedStages.length === 1) return error.message === `${failedStages[0]} failed`;
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors.map((entry) => entry.message), failedStages.map((stage) => `${stage} failed`));
      return true;
    });
    assert.deepEqual(calls, ["disable", "revoke", "contributions", "stop"]);
  }
});
