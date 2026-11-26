"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PluginCredentialBroker } = require("./credentialBroker.cjs");
const { PluginDatabase } = require("./database.cjs");
const { RPC_ERRORS } = require("./rpcRouter.cjs");
const { SecretLeaseStore } = require("./secretLease.cjs");
const { PluginSecretStore } = require("./secretStore.cjs");

function createDatabase(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-secrets-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new PluginDatabase(path.join(root, "plugins.sqlite"));
}

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
    decryptString: (value) => {
      const encoded = value.toString().slice("sealed:".length);
      return Buffer.from(encoded, "base64").toString();
    },
  };
}

test("plugin secrets are OS-encrypted, opaque, ownership-bound, and uninstall-independent", (context) => {
  const database = createDatabase(context);
  let random = 0;
  const store = new PluginSecretStore({
    database,
    safeStorage: fakeSafeStorage(),
    randomBytes: () => Buffer.alloc(24, ++random),
  });
  const secret = store.set("com.example.one", "api-key", "plaintext-token");
  const record = database.getSecretByKey("com.example.one", "api-key");
  assert.equal(record.ciphertext.includes(Buffer.from("plaintext-token")), false);
  assert.deepEqual(store.getReference("com.example.one", "api-key"), secret);
  assert.equal(store.resolve("com.example.one", secret), "plaintext-token");
  assert.throws(
    () => store.resolve("com.example.two", secret),
    (error) => error.code === RPC_ERRORS.notFound,
  );
  assert.throws(
    () => store.resolve("com.example.one", { ...secret, key: "different-key" }),
    (error) => error.code === RPC_ERRORS.notFound,
  );
  store.delete("com.example.one", "api-key");
  assert.equal(store.getReference("com.example.one", "api-key"), undefined);
  database.close();
});

test("plugin secrets fail closed when OS encryption is unavailable or ciphertext is corrupt", (context) => {
  const database = createDatabase(context);
  const unavailable = new PluginSecretStore({ database, safeStorage: null });
  assert.throws(
    () => unavailable.set("com.example.one", "api-key", "value"),
    (error) => error.code === RPC_ERRORS.unavailable,
  );
  const insecureBackend = new PluginSecretStore({
    database,
    safeStorage: {
      ...fakeSafeStorage(),
      getSelectedStorageBackend: () => "basic_text",
    },
  });
  assert.throws(
    () => insecureBackend.set("com.example.one", "api-key", "value"),
    (error) => error.code === RPC_ERRORS.unavailable,
  );

  const safeStorage = fakeSafeStorage();
  const store = new PluginSecretStore({ database, safeStorage });
  const secret = store.set("com.example.one", "api-key", "value");
  safeStorage.decryptString = () => { throw new Error("corrupt"); };
  assert.throws(
    () => store.resolve("com.example.one", secret),
    (error) => error.code === RPC_ERRORS.dataLoss,
  );
  database.close();
});

