"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PluginDatabase } = require("./database.cjs");
const { PluginSyncSidecarService } = require("./pluginSyncSidecarService.cjs");

function tempDb(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-sidecar-"));
  context.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return new PluginDatabase(path.join(dir, "plugins.sqlite"));
}

test("sidecar table has no package cascade and survives removePlugin", (context) => {
  const database = tempDb(context);
  database.installVersion({
    pluginId: "com.example.sync",
    version: "1.0.0",
    manifest: { id: "com.example.sync", version: "1.0.0" },
    archiveSha256: "a".repeat(64),
    packageRelativePath: "packages/com.example.sync/1.0.0",
  }, { enable: true });
  database.setSyncSidecar("com.example.sync", "account_baseline", "account", { id: "acct" }, 10);
  database.setSetting("com.example.sync", "com.example.sync.theme", "application", "application", "dark");

  assert.deepEqual(database.db.prepare("PRAGMA foreign_key_list(plugin_sync_sidecars)").all(), []);
  database.removePlugin("com.example.sync");

  assert.deepEqual(database.getSyncSidecar("com.example.sync", "account_baseline", "account"), {
    pluginId: database.privateOwner("com.example.sync"),
    kind: "account_baseline",
    key: "account",
    value: { id: "acct" },
    updatedAt: 10,
  });
  assert.equal(
    database.getSetting("com.example.sync", "com.example.sync.theme", "application", "application"),
    "dark",
  );
});

test("collectForSync excludes secrets and preserves missing-plugin baselines", (context) => {
  const database = tempDb(context);
  database.setSyncSidecar("com.missing.plugin", "crdt_baseline", "replica", { clock: 2 }, 5);
  database.setSetting("com.example.sync", "com.example.sync.theme", "application", "application", "dark");
  database.setSetting("com.example.sync", "com.example.sync.token", "application", "application", "secret");

  const contributionService = {
    snapshot() {
      return {
        plugins: [{
          id: "com.example.sync",
          settings: [
            { id: "com.example.sync.theme", secret: false, sync: true, scope: "application" },
            { id: "com.example.sync.token", secret: true, sync: true, scope: "application" },
          ],
        }],
      };
    },
  };

  const service = new PluginSyncSidecarService({ database, contributionService });
  const bundle = service.collectForSync();
  assert.equal(bundle.version, 1);
  assert.ok(bundle.entries.some((entry) => entry.kind === "crdt_baseline" && entry.pluginId === database.privateOwner("com.missing.plugin")));
  assert.ok(bundle.entries.some((entry) => entry.kind === "settings" && entry.value === "dark"));
  assert.equal(bundle.entries.some((entry) => entry.value === "secret"), false);
  // Collected settings must land in the non-cascade table for post-uninstall collect.
  const persisted = database.listAllSyncSidecars();
  assert.ok(persisted.some((entry) => entry.kind === "settings" && entry.value === "dark"));
  assert.ok(persisted.some((entry) => entry.kind === "crdt_baseline"));
});

test("collectForSync re-emits retained sidecars after plugin reinstall without writing settings", (context) => {
  const database = tempDb(context);
  // Sidecar applied while plugin was missing (no plugin_settings row).
  database.setSyncSidecar(
    "com.example.sync",
    "settings",
    "com.example.sync.theme\0application\0application",
    "from-cloud",
    9,
  );
  const service = new PluginSyncSidecarService({
    database,
    contributionService: {
      snapshot() {
        return {
          plugins: [{
            id: "com.example.sync",
            settings: [
              { id: "com.example.sync.theme", secret: false, sync: true, scope: "application" },
            ],
          }],
        };
      },
    },
  });
  const bundle = service.collectForSync();
  assert.ok(bundle.entries.some((e) => e.value === "from-cloud"));
  // Collect must not bypass schema validation by writing plugin_settings.
  assert.equal(
    database.getSetting("com.example.sync", "com.example.sync.theme", "application", "application"),
    undefined,
  );
});

