"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { privateOwner, LOCAL_SOURCE } = require("./sourceIdentity.cjs");

const {
  MAX_SECURITY_AUDIT_DETAILS_BYTES,
  PluginDatabase,
  SCHEMA_VERSION,
} = require("./database.cjs");

function createDatabase(context, clock = () => 1_000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-db-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new PluginDatabase(path.join(root, "plugins.sqlite"), { clock });
}

function manifest(id = "com.example.test", version = "1.0.0") {
  return {
    manifestVersion: 1,
    id,
    name: "test",
    version,
    publisher: "example",
    engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal <0.2.0" },
    main: { browser: "dist/index.js" },
  };
}

test("plugin database initializes atomically and rejects newer schemas", (context) => {
  const database = createDatabase(context);
  assert.equal(database.db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.equal(database.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  database.close();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-newer-db-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "plugins.sqlite");
  const newer = new DatabaseSync(file);
  newer.exec("PRAGMA user_version = 99");
  newer.close();
  assert.throws(() => new PluginDatabase(file), /newer than supported/);
});

test("obsolete unpublished v1 layouts fail with an explicit reset instruction", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-obsolete-db-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "plugins.sqlite");
  const obsolete = new DatabaseSync(file);
  obsolete.exec("CREATE TABLE plugins(id TEXT PRIMARY KEY); PRAGMA user_version = 1");
  obsolete.close();
  assert.throws(
    () => new PluginDatabase(file),
    /reset userData\/plugins\/plugins\.sqlite/,
  );
});