test("credential leases are one-use and bound to plugin, runtime, operation, abort, and expiry", async (context) => {
  const database = createDatabase(context);
  let now = 1_000;
  let random = 0;
  const secretStore = new PluginSecretStore({
    database,
    safeStorage: fakeSafeStorage(),
    randomBytes: () => Buffer.alloc(24, ++random),
  });
  const secret = secretStore.set("com.example.one", "api-key", "credential-value");
  const leaseStore = new SecretLeaseStore({
    secretStore,
    clock: () => now,
    randomBytes: () => Buffer.alloc(24, ++random),
    setTimeout: () => ({ timer: true }),
    clearTimeout: () => {},
  });
  const broker = new PluginCredentialBroker({ secretStore, leaseStore });
  const runtime = {
    pluginId: "com.example.one",
    runtimeId: "runtime-1",
    signal: new AbortController().signal,
    assertActive: async () => {},
  };
  const lease = leaseStore.issue({
    ...runtime,
    secret,
    operationId: "network:login",
    purpose: "Authenticate",
    ttlMs: 500,
  });
  await assert.rejects(
    broker.consumeLease({ ...runtime, runtimeId: "runtime-2" }, lease, "network:login"),
    (error) => error.code === RPC_ERRORS.permissionDenied,
  );
  assert.equal(await broker.consumeLease(runtime, lease, "network:login"), "credential-value");
  await assert.rejects(
    broker.consumeLease(runtime, lease, "network:login"),
    (error) => error.code === RPC_ERRORS.notFound,
  );

  const expired = leaseStore.issue({
    ...runtime,
    secret,
    operationId: "network:expired",
    purpose: "Expire",
    ttlMs: 1,
  });
  now += 2;
  await assert.rejects(
    broker.consumeLease(runtime, expired, "network:expired"),
    (error) => error.code === RPC_ERRORS.notFound,
  );

  const controller = new AbortController();
  const aborted = leaseStore.issue({
    ...runtime,
    signal: controller.signal,
    secret,
    operationId: "network:aborted",
    purpose: "Abort",
  });
  controller.abort();
  await assert.rejects(
    broker.consumeLease(runtime, aborted, "network:aborted"),
    (error) => error.code === RPC_ERRORS.notFound,
  );
  leaseStore.shutdown();
  database.close();
});

test("Netcatty credentials resolve only when a one-use provider lease is consumed", async (context) => {
  const database = createDatabase(context);
  const secretStore = new PluginSecretStore({ database, safeStorage: fakeSafeStorage() });
  const leaseStore = new SecretLeaseStore({ secretStore });
  let resolved = 0;
  let referenceChecks = 0;
  const broker = new PluginCredentialBroker({
    secretStore,
    leaseStore,
    credentialResolver: {
      assertReference: async (reference, leaseContext) => {
        referenceChecks += 1;
        assert.equal(reference.id, "vault-credential-1");
        assert.equal(leaseContext.operationId, "connection:open-1");
      },
      resolve: async (reference, consumeContext) => {
        resolved += 1;
        assert.equal(reference.id, "vault-credential-1");
        assert.equal(consumeContext.pluginId, "com.example.provider");
        assert.equal(consumeContext.purpose, "Authenticate connection");
        return "host-owned-plaintext";
      },
    },
  });
  const runtime = {
    pluginId: "com.example.provider",
    runtimeId: "runtime-provider",
    signal: new AbortController().signal,
    assertActive: async () => {},
  };
  const params = {
    secret: { kind: "credential", id: "vault-credential-1" },
    operationId: "connection:open-1",
    purpose: "Authenticate connection",
  };
  assert.deepEqual(broker.describeAuthorization(params).resources, ["credential:vault-credential-1"]);
  assert.equal(referenceChecks, 0);
  const lease = await broker.createLease(params, runtime);
  assert.equal(referenceChecks, 1);
  assert.equal(resolved, 0);
  assert.equal(await broker.consumeLease(runtime, lease, "connection:open-1"), "host-owned-plaintext");
  assert.equal(resolved, 1);
  await assert.rejects(
    broker.consumeLease(runtime, lease, "connection:open-1"),
    (error) => error.code === RPC_ERRORS.notFound,
  );
  leaseStore.shutdown();
  database.close();
});

