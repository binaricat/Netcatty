"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PluginDatabase } = require("./database.cjs");
const { thirdPartySource, LOCAL_SOURCE } = require("./sourceIdentity.cjs");
const { PluginContributionService } = require("./contributionService.cjs");
const { PluginSyncSidecarService } = require("./pluginSyncSidecarService.cjs");
const { settingsSidecarKey } = require("./pluginSyncSidecarHelpers.cjs");
const id = "example.plugin";
const first = thirdPartySource("First", "https://first.example.com");
const second = thirdPartySource("Second", "https://second.example.com");
function install(db, source) {
  db.installVersion({ pluginId: id, version: "1.0.0", manifest: {}, archiveSha256: "a".repeat(64), packageRelativePath: "example.plugin/1.0.0", source });
}
test("schema-4 local provenance survives upgrade and uninstall until explicit reset", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-upgrade-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "db.sqlite");
  let db = new PluginDatabase(file);
  install(db, LOCAL_SOURCE);
  db.setSetting(id, "private", "application", "application", "retained");
  db.db.exec("DROP TABLE plugin_source_bindings; PRAGMA user_version = 4");
  db.close();
  db = new PluginDatabase(file);
  t.after(() => db.close());
  db.removePlugin(id);
  assert.equal(db.getRetainedPluginSource(id).id, "local");
  assert.throws(() => install(db, first), /source differs/);
  assert.equal(db.getSetting(id, "private", "application", "application"), "retained");
  db.clearUninstalledSourceData(id, "local");
  install(db, first);
  assert.equal(db.getSetting(id, "private", "application", "application"), undefined);
});

test("failed provenance backfill does not publish the new schema version", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-upgrade-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "db.sqlite");
  const db = new PluginDatabase(file);
  t.after(() => db.close());
  install(db, LOCAL_SOURCE);
  db.db.exec("DELETE FROM plugin_source_bindings; PRAGMA user_version = 5; CREATE TRIGGER fail_source_backfill BEFORE INSERT ON plugin_source_bindings BEGIN SELECT RAISE(ABORT, 'synthetic backfill failure'); END;");
  assert.throws(() => new PluginDatabase(file, { database: db.db }), /synthetic backfill failure/);
  assert.equal(db.db.prepare("PRAGMA user_version").get().user_version, 5);
  db.db.exec("DROP TRIGGER fail_source_backfill");
  new PluginDatabase(file, { database: db.db });
  db.removePlugin(id);
  assert.equal(db.getRetainedPluginSource(id).id, "local");
  assert.throws(() => install(db, first), /source differs/);
});
test("same ID cannot change source during install, uninstall or database restart without explicit private reset", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-isolation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "db.sqlite");
  let db = new PluginDatabase(file);
  install(db, first);
  db.setValue(id, "key", "old KV");
  assert.deepEqual(db.listKeys(id), ["key"]);
  db.setSetting(id, "greeting", "application", "application", "old setting");
  db.setViewState(id, "view", "self", { private: true });
  db.upsertPermissionGrant({ pluginId: id, permission: "views", resource: "self", resourceKind: "exact", declarationHash: "same-code" });
  db.upsertSecret({ pluginId: id, key: "secret", secretRef: "old-ref", ciphertext: Buffer.from("ciphertext") });
  db.setSyncSidecar(id, "account_baseline", "account", "old baseline");
  assert.equal(db.getSecretByRef(id, "old-ref").pluginId, id);
  assert.deepEqual(db.listPluginIdsWithSecretKeyPrefix("secret"), [id], "host provider recovery receives the current public plugin ID, not its opaque storage owner");
  assert.equal(db.listPermissionGrants(id)[0].pluginId, id);
  assert.throws(() => install(db, second), /source differs/);
  assert.throws(() => db.clearUninstalledSourceData(id, first.id), /Uninstall/);
  db.removePlugin(id);
  db.close();
  db = new PluginDatabase(file);
  t.after(() => db.close());
  assert.throws(() => install(db, second), /source differs/);
  assert.throws(() => install(db, LOCAL_SOURCE), /source differs/);
  assert.throws(() => db.clearUninstalledSourceData(id, second.id), /changed/);
  db.clearUninstalledSourceData(id, first.id);
  install(db, second);
  assert.equal(db.getActivePlugin(id).source.id, second.id);
  assert.equal(db.getValue(id, "key"), undefined);
  assert.equal(db.getSetting(id, "greeting", "application", "application"), undefined);
  assert.equal(db.getViewState(id, "view", "self"), undefined);
  assert.deepEqual(db.listPermissionGrants(id), []);
  assert.equal(db.getSecretByRef(id, "old-ref"), null);
  assert.equal(db.getSyncSidecar(id, "account_baseline", "account"), undefined);
});

