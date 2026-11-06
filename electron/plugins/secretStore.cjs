"use strict";

const { randomBytes } = require("node:crypto");

const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");

const MAX_SECRET_BYTES = 64 * 1024;

function assertSecretKey(key) {
  if (typeof key !== "string" || key.length < 1 || key.length > 256 || key.includes("\0")) {
    throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Plugin secret key is invalid");
  }
  return key;
}

function assertSecretRef(secret) {
  if (
    !secret
    || typeof secret !== "object"
    || Array.isArray(secret)
    || secret.kind !== "secret"
    || typeof secret.id !== "string"
    || secret.id.length < 16
    || secret.id.length > 256
    || typeof secret.key !== "string"
    || secret.key.length < 1
    || secret.key.length > 256
    || secret.key.includes("\0")
  ) throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Plugin secret reference is invalid");
  return { id: secret.id, key: secret.key };
}

class PluginSecretStore {
  /** @type {Map<string, { value: string, secretRef: string }>} */
  #overwriteStash = new Map();

  constructor(options) {
    this.database = options.database;
    this.safeStorage = options.safeStorage ?? null;
    this.randomBytes = options.randomBytes ?? randomBytes;
  }

  #stashKey(pluginId, key) {
    return `${this.database.privateOwner?.(pluginId) ?? pluginId}\0${key}`;
  }

  clearPluginMemory(pluginId) {
    const prefix = `${this.database.privateOwner?.(pluginId) ?? pluginId}\0`;
    for (const key of this.#overwriteStash.keys()) if (key.startsWith(prefix)) this.#overwriteStash.delete(key);
  }

  #assertAvailable() {
    const backend = this.safeStorage?.getSelectedStorageBackend?.();
    if (
      !this.safeStorage?.isEncryptionAvailable?.()
      || backend === "basic_text"
      || typeof this.safeStorage.encryptString !== "function"
      || typeof this.safeStorage.decryptString !== "function"
    ) {
      throw new PluginRpcError(
        RPC_ERRORS.unavailable,
        "Secure OS-backed encryption is unavailable for plugin secrets",
      );
    }
  }

  getReference(pluginId, key) {
    assertSecretKey(key);
    const record = this.database.getSecretByKey(pluginId, key);
    return record ? Object.freeze({ kind: "secret", id: record.secretRef, key: record.key }) : undefined;
  }

  getRecordByReference(pluginId, secret) {
    const reference = assertSecretRef(secret);
    const record = this.database.getSecretByRef(pluginId, reference.id);
    if (!record || record.key !== reference.key) {
      throw new PluginRpcError(RPC_ERRORS.notFound, "Plugin secret reference was not found");
    }
    return record;
  }

  set(pluginId, key, value, options = {}) {
    this.#assertAvailable();
    assertSecretKey(key);
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
      throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Plugin secret value is invalid or too large");
    }
    const stashPrevious = options.stashPrevious === true;
    const stashKey = this.#stashKey(pluginId, key);
    let stashed = false;
    if (stashPrevious && !this.#overwriteStash.has(stashKey)) {
      // Keep an existing stash (e.g. after a failed restore) so a later retry
      // still recovers the original SecretRef, not a rejected replacement.
      const existing = this.getReference(pluginId, key);
      if (existing) {
        try {
          this.#overwriteStash.set(stashKey, {
            value: this.resolve(pluginId, existing),
            // Keep the prior SecretRef id so saved provider connections still resolve.
            secretRef: existing.id,
          });
          stashed = true;
        } catch {
          /* keep going; restore may be unavailable for this key */
        }
      }
    }
    try {
      const secretRef = this.randomBytes(24).toString("base64url");
      const ciphertext = this.safeStorage.encryptString(value);
      if (!Buffer.isBuffer(ciphertext) || ciphertext.byteLength < 1) {
        throw new PluginRpcError(RPC_ERRORS.unavailable, "OS-backed plugin secret encryption failed");
      }
      this.database.upsertSecret({ pluginId, key, secretRef, ciphertext });
      return Object.freeze({ kind: "secret", id: secretRef, key });
    } catch (error) {
      // Failed replacement must not leave prior plaintext stranded in memory.
      if (stashed) this.#overwriteStash.delete(stashKey);
      throw error;
    }
  }

  /**
   * Restore the plaintext (and SecretRef id) stashed by the last overwrite.
   * Returns true when a stashed value was written back.
   */
  restoreOverwrite(pluginId, key) {
    this.#assertAvailable();
    assertSecretKey(key);
    const stashKey = this.#stashKey(pluginId, key);
    const previous = this.#overwriteStash.get(stashKey);
    if (!previous || typeof previous.value !== "string" || typeof previous.secretRef !== "string") {
      return false;
    }
    const ciphertext = this.safeStorage.encryptString(previous.value);
    if (!Buffer.isBuffer(ciphertext) || ciphertext.byteLength < 1) {
      throw new PluginRpcError(RPC_ERRORS.unavailable, "OS-backed plugin secret encryption failed");
    }
    this.database.upsertSecret({
      pluginId,
      key,
      secretRef: previous.secretRef,
      ciphertext,
    });
    // Drop the stash only after the prior value is durably written so a failed
    // encrypt/upsert can still be retried.
    this.#overwriteStash.delete(stashKey);
    return true;
  }

  clearOverwriteStash(pluginId, key) {
    assertSecretKey(key);
    this.#overwriteStash.delete(this.#stashKey(pluginId, key));
  }

  delete(pluginId, key) {
    assertSecretKey(key);
    this.#overwriteStash.delete(this.#stashKey(pluginId, key));
    this.database.deleteSecret(pluginId, key);
  }

  deleteByKeyPrefix(pluginId, prefix) {
    assertSecretKey(prefix);
    let deleted = 0;
    if (typeof this.database.deleteSecretsByKeyPrefix !== "function") {
      this.delete(pluginId, prefix);
      deleted = 1;
    } else {
      deleted = this.database.deleteSecretsByKeyPrefix(pluginId, prefix);
    }
    const pluginPrefix = `${this.database.privateOwner?.(pluginId) ?? pluginId}\0`;
    for (const stashKey of [...this.#overwriteStash.keys()]) {
      if (!stashKey.startsWith(pluginPrefix)) continue;
      const secretKey = stashKey.slice(pluginPrefix.length);
      if (secretKey === prefix || secretKey.startsWith(`${prefix}:`)) {
        this.#overwriteStash.delete(stashKey);
      }
    }
    return deleted;
  }

  /**
   * Durable providerId → pluginId binding so disconnect can wipe sync secrets
   * after the contribution disappears (disabled/uninstalled plugin).
   * Stored in a host-owned table, not plugin-writable secrets.
   * Overwrites any prior empty-plugin_id unbind tombstone.
   */
  bindSyncProviderPlugin(pluginId, providerId) {
    if (typeof pluginId !== "string" || pluginId.length < 1) {
      throw new TypeError("Plugin id is invalid");
    }
    assertSecretKey(providerId);
    // Contribution provider ids live under the owning plugin namespace
    // (`pluginId.`…); they are never equal to the plugin id itself.
    if (!providerId.startsWith(`${pluginId}.`)) {
      throw new TypeError("Sync provider id is outside the plugin namespace");
    }
    if (typeof this.database.upsertSyncProviderBinding !== "function") {
      throw new Error("Plugin sync provider binding storage is unavailable");
    }
    this.database.upsertSyncProviderBinding(providerId, pluginId);
  }

  resolveSyncProviderPlugin(providerId) {
    assertSecretKey(providerId);
    if (typeof this.database.getSyncProviderBinding === "function") {
      const row = this.database.getSyncProviderBinding(providerId);
      const pluginId = row?.pluginId;
      if (
        typeof pluginId === "string"
        && pluginId.length > 0
        && providerId.startsWith(`${pluginId}.`)
      ) {
        return pluginId;
      }
    }
    // Do not infer ownership from sync-credential* key prefixes: a parent
    // plugin id may namespace-prefix another plugin's provider and would cause
    // disconnect to delete the wrong secrets. Pre-binding installs recover via
    // (1) backfillSyncProviderBindingsFromLegacySecrets for intermediate map
    // rows, (2) backfillSyncProviderBindingsFromLiveProviders using host
    // contribution metadata at startup, or (3) the next successful put.
    return undefined;
  }

  /**
   * Seed missing provider→plugin bindings from contribution metadata.
   *
   * Real schema-2 installs only stored plugin-scoped `sync-credential*` rows
   * (no per-provider ownership). After upgrade, seed a binding only when a
   * plugin with credentials has exactly one sync provider id across the
   * catalog: binding every historical/active provider would let disconnecting
   * a stale provider wipe the shared credential prefix used by the live one.
   * Multi-provider plugins wait for the next successful put (or map backfill).
   *
   * @param {Array<{ pluginId?: string, id?: string, provider?: { id?: string } }>} providers
   * @returns {number} number of newly written bindings
   */
  backfillSyncProviderBindingsFromLiveProviders(providers) {
    if (!Array.isArray(providers)) return 0;
    if (typeof this.database.listPluginIdsWithSecretKeyPrefix !== "function") return 0;
    const credentialOwners = new Set(
      this.database.listPluginIdsWithSecretKeyPrefix("sync-credential")
        .filter((id) => typeof id === "string" && id.length > 0),
    );
    if (credentialOwners.size === 0) return 0;
    /** @type {Map<string, Set<string>>} pluginId -> provider ids it declares */
    const providersByPlugin = new Map();
    /** @type {Map<string, Set<string>>} providerId -> plugins claiming it */
    const pluginsByProvider = new Map();
    for (const entry of providers) {
      const pluginId = entry?.pluginId;
      const providerId = entry?.provider?.id ?? entry?.id;
      if (typeof pluginId !== "string" || pluginId.length < 1) continue;
      if (typeof providerId !== "string" || providerId.length < 1) continue;
      if (!providerId.startsWith(`${pluginId}.`)) continue;
      // Count every manifest claim for conflict detection — including live
      // plugins that have not stored credentials yet. Binding only a
      // credential-backed legacy parent would orphan credentials when a later
      // disconnect prefers the live nested owner (Codex P2 on 8d64ea20).
      const claimants = pluginsByProvider.get(providerId) || new Set();
      claimants.add(pluginId);
      pluginsByProvider.set(providerId, claimants);
      // Only credential-backed plugins are eligible to become the binding owner.
      if (!credentialOwners.has(pluginId)) continue;
      const set = providersByPlugin.get(pluginId) || new Set();
      set.add(providerId);
      providersByPlugin.set(pluginId, set);
    }
    let promoted = 0;
    for (const [pluginId, providerIds] of providersByPlugin) {
      if (providerIds.size !== 1) continue;
      const providerId = [...providerIds][0];
      // Two credential-backed plugins can both declare the same provider via
      // nested namespaces (legacy disabled parent + live child). Binding the
      // first writer would make a later missing-provider disconnect delete the
      // wrong sync-credential* rows. Skip any cross-plugin claim conflict.
      const claimants = pluginsByProvider.get(providerId);
      if (!claimants || claimants.size !== 1) continue;
      // Skip active binds and explicit-unbind tombstones alike.
      if (typeof this.database.getSyncProviderBinding === "function"
        && this.database.getSyncProviderBinding(providerId)) {
        continue;
      }
      try {
        this.bindSyncProviderPlugin(pluginId, providerId);
        promoted += 1;
      } catch {
        /* invalid contribution ids stay unbound */
      }
    }
    return promoted;
  }

  unbindSyncProviderPlugin(pluginId, providerId) {
    assertSecretKey(providerId);
    if (typeof this.database.upsertSyncProviderBinding !== "function") return;
    const existing = typeof this.database.getSyncProviderBinding === "function"
      ? this.database.getSyncProviderBinding(providerId)
      : null;
    // Do not steal another plugin's active binding. Empty plugin_id is an
    // unbind tombstone and may be refreshed idempotently.
    if (
      existing
      && typeof existing.pluginId === "string"
      && existing.pluginId.length > 0
      && existing.pluginId !== pluginId
    ) {
      return;
    }
    // Consume leftover intermediate-build map markers so they cannot re-seed
    // a binding if the tombstone is ever cleared. Delete under this plugin and
    // any residual map rows for the same provider across plugins.
    const mapKey = `sync-provider-map:${providerId}`;
    if (typeof this.database.deleteSecret === "function") {
      try {
        this.database.deleteSecret(pluginId, mapKey);
      } catch {
        /* ignore */
      }
    }
    if (typeof this.database.findSecretsByKey === "function" && typeof this.database.deleteSecret === "function") {
      for (const row of this.database.findSecretsByKey(mapKey) || []) {
        if (typeof row?.pluginId !== "string" || typeof row?.key !== "string") continue;
        try {
          this.database.deleteSecret(row.pluginId, row.key);
        } catch {
          /* ignore */
        }
      }
    }
    // Tombstone with empty plugin_id so leftover sync-provider-map:* secret
    // rows cannot re-promote this provider on the next database open.
    this.database.upsertSyncProviderBinding(providerId, "");
  }

  resolve(pluginId, secret) {
    this.#assertAvailable();
    const record = this.getRecordByReference(pluginId, secret);
    try {
      return this.safeStorage.decryptString(record.ciphertext);
    } catch {
      throw new PluginRpcError(RPC_ERRORS.dataLoss, "Plugin secret could not be decrypted");
    }
  }
}

module.exports = {
  MAX_SECRET_BYTES,
  PluginSecretStore,
  assertSecretKey,
  assertSecretRef,
};