test("credential authorization descriptors do not probe opaque references before permission", async () => {
  let credentialChecks = 0;
  let secretChecks = 0;
  const broker = new PluginCredentialBroker({
    secretStore: {
      getRecordByReference() {
        secretChecks += 1;
        throw new Error("unknown plugin secret");
      },
    },
    leaseStore: { issue: () => { throw new Error("lease must not be issued"); } },
    credentialResolver: {
      async assertReference() {
        credentialChecks += 1;
        throw new Error("unknown Netcatty credential");
      },
      async resolve() { throw new Error("credential must not resolve"); },
    },
  });
  const base = {
    operationId: "connection:open-1",
    purpose: "Authenticate connection",
  };
  assert.deepEqual(broker.describeAuthorization({
    ...base,
    secret: { kind: "credential", id: "unknown-credential" },
  }).resources, ["credential:unknown-credential"]);
  assert.deepEqual(broker.describeAuthorization({
    ...base,
    secret: { kind: "secret", id: "unknown-secret-reference", key: "api-key" },
  }).resources, ["secret:api-key"]);
  assert.equal(credentialChecks, 0);
  assert.equal(secretChecks, 0);

  const runtime = {
    pluginId: "com.example.provider",
    runtimeId: "runtime-provider",
    signal: new AbortController().signal,
    assertActive: async () => {},
  };
  await assert.rejects(broker.createLease({
    ...base,
    secret: { kind: "credential", id: "unknown-credential" },
  }, runtime), /unknown Netcatty credential/);
  assert.equal(credentialChecks, 1);
  await assert.rejects(broker.createLease({
    ...base,
    secret: { kind: "secret", id: "unknown-secret-reference", key: "api-key" },
  }, runtime), /unknown plugin secret/);
  assert.equal(secretChecks, 1);
});