test("old-source cloud settings remain orphaned and cannot hydrate a new source", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new PluginDatabase(path.join(root, "db.sqlite"));
  t.after(() => db.close());
  install(db, first);
  const oldOwner = db.privateOwner(id);
  db.removePlugin(id);
  db.clearUninstalledSourceData(id, first.id);
  install(db, second);
  const calls = [];
  const service = new PluginSyncSidecarService({ database: db, contributionService: {
    snapshot: () => ({ plugins: [{ id, settings: [{ id: "greeting", scope: "application", sync: true }] }] }),
    updateSetting: (...args) => calls.push(args),
  } });
  const entry = { pluginId: oldOwner, kind: "settings", key: settingsSidecarKey("greeting", "application", "application"), value: "old remote data", updatedAt: 1000 };
  await service.applyFromSync({ version: 1, entries: [entry] });
  await service.hydrateInstalledPluginSettings(id);
  assert.deepEqual(calls, []);
  assert.equal(db.getSetting(id, "greeting", "application", "application"), undefined);
  await service.applyFromSync({ version: 1, entries: [{ ...entry, pluginId: db.privateOwner(id), value: "new source" }] });
  assert.equal(calls[0][0], id);
  assert.equal(db.getSetting(id, "greeting", "application", "application"), "new source");
});

test("in-flight sync cannot apply local B after A yields and B changes source", { timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-sync-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new PluginDatabase(path.join(root, "db.sqlite"));
  t.after(() => db.close());
  const a = "aa.plugin", b = "bb.plugin";
  const put = (pluginId, source) => db.installVersion({ pluginId, version: "1.0.0", manifest: {
    id: pluginId, version: "1.0.0", main: { browser: "index.js" },
    contributes: { settings: [{ id: `${pluginId}.greeting`, label: "Greeting", control: "text", scope: "application", sync: true }] },
  }, archiveSha256: "a".repeat(64), packageRelativePath: `${pluginId}/1.0.0`, source }, { enable: true });
  put(a, LOCAL_SOURCE); put(b, LOCAL_SOURCE);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const calls = [];
  const contributionService = new PluginContributionService({ database: db, runtimeSupervisor: {
    async notify(pluginId) {
      calls.push(pluginId);
      if (pluginId === a) { entered(); await paused; }
    },
  } });
  const service = new PluginSyncSidecarService({ database: db, contributionService });
  const entries = [a, b].map(pluginId => ({ pluginId: db.privateOwner(pluginId), kind: "settings", key: settingsSidecarKey(`${pluginId}.greeting`, "application", "application"), value: `OLD ${pluginId}`, updatedAt: 1000 }));
  const applying = service.applyFromSync({ version: 1, entries });
  await waiting;
  db.removePlugin(b); db.clearUninstalledSourceData(b, "local"); put(b, first);
  release(); await applying;
  assert.deepEqual(calls, [a]);
  assert.equal(db.getSetting(b, `${b}.greeting`, "application", "application"), undefined);
});