test("collectForSync re-emits settings after plugin uninstall via non-cascade table", (context) => {
  const database = tempDb(context);
  database.installVersion({
    pluginId: "com.example.sync",
    version: "1.0.0",
    manifest: { id: "com.example.sync", version: "1.0.0" },
    archiveSha256: "b".repeat(64),
    packageRelativePath: "packages/com.example.sync/1.0.0",
  }, { enable: true });
  database.setSetting("com.example.sync", "com.example.sync.theme", "application", "application", "dark");

  const contributionService = {
    snapshot() {
      return {
        plugins: [{
          id: "com.example.sync",
          settings: [
            { id: "com.example.sync.theme", secret: false, sync: true, scope: "application" },
          ],
        }],
      };
    },
  };
  const service = new PluginSyncSidecarService({ database, contributionService });
  service.collectForSync();

  database.removePlugin("com.example.sync");
  const missingService = new PluginSyncSidecarService({
    database,
    contributionService: { snapshot: () => ({ plugins: [] }) },
  });
  const afterUninstall = missingService.collectForSync();
  assert.ok(
    afterUninstall.entries.some((entry) => entry.kind === "settings" && entry.value === "dark"),
    "settings sidecar must survive uninstall via non-cascade persistence",
  );
});

test("collectForSync omits deleted settings for installed plugins but keeps missing-plugin rows", (context) => {
  const database = tempDb(context);
  // User reset clears both plugin_settings and the matching sidecar row.
  database.setSyncSidecar(
    "com.example.sync",
    "settings",
    "com.example.sync.theme\0application\0application",
    "stale",
    5,
  );
  database.deleteSyncSidecar(
    "com.example.sync",
    "settings",
    "com.example.sync.theme\0application\0application",
  );
  database.setSyncSidecar("com.missing.plugin", "settings", "com.missing.plugin.x\0application\0application", "keep", 5);
  // Only store a different setting for the installed plugin.
  database.setSetting("com.example.sync", "com.example.sync.other", "application", "application", "ok");

  const service = new PluginSyncSidecarService({
    database,
    contributionService: {
      snapshot() {
        return {
          plugins: [{
            id: "com.example.sync",
            settings: [
              { id: "com.example.sync.theme", secret: false, sync: true, scope: "application" },
              { id: "com.example.sync.other", secret: false, sync: true, scope: "application" },
            ],
          }],
        };
      },
    },
  });
  const bundle = service.collectForSync();
  assert.equal(bundle.entries.some((e) => e.value === "stale"), false);
  assert.ok(bundle.entries.some((e) => e.value === "ok"));
  assert.ok(bundle.entries.some((e) => e.pluginId === database.privateOwner("com.missing.plugin") && e.value === "keep"));
});

test("applyFromSync preserves remote updatedAt when writing settings", async (context) => {
  const database = tempDb(context);
  const service = new PluginSyncSidecarService({
    database,
    contributionService: {
      snapshot() {
        return {
          plugins: [{
            id: "com.example.sync",
            settings: [
              { id: "com.example.sync.theme", secret: false, sync: true, scope: "application" },
            ],
          }],
        };
      },
    },
  });
  await service.applyFromSync({
    version: 1,
    entries: [{
      pluginId: database.privateOwner("com.example.sync"),
      kind: "settings",
      key: "com.example.sync.theme\0application\0application",
      value: "dark",
      updatedAt: 42,
    }],
  });
  const rows = database.listAllSettings();
  const theme = rows.find((r) => r.settingId === "com.example.sync.theme");
  assert.equal(theme?.value, "dark");
  assert.equal(theme?.updatedAt, 42);
});

test("applyFromSync does not drop local baselines for plugins absent remotely", async (context) => {
  const database = tempDb(context);
  database.setSyncSidecar("com.local.only", "account_baseline", "account", { id: "local" }, 1);

  const service = new PluginSyncSidecarService({
    database,
    contributionService: { snapshot: () => ({ plugins: [] }) },
  });
  await service.applyFromSync({
    version: 1,
    entries: [{
      pluginId: database.privateOwner("com.remote.plugin"),
      kind: "settings",
      key: "com.remote.plugin.theme\0application\0application",
      value: "light",
      updatedAt: 2,
    }],
  });

  const all = database.listAllSyncSidecars();
  assert.ok(all.some((entry) => entry.pluginId === database.privateOwner("com.local.only")));
  assert.ok(all.some((entry) => entry.pluginId === database.privateOwner("com.remote.plugin") && entry.value === "light"));
});