test("complete schema-1 databases migrate in place to schema 3 with sidecar and binding tables", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-v1-migrate-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "plugins.sqlite");
  const v1 = new DatabaseSync(file);
  // Full pre-sidecar schema-1 layout (all tables except plugin_sync_sidecars).
  v1.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE plugins (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      active_version TEXT,
      installed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE plugin_versions (
      plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      archive_sha256 TEXT NOT NULL,
      package_relative_path TEXT NOT NULL,
      installed_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, version)
    );
    CREATE TABLE plugin_runtime_state (
      plugin_id TEXT NOT NULL,
      plugin_version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'stopped',
      runtime_kind TEXT,
      last_error TEXT,
      quarantined_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, plugin_version),
      FOREIGN KEY (plugin_id, plugin_version)
        REFERENCES plugin_versions(plugin_id, version) ON DELETE CASCADE
    );
    CREATE TABLE plugin_crashes (
      plugin_id TEXT NOT NULL,
      plugin_version TEXT NOT NULL,
      crashed_at INTEGER NOT NULL,
      FOREIGN KEY (plugin_id, plugin_version)
        REFERENCES plugin_versions(plugin_id, version) ON DELETE CASCADE
    );
    CREATE TABLE plugin_kv (
      plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, key)
    );
    CREATE TABLE plugin_settings (
      plugin_id TEXT NOT NULL,
      setting_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('application', 'workspace', 'host', 'session', 'device')),
      scope_id TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, setting_id, scope, scope_id)
    );
    CREATE TABLE plugin_view_state (
      plugin_id TEXT NOT NULL,
      view_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, view_id, scope_id)
    );
    CREATE TABLE plugin_permission_grants (
      plugin_id TEXT NOT NULL,
      permission TEXT NOT NULL,
      resource TEXT NOT NULL,
      resource_kind TEXT NOT NULL CHECK (resource_kind IN ('exact', 'directory')),
      declaration_hash TEXT NOT NULL,
      granted_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, permission, resource)
    );
    CREATE TABLE plugin_secrets (
      plugin_id TEXT NOT NULL,
      key TEXT NOT NULL,
      secret_ref TEXT NOT NULL UNIQUE,
      ciphertext BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, key)
    );
    CREATE TABLE plugin_security_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_id TEXT NOT NULL,
      event TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    PRAGMA user_version = 1;
  `);
  v1.prepare(
    "INSERT INTO plugins(id, enabled, active_version, installed_at, updated_at) VALUES (?, 1, ?, 1, 1)",
  ).run("com.example.v1", "1.0.0");
  v1.close();

  const database = new PluginDatabase(file);
  assert.equal(database.db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.deepEqual(
    database.db.prepare("PRAGMA table_info(plugin_sync_sidecars)").all().map(({ name }) => name),
    ["plugin_id", "kind", "key", "value_json", "updated_at"],
  );
  assert.deepEqual(
    database.db.prepare("PRAGMA table_info(plugin_sync_provider_bindings)").all().map(({ name }) => name),
    ["provider_id", "plugin_id", "created_at", "updated_at"],
  );
  // Existing rows survive the in-place migration.
  assert.equal(database.db.prepare("SELECT id FROM plugins").get().id, "com.example.v1");
  database.setSyncSidecar("com.example.v1", "settings", "theme\0application\0application", "dark", 2);
  assert.equal(
    database.getSyncSidecar("com.example.v1", "settings", "theme\0application\0application")?.value,
    "dark",
  );
  database.upsertSyncProviderBinding("com.example.v1.sync", "com.example.v1");
  assert.equal(database.getSyncProviderBinding("com.example.v1.sync")?.pluginId, "com.example.v1");
  database.close();
});

test("initial schema scopes runtime and crash state to immutable plugin versions", (context) => {
  const database = createDatabase(context);
  assert.deepEqual(
    database.db.prepare("PRAGMA table_info(plugin_crashes)").all().map(({ name }) => name),
    ["plugin_id", "plugin_version", "crashed_at"],
  );
  assert.deepEqual(
    database.db.prepare("PRAGMA table_info(plugin_runtime_state)").all().map(({ name }) => name),
    [
      "plugin_id",
      "plugin_version",
      "status",
      "runtime_kind",
      "last_error",
      "quarantined_at",
      "updated_at",
    ],
  );
  assert.deepEqual(
    database.db.prepare("PRAGMA table_info(plugin_permission_grants)").all().map(({ name }) => name),
    ["plugin_id", "permission", "resource", "resource_kind", "declaration_hash", "granted_at"],
  );
  assert.deepEqual(
    database.db.prepare("PRAGMA table_info(plugin_secrets)").all().map(({ name }) => name),
    ["plugin_id", "key", "secret_ref", "ciphertext", "created_at", "updated_at"],
  );
  assert.deepEqual(
    database.db.prepare("PRAGMA table_info(plugin_settings)").all().map(({ name }) => name),
    ["plugin_id", "setting_id", "scope", "scope_id", "value_json", "updated_at"],
  );
  assert.deepEqual(
    database.db.prepare("PRAGMA table_info(plugin_view_state)").all().map(({ name }) => name),
    ["plugin_id", "view_id", "scope_id", "state_json", "updated_at"],
  );
  assert.deepEqual(
    database.db.prepare("PRAGMA table_info(plugin_sync_sidecars)").all().map(({ name }) => name),
    ["plugin_id", "kind", "key", "value_json", "updated_at"],
  );
  assert.deepEqual(
    database.db.prepare("PRAGMA table_info(plugin_sync_provider_bindings)").all().map(({ name }) => name),
    ["provider_id", "plugin_id", "created_at", "updated_at"],
  );
  assert.deepEqual(database.db.prepare("PRAGMA foreign_key_list(plugin_settings)").all(), []);
  assert.deepEqual(database.db.prepare("PRAGMA foreign_key_list(plugin_view_state)").all(), []);
  assert.deepEqual(database.db.prepare("PRAGMA foreign_key_list(plugin_sync_sidecars)").all(), []);
  database.close();
});

test("user-owned security records survive package uninstall in the complete v1 schema", (context) => {
  const database = createDatabase(context);
  const pluginManifest = manifest();
  database.installVersion({
    pluginId: pluginManifest.id,
    version: pluginManifest.version,
    manifest: pluginManifest,
    archiveSha256: "a".repeat(64),
    packageRelativePath: `${pluginManifest.id}/${pluginManifest.version}/package`,
  });
  database.upsertPermissionGrant({
    pluginId: pluginManifest.id,
    permission: "network",
    resource: "https://example.com",
    resourceKind: "exact",
    declarationHash: "b".repeat(64),
  });
  database.upsertSecret({
    pluginId: pluginManifest.id,
    key: "api-key",
    secretRef: "secret-reference-0000000000000000",
    ciphertext: Buffer.from("encrypted"),
  });
  database.recordSecurityAudit(pluginManifest.id, "permission.granted", { permission: "network" });

  database.removePlugin(pluginManifest.id);

  assert.equal(database.getActivePlugin(pluginManifest.id), null);
  assert.deepEqual(database.listPermissionGrants(pluginManifest.id).map((grant) => ({
    resource: grant.resource,
    resourceKind: grant.resourceKind,
  })), [{ resource: "https://example.com", resourceKind: "exact" }]);
  assert.equal(database.getSecretByKey(pluginManifest.id, "api-key").secretRef, "secret-reference-0000000000000000");
  assert.deepEqual(database.listSecurityAudit(pluginManifest.id)[0].details, { permission: "network" });
  database.close();
});

test("security audit details are bounded and oversized records retain only a digest", (context) => {
  const database = createDatabase(context);
  database.recordSecurityAudit("com.example.test", "permission.denied", {
    untrusted: "x".repeat(MAX_SECURITY_AUDIT_DETAILS_BYTES + 1),
  });
  const record = database.listSecurityAudit("com.example.test")[0];
  assert.equal(record.details.truncated, true);
  assert.match(record.details.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(record.details, "untrusted"), false);
  database.close();
});

test("version activation and namespaced key/value writes are transactional", (context) => {
  const database = createDatabase(context);
  const pluginManifest = manifest();
  database.installVersion({
    pluginId: pluginManifest.id,
    version: pluginManifest.version,
    manifest: pluginManifest,
    archiveSha256: "a".repeat(64),
    packageRelativePath: "com.example.test/1.0.0/package",
  }, { enable: true });

  const installed = database.getActivePlugin(pluginManifest.id);
  assert.equal(installed.enabled, true);
  assert.equal(installed.activeVersion, "1.0.0");
  assert.deepEqual(installed.manifest, pluginManifest);

  database.setValue(pluginManifest.id, "greeting", { text: "hello" });
  database.setValue(pluginManifest.id, "count", 2);
  assert.deepEqual(database.getValue(pluginManifest.id, "greeting"), { text: "hello" });
  assert.deepEqual(database.listKeys(pluginManifest.id), ["count", "greeting"]);
  database.deleteValue(pluginManifest.id, "count");
  assert.equal(database.getValue(pluginManifest.id, "count"), undefined);
  database.close();
});

test("database transactions reject async callbacks before committing", (context) => {
  const database = createDatabase(context);
  assert.throws(() => database.transaction(async () => {
    database.db.prepare(`
      INSERT INTO plugins(id, enabled, active_version, installed_at, updated_at)
      VALUES ('com.example.async', 0, NULL, 1, 1)
    `).run();
  }), /must be synchronous/);
  assert.equal(database.getActivePlugin("com.example.async"), null);
  database.close();
});

test("recovered versions can atomically replace an enabled version while staying disabled", (context) => {
  const database = createDatabase(context);
  const first = manifest();
  database.installVersion({
    pluginId: first.id,
    version: first.version,
    manifest: first,
    archiveSha256: "a".repeat(64),
    packageRelativePath: `${first.id}/${first.version}/package`,
  }, { enable: true });
  const second = manifest(first.id, "2.0.0");
  database.installVersion({
    pluginId: second.id,
    version: second.version,
    manifest: second,
    archiveSha256: "b".repeat(64),
    packageRelativePath: `${second.id}/${second.version}/package`,
  }, { forceDisabled: true });

  const recovered = database.getActivePlugin(first.id);
  assert.equal(recovered.activeVersion, "2.0.0");
  assert.equal(recovered.enabled, false);
  assert.throws(() => database.installVersion({
    pluginId: second.id,
    version: second.version,
    manifest: second,
    archiveSha256: "b".repeat(64),
    packageRelativePath: `${second.id}/${second.version}/package`,
  }, { enable: true, forceDisabled: true }), /cannot be enabled and force-disabled/);
  database.close();
});

test("active version rollback is compare-and-set and keeps version state isolated", (context) => {
  const database = createDatabase(context);
  const first = manifest();
  const second = manifest(first.id, "2.0.0");
  for (const [pluginManifest, archive] of [[first, "a"], [second, "b"]]) {
    database.installVersion({
      pluginId: pluginManifest.id,
      version: pluginManifest.version,
      manifest: pluginManifest,
      archiveSha256: archive.repeat(64),
      packageRelativePath: `${pluginManifest.id}/${pluginManifest.version}/package`,
    }, { enable: true });
  }
  database.setRuntimeState(first.id, "error", {
    pluginVersion: second.version,
    error: "new version failed",
  });

  const restored = database.setActiveVersion(first.id, first.version, {
    enabled: true,
    expectedActiveVersion: second.version,
  });
  assert.equal(restored.activeVersion, first.version);
  assert.equal(restored.enabled, true);
  assert.equal(restored.runtime.status, "stopped");
  assert.equal(database.getVersion(first.id, second.version).version, second.version);
  assert.throws(() => database.setActiveVersion(first.id, second.version, {
    enabled: true,
    expectedActiveVersion: "3.0.0",
  }), /changed before it could be restored/);
  assert.throws(() => database.setActiveVersion(first.id, "9.0.0"), /version is not installed/);
  database.close();
});

test("three crashes inside five minutes quarantine until explicit recovery", (context) => {
  let now = 10_000;
  const database = createDatabase(context, () => now);
  const pluginManifest = manifest();
  database.installVersion({
    pluginId: pluginManifest.id,
    version: pluginManifest.version,
    manifest: pluginManifest,
    archiveSha256: "a".repeat(64),
    packageRelativePath: "com.example.test/1.0.0/package",
  });

  assert.deepEqual(database.recordCrash(pluginManifest.id, pluginManifest.version, 300_000, 3), {
    count: 1, quarantined: false, quarantinedAt: null,
  });
  now += 1_000;
  assert.equal(database.recordCrash(pluginManifest.id, pluginManifest.version, 300_000, 3).quarantined, false);
  now += 1_000;
  assert.equal(database.recordCrash(pluginManifest.id, pluginManifest.version, 300_000, 3).quarantined, true);
  assert.equal(database.getActivePlugin(pluginManifest.id).runtime.status, "quarantined");

  database.clearQuarantine(pluginManifest.id);
  assert.equal(database.getActivePlugin(pluginManifest.id).runtime.quarantinedAt, null);
  assert.equal(database.getActivePlugin(pluginManifest.id).runtime.status, "stopped");
  database.close();
});

test("activating a new version resets runtime quarantine without forgiving the same version", (context) => {
  const database = createDatabase(context);
  const first = manifest();
  database.installVersion({
    pluginId: first.id,
    version: first.version,
    manifest: first,
    archiveSha256: "a".repeat(64),
    packageRelativePath: `${first.id}/${first.version}/package`,
  }, { enable: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    database.recordCrash(first.id, first.version, 300_000, 3);
  }
  assert.equal(database.getActivePlugin(first.id).runtime.status, "quarantined");

  database.installVersion({
    pluginId: first.id,
    version: first.version,
    manifest: first,
    archiveSha256: "a".repeat(64),
    packageRelativePath: `${first.id}/${first.version}/package`,
  });
  assert.equal(database.getActivePlugin(first.id).runtime.status, "quarantined");

  const second = manifest(first.id, "2.0.0");
  database.installVersion({
    pluginId: second.id,
    version: second.version,
    manifest: second,
    archiveSha256: "b".repeat(64),
    packageRelativePath: `${second.id}/${second.version}/package`,
  });
  const active = database.getActivePlugin(first.id);
  assert.equal(active.activeVersion, "2.0.0");
  assert.equal(active.runtime.status, "stopped");
  assert.equal(active.runtime.lastError, null);
  assert.equal(active.runtime.quarantinedAt, null);
  assert.deepEqual(database.recordCrash(second.id, second.version, 300_000, 3), {
    count: 1,
    quarantined: false,
    quarantinedAt: null,
  });
  assert.deepEqual(database.recordCrash(first.id, first.version, 300_000, 3), {
    count: 4,
    quarantined: true,
    quarantinedAt: 1_000,
  });
  database.clearQuarantine(second.id);
  assert.equal(Number(database.db.prepare(`
    SELECT COUNT(*) AS count FROM plugin_crashes
    WHERE plugin_id = ? AND plugin_version = ?
  `).get(first.id, first.version).count), 4);
  assert.equal(Number(database.db.prepare(`
    SELECT COUNT(*) AS count FROM plugin_crashes
    WHERE plugin_id = ? AND plugin_version = ?
  `).get(second.id, second.version).count), 0);
  database.installVersion({
    pluginId: first.id,
    version: first.version,
    manifest: first,
    archiveSha256: "a".repeat(64),
    packageRelativePath: `${first.id}/${first.version}/package`,
  });
  assert.equal(database.getActivePlugin(first.id).runtime.status, "quarantined");
  assert.equal(database.getActivePlugin(first.id).runtime.quarantinedAt, 1_000);
  database.close();
});

test("schema upgrade backfills bindings from legacy sync-provider-map secrets", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-v2-backfill-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "plugins.sqlite");
  // Bootstrap a schema-2 DB then open with PluginDatabase to migrate to v3.
  const seed = new PluginDatabase(file);
  // Force downgrade-like state: empty bindings + a legacy map secret row.
  seed.db.exec("DELETE FROM plugin_sync_provider_bindings");
  const now = Date.now();
  seed.db.prepare(`
    INSERT INTO plugin_secrets(plugin_id, key, secret_ref, ciphertext, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    privateOwner(LOCAL_SOURCE, "com.example"),
    "sync-provider-map:com.example.sync",
    "ref-legacy-map",
    Buffer.from("sealed"),
    now,
    now,
  );
  seed.db.prepare(`
    INSERT INTO plugin_secrets(plugin_id, key, secret_ref, ciphertext, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    privateOwner(LOCAL_SOURCE, "com.example"),
    "sync-credential",
    "ref-cred",
    Buffer.from("sealed-cred"),
    now,
    now,
  );
  seed.close();

  const database = new PluginDatabase(file);
  // Constructor no longer promotes; hostService seeds after package recovery.
  assert.equal(database.backfillSyncProviderBindingsFromLegacySecrets(), 1);
  assert.equal(database.getSyncProviderBinding("com.example.sync")?.pluginId, "com.example");
  // Consumed map marker so later unbind + reopen cannot re-promote.
  assert.equal(
    database.getSecretByKey("com.example", "sync-provider-map:com.example.sync"),
    null,
    "promoted map markers must be deleted",
  );
  assert.ok(database.getSecretByKey("com.example", "sync-credential"));
  database.close();
});

test("legacy map backfill does not overwrite an existing host binding", (context) => {
  const database = createDatabase(context);
  const now = Date.now();
  // Correct owner already bound.
  database.upsertSyncProviderBinding("com.example.sync.foo", "com.example.sync");
  // Stale parent leftover map secret that would steal ownership if upserted.
  database.db.prepare(`
    INSERT INTO plugin_secrets(plugin_id, key, secret_ref, ciphertext, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    privateOwner(LOCAL_SOURCE, "com.example"),
    "sync-provider-map:com.example.sync.foo",
    "ref-stale-parent-map",
    Buffer.from("sealed"),
    now,
    now,
  );
  const promoted = database.backfillSyncProviderBindingsFromLegacySecrets();
  assert.equal(promoted, 0, "must not promote over an existing binding");
  assert.equal(
    database.getSyncProviderBinding("com.example.sync.foo")?.pluginId,
    "com.example.sync",
    "existing binding must be preserved",
  );
  // Skipped promote leaves non-winning map rows in place (only winners are consumed).
  assert.ok(
    database.getSecretByKey("com.example", "sync-provider-map:com.example.sync.foo"),
    "non-promoted leftover map rows stay until unbind consumes them",
  );
  database.close();
});