for (const mode of ["apply", "hydrate", "reset"]) {
  test(`${mode} drops post-await writes after the current plugin changes source`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-await-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const db = new PluginDatabase(path.join(root, "db.sqlite"));
    t.after(() => db.close());
    install(db, LOCAL_SOURCE);
    const oldOwner = db.privateOwner(id);
    const key = settingsSidecarKey("greeting", "application", "application");
    db.setSyncSidecar(id, "settings", key, "OLD", 1000);
    db.setSetting(id, "greeting", "application", "application", "OLD", 1000);
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const paused = new Promise(resolve => { release = resolve; });
    const service = new PluginSyncSidecarService({ database: db, contributionService: {
      snapshot: () => ({ plugins: [{ id, settings: [{ id: "greeting", scope: "application", sync: true }] }] }),
      async updateSetting(pluginId, settingId, value) {
        db.setSetting(pluginId, settingId, "application", "application", value);
        entered(); await paused;
      },
      async resetSetting(pluginId, settingId) {
        db.deleteSetting(pluginId, settingId, "application", "application");
        entered(); await paused;
      },
    } });
    const applying = mode === "hydrate" ? service.hydrateInstalledPluginSettings(id)
      : service.applyFromSync({ version: 1, entries: mode === "reset" ? [] : [{ pluginId: oldOwner, kind: "settings", key, value: "OLD REMOTE", updatedAt: 2000 }] });
    await waiting;
    db.removePlugin(id); db.clearUninstalledSourceData(id, "local"); install(db, first);
    db.setSetting(id, "greeting", "application", "application", "NEW", 3000);
    release(); await applying;
    assert.equal(db.getSetting(id, "greeting", "application", "application"), "NEW");
    assert.equal(db.listAllSettings().some(row => row.pluginId === oldOwner), false, "a completed reset must not be undone by stale LWW writes");
  });
}

test("local owners are encoded and raw remote IDs never resolve into another source", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-local-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new PluginDatabase(path.join(root, "db.sqlite"));
  t.after(() => db.close());
  install(db, LOCAL_SOURCE);
  const owner = db.privateOwner(id);
  assert.notEqual(owner, id);
  assert.equal(db.publicPluginId(id), null);
  assert.equal(db.publicPluginId(owner), id);
  db.removePlugin(id); db.clearUninstalledSourceData(id, "local"); install(db, first);
  assert.equal(db.publicPluginId(owner), null);
  const calls = [];
  const service = new PluginSyncSidecarService({ database: db, contributionService: {
    snapshot: () => ({ plugins: [{ id, settings: [{ id: "greeting", scope: "application", sync: true }] }] }),
    updateSetting: (...args) => calls.push(args),
  } });
  await service.applyFromSync({ version: 1, entries: [{ pluginId: id, kind: "settings", key: settingsSidecarKey("greeting", "application", "application"), value: "RAW OLD LOCAL", updatedAt: 1000 }] });
  assert.deepEqual(calls, []);
  assert.equal(db.getSetting(id, "greeting", "application", "application"), undefined);
});

test("schema-6 raw local data converts atomically without a runtime fallback", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-owner-upgrade-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "db.sqlite");
  let db = new PluginDatabase(file);
  install(db, LOCAL_SOURCE);
  db.setSetting(id, "greeting", "application", "application", "RETAIN");
  db.setValue(id, "key", "KEEP KV");
  const owner = db.privateOwner(id);
  db.db.prepare("UPDATE plugin_settings SET plugin_id = ? WHERE plugin_id = ?").run(id, owner);
  db.db.prepare("UPDATE plugin_kv SET key = 'key' WHERE plugin_id = ?").run(id);
  db.db.exec("PRAGMA user_version = 6");
  db.close();
  db = new PluginDatabase(file); t.after(() => db.close());
  assert.equal(db.getSetting(id, "greeting", "application", "application"), "RETAIN");
  assert.equal(db.getValue(id, "key"), "KEEP KV");
  assert.deepEqual(db.listKeys(id), ["key"]);
  assert.equal(db.listAllSettings()[0].pluginId, owner);
  assert.equal(db.db.prepare("PRAGMA user_version").get().user_version, 7);
});

test("owner conversion conflict preserves schema-6 rows and does not publish schema 7", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-owner-conflict-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "db.sqlite");
  const db = new PluginDatabase(file); t.after(() => db.close());
  install(db, LOCAL_SOURCE);
  db.setSetting(id, "greeting", "application", "application", "ENCODED");
  db.db.prepare("INSERT INTO plugin_settings(plugin_id,setting_id,scope,scope_id,value_json,updated_at) VALUES(?, 'greeting', 'application', 'application', ?, 1)").run(id, JSON.stringify("RAW"));
  db.db.exec("PRAGMA user_version = 6");
  assert.throws(() => new PluginDatabase(file, { database: db.db }), /UNIQUE constraint/);
  assert.equal(db.db.prepare("PRAGMA user_version").get().user_version, 6);
  assert.equal(db.db.prepare("SELECT count(*) AS count FROM plugin_settings").get().count, 2);
});