test("hydrateInstalledPluginSettings applies retained sidecars through contribution service", async (context) => {
  const database = tempDb(context);
  database.setSyncSidecar(
    "com.example.sync",
    "settings",
    "com.example.sync.theme\0application\0application",
    "from-cloud",
    9,
  );
  const updates = [];
  const service = new PluginSyncSidecarService({
    database,
    contributionService: {
      snapshot() {
        return {
          plugins: [{
            id: "com.example.sync",
            settings: [
              { id: "com.example.sync.theme", secret: false, sync: true, scope: "application" },
            ],
          }],
        };
      },
      async updateSetting(pluginId, settingId, value, scopeId) {
        updates.push({ pluginId, settingId, value, scopeId });
      },
    },
  });
  await service.hydrateInstalledPluginSettings("com.example.sync");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].value, "from-cloud");
  assert.equal(
    database.getSetting("com.example.sync", "com.example.sync.theme", "application", "application"),
    "from-cloud",
  );
});

test("hydrateInstalledPluginSettings skips sidecars older than local settings", async (context) => {
  const database = tempDb(context);
  database.setSetting(
    "com.example.sync",
    "com.example.sync.theme",
    "application",
    "application",
    "local-newer",
    20,
  );
  database.setSyncSidecar(
    "com.example.sync",
    "settings",
    "com.example.sync.theme\0application\0application",
    "from-cloud-stale",
    9,
  );
  const updates = [];
  const service = new PluginSyncSidecarService({
    database,
    contributionService: {
      snapshot() {
        return {
          plugins: [{
            id: "com.example.sync",
            settings: [
              { id: "com.example.sync.theme", secret: false, sync: true, scope: "application" },
            ],
          }],
        };
      },
      async updateSetting(pluginId, settingId, value, scopeId) {
        updates.push({ pluginId, settingId, value, scopeId });
      },
    },
  });
  await service.hydrateInstalledPluginSettings("com.example.sync");
  assert.equal(updates.length, 0);
  assert.equal(
    database.getSetting("com.example.sync", "com.example.sync.theme", "application", "application"),
    "local-newer",
  );
});

test("applyFromSync empty remote clears installed settings without sidecar rows", async (context) => {
  const database = tempDb(context);
  // Pre-sidecar migration residue: setting exists, sidecar table empty.
  database.setSetting(
    "com.example.sync",
    "com.example.sync.theme",
    "application",
    "application",
    "stale-local",
    3,
  );
  const resets = [];
  const service = new PluginSyncSidecarService({
    database,
    contributionService: {
      snapshot() {
        return {
          plugins: [{
            id: "com.example.sync",
            settings: [
              { id: "com.example.sync.theme", secret: false, sync: true, scope: "application" },
            ],
          }],
        };
      },
      async resetSetting(pluginId, settingId, scopeId) {
        resets.push({ pluginId, settingId, scopeId });
        database.deleteSetting(pluginId, settingId, "application", scopeId);
      },
    },
  });
  await service.applyFromSync({ version: 1, entries: [] });
  assert.equal(resets.length, 1);
  assert.equal(
    database.getSetting("com.example.sync", "com.example.sync.theme", "application", "application"),
    undefined,
  );
});

test("applyFromSync deletes stale-scope settings under stored coordinates", async (context) => {
  const database = tempDb(context);
  // Sidecar/key still encodes application scope, but declaration moved to device.
  database.setSetting(
    "com.example.sync",
    "com.example.sync.theme",
    "application",
    "application",
    "stale-scope",
    3,
  );
  database.setSyncSidecar(
    "com.example.sync",
    "settings",
    "com.example.sync.theme\0application\0application",
    "stale-scope",
    3,
  );
  const resets = [];
  const service = new PluginSyncSidecarService({
    database,
    contributionService: {
      snapshot() {
        return {
          plugins: [{
            id: "com.example.sync",
            settings: [
              { id: "com.example.sync.theme", secret: false, sync: true, scope: "device" },
            ],
          }],
        };
      },
      async resetSetting(pluginId, settingId, scopeId) {
        // Simulates normalizeScopeId against the *current* device scope.
        resets.push({ pluginId, settingId, scopeId });
        database.deleteSetting(pluginId, settingId, "device", scopeId === "application" ? "device" : scopeId);
      },
    },
  });
  await service.applyFromSync({ version: 1, entries: [] });
  assert.equal(
    database.getSetting("com.example.sync", "com.example.sync.theme", "application", "application"),
    undefined,
    "stale application-scope row must be deleted by stored-coordinate fallback",
  );
});