test("legacy map backfill skips when no candidate holds sync credentials", (context) => {
  const database = createDatabase(context);
  const now = Date.now();
  // Map-only leftovers: longest namespace must not invent ownership without
  // sync-credential* evidence (parent may be the true owner later).
  for (const [pluginId, key] of [
    ["com.example", "sync-provider-map:com.example.sync.foo"],
    ["com.example.sync", "sync-provider-map:com.example.sync.foo"],
  ]) {
    database.db.prepare(`
      INSERT INTO plugin_secrets(plugin_id, key, secret_ref, ciphertext, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(privateOwner(LOCAL_SOURCE, pluginId), key, `ref-${pluginId}`, Buffer.from("sealed"), now, now);
  }
  const promoted = database.backfillSyncProviderBindingsFromLegacySecrets();
  assert.equal(promoted, 0, "map-only candidates must not bind without credentials");
  assert.equal(database.getSyncProviderBinding("com.example.sync.foo"), null);
  // Unbound maps stay so a later credential-backed promote or live put can resolve.
  assert.ok(database.getSecretByKey("com.example", "sync-provider-map:com.example.sync.foo"));
  assert.ok(database.getSecretByKey("com.example.sync", "sync-provider-map:com.example.sync.foo"));
  database.close();
});

test("legacy map backfill binds sole credential-backed owner when maps conflict", (context) => {
  const database = createDatabase(context);
  const now = Date.now();
  // Parent has leftover map only; nested owner still holds credentials.
  for (const [pluginId, key, ciphertext] of [
    ["com.example", "sync-provider-map:com.example.sync.foo", "map-parent"],
    ["com.example.sync", "sync-provider-map:com.example.sync.foo", "map-nested"],
    ["com.example.sync", "sync-credential", "real-secret"],
  ]) {
    database.db.prepare(`
      INSERT INTO plugin_secrets(plugin_id, key, secret_ref, ciphertext, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(privateOwner(LOCAL_SOURCE, pluginId), key, `ref-${pluginId}-${key}`, Buffer.from(ciphertext), now, now);
  }
  const promoted = database.backfillSyncProviderBindingsFromLegacySecrets();
  assert.equal(promoted, 1);
  assert.equal(
    database.getSyncProviderBinding("com.example.sync.foo")?.pluginId,
    "com.example.sync",
    "sole credential-backed owner must win over map-only parent",
  );
  // All candidate map markers for the promoted provider are consumed.
  assert.equal(database.getSecretByKey("com.example", "sync-provider-map:com.example.sync.foo"), null);
  assert.equal(database.getSecretByKey("com.example.sync", "sync-provider-map:com.example.sync.foo"), null);
  assert.ok(database.getSecretByKey("com.example.sync", "sync-credential"));
  database.close();
});

test("legacy map backfill does not let longest map override credential-backed parent", (context) => {
  const database = createDatabase(context);
  const now = Date.now();
  // True owner is the shorter parent (still has credentials). Nested plugin has
  // only a stale map row - longest map alone must not steal the binding.
  for (const [pluginId, key, ciphertext] of [
    ["com.example", "sync-provider-map:com.example.sync.foo", "map-parent"],
    ["com.example", "sync-credential", "parent-secret"],
    ["com.example.sync", "sync-provider-map:com.example.sync.foo", "map-nested"],
  ]) {
    database.db.prepare(`
      INSERT INTO plugin_secrets(plugin_id, key, secret_ref, ciphertext, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(privateOwner(LOCAL_SOURCE, pluginId), key, `ref-${pluginId}-${key}`, Buffer.from(ciphertext), now, now);
  }
  const promoted = database.backfillSyncProviderBindingsFromLegacySecrets();
  assert.equal(promoted, 1);
  assert.equal(
    database.getSyncProviderBinding("com.example.sync.foo")?.pluginId,
    "com.example",
    "credential-backed parent must win over longer map-only nested id",
  );
  assert.equal(database.getSecretByKey("com.example", "sync-provider-map:com.example.sync.foo"), null);
  assert.equal(database.getSecretByKey("com.example.sync", "sync-provider-map:com.example.sync.foo"), null);
  assert.ok(database.getSecretByKey("com.example", "sync-credential"));
  database.close();
});

test("legacy map backfill skips when multiple credential-backed candidates exist", (context) => {
  const database = createDatabase(context);
  const now = Date.now();
  // Both parent and nested hold credentials + map for the same provider.
  // Longest pluginId is not a reliable owner signal — the shorter parent may
  // be the legitimate owner — so leave unbound rather than guessing.
  for (const [pluginId, key, ciphertext] of [
    ["com.example", "sync-provider-map:com.example.sync.foo", "map-parent"],
    ["com.example", "sync-credential", "parent-secret"],
    ["com.example.sync", "sync-provider-map:com.example.sync.foo", "map-nested"],
    ["com.example.sync", "sync-credential", "nested-secret"],
  ]) {
    database.db.prepare(`
      INSERT INTO plugin_secrets(plugin_id, key, secret_ref, ciphertext, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(privateOwner(LOCAL_SOURCE, pluginId), key, `ref-${pluginId}-${key}`, Buffer.from(ciphertext), now, now);
  }
  const promoted = database.backfillSyncProviderBindingsFromLegacySecrets();
  assert.equal(promoted, 0, "ambiguous credential-backed candidates must not auto-bind");
  assert.equal(database.getSyncProviderBinding("com.example.sync.foo"), null);
  // Maps stay so a live put / explicit bind can resolve ownership later.
  assert.ok(database.getSecretByKey("com.example", "sync-provider-map:com.example.sync.foo"));
  assert.ok(database.getSecretByKey("com.example.sync", "sync-provider-map:com.example.sync.foo"));
  assert.ok(database.getSecretByKey("com.example", "sync-credential"));
  assert.ok(database.getSecretByKey("com.example.sync", "sync-credential"));
  database.close();
});

test("legacy map backfill still consumes maps after unbind tombstone blocks promote", (context) => {
  // Verify prior fix: explicit unbind tombstone blocks re-promote; maps may remain
  // until unbind/delete paths consume them (backfill itself skips and does not
  // delete when promote is blocked).
  const database = createDatabase(context);
  const now = Date.now();
  database.upsertSyncProviderBinding("com.example.sync.foo", "");
  database.db.prepare(`
    INSERT INTO plugin_secrets(plugin_id, key, secret_ref, ciphertext, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    privateOwner(LOCAL_SOURCE, "com.example"),
    "sync-provider-map:com.example.sync.foo",
    "ref-tombstone-map",
    Buffer.from("sealed"),
    now,
    now,
  );
  database.db.prepare(`
    INSERT INTO plugin_secrets(plugin_id, key, secret_ref, ciphertext, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    privateOwner(LOCAL_SOURCE, "com.example"),
    "sync-credential",
    "ref-cred",
    Buffer.from("secret"),
    now,
    now,
  );
  assert.equal(database.backfillSyncProviderBindingsFromLegacySecrets(), 0);
  assert.equal(
    database.getSyncProviderBinding("com.example.sync.foo")?.pluginId,
    "",
    "unbind tombstone must block credential-backed map promote",
  );
  // Map row stays; disconnect/unbind consumption is responsible for cleanup.
  assert.ok(
    database.getSecretByKey("com.example", "sync-provider-map:com.example.sync.foo"),
    "skipped promote leaves map markers for unbind to consume",
  );
  database.close();
});

test("legacy map backfill deletes promoted map markers so unbind cannot resurrect", (context) => {
  const database = createDatabase(context);
  const now = Date.now();
  database.db.prepare(`
    INSERT INTO plugin_secrets(plugin_id, key, secret_ref, ciphertext, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    privateOwner(LOCAL_SOURCE, "com.example"),
    "sync-provider-map:com.example.custom",
    "ref-plugin-owned",
    Buffer.from("plugin-owned-payload"),
    now,
    now,
  );
  // Credential evidence required to promote; non-map secrets must survive map consume.
  database.db.prepare(`
    INSERT INTO plugin_secrets(plugin_id, key, secret_ref, ciphertext, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    privateOwner(LOCAL_SOURCE, "com.example"),
    "sync-credential",
    "ref-cred-keep",
    Buffer.from("cred"),
    now,
    now,
  );
  assert.equal(database.backfillSyncProviderBindingsFromLegacySecrets(), 1);
  assert.equal(database.getSyncProviderBinding("com.example.custom")?.pluginId, "com.example");
  assert.equal(
    database.getSecretByKey("com.example", "sync-provider-map:com.example.custom"),
    null,
    "promoted map markers must be deleted to stop post-unbind resurrection",
  );
  assert.ok(database.getSecretByKey("com.example", "sync-credential"));
  database.close();
});

test("legacy map backfill does not resurrect after explicit unbind tombstone", (context) => {
  const database = createDatabase(context);
  const now = Date.now();
  // Pre-seed a leftover map after an explicit empty-plugin_id unbind tombstone.
  database.upsertSyncProviderBinding("com.example.sync", "");
  database.db.prepare(`
    INSERT INTO plugin_secrets(plugin_id, key, secret_ref, ciphertext, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    privateOwner(LOCAL_SOURCE, "com.example"),
    "sync-provider-map:com.example.sync",
    "ref-leftover-map",
    Buffer.from("sealed"),
    now,
    now,
  );
  assert.equal(database.backfillSyncProviderBindingsFromLegacySecrets(), 0);
  assert.equal(
    database.getSyncProviderBinding("com.example.sync")?.pluginId,
    "",
    "empty-plugin_id unbind tombstone must block re-promotion",
  );
  database.close();
});


test("listInstalledVersions includes inactive package manifests", (context) => {
  const database = createDatabase(context);
  const now = Date.now();
  // Install two versions under one plugin id via raw rows if helpers are heavy.
  database.db.prepare(`
    INSERT INTO plugins(id, enabled, active_version, installed_at, updated_at)
    VALUES (?, 1, ?, ?, ?)
  `).run("com.example", "2.0.0", now, now);
  for (const [version, providerId] of [
    ["1.0.0", "com.example.legacy-sync"],
    ["2.0.0", "com.example.sync"],
  ]) {
    database.db.prepare(`
      INSERT INTO plugin_versions(
        plugin_id, version, manifest_json, archive_sha256, package_relative_path, installed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "com.example",
      version,
      JSON.stringify({
        id: "com.example",
        version,
        contributes: { providers: [{ id: providerId, kind: "sync", label: providerId }] },
      }),
      "a".repeat(64),
      `com.example/${version}/package`,
      now,
    );
  }
  const versions = database.listInstalledVersions();
  assert.equal(versions.length, 2);
  const providerIds = new Set();
  for (const v of versions) {
    for (const p of v.manifest?.contributes?.providers ?? []) {
      if (p.kind === "sync") providerIds.add(p.id);
    }
  }
  assert.ok(providerIds.has("com.example.legacy-sync"));
  assert.ok(providerIds.has("com.example.sync"));
  // Active list only has 2.0.0
  assert.equal(database.listPlugins()[0]?.activeVersion, "2.0.0");
  database.close();
});

test("inferPluginIdForSyncProvider never guesses from credential key prefixes", (context) => {
  const database = createDatabase(context);
  const now = Date.now();
  for (const [pluginId, key] of [
    ["com.example", "sync-credential"],
    ["com.example.backup", "sync-credential"],
    ["com.other", "sync-credential"],
    ["com.example.sync", "sync-credential"],
  ]) {
    database.db.prepare(`
      INSERT INTO plugin_secrets(plugin_id, key, secret_ref, ciphertext, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(privateOwner(LOCAL_SOURCE, pluginId), key, `ref-${pluginId}`, Buffer.from("x"), now, now);
  }
  // Parent prefix alone is not enough: a removed plugin may have owned
  // com.example.backup.sync while only com.example still has credentials.
  assert.equal(database.inferPluginIdForSyncProvider("com.example.backup.sync"), undefined);
  assert.equal(database.inferPluginIdForSyncProvider("com.example.sync"), undefined);
  assert.equal(database.inferPluginIdForSyncProvider("com.other.cloud"), undefined);
  assert.equal(database.inferPluginIdForSyncProvider("com.missing.sync"), undefined);
  database.close();
});

test("sync sidecar enumeration preserves NUL-separated setting coordinates", (context) => {
  const database = createDatabase(context);
  context.after(() => database.close());
  const key = "com.example.test.theme\0application\0application";
  database.setSyncSidecar("com.example.test", "settings", key, "dark", 10);
  assert.equal(database.listSyncSidecars("com.example.test")[0].key, key);
  assert.equal(database.listAllSyncSidecars()[0].key, key);
  database.replaceAllSyncSidecars(database.listAllSyncSidecars());
  assert.equal(database.getSyncSidecar("com.example.test", "settings", key).value, "dark");
});
