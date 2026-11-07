"use strict";

/**
 * Host-side collection and apply path for plugin encrypted sync sidecars.
 * Uses non-cascade tables so uninstall/missing plugins do not destroy data.
 */

const {
  collectPluginSyncSidecars,
  excludeSecretPluginSettingsFromSidecars,
  mergePluginSyncSidecars,
  parseSettingsSidecarKey,
  resolveSettingsSidecarTarget,
  settingsSidecarKey,
  isCloudSyncablePluginSetting,
} = require("./pluginSyncSidecarHelpers.cjs");

class PluginSyncSidecarService {
  constructor(options) {
    if (!options?.database) {
      throw new TypeError("Plugin sync sidecar service requires a database");
    }
    this.database = options.database;
    this.contributionService = options.contributionService ?? null;
  }

  #declaredSettingsByPlugin() {
    const map = new Map();
    const snapshot = this.contributionService?.snapshot?.();
    const plugins = snapshot?.plugins ?? [];
    for (const plugin of plugins) {
      const fields = (plugin.settings ?? []).map((setting) => ({
        id: setting.id,
        secret: setting.secret === true,
        sync: setting.sync === true,
        scope: setting.scope,
      }));
      map.set(this.database.privateOwner(plugin.id), fields);
    }
    return map;
  }

  #isCurrentOwner(owner, publicId) {
    return publicId !== null && this.database.publicPluginId(owner) === publicId
      && this.#declaredSettingsByPlugin().has(owner);
  }

  /**
   * Build the sidecar bundle for inclusion in the encrypted cloud payload.
   */
  collectForSync() {
    const declared = this.#declaredSettingsByPlugin();
    const storedSettings = typeof this.database.listAllSettings === "function"
      ? this.database.listAllSettings()
      : [];
    const existingSidecars = typeof this.database.listAllSyncSidecars === "function"
      ? this.database.listAllSyncSidecars()
      : [];
    // Keep retained settings sidecars for installed plugins even when
    // plugin_settings has no row yet (downloaded while plugin was missing).
    // Do not write them into plugin_settings here — that would bypass the
    // contribution service's schema validation. applyFromSync / enable paths
    // rehydrate through updateSetting. User resets clear the sidecar row via
    // contributionService.resetSetting so deliberate deletions stay deleted.
    const filteredExisting = existingSidecars.filter((entry) => {
      if (entry.kind !== "settings") return true;
      if (!declared.has(entry.pluginId)) return true; // missing plugin — preserve
      const parsed = parseSettingsSidecarKey(entry.key);
      if (!parsed) return false;
      const fields = declared.get(entry.pluginId) ?? [];
      const field = fields.find((item) => item.id === parsed.settingId);
      // Drop secret / non-sync declarations; unknown fields stay for schema lag.
      if (field && !isCloudSyncablePluginSetting(field)) return false;
      return true;
    });
    const bundle = collectPluginSyncSidecars({
      declaredSettingsByPlugin: declared,
      storedSettings,
      existingSidecars: filteredExisting,
    });
    bundle.entries = excludeSecretPluginSettingsFromSidecars(bundle.entries, declared);
    // Persist collected settings into the non-cascade table so a later uninstall
    // still has rows to re-emit (plugin_settings alone is not enough once the
    // declaration disappears and collection skips undeclared stored values).
    if (typeof this.database.replaceAllSyncSidecars === "function") {
      this.database.replaceAllSyncSidecars(bundle.entries);
    }
    return bundle;
  }

  /**
   * Merge a remote sidecar bundle into local non-cascade storage.
   * Does not delete local rows for plugins absent from the remote bundle.
   * Installed-plugin settings go through the contribution service when available
   * so values are validated and runtime change events fire.
   */
  async applyFromSync(remoteBundle) {
    const declared = this.#declaredSettingsByPlugin();
    const local = typeof this.database.listAllSyncSidecars === "function"
      ? this.database.listAllSyncSidecars()
      : [];
    const remoteEntries = Array.isArray(remoteBundle?.entries) ? remoteBundle.entries : [];
    // Explicit empty remote bundle is an authoritative wipe (including rows for
    // missing plugins). Legacy payloads without pluginSidecars never reach here
    // (apply path only runs when the field is present).
    const remoteIsAuthoritativeEmpty = Array.isArray(remoteBundle?.entries)
      && remoteBundle.entries.length === 0;
    // Remote is authoritative for installed plugins. For missing plugins, if the
    // remote bundle mentions the plugin at all, remote is authoritative for that
    // plugin's entire sidecar set (do not resurrect local-only keys another
    // device deleted). Only plugins completely absent from remote keep local
    // retention so first-time missing-plugin baselines are not wiped.
    const remotePluginIds = new Set(
      remoteEntries.map((entry) => entry.pluginId).filter((id) => typeof id === "string"),
    );
    const remoteKeys = new Set(
      remoteEntries.map((entry) => `${entry.pluginId}\0${entry.kind}\0${entry.key}`),
    );
    // Settings: remote is authoritative for installed plugins and for missing
    // plugins mentioned in the remote bundle. Baselines (account/crdt) always
    // enter merge so domain LWW can compare local vs remote; orphans survive.
    const preservedLocal = local.filter((entry) => {
      if (entry.kind !== "settings") {
        return true;
      }
      if (remoteIsAuthoritativeEmpty) return false;
      if (declared.has(entry.pluginId)) return false; // installed: remote wins
      if (remotePluginIds.has(entry.pluginId)) return false;
      return true;
    });
    const merged = mergePluginSyncSidecars({
      local: preservedLocal,
      remote: { version: 1, entries: remoteEntries },
      declaredSettingsByPlugin: declared,
    });
    const safe = excludeSecretPluginSettingsFromSidecars(merged, declared);
    if (typeof this.database.replaceAllSyncSidecars === "function") {
      this.database.replaceAllSyncSidecars(safe);
    }
    // Drop installed-plugin settings that remote no longer carries.
    // Prefer contributionService.resetSetting so plugins and the renderer
    // receive change events; fall back to direct DB delete when unavailable.
    // Include live plugin_settings rows that were never mirrored into
    // plugin_sync_sidecars (e.g. pre-sidecar schema migrations) so remote
    // deletions still clear them instead of being republished on next collect.
    const resetCandidates = [];
    const seenResetKeys = new Set();
    const pushResetCandidate = (entry) => {
      const mapKey = `${entry.pluginId}\0${entry.kind}\0${entry.key}`;
      if (seenResetKeys.has(mapKey)) return;
      seenResetKeys.add(mapKey);
      resetCandidates.push(entry);
    };
    for (const entry of local) {
      if (entry.kind !== "settings") continue;
      if (!declared.has(entry.pluginId)) continue;
      if (remoteKeys.has(`${entry.pluginId}\0${entry.kind}\0${entry.key}`)) continue;
      pushResetCandidate(entry);
    }
    if (typeof this.database.listAllSettings === "function") {
      for (const row of this.database.listAllSettings()) {
        if (!declared.has(row.pluginId)) continue;
        const fields = declared.get(row.pluginId) ?? [];
        const field = fields.find((item) => item.id === row.settingId);
        if (!field || !isCloudSyncablePluginSetting(field)) continue;
        const key = settingsSidecarKey(row.settingId, row.scope, row.scopeId);
        if (remoteKeys.has(`${row.pluginId}\0settings\0${key}`)) continue;
        pushResetCandidate({
          pluginId: row.pluginId,
          kind: "settings",
          key,
          value: row.value,
          updatedAt: row.updatedAt,
        });
      }
    }
    for (const entry of resetCandidates) {
      const publicId = this.database.publicPluginId(entry.pluginId);
      if (!this.#isCurrentOwner(entry.pluginId, publicId)) continue;
      const parsed = parseSettingsSidecarKey(entry.key);
      if (!parsed) continue;
      if (typeof this.contributionService?.resetSetting === "function") {
        try {
          await this.contributionService.resetSetting(
            publicId,
            parsed.settingId,
            parsed.scopeId,
          );
        } catch {
          // Validation rejected the reset (e.g. required setting) — still try
          // the stored-coordinate delete below for stale-scope rows.
        }
        if (!this.#isCurrentOwner(entry.pluginId, publicId)) continue;
        // resetSetting normalizes against the *current* declared scope. After a
        // scope migration (application → device), that may miss the stale row
        // still stored under the old coordinates; always delete those too.
        try {
          this.database.deleteSetting(
            entry.pluginId,
            parsed.settingId,
            parsed.scope,
            parsed.scopeId,
          );
        } catch {
          // Best-effort cleanup of the stored-coordinate row.
        }
        continue;
      }
      this.database.deleteSetting(entry.pluginId, parsed.settingId, parsed.scope, parsed.scopeId);
    }
    for (const entry of safe) {
      const publicId = this.database.publicPluginId(entry.pluginId);
      if (!this.#isCurrentOwner(entry.pluginId, publicId)) continue;
      if (entry.kind !== "settings") continue;
      const fields = declared.get(entry.pluginId);
      if (!fields) continue;
      const parsed = parseSettingsSidecarKey(entry.key);
      if (!parsed) continue;
      const field = fields.find((item) => item.id === parsed.settingId);
      if (!field || !isCloudSyncablePluginSetting(field)) continue;
      // Always write under the currently declared scope/key coordinates.
      // Older sidecars may encode an obsolete scope after a plugin update;
      // recreating that scope would leave duplicate rows that collection
      // republishes. Application scope always uses the fixed "application" id.
      const target = resolveSettingsSidecarTarget(field, parsed);
      if (!target) continue;
      const { targetScope, targetScopeId, nextKey } = target;
      if (typeof this.contributionService?.updateSetting === "function") {
        try {
          await this.contributionService.updateSetting(
            publicId,
            parsed.settingId,
            entry.value,
            targetScopeId,
            { source: "host" },
          );
          if (!this.#isCurrentOwner(entry.pluginId, publicId)) continue;
          // Preserve remote LWW timestamp after validated write (updateSetting uses clock).
          this.database.setSetting(
            entry.pluginId,
            parsed.settingId,
            targetScope,
            targetScopeId,
            entry.value,
            entry.updatedAt,
          );
          if (targetScope !== parsed.scope || targetScopeId !== parsed.scopeId) {
            try {
              this.database.deleteSetting(
                entry.pluginId,
                parsed.settingId,
                parsed.scope,
                parsed.scopeId,
              );
            } catch {
              // Best-effort cleanup of the obsolete scope row.
            }
            if (typeof this.database.setSyncSidecar === "function") {
              try {
                this.database.setSyncSidecar(
                  entry.pluginId,
                  "settings",
                  nextKey,
                  entry.value,
                  entry.updatedAt,
                );
                if (nextKey !== entry.key && typeof this.database.deleteSyncSidecar === "function") {
                  this.database.deleteSyncSidecar(entry.pluginId, "settings", entry.key);
                }
              } catch {
                // Sidecar re-key is best-effort after settings write.
              }
            }
          }
        } catch {
          // Invalid against current schema — keep sidecar row only.
        }
        continue;
      }
      this.database.setSetting(
        entry.pluginId,
        parsed.settingId,
        targetScope,
        targetScopeId,
        entry.value,
        entry.updatedAt,
      );
      if (targetScope !== parsed.scope || targetScopeId !== parsed.scopeId) {
        try {
          this.database.deleteSetting(
            entry.pluginId,
            parsed.settingId,
            parsed.scope,
            parsed.scopeId,
          );
        } catch {
          // Best-effort cleanup of the obsolete scope row.
        }
        if (typeof this.database.setSyncSidecar === "function") {
          try {
            this.database.setSyncSidecar(
              entry.pluginId,
              "settings",
              nextKey,
              entry.value,
              entry.updatedAt,
            );
            if (nextKey !== entry.key && typeof this.database.deleteSyncSidecar === "function") {
              this.database.deleteSyncSidecar(entry.pluginId, "settings", entry.key);
            }
          } catch {
            // Sidecar re-key is best-effort after settings write.
          }
        }
      }
    }
    return safe;
  }

  /**
   * After a plugin is installed/enabled, validate and apply retained settings
   * sidecars into plugin_settings so the running plugin sees cloud values.
   */
  async hydrateInstalledPluginSettings(pluginId) {
    if (typeof pluginId !== "string" || pluginId.length < 1) return;
    const owner = this.database.privateOwner(pluginId);
    const declared = this.#declaredSettingsByPlugin().get(owner);
    if (!declared) return;
    const rows = typeof this.database.listSyncSidecars === "function"
      ? this.database.listSyncSidecars(pluginId)
      : [];
    for (const entry of rows) {
      if (!this.#isCurrentOwner(owner, pluginId)) return;
      if (entry.kind !== "settings") continue;
      const parsed = parseSettingsSidecarKey(entry.key);
      if (!parsed) continue;
      const field = declared.find((item) => item.id === parsed.settingId);
      if (!field || !isCloudSyncablePluginSetting(field)) continue;
      const target = resolveSettingsSidecarTarget(field, parsed);
      if (!target) continue;
      const { targetScope, targetScopeId, nextKey } = target;
      // Do not overwrite a newer local edit that has not been collected yet.
      if (typeof this.database.listSettings === "function") {
        const localRows = this.database.listSettings(pluginId);
        const local = localRows.find((row) => (
          row.settingId === parsed.settingId
          && row.scope === targetScope
          && row.scopeId === targetScopeId
        ));
        if (local && Number(local.updatedAt) > Number(entry.updatedAt)) {
          continue;
        }
      }
      if (typeof this.contributionService?.updateSetting === "function") {
        try {
          await this.contributionService.updateSetting(
            pluginId,
            parsed.settingId,
            entry.value,
            targetScopeId,
            { source: "host" },
          );
          if (!this.#isCurrentOwner(owner, pluginId)) return;
          this.database.setSetting(
            owner,
            parsed.settingId,
            targetScope,
            targetScopeId,
            entry.value,
            entry.updatedAt,
          );
          if (targetScope !== parsed.scope || targetScopeId !== parsed.scopeId) {
            try {
              this.database.deleteSetting(
                owner,
                parsed.settingId,
                parsed.scope,
                parsed.scopeId,
              );
            } catch {
              // Best-effort cleanup of the obsolete scope row.
            }
            if (typeof this.database.setSyncSidecar === "function") {
              try {
                this.database.setSyncSidecar(
                  owner,
                  "settings",
                  nextKey,
                  entry.value,
                  entry.updatedAt,
                );
                if (nextKey !== entry.key && typeof this.database.deleteSyncSidecar === "function") {
                  this.database.deleteSyncSidecar(owner, "settings", entry.key);
                }
              } catch {
                // Sidecar re-key is best-effort after settings write.
              }
            }
          }
        } catch {
          // Invalid against current schema — keep sidecar only.
        }
      }
    }
  }

  /**
   * Persist an account or CRDT baseline without cascading on uninstall.
   */
  setBaseline(pluginId, kind, key, value) {
    if (kind !== "account_baseline" && kind !== "crdt_baseline") {
      throw new TypeError("Baseline kind must be account_baseline or crdt_baseline");
    }
    this.database.setSyncSidecar(pluginId, kind, key, value);
  }

  getBaseline(pluginId, kind, key) {
    return this.database.getSyncSidecar(pluginId, kind, key);
  }
}

module.exports = {
  PluginSyncSidecarService,
};