test("applyFromSync empty remote bundle wipes missing-plugin retained rows", async (context) => {
  const database = tempDb(context);
  database.setSyncSidecar("com.missing.plugin", "settings", "com.missing.plugin.x\0application\0application", "old", 1);
  const service = new PluginSyncSidecarService({
    database,
    contributionService: { snapshot: () => ({ plugins: [] }) },
  });
  await service.applyFromSync({ version: 1, entries: [] });
  assert.equal(database.listAllSyncSidecars().length, 0);
});

test("applyFromSync does not resurrect missing-plugin keys deleted on another device", async (context) => {
  const database = tempDb(context);
  // Local still has a setting that remote deleted, plus we keep another remote key.
  database.setSyncSidecar(
    "com.missing.plugin",
    "settings",
    "com.missing.plugin.deleted\0application\0application",
    "stale",
    1,
  );
  database.setSyncSidecar(
    "com.missing.plugin",
    "settings",
    "com.missing.plugin.kept\0application\0application",
    "local-old",
    1,
  );
  const service = new PluginSyncSidecarService({
    database,
    contributionService: { snapshot: () => ({ plugins: [] }) },
  });
  await service.applyFromSync({
    version: 1,
    entries: [{
      pluginId: database.privateOwner("com.missing.plugin"),
      kind: "settings",
      key: "com.missing.plugin.kept\0application\0application",
      value: "remote-new",
      updatedAt: 5,
    }],
  });
  const all = database.listAllSyncSidecars();
  assert.equal(
    all.some((entry) => String(entry.key).includes("deleted")),
    false,
    "must not resurrect remote-deleted missing-plugin setting",
  );
  assert.ok(all.some((entry) => entry.value === "remote-new"));
});

test("applyFromSync empty remote bundle preserves local baselines", async (context) => {
  const database = tempDb(context);
  database.setSyncSidecar("com.missing.plugin", "settings", "com.missing.plugin.x\0application\0application", "old", 1);
  database.setSyncSidecar("com.missing.plugin", "account_baseline", "account", { id: "a1" }, 2);
  database.setSyncSidecar("com.missing.plugin", "crdt_baseline", "crdt", { clock: 9 }, 3);
  const service = new PluginSyncSidecarService({
    database,
    contributionService: { snapshot: () => ({ plugins: [] }) },
  });
  await service.applyFromSync({ version: 1, entries: [] });
  const all = database.listAllSyncSidecars();
  assert.equal(all.some((entry) => entry.kind === "settings"), false);
  assert.equal(all.some((entry) => entry.kind === "account_baseline"), true);
  assert.equal(all.some((entry) => entry.kind === "crdt_baseline"), true);
});

test("applyFromSync keeps newer local baseline over older remote (LWW)", async (context) => {
  const database = tempDb(context);
  database.setSyncSidecar("com.example.plugin", "crdt_baseline", "crdt", { clock: 100 }, 100);
  const service = new PluginSyncSidecarService({
    database,
    contributionService: {
      snapshot: () => ({
        plugins: [{
          id: "com.example.plugin",
          settings: [],
        }],
      }),
    },
  });
  await service.applyFromSync({
    version: 1,
    entries: [{
      pluginId: database.privateOwner("com.example.plugin"),
      kind: "crdt_baseline",
      key: "crdt",
      value: { clock: 50 },
      updatedAt: 50,
    }],
  });
  const row = database.listAllSyncSidecars().find((entry) => entry.kind === "crdt_baseline");
  assert.ok(row);
  assert.equal(row.updatedAt, 100);
  assert.deepEqual(row.value, { clock: 100 });
});
