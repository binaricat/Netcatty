"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { LOCAL_SOURCE, assertSource, privateOwner } = require("./sourceIdentity.cjs");

const SCHEMA_VERSION = 7;
const MAX_SECURITY_AUDIT_DETAILS_BYTES = 16 * 1024;
const MAX_SECURITY_AUDIT_RECORDS_PER_PLUGIN = 1_000;
const REQUIRED_SCHEMA_COLUMNS = Object.freeze({
  plugin_source_bindings: ["plugin_id", "source_json"],
  plugin_host_preferences: ["key", "value_json", "updated_at"],
  plugins: ["id", "enabled", "active_version", "installed_at", "updated_at"],
  plugin_versions: ["plugin_id", "version", "manifest_json", "archive_sha256", "package_relative_path", "installed_at"],
  plugin_runtime_state: ["plugin_id", "plugin_version", "status", "runtime_kind", "last_error", "quarantined_at", "updated_at"],
  plugin_crashes: ["plugin_id", "plugin_version", "crashed_at"],
  plugin_kv: ["plugin_id", "key", "value_json", "updated_at"],
  plugin_settings: ["plugin_id", "setting_id", "scope", "scope_id", "value_json", "updated_at"],
  plugin_view_state: ["plugin_id", "view_id", "scope_id", "state_json", "updated_at"],
  plugin_permission_grants: ["plugin_id", "permission", "resource", "resource_kind", "declaration_hash", "granted_at"],
  plugin_secrets: ["plugin_id", "key", "secret_ref", "ciphertext", "created_at", "updated_at"],
  plugin_security_audit: ["id", "plugin_id", "event", "details_json", "created_at"],
  // User-owned encrypted-sync sidecars: no FK cascade on package uninstall.
  plugin_sync_sidecars: ["plugin_id", "kind", "key", "value_json", "updated_at"],
  // Host-owned sync provider→plugin bindings (not plugin-writable secrets).
  plugin_sync_provider_bindings: ["provider_id", "plugin_id", "created_at", "updated_at"],
});

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Corrupt plugin database ${label}`);
  }
}

class PluginDatabase {
  constructor(databasePath, options = {}) {
    if (typeof databasePath !== "string" || !path.isAbsolute(databasePath)) {
      throw new TypeError("Plugin database path must be absolute");
    }
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.databasePath = databasePath;
    this.clock = options.clock ?? (() => Date.now());
    const ownsDatabase = !options.database;
    this.db = options.database ?? new DatabaseSync(databasePath);
    try {
      this.#initializeSchema();
    } catch (error) {
      if (ownsDatabase) {
        try { this.db.close(); } catch {}
      }
      throw error;
    }
  }

  #initializeSchema() {
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      throw new Error(`Plugin database schema ${version} is newer than supported ${SCHEMA_VERSION}`);
    }
    if (version === 0) {
      this.transaction(() => {
        this.db.exec(`
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
          CREATE INDEX plugin_crashes_lookup
            ON plugin_crashes(plugin_id, plugin_version, crashed_at);
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
          CREATE INDEX plugin_settings_lookup
            ON plugin_settings(plugin_id, scope, scope_id, setting_id);
          CREATE TABLE plugin_view_state (
            plugin_id TEXT NOT NULL,
            view_id TEXT NOT NULL,
            scope_id TEXT NOT NULL,
            state_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (plugin_id, view_id, scope_id)
          );
          CREATE INDEX plugin_view_state_lookup
            ON plugin_view_state(plugin_id, scope_id, view_id);
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
          CREATE INDEX plugin_secrets_ref_lookup
            ON plugin_secrets(plugin_id, secret_ref);
          CREATE TABLE plugin_security_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plugin_id TEXT NOT NULL,
            event TEXT NOT NULL,
            details_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX plugin_security_audit_lookup
            ON plugin_security_audit(plugin_id, created_at DESC);
          CREATE TABLE plugin_sync_sidecars (
            plugin_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('settings', 'account_baseline', 'crdt_baseline')),
            key TEXT NOT NULL,
            value_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (plugin_id, kind, key)
          );
          CREATE INDEX plugin_sync_sidecars_lookup
            ON plugin_sync_sidecars(plugin_id, kind, key);
          CREATE TABLE plugin_sync_provider_bindings (
            provider_id TEXT PRIMARY KEY,
            plugin_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          PRAGMA user_version = 3;
        `);
      });
    } else if (version === 1) {
      // Pre-sidecar schema-1 databases only created the original tables.
      // Migrate in place to schema 3 with sidecar + provider binding tables.
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS plugin_sync_sidecars (
            plugin_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('settings', 'account_baseline', 'crdt_baseline')),
            key TEXT NOT NULL,
            value_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (plugin_id, kind, key)
          );
          CREATE INDEX IF NOT EXISTS plugin_sync_sidecars_lookup
            ON plugin_sync_sidecars(plugin_id, kind, key);
          CREATE TABLE IF NOT EXISTS plugin_sync_provider_bindings (
            provider_id TEXT PRIMARY KEY,
            plugin_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          PRAGMA user_version = 3;
        `);
      });
    } else if (version === 2) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS plugin_sync_provider_bindings (
            provider_id TEXT PRIMARY KEY,
            plugin_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          PRAGMA user_version = 3;
        `);
      });
    }
    if (version <= 3) this.transaction(() => this.db.exec(`
      CREATE TABLE plugin_host_preferences (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
      PRAGMA user_version = 4;
    `));
    if (version <= 4) this.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_source_bindings (plugin_id TEXT PRIMARY KEY, source_json TEXT NOT NULL);
    `));
    this.#assertSchemaLayout();
    if (version <= 5) this.transaction(() => {
      // Upgraded installs and retained local private records must keep their
      // provenance after uninstall. Never infer official ownership from names.
      const rows = this.db.prepare(`
        SELECT id AS plugin_id FROM plugins
        UNION SELECT plugin_id FROM plugin_settings
        UNION SELECT plugin_id FROM plugin_view_state
        UNION SELECT plugin_id FROM plugin_permission_grants
        UNION SELECT plugin_id FROM plugin_secrets
        UNION SELECT plugin_id FROM plugin_sync_sidecars
      `).all();
      const insert = this.db.prepare("INSERT OR IGNORE INTO plugin_source_bindings(plugin_id,source_json) VALUES(?,?)");
      for (const row of rows) {
        if (/^[a-z0-9][a-z0-9.-]{1,127}$/u.test(row.plugin_id)) insert.run(row.plugin_id, JSON.stringify(LOCAL_SOURCE));
      }
      this.db.exec("PRAGMA user_version = 6");
    });
    if (version <= 6) this.transaction(() => {
      // One-time conversion of existing local private rows; all sources now use
      // immutable encoded owners. Never retain a raw-ID lookup fallback.
      for (const table of ["plugin_settings", "plugin_view_state", "plugin_permission_grants", "plugin_secrets", "plugin_sync_sidecars"]) {
        const rows = this.db.prepare(`SELECT DISTINCT plugin_id FROM ${table}`).all();
        for (const { plugin_id: id } of rows) {
          if (/^[a-z0-9][a-z0-9.-]{1,127}$/u.test(id)) {
            this.db.prepare(`UPDATE ${table} SET plugin_id = ? WHERE plugin_id = ?`).run(privateOwner(LOCAL_SOURCE, id), id);
          }
        }
      }
      for (const row of this.db.prepare("SELECT plugin_id, key FROM plugin_kv").all()) {
        if (this.getPluginSource(row.plugin_id).id === "local") {
          const prefix = `${privateOwner(LOCAL_SOURCE, row.plugin_id)}:`;
          if (!row.key.startsWith(prefix)) this.db.prepare("UPDATE plugin_kv SET key = ? WHERE plugin_id = ? AND key = ?").run(prefix + row.key, row.plugin_id, row.key);
        }
      }
      this.db.exec("PRAGMA user_version = 7");
    });
    // Legacy-map backfill is deferred until PackageStore.recover() has finished
    // (hostService seeds after package initialize). Running here would promote
    // sole map candidates before recovered manifests are visible, then skip
    // re-evaluation because bindings already exist (Codex P2 on cded4c8a).
  }

  #assertSchemaLayout() {
    for (const [table, columns] of Object.entries(REQUIRED_SCHEMA_COLUMNS)) {
      const actual = this.db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name);
      if (JSON.stringify(actual) !== JSON.stringify(columns)) {
        throw new Error(
          "Pre-release plugin database schema is obsolete; reset userData/plugins/plugins.sqlite",
        );
      }
    }
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      if (result && typeof result.then === "function") {
        throw new TypeError("Plugin database transactions must be synchronous");
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  getPluginSource(pluginId) {
    const row = this.db.prepare("SELECT source_json FROM plugin_source_bindings WHERE plugin_id = ?").get(pluginId);
    return row ? assertSource(parseJson(row.source_json, "source identity")) : { ...LOCAL_SOURCE };
  }

  getRetainedPluginSource(pluginId) {
    const row = this.db.prepare("SELECT source_json FROM plugin_source_bindings WHERE plugin_id = ?").get(pluginId);
    if (row) return assertSource(parseJson(row.source_json, "source identity"));
    return this.db.prepare("SELECT id FROM plugins WHERE id = ?").get(pluginId) ? { ...LOCAL_SOURCE } : null;
  }

  assertInstallSource(pluginId, source = LOCAL_SOURCE) {
    const trusted = assertSource(source);
    const row = this.db.prepare("SELECT source_json FROM plugin_source_bindings WHERE plugin_id = ?").get(pluginId);
    const existing = row ? assertSource(parseJson(row.source_json, "source identity"))
      : this.getActivePlugin(pluginId) ? LOCAL_SOURCE : null;
    if (existing && existing.id !== trusted.id) {
      throw new Error("Plugin source differs. Uninstall and explicitly clear the old source's private data before reinstalling.");
    }
    return trusted;
  }

  privateOwner(pluginId) {
    // Opaque owners enter only from host sync storage, never plugin RPC identity.
    if (/^source:[a-f0-9]{64}:[a-z0-9][a-z0-9.-]{1,127}$/u.test(pluginId)) return pluginId;
    const source = this.getPluginSource(pluginId);
    return privateOwner(source, pluginId);
  }

  publicPluginId(owner) {
    if (!/^source:[a-f0-9]{64}:[a-z0-9][a-z0-9.-]{1,127}$/u.test(owner)) return null;
    const pluginId = owner.slice(owner.lastIndexOf(":") + 1);
    return this.privateOwner(pluginId) === owner ? pluginId : null;
  }

  clearUninstalledSourceData(pluginId, expectedSourceId) {
    if (this.getActivePlugin(pluginId)) throw new Error("Uninstall the plugin before changing its source");
    if (this.getPluginSource(pluginId).id !== expectedSourceId) throw new Error("Plugin source changed; review the reset again");
    const owner = this.privateOwner(pluginId);
    this.transaction(() => {
      for (const table of ["plugin_settings", "plugin_view_state", "plugin_permission_grants", "plugin_secrets", "plugin_sync_sidecars", "plugin_sync_provider_bindings"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE plugin_id = ? OR plugin_id = ?`).run(owner, pluginId);
      }
      this.db.prepare("DELETE FROM plugin_host_preferences WHERE key LIKE ?").run(`permission:${owner}:%`);
      this.db.prepare("DELETE FROM plugin_source_bindings WHERE plugin_id = ?").run(pluginId);
    });
  }

  installVersion(record, options = {}) {
    if (options.enable === true && options.forceDisabled === true) {
      throw new TypeError("Plugin version cannot be enabled and force-disabled together");
    }
    const source = this.assertInstallSource(record.pluginId, record.source);
    const now = this.clock();
    const manifestJson = JSON.stringify(record.manifest);
    const requestedEnabled = options.enable === true ? 1 : 0;
    const overwriteEnabled = options.enable === true || options.forceDisabled === true;
    this.transaction(() => {
      this.db.prepare("INSERT INTO plugin_source_bindings(plugin_id,source_json) VALUES(?,?) ON CONFLICT(plugin_id) DO UPDATE SET source_json=excluded.source_json").run(record.pluginId, JSON.stringify(source));
      this.db.prepare(`
        INSERT INTO plugins(id, enabled, active_version, installed_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          active_version = excluded.active_version,
          enabled = CASE WHEN ? THEN excluded.enabled ELSE plugins.enabled END,
          updated_at = excluded.updated_at
      `).run(
        record.pluginId,
        requestedEnabled,
        record.version,
        now,
        now,
        overwriteEnabled ? 1 : 0,
      );
      this.db.prepare(`
        INSERT INTO plugin_versions(
          plugin_id, version, manifest_json, archive_sha256, package_relative_path, installed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(plugin_id, version) DO UPDATE SET
          manifest_json = excluded.manifest_json,
          archive_sha256 = excluded.archive_sha256,
          package_relative_path = excluded.package_relative_path,
          installed_at = excluded.installed_at
      `).run(
        record.pluginId,
        record.version,
        manifestJson,
        record.archiveSha256,
        record.packageRelativePath,
        now,
      );
      this.db.prepare(`
        INSERT INTO plugin_runtime_state(plugin_id, plugin_version, status, updated_at)
        VALUES (?, ?, 'stopped', ?)
        ON CONFLICT(plugin_id, plugin_version) DO NOTHING
      `).run(record.pluginId, record.version, now);
    });
  }

  getVersion(pluginId, version) {
    const row = this.db.prepare(`
      SELECT plugin_id, version, manifest_json, archive_sha256,
             package_relative_path, installed_at
      FROM plugin_versions WHERE plugin_id = ? AND version = ?
    `).get(pluginId, version);
    return row ? this.#mapVersion(row) : null;
  }

  getActivePlugin(pluginId) {
    const row = this.db.prepare(`
      SELECT p.id, p.enabled, p.active_version, p.installed_at, p.updated_at,
             v.manifest_json, v.archive_sha256, v.package_relative_path,
             r.status, r.runtime_kind, r.last_error, r.quarantined_at
      FROM plugins p
      LEFT JOIN plugin_versions v
        ON v.plugin_id = p.id AND v.version = p.active_version
      LEFT JOIN plugin_runtime_state r ON r.plugin_id = p.id
        AND r.plugin_version = p.active_version
      WHERE p.id = ?
    `).get(pluginId);
    return row ? this.#mapPlugin(row) : null;
  }

  listPlugins() {
    return this.db.prepare(`
      SELECT p.id, p.enabled, p.active_version, p.installed_at, p.updated_at,
             v.manifest_json, v.archive_sha256, v.package_relative_path,
             r.status, r.runtime_kind, r.last_error, r.quarantined_at
      FROM plugins p
      LEFT JOIN plugin_versions v
        ON v.plugin_id = p.id AND v.version = p.active_version
      LEFT JOIN plugin_runtime_state r ON r.plugin_id = p.id
        AND r.plugin_version = p.active_version
      ORDER BY p.id COLLATE BINARY
    `).all().map((row) => this.#mapPlugin(row));
  }

  /**
   * Every installed package version (active and inactive), with parsed manifests.
   * Used for ownership recovery when an older version still identifies a sync
   * provider that the active manifest no longer contributes.
   */
  listInstalledVersions() {
    return this.db.prepare(`
      SELECT plugin_id, version, manifest_json, archive_sha256,
             package_relative_path, installed_at
      FROM plugin_versions
      ORDER BY plugin_id COLLATE BINARY, installed_at DESC, version COLLATE BINARY
    `).all().map((row) => this.#mapVersion(row));
  }

  #mapVersion(row) {
    return {
      pluginId: row.plugin_id,
      version: row.version,
      manifest: parseJson(row.manifest_json, "manifest"),
      archiveSha256: row.archive_sha256,
      packageRelativePath: row.package_relative_path,
      installedAt: Number(row.installed_at),
    };
  }

  #mapPlugin(row) {
    return {
      id: row.id,
      source: this.getPluginSource(row.id),
      enabled: row.enabled === 1,
      activeVersion: row.active_version ?? null,
      installedAt: Number(row.installed_at),
      updatedAt: Number(row.updated_at),
      manifest: row.manifest_json ? parseJson(row.manifest_json, "manifest") : null,
      archiveSha256: row.archive_sha256 ?? null,
      packageRelativePath: row.package_relative_path ?? null,
      runtime: {
        status: row.status ?? "stopped",
        kind: row.runtime_kind ?? null,
        lastError: row.last_error ?? null,
        quarantinedAt: row.quarantined_at == null ? null : Number(row.quarantined_at),
      },
    };
  }

  setEnabled(pluginId, enabled) {
    const result = this.db.prepare("UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, this.clock(), pluginId);
    if (Number(result.changes) !== 1) throw new Error(`Plugin is not installed: ${pluginId}`);
  }

  setActiveVersion(pluginId, version, options = {}) {
    this.transaction(() => {
      if (!this.getVersion(pluginId, version)) {
        throw new Error(`Plugin version is not installed: ${pluginId}@${version}`);
      }
      const enabled = options.enabled === true ? 1 : 0;
      const expectedActiveVersion = options.expectedActiveVersion;
      const result = expectedActiveVersion === undefined
        ? this.db.prepare(`
            UPDATE plugins
            SET active_version = ?, enabled = ?, updated_at = ?
            WHERE id = ?
          `).run(version, enabled, this.clock(), pluginId)
        : this.db.prepare(`
            UPDATE plugins
            SET active_version = ?, enabled = ?, updated_at = ?
            WHERE id = ? AND active_version = ?
          `).run(version, enabled, this.clock(), pluginId, expectedActiveVersion);
      if (Number(result.changes) !== 1) {
        throw new Error(`Plugin active version changed before it could be restored: ${pluginId}`);
      }
    });
    return this.getActivePlugin(pluginId);
  }

  setRuntimeState(pluginId, status, options = {}) {
    const activeVersion = this.db.prepare(
      "SELECT active_version FROM plugins WHERE id = ?",
    ).get(pluginId)?.active_version;
    const pluginVersion = options.pluginVersion ?? activeVersion;
    if (!pluginVersion) throw new Error(`Plugin is not installed: ${pluginId}`);
    if (!this.getVersion(pluginId, pluginVersion)) {
      throw new Error(`Plugin version is not installed: ${pluginId}@${pluginVersion}`);
    }
    this.db.prepare(`
      INSERT INTO plugin_runtime_state(
        plugin_id, plugin_version, status, runtime_kind,
        last_error, quarantined_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id, plugin_version) DO UPDATE SET
        status = excluded.status,
        runtime_kind = excluded.runtime_kind,
        last_error = excluded.last_error,
        quarantined_at = COALESCE(excluded.quarantined_at, plugin_runtime_state.quarantined_at),
        updated_at = excluded.updated_at
    `).run(
      pluginId,
      pluginVersion,
      status,
      options.kind ?? null,
      options.error == null ? null : String(options.error).slice(0, 4_096),
      options.quarantinedAt ?? null,
      this.clock(),
    );
  }

  recordCrash(pluginId, pluginVersion, windowMs, threshold) {
    const now = this.clock();
    return this.transaction(() => {
      if (!this.getVersion(pluginId, pluginVersion)) {
        throw new Error(`Plugin version is not installed: ${pluginId}@${pluginVersion}`);
      }
      this.db.prepare(`
        DELETE FROM plugin_crashes
        WHERE plugin_id = ? AND plugin_version = ? AND crashed_at < ?
      `).run(pluginId, pluginVersion, now - windowMs);
      this.db.prepare(`
        INSERT INTO plugin_crashes(plugin_id, plugin_version, crashed_at)
        VALUES (?, ?, ?)
      `).run(pluginId, pluginVersion, now);
      const count = Number(this.db.prepare(
        "SELECT COUNT(*) AS count FROM plugin_crashes WHERE plugin_id = ? AND plugin_version = ?",
      ).get(pluginId, pluginVersion)?.count ?? 0);
      if (count >= threshold) {
        this.db.prepare(`
          UPDATE plugin_runtime_state
          SET status = 'quarantined', quarantined_at = ?, updated_at = ?
          WHERE plugin_id = ? AND plugin_version = ?
        `).run(now, now, pluginId, pluginVersion);
      }
      return { count, quarantined: count >= threshold, quarantinedAt: count >= threshold ? now : null };
    });
  }

  clearQuarantine(pluginId, pluginVersion) {
    const now = this.clock();
    this.transaction(() => {
      const activeVersion = this.db.prepare(
        "SELECT active_version FROM plugins WHERE id = ?",
      ).get(pluginId)?.active_version;
      const targetVersion = pluginVersion ?? activeVersion;
      if (!targetVersion) throw new Error(`Plugin is not installed: ${pluginId}`);
      if (!this.getVersion(pluginId, targetVersion)) {
        throw new Error(`Plugin version is not installed: ${pluginId}@${targetVersion}`);
      }
      this.db.prepare(`
        DELETE FROM plugin_crashes WHERE plugin_id = ? AND plugin_version = ?
      `).run(pluginId, targetVersion);
      this.db.prepare(`
        UPDATE plugin_runtime_state
        SET status = 'stopped', last_error = NULL, quarantined_at = NULL, updated_at = ?
        WHERE plugin_id = ? AND plugin_version = ?
      `).run(now, pluginId, targetVersion);
    });
  }

  removePlugin(pluginId) {
    this.db.prepare("DELETE FROM plugins WHERE id = ?").run(pluginId);
  }

  getValue(pluginId, key) {
    const owner = this.privateOwner(pluginId);
    if (owner !== pluginId) key = `${owner}:${key}`;
    const row = this.db.prepare(
      "SELECT value_json FROM plugin_kv WHERE plugin_id = ? AND key = ?",
    ).get(pluginId, key);
    return row ? parseJson(row.value_json, "key/value entry") : undefined;
  }

  setValue(pluginId, key, value) {
    const owner = this.privateOwner(pluginId);
    if (owner !== pluginId) key = `${owner}:${key}`;
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("Plugin storage value must be JSON serializable");
    this.db.prepare(`
      INSERT INTO plugin_kv(plugin_id, key, value_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(plugin_id, key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(pluginId, key, serialized, this.clock());
  }

  deleteValue(pluginId, key) {
    const owner = this.privateOwner(pluginId);
    if (owner !== pluginId) key = `${owner}:${key}`;
    this.db.prepare("DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?").run(pluginId, key);
  }

  listKeys(pluginId) {
    return this.db.prepare(
      "SELECT key FROM plugin_kv WHERE plugin_id = ? ORDER BY key COLLATE BINARY",
    ).all(pluginId).map((row) => row.key).filter((key) => {
      const owner = this.privateOwner(pluginId);
      return owner === pluginId || key.startsWith(`${owner}:`);
    }).map((key) => this.privateOwner(pluginId) === pluginId ? key : key.slice(this.privateOwner(pluginId).length + 1));
  }

  getSetting(pluginId, settingId, scope, scopeId) {
    pluginId = this.privateOwner(pluginId);
    const row = this.db.prepare(`
      SELECT value_json FROM plugin_settings
      WHERE plugin_id = ? AND setting_id = ? AND scope = ? AND scope_id = ?
    `).get(pluginId, settingId, scope, scopeId);
    return row ? parseJson(row.value_json, "setting value") : undefined;
  }

  setSetting(pluginId, settingId, scope, scopeId, value, updatedAt = this.clock()) {
    pluginId = this.privateOwner(pluginId);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("Plugin setting value must be JSON serializable");
    const stamp = Number.isFinite(Number(updatedAt)) ? Number(updatedAt) : this.clock();
    this.db.prepare(`
      INSERT INTO plugin_settings(plugin_id, setting_id, scope, scope_id, value_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id, setting_id, scope, scope_id) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(pluginId, settingId, scope, scopeId, serialized, stamp);
  }

  deleteSetting(pluginId, settingId, scope, scopeId) {
    pluginId = this.privateOwner(pluginId);
    this.db.prepare(`
      DELETE FROM plugin_settings
      WHERE plugin_id = ? AND setting_id = ? AND scope = ? AND scope_id = ?
    `).run(pluginId, settingId, scope, scopeId);
  }

  listSettings(pluginId) {
    pluginId = this.privateOwner(pluginId);
    return this.db.prepare(`
      SELECT setting_id, scope, scope_id, value_json, updated_at
      FROM plugin_settings WHERE plugin_id = ?
      ORDER BY setting_id COLLATE BINARY, scope COLLATE BINARY, scope_id COLLATE BINARY
    `).all(pluginId).map((row) => ({
      settingId: row.setting_id,
      scope: row.scope,
      scopeId: row.scope_id,
      value: parseJson(row.value_json, "setting value"),
      updatedAt: Number(row.updated_at),
    }));
  }

  listAllSettings() {
    return this.db.prepare(`
      SELECT plugin_id, setting_id, scope, scope_id, value_json, updated_at
      FROM plugin_settings
      ORDER BY plugin_id COLLATE BINARY, setting_id COLLATE BINARY, scope COLLATE BINARY, scope_id COLLATE BINARY
    `).all().map((row) => ({
      pluginId: row.plugin_id,
      settingId: row.setting_id,
      scope: row.scope,
      scopeId: row.scope_id,
      value: parseJson(row.value_json, "setting value"),
      updatedAt: Number(row.updated_at),
    }));
  }

  getSyncSidecar(pluginId, kind, key) {
    pluginId = this.privateOwner(pluginId);
    const row = this.db.prepare(`
      SELECT value_json, updated_at FROM plugin_sync_sidecars
      WHERE plugin_id = ? AND kind = ? AND key = ?
    `).get(pluginId, kind, key);
    if (!row) return undefined;
    return {
      pluginId,
      kind,
      key,
      value: parseJson(row.value_json, "sync sidecar value"),
      updatedAt: Number(row.updated_at),
    };
  }

  setSyncSidecar(pluginId, kind, key, value, updatedAt = this.clock()) {
    pluginId = this.privateOwner(pluginId);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("Plugin sync sidecar value must be JSON serializable");
    this.db.prepare(`
      INSERT INTO plugin_sync_sidecars(plugin_id, kind, key, value_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id, kind, key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(pluginId, kind, key, serialized, updatedAt);
  }

  deleteSyncSidecar(pluginId, kind, key) {
    pluginId = this.privateOwner(pluginId);
    this.db.prepare(`
      DELETE FROM plugin_sync_sidecars
      WHERE plugin_id = ? AND kind = ? AND key = ?
    `).run(pluginId, kind, key);
  }

  listSyncSidecars(pluginId) {
    pluginId = this.privateOwner(pluginId);
    return this.db.prepare(`
      SELECT plugin_id, kind, CAST(key AS BLOB) AS key_bytes, value_json, updated_at
      FROM plugin_sync_sidecars
      WHERE plugin_id = ?
      ORDER BY kind COLLATE BINARY, key COLLATE BINARY
    `).all(pluginId).map((row) => ({
      pluginId: row.plugin_id,
      kind: row.kind,
      // Node 22 truncates TEXT results at NUL; settings keys contain NUL separators.
      key: Buffer.from(row.key_bytes).toString("utf8"),
      value: parseJson(row.value_json, "sync sidecar value"),
      updatedAt: Number(row.updated_at),
    }));
  }

  listAllSyncSidecars() {
    return this.db.prepare(`
      SELECT plugin_id, kind, CAST(key AS BLOB) AS key_bytes, value_json, updated_at
      FROM plugin_sync_sidecars
      ORDER BY plugin_id COLLATE BINARY, kind COLLATE BINARY, key COLLATE BINARY
    `).all().map((row) => ({
      pluginId: row.plugin_id,
      kind: row.kind,
      // Node 22 truncates TEXT results at NUL; settings keys contain NUL separators.
      key: Buffer.from(row.key_bytes).toString("utf8"),
      value: parseJson(row.value_json, "sync sidecar value"),
      updatedAt: Number(row.updated_at),
    }));
  }

  replaceAllSyncSidecars(entries) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM plugin_sync_sidecars").run();
      const insert = this.db.prepare(`
        INSERT INTO plugin_sync_sidecars(plugin_id, kind, key, value_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const entry of entries) {
        const serialized = JSON.stringify(entry.value);
        if (serialized === undefined) {
          throw new TypeError("Plugin sync sidecar value must be JSON serializable");
        }
        insert.run(
          entry.pluginId,
          entry.kind,
          entry.key,
          serialized,
          Number(entry.updatedAt) || this.clock(),
        );
      }
    });
  }

  getViewState(pluginId, viewId, scopeId) {
    pluginId = this.privateOwner(pluginId);
    const row = this.db.prepare(`
      SELECT state_json FROM plugin_view_state
      WHERE plugin_id = ? AND view_id = ? AND scope_id = ?
    `).get(pluginId, viewId, scopeId);
    return row ? parseJson(row.state_json, "view state") : undefined;
  }

  setViewState(pluginId, viewId, scopeId, state) {
    pluginId = this.privateOwner(pluginId);
    const serialized = JSON.stringify(state);
    if (serialized === undefined) throw new TypeError("Plugin view state must be JSON serializable");
    this.db.prepare(`
      INSERT INTO plugin_view_state(plugin_id, view_id, scope_id, state_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id, view_id, scope_id) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(pluginId, viewId, scopeId, serialized, this.clock());
  }

  deleteViewState(pluginId, viewId, scopeId) {
    pluginId = this.privateOwner(pluginId);
    this.db.prepare(`
      DELETE FROM plugin_view_state
      WHERE plugin_id = ? AND view_id = ? AND scope_id = ?
    `).run(pluginId, viewId, scopeId);
  }

  listPermissionGrants(pluginId) {
    return this.db.prepare(`
      SELECT plugin_id, permission, resource, resource_kind, declaration_hash, granted_at
      FROM plugin_permission_grants
      WHERE plugin_id = ?
      ORDER BY permission COLLATE BINARY, resource COLLATE BINARY
    `).all(this.privateOwner(pluginId)).map((row) => ({
      pluginId,
      permission: row.permission,
      resource: row.resource,
      resourceKind: row.resource_kind,
      declarationHash: row.declaration_hash,
      grantedAt: Number(row.granted_at),
    }));
  }

  upsertPermissionGrant(record) {
    this.db.prepare(`
      INSERT INTO plugin_permission_grants(
        plugin_id, permission, resource, resource_kind, declaration_hash, granted_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id, permission, resource) DO UPDATE SET
        resource_kind = excluded.resource_kind,
        declaration_hash = excluded.declaration_hash,
        granted_at = excluded.granted_at
    `).run(
      this.privateOwner(record.pluginId),
      record.permission,
      record.resource,
      record.resourceKind,
      record.declarationHash,
      this.clock(),
    );
  }

  deletePermissionGrant(pluginId, permission, resource) {
    pluginId = this.privateOwner(pluginId);
    this.db.prepare(`
      DELETE FROM plugin_permission_grants
      WHERE plugin_id = ? AND permission = ? AND resource = ?
    `).run(pluginId, permission, resource);
  }

  deleteAllPermissionGrants(pluginId) {
    pluginId = this.privateOwner(pluginId);
    this.db.prepare("DELETE FROM plugin_permission_grants WHERE plugin_id = ?").run(pluginId);
  }

  getSecretByKey(pluginId, key) {
    pluginId = this.privateOwner(pluginId);
    const row = this.db.prepare(`
      SELECT plugin_id, key, secret_ref, ciphertext, created_at, updated_at
      FROM plugin_secrets WHERE plugin_id = ? AND key = ?
    `).get(pluginId, key);
    return row ? this.#mapSecret(row) : null;
  }

  getSecretByRef(pluginId, secretRef) {
    pluginId = this.privateOwner(pluginId);
    const row = this.db.prepare(`
      SELECT plugin_id, key, secret_ref, ciphertext, created_at, updated_at
      FROM plugin_secrets WHERE plugin_id = ? AND secret_ref = ?
    `).get(pluginId, secretRef);
    return row ? this.#mapSecret(row) : null;
  }

  #mapSecret(row) {
    return {
      pluginId: this.publicPluginId(row.plugin_id),
      key: row.key,
      secretRef: row.secret_ref,
      ciphertext: Buffer.from(row.ciphertext),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  upsertSecret(record) {
    const now = this.clock();
    this.db.prepare(`
      INSERT INTO plugin_secrets(
        plugin_id, key, secret_ref, ciphertext, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id, key) DO UPDATE SET
        secret_ref = excluded.secret_ref,
        ciphertext = excluded.ciphertext,
        updated_at = excluded.updated_at
    `).run(
      this.privateOwner(record.pluginId),
      record.key,
      record.secretRef,
      record.ciphertext,
      now,
      now,
    );
  }

  deleteSecret(pluginId, key) {
    pluginId = this.privateOwner(pluginId);
    this.db.prepare("DELETE FROM plugin_secrets WHERE plugin_id = ? AND key = ?")
      .run(pluginId, key);
  }

  /** Delete all secrets whose key equals prefix or starts with `${prefix}:`. */
  deleteSecretsByKeyPrefix(pluginId, prefix) {
    pluginId = this.privateOwner(pluginId);
    const result = this.db.prepare(`
      DELETE FROM plugin_secrets
      WHERE plugin_id = ?
        AND (key = ? OR key LIKE ? ESCAPE '\\')
    `).run(
      pluginId,
      prefix,
      `${String(prefix).replace(/[%_\\]/g, (ch) => `\\${ch}`)}:%`,
    );
    return Number(result?.changes) || 0;
  }

  /** Find secret rows by exact key across all plugins (sync provider cleanup). */
  findSecretsByKey(key) {
    return this.db.prepare(`
      SELECT plugin_id, key, secret_ref, ciphertext, created_at, updated_at
      FROM plugin_secrets WHERE key = ?
    `).all(key).map((row) => this.#mapSecret(row));
  }

  upsertSyncProviderBinding(providerId, pluginId) {
    const now = this.clock();
    this.db.prepare(`
      INSERT INTO plugin_sync_provider_bindings(provider_id, plugin_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
        plugin_id = excluded.plugin_id,
        updated_at = excluded.updated_at
    `).run(providerId, pluginId, now, now);
  }

  getSyncProviderBinding(providerId) {
    const row = this.db.prepare(`
      SELECT provider_id, plugin_id, created_at, updated_at
      FROM plugin_sync_provider_bindings WHERE provider_id = ?
    `).get(providerId);
    if (!row) return null;
    return {
      providerId: row.provider_id,
      pluginId: row.plugin_id,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  deleteSyncProviderBinding(providerId) {
    const result = this.db.prepare(`
      DELETE FROM plugin_sync_provider_bindings WHERE provider_id = ?
    `).run(providerId);
    return Number(result?.changes) || 0;
  }

  /** Distinct plugin ids that own secrets with key === prefix or key LIKE prefix:%. */
  listPluginIdsWithSecretKeyPrefix(prefix) {
    const escaped = String(prefix).replace(/[%_\\]/g, (ch) => `\\${ch}`);
    return this.db.prepare(`
      SELECT DISTINCT plugin_id
      FROM plugin_secrets
      WHERE key = ? OR key LIKE ? ESCAPE '\\'
    `).all(prefix, `${escaped}:%`).map((row) => this.publicPluginId(row.plugin_id)).filter((id) => id !== null);
  }

  /**
   * Promote leftover sync-provider-map:* secret rows into the host-owned binding
   * table. Idempotent.
   *
   * Host map keys under this prefix are migration markers from an intermediate
   * build (pluginId-namespaced provider ids only). After a successful promote,
   * those map rows are deleted so constructor-time backfill cannot resurrect a
   * binding after the user disconnects/unbinds. Multiple plugins may hold map
   * rows for the same provider (parent + nested id): group by provider, never
   * overwrite an existing host binding (including empty-plugin_id unbind
   * tombstones). Among candidates, only plugins that still hold sync-credential*
   * secrets are eligible. Auto-bind only when exactly one distinct
   * credential-backed candidate exists; if several credential-backed plugins
   * map the same provider (e.g. com.example and com.example.sync both hold
   * credentials), skip entirely — longest pluginId is not a reliable owner
   * signal (the shorter parent can be the legitimate owner). Map-only leftovers
   * never invent ownership (validation only requires
   * providerId.startsWith(pluginId + ".")).
   */
  backfillSyncProviderBindingsFromLegacySecrets() {
    const legacyPrefix = "sync-provider-map:";
    const escaped = legacyPrefix.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    const legacyRows = this.db.prepare(`
      SELECT plugin_id, key
      FROM plugin_secrets
      WHERE key LIKE ? ESCAPE '\\'
    `).all(`${escaped}%`);
    /** @type {Map<string, Array<{ pluginId: string, key: string }>>} */
    const byProvider = new Map();
    for (const row of legacyRows) {
      const pluginId = this.publicPluginId(row.plugin_id);
      const key = row.key;
      if (typeof pluginId !== "string" || typeof key !== "string") continue;
      if (!key.startsWith(legacyPrefix)) continue;
      const providerId = key.slice(legacyPrefix.length);
      if (!providerId || providerId.includes("\0")) continue;
      if (!providerId.startsWith(`${pluginId}.`)) {
        continue;
      }
      const list = byProvider.get(providerId) || [];
      list.push({ pluginId, key });
      byProvider.set(providerId, list);
    }
    // Credential presence is the signal for real ownership. A longer nested map
    // row without credentials must not steal bind from a parent that still owns
    // sync-credential* secrets for the provider namespace.
    const credentialOwners = new Set(
      this.listPluginIdsWithSecretKeyPrefix("sync-credential")
        .filter((id) => typeof id === "string" && id.length > 0),
    );
    // Same single-provider guard as live backfill: one shared sync-credential*
    // row must not seed bindings for every historical map provider under that
    // plugin (disconnecting a stale provider would wipe the live credentials).
    // Count both legacy map rows and installed-manifest sync providers so a
    // stale map cannot promote when the live manifest also declares another
    // provider under the same credential owner (Codex P2 on 8ae60205).
    /** @type {Map<string, Set<string>>} */
    const providersByCredentialOwner = new Map();
    for (const [providerId, candidates] of byProvider) {
      for (const c of candidates) {
        if (!credentialOwners.has(c.pluginId)) continue;
        const set = providersByCredentialOwner.get(c.pluginId) || new Set();
        set.add(providerId);
        providersByCredentialOwner.set(c.pluginId, set);
      }
    }
    try {
      const versions = typeof this.listInstalledVersions === "function"
        ? this.listInstalledVersions()
        : [];
      for (const version of versions) {
        const pluginId = version?.pluginId;
        if (typeof pluginId !== "string" || !credentialOwners.has(pluginId)) continue;
        for (const provider of version.manifest?.contributes?.providers ?? []) {
          if (provider?.kind !== "sync") continue;
          if (typeof provider.id !== "string" || provider.id.length < 1) continue;
          const set = providersByCredentialOwner.get(pluginId) || new Set();
          set.add(provider.id);
          providersByCredentialOwner.set(pluginId, set);
        }
      }
    } catch {
      /* ignore catalog probe failures */
    }
    let promoted = 0;
    for (const [providerId, candidates] of byProvider) {
      // Any host row means a prior decision: active bind or explicit unbind
      // tombstone (empty plugin_id). Never resurrect from leftover map secrets.
      if (this.getSyncProviderBinding(providerId)) {
        continue;
      }
      // Only credential-backed map candidates may win; map-only leftovers stay
      // unbound rather than inventing ownership from namespace length alone.
      // Multiple distinct credential-backed candidates is ambiguous (parent vs
      // nested can both hold credentials for the same provider namespace) — skip
      // entirely rather than picking longest pluginId.
      const uniqueCredentialOwners = [
        ...new Set(
          candidates
            .filter((c) => credentialOwners.has(c.pluginId))
            .map((c) => c.pluginId),
        ),
      ];
      if (uniqueCredentialOwners.length !== 1) {
        continue;
      }
      const chosenOwner = uniqueCredentialOwners[0];
      if ((providersByCredentialOwner.get(chosenOwner)?.size ?? 0) !== 1) {
        continue;
      }
      // Constructor-time map promote runs before hostService's installed-manifest
      // conflict check. Skip when another installed package would also claim this
      // provider (live nested plugin without credentials yet) so we do not bind
      // a legacy parent that later disconnect cannot clear (Codex P2 on 5bc1b60d).
      let hasManifestConflict = false;
      try {
        const versions = typeof this.listInstalledVersions === "function"
          ? this.listInstalledVersions()
          : [];
        for (const version of versions) {
          const pluginId = version?.pluginId;
          if (typeof pluginId !== "string" || pluginId === chosenOwner) continue;
          for (const provider of version.manifest?.contributes?.providers ?? []) {
            if (provider?.kind !== "sync") continue;
            if (provider.id === providerId) {
              hasManifestConflict = true;
              break;
            }
          }
          if (hasManifestConflict) break;
        }
      } catch {
        /* ignore catalog probe failures */
      }
      if (hasManifestConflict) {
        continue;
      }
      this.upsertSyncProviderBinding(providerId, chosenOwner);
      // Consume legacy map markers for this provider so a later unbind + reopen
      // cannot re-promote from leftover secrets. Only delete namespaced map keys
      // we accepted as candidates (not arbitrary plugin secrets). Consume all
      // candidate maps (including map-only losers) once a credential-backed
      // owner is bound, so orphans cannot re-run later.
      for (const candidate of candidates) {
        this.deleteSecret(candidate.pluginId, candidate.key);
      }
      promoted += 1;
    }
    return promoted;
  }

  /**
   * Credential-row prefix inference is intentionally not used.
   *
   * A shorter parent plugin id (e.g. com.example with sync-credential rows) can
   * namespace-prefix a provider owned by a different/removed plugin
   * (com.example.backup.sync). Falling back to that parent would let
   * syncDeleteSecrets wipe unrelated credentials. Ownership must come from the
   * host binding table (including rows promoted by
   * backfillSyncProviderBindingsFromLegacySecrets) or a live contribution.
   */
  inferPluginIdForSyncProvider(_providerId) {
    return undefined;
  }

  recordSecurityAudit(pluginId, event, details) {
    let detailsJson = JSON.stringify(details ?? {});
    const originalBytes = Buffer.byteLength(detailsJson);
    if (originalBytes > MAX_SECURITY_AUDIT_DETAILS_BYTES) {
      detailsJson = JSON.stringify({
        truncated: true,
        originalBytes,
        sha256: createHash("sha256").update(detailsJson).digest("hex"),
      });
    }
    this.transaction(() => this.#appendSecurityAudit(pluginId, event, detailsJson));
  }

  #appendSecurityAudit(pluginId, event, detailsJson) {
    this.db.prepare(`
      INSERT INTO plugin_security_audit(plugin_id, event, details_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(pluginId, event, detailsJson, this.clock());
    this.db.prepare(`
      DELETE FROM plugin_security_audit
      WHERE plugin_id = ? AND id NOT IN (
        SELECT id FROM plugin_security_audit
        WHERE plugin_id = ? ORDER BY id DESC LIMIT ${MAX_SECURITY_AUDIT_RECORDS_PER_PLUGIN}
      )
    `).run(pluginId, pluginId);
  }

  // Host-owned policy preferences are deliberately separate from plugin-writable
  // settings. Source ownership is stable across package versions; grants are not.
  getPermissionMode(pluginId, permission) {
    const key = `permission:${this.privateOwner(pluginId)}:${permission}`;
    const row = this.db.prepare("SELECT value_json FROM plugin_host_preferences WHERE key = ?").get(key);
    const mode = row ? parseJson(row.value_json, "permission mode") : "allow";
    if (!["allow", "ask", "deny"].includes(mode)) throw new Error("Corrupt plugin permission mode");
    return mode;
  }

  setPermissionMode(pluginId, permission, mode) {
    const key = `permission:${this.privateOwner(pluginId)}:${permission}`;
    this.transaction(() => {
      this.db.prepare("INSERT INTO plugin_host_preferences(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at")
        .run(key, JSON.stringify(mode), this.clock());
      this.#appendSecurityAudit(pluginId, "permission.policy-edited", JSON.stringify({ permission, mode, sourceOwner: this.privateOwner(pluginId) }));
    });
  }

  getHostThemeSelection() {
    const row = this.db.prepare("SELECT value_json FROM plugin_host_preferences WHERE key = 'theme'").get();
    return row ? parseJson(row.value_json, "host theme selection") : {formatVersion: 1, revision: 0, light: null, dark: null};
  }

  commitHostThemeSelection(expectedRevision, selection, pluginId) {
    this.transaction(() => {
      if (this.getHostThemeSelection().revision !== expectedRevision) throw new Error("Theme selection changed; refresh before applying");
      this.db.prepare("INSERT INTO plugin_host_preferences(key,value_json,updated_at) VALUES('theme',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at")
        .run(JSON.stringify(selection), this.clock());
      this.#appendSecurityAudit(pluginId ?? "$host.appearance", "theme-selection", JSON.stringify({revision:selection.revision, action:pluginId ? "apply" : "restore"}));
    });
  }

  listSecurityAudit(pluginId, limit = 100) {
    const requestedLimit = Number(limit);
    const normalizedLimit = Math.max(1, Math.min(
      1_000,
      Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 100,
    ));
    return this.db.prepare(`
      SELECT event, details_json, created_at
      FROM plugin_security_audit
      WHERE plugin_id = ? ORDER BY id DESC LIMIT ?
    `).all(pluginId, normalizedLimit).map((row) => ({
      event: row.event,
      details: parseJson(row.details_json, "security audit entry"),
      createdAt: Number(row.created_at),
    }));
  }

  close() {
    this.db.close();
  }
}

module.exports = {
  MAX_SECURITY_AUDIT_DETAILS_BYTES,
  MAX_SECURITY_AUDIT_RECORDS_PER_PLUGIN,
  PluginDatabase,
  REQUIRED_SCHEMA_COLUMNS,
  SCHEMA_VERSION,
};