test("credential lease resolution cannot return plaintext after operation cancellation", async (context) => {
  const database = createDatabase(context);
  const secretStore = new PluginSecretStore({ database, safeStorage: fakeSafeStorage() });
  const leaseStore = new SecretLeaseStore({ secretStore });
  const controller = new AbortController();
  let releaseResolution;
  let resolutionSignal;
  const broker = new PluginCredentialBroker({
    secretStore,
    leaseStore,
    credentialResolver: {
      assertReference: async () => {},
      resolve: async (_reference, consumeContext) => {
        resolutionSignal = consumeContext.signal;
        await new Promise((resolve) => { releaseResolution = resolve; });
        return "must-not-escape-after-cancel";
      },
    },
  });
  const runtime = {
    pluginId: "com.example.provider",
    runtimeId: "runtime-provider",
    signal: controller.signal,
    assertActive: async () => controller.signal.throwIfAborted(),
  };
  const params = {
    secret: { kind: "credential", id: "vault-credential-1" },
    operationId: "connection:open-1",
    purpose: "Authenticate connection",
  };
  const lease = await broker.createLease(params, runtime);
  const consuming = broker.consumeLease(runtime, lease, "connection:open-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolutionSignal, controller.signal);
  controller.abort();
  releaseResolution();
  await assert.rejects(
    consuming,
    (error) => error.code === RPC_ERRORS.cancelled,
  );
  leaseStore.shutdown();
  database.close();
});

test("overwrite stash restores previous plaintext and discard clears it", (context) => {
  const database = createDatabase(context);
  let random = 0;
  const store = new PluginSecretStore({
    database,
    safeStorage: fakeSafeStorage(),
    randomBytes: () => Buffer.alloc(24, ++random),
  });
  const first = store.set("com.example.one", "sync-credential", "good-password");
  assert.equal(store.resolve("com.example.one", first), "good-password");
  const second = store.set("com.example.one", "sync-credential", "bad-password", { stashPrevious: true });
  assert.equal(store.resolve("com.example.one", second), "bad-password");
  assert.equal(store.restoreOverwrite("com.example.one", "sync-credential"), true);
  const restored = store.getReference("com.example.one", "sync-credential");
  assert.equal(restored.id, first.id, "restore must keep the prior SecretRef id");
  assert.equal(store.resolve("com.example.one", first), "good-password");
  assert.equal(store.restoreOverwrite("com.example.one", "sync-credential"), false);

  store.set("com.example.one", "sync-credential", "another-bad", { stashPrevious: true });
  store.clearOverwriteStash("com.example.one", "sync-credential");
  assert.equal(store.restoreOverwrite("com.example.one", "sync-credential"), false);
  assert.equal(
    store.resolve("com.example.one", store.getReference("com.example.one", "sync-credential")),
    "another-bad",
  );
  // Ordinary secrets.set-style overwrites must not stash plaintext by default.
  store.set("com.example.one", "api-key", "one");
  store.set("com.example.one", "api-key", "two");
  assert.equal(store.restoreOverwrite("com.example.one", "api-key"), false);
  database.close();
});

test("failed overwrite clears stashed plaintext", (context) => {
  const database = createDatabase(context);
  let failEncrypt = false;
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => {
      if (failEncrypt) return Buffer.alloc(0);
      return Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`);
    },
    decryptString: (value) => {
      const encoded = value.toString().slice("sealed:".length);
      return Buffer.from(encoded, "base64").toString();
    },
  };
  const store = new PluginSecretStore({ database, safeStorage });
  store.set("com.example", "sync-credential", "good-password");
  failEncrypt = true;
  assert.throws(
    () => store.set("com.example", "sync-credential", "bad-password", { stashPrevious: true }),
    (error) => error.code === RPC_ERRORS.unavailable,
  );
  assert.equal(store.restoreOverwrite("com.example", "sync-credential"), false);
  failEncrypt = false;
  const ref = store.getReference("com.example", "sync-credential");
  assert.equal(store.resolve("com.example", ref), "good-password");
  database.close();
});

test("sync provider bindings live outside plugin secrets and reject namespace mismatches", (context) => {
  const database = createDatabase(context);
  const store = new PluginSecretStore({
    database,
    safeStorage: fakeSafeStorage(),
  });
  store.bindSyncProviderPlugin("com.example", "com.example.sync");
  assert.equal(store.resolveSyncProviderPlugin("com.example.sync"), "com.example");
  assert.throws(
    () => store.bindSyncProviderPlugin("com.example", "com.other.sync"),
    /outside the plugin namespace/,
  );
  store.set("com.attacker", "sync-provider-map:com.example.sync", "com.attacker");
  assert.equal(store.resolveSyncProviderPlugin("com.example.sync"), "com.example");
  store.unbindSyncProviderPlugin("com.example", "com.example.sync");
  assert.equal(store.resolveSyncProviderPlugin("com.example.sync"), undefined);
  // Tombstone remains so legacy map backfill cannot resurrect after disconnect.
  assert.equal(database.getSyncProviderBinding("com.example.sync")?.pluginId, "");
  // Unbind also consumes map markers (including attacker leftovers).
  assert.equal(
    database.getSecretByKey("com.attacker", "sync-provider-map:com.example.sync"),
    null,
  );
  assert.equal(database.backfillSyncProviderBindingsFromLegacySecrets(), 0);
  assert.equal(store.resolveSyncProviderPlugin("com.example.sync"), undefined);
  // Reconnect clears the tombstone.
  store.bindSyncProviderPlugin("com.example", "com.example.sync");
  assert.equal(store.resolveSyncProviderPlugin("com.example.sync"), "com.example");
  database.close();
});

test("unbind deletes owner map markers and blocks legacy re-promotion", (context) => {
  const database = createDatabase(context);
  const store = new PluginSecretStore({
    database,
    safeStorage: fakeSafeStorage(),
  });
  // Credential evidence is required for map promote; simulate a real owner plus
  // an intermediate-build map row that backfill would otherwise promote.
  store.set("com.example", "sync-credential", "secret");
  store.set("com.example", "sync-provider-map:com.example.sync", "com.example");
  assert.equal(database.backfillSyncProviderBindingsFromLegacySecrets(), 1);
  assert.equal(store.resolveSyncProviderPlugin("com.example.sync"), "com.example");
  assert.equal(
    database.getSecretByKey("com.example", "sync-provider-map:com.example.sync"),
    null,
    "promote consumes the map marker",
  );
  // User disconnects; reintroduce a map row as if something wrote it back.
  // Tombstone still blocks re-promotion even with credentials + map present.
  store.unbindSyncProviderPlugin("com.example", "com.example.sync");
  store.set("com.example", "sync-provider-map:com.example.sync", "com.example");
  assert.equal(database.backfillSyncProviderBindingsFromLegacySecrets(), 0);
  assert.equal(store.resolveSyncProviderPlugin("com.example.sync"), undefined);
  assert.equal(database.getSyncProviderBinding("com.example.sync")?.pluginId, "");
  database.close();
});

test("failed restoreOverwrite keeps stash for retry", (context) => {
  const database = createDatabase(context);
  let failEncrypt = false;
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => {
      if (failEncrypt) return Buffer.alloc(0);
      return Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`);
    },
    decryptString: (value) => {
      const encoded = value.toString().slice("sealed:".length);
      return Buffer.from(encoded, "base64").toString();
    },
  };
  const store = new PluginSecretStore({ database, safeStorage });
  const first = store.set("com.example", "sync-credential", "good-password");
  store.set("com.example", "sync-credential", "bad-password", { stashPrevious: true });
  failEncrypt = true;
  assert.throws(
    () => store.restoreOverwrite("com.example", "sync-credential"),
    (error) => error.code === RPC_ERRORS.unavailable,
  );
  failEncrypt = false;
  assert.equal(store.restoreOverwrite("com.example", "sync-credential"), true);
  assert.equal(store.resolve("com.example", first), "good-password");
  database.close();
});

test("existing overwrite stash is preserved across retry puts and cleared by prefix delete", (context) => {
  const database = createDatabase(context);
  let failEncrypt = false;
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => {
      if (failEncrypt) return Buffer.alloc(0);
      return Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`);
    },
    decryptString: (value) => {
      const encoded = value.toString().slice("sealed:".length);
      return Buffer.from(encoded, "base64").toString();
    },
  };
  const store = new PluginSecretStore({ database, safeStorage });
  const first = store.set("com.example", "sync-credential", "good-password");
  store.set("com.example", "sync-credential", "bad-password", { stashPrevious: true });
  failEncrypt = true;
  assert.throws(
    () => store.restoreOverwrite("com.example", "sync-credential"),
    (error) => error.code === RPC_ERRORS.unavailable,
  );
  failEncrypt = false;
  // Retry put must not replace the original good-password stash with bad-password.
  store.set("com.example", "sync-credential", "worse-password", { stashPrevious: true });
  assert.equal(store.restoreOverwrite("com.example", "sync-credential"), true);
  assert.equal(store.resolve("com.example", first), "good-password");

  store.set("com.example", "sync-credential", "temp", { stashPrevious: true });
  store.deleteByKeyPrefix("com.example", "sync-credential");
  assert.equal(store.restoreOverwrite("com.example", "sync-credential"), false);
  assert.equal(store.getReference("com.example", "sync-credential"), undefined);
  database.close();
});

test("resolveSyncProviderPlugin does not infer ownership from credential prefixes alone", (context) => {
  const database = createDatabase(context);
  const store = new PluginSecretStore({
    database,
    safeStorage: fakeSafeStorage(),
  });
  store.set("com.example", "sync-credential", "pw");
  assert.equal(database.getSyncProviderBinding("com.example.sync"), null);
  // Without a binding (or live-provider backfill), credentials alone are not enough.
  assert.equal(store.resolveSyncProviderPlugin("com.example.sync"), undefined);
  // Explicit bind still works for disconnect cleanup.
  store.bindSyncProviderPlugin("com.example", "com.example.sync");
  assert.equal(store.resolveSyncProviderPlugin("com.example.sync"), "com.example");
  database.close();
});

test("live provider backfill seeds bindings for v2 credential-only upgrades", (context) => {
  const database = createDatabase(context);
  const store = new PluginSecretStore({
    database,
    safeStorage: fakeSafeStorage(),
  });
  // Real schema-2 path: credentials exist, binding table empty, no map rows.
  store.set("com.example", "sync-credential", "pw");
  store.set("com.disabled", "sync-credential", "pw2");
  assert.equal(database.getSyncProviderBinding("com.example.sync"), null);
  // Host should pass installed manifests including disabled plugins.
  const promoted = store.backfillSyncProviderBindingsFromLiveProviders([
    { pluginId: "com.example", provider: { id: "com.example.sync" } },
    { pluginId: "com.disabled", provider: { id: "com.disabled.sync" } },
    // No credentials under this plugin — skip.
    { pluginId: "com.other", provider: { id: "com.other.cloud" } },
    // Wrong namespace alone would be multi with sync below — still skip evil.
  ]);
  assert.equal(promoted, 2);
  assert.equal(store.resolveSyncProviderPlugin("com.example.sync"), "com.example");
  assert.equal(store.resolveSyncProviderPlugin("com.disabled.sync"), "com.disabled");
  assert.equal(store.resolveSyncProviderPlugin("com.other.cloud"), undefined);
  // Idempotent when binding already exists.
  assert.equal(
    store.backfillSyncProviderBindingsFromLiveProviders([
      { pluginId: "com.example", provider: { id: "com.example.sync" } },
    ]),
    0,
  );
  // Multi-provider plugins must not all bind from one shared credential row.
  store.set("com.multi", "sync-credential", "shared");
  assert.equal(
    store.backfillSyncProviderBindingsFromLiveProviders([
      { pluginId: "com.multi", provider: { id: "com.multi.old" } },
      { pluginId: "com.multi", provider: { id: "com.multi.new" } },
    ]),
    0,
  );
  assert.equal(store.resolveSyncProviderPlugin("com.multi.old"), undefined);
  assert.equal(store.resolveSyncProviderPlugin("com.multi.new"), undefined);
  // Cross-plugin claim on the same providerId must not bind the first writer.
  store.set("com.example.sync", "sync-credential", "nested");
  assert.equal(
    store.backfillSyncProviderBindingsFromLiveProviders([
      { pluginId: "com.example", provider: { id: "com.example.sync.foo" } },
      { pluginId: "com.example.sync", provider: { id: "com.example.sync.foo" } },
    ]),
    0,
  );
  assert.equal(store.resolveSyncProviderPlugin("com.example.sync.foo"), undefined);
  database.close();
});

test("live provider backfill does not resurrect explicit unbind tombstones", (context) => {
  const database = createDatabase(context);
  const store = new PluginSecretStore({
    database,
    safeStorage: fakeSafeStorage(),
  });
  store.set("com.example", "sync-credential", "pw");
  store.bindSyncProviderPlugin("com.example", "com.example.sync");
  store.unbindSyncProviderPlugin("com.example", "com.example.sync");
  assert.equal(database.getSyncProviderBinding("com.example.sync")?.pluginId, "");
  assert.equal(
    store.backfillSyncProviderBindingsFromLiveProviders([
      { pluginId: "com.example", provider: { id: "com.example.sync" } },
    ]),
    0,
  );
  assert.equal(store.resolveSyncProviderPlugin("com.example.sync"), undefined);
  database.close();
});

test("getPlaintext reads only the calling plugin's own encrypted secrets and never leaks across plugins", (context) => {
  const database = createDatabase(context);
  const store = new PluginSecretStore({
    database,
    safeStorage: fakeSafeStorage(),
  });
  store.set("com.example.db", "conn:pg:password", "pg-secret-123");
  assert.equal(store.getPlaintext("com.example.db", "conn:pg:password"), "pg-secret-123");
  assert.equal(store.getPlaintext("com.example.db", "conn:missing"), undefined);
  assert.equal(store.getPlaintext("com.example.other", "conn:pg:password"), undefined);
  store.delete("com.example.db", "conn:pg:password");
  assert.equal(store.getPlaintext("com.example.db", "conn:pg:password"), undefined);
  database.close();
});
