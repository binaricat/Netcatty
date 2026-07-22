import assert from "node:assert/strict";
import test from "node:test";

import type { Host, SSHKey } from "../domain/models";
import { STORAGE_KEY_DEFAULT_KEY_PASSPHRASES } from "../infrastructure/config/storageKeys";
import { buildVaultCsvCredentialOptions } from "./vaultCsvExportCredentials";

function installEmptyLocalStorage(t: test.TestContext): Map<string, string> {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty: undefined },
  });
  t.after(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
    Reflect.deleteProperty(globalThis, "window");
  });
  return storage;
}

const host = (identityFileId?: string): Host => ({
  id: "host-1",
  label: "Host",
  hostname: "host.example.com",
  port: 22,
  identityFileId,
  identityFilePaths: identityFileId ? undefined : ["/Users/alice/.ssh/id_ed25519"],
  authMethod: "key",
});

const referenceKey = (overrides: Partial<SSHKey> = {}): SSHKey => ({
  id: "key-1",
  label: "id_ed25519",
  type: "ED25519",
  category: "key",
  source: "reference",
  filePath: "/Users/alice/.ssh/id_ed25519",
  privateKey: "",
  created: 1,
  ...overrides,
});

test("CSV credentials prefer a readable reference-key passphrase without a false warning", async () => {
  const result = await buildVaultCsvCredentialOptions(
    [host("key-1")],
    [referenceKey({ savePassphrase: true, passphrase: "key-secret" })],
    async () => ({ values: [], unreadable: true, present: true }),
  );

  assert.equal(result.keyPassphrasesById.get("key-1"), "key-secret");
  assert.equal(result.unreadablePassphraseCount, 0);
});

test("CSV credentials preserve legacy reference-key passphrases without a save flag", async () => {
  const result = await buildVaultCsvCredentialOptions(
    [host("key-1")],
    [referenceKey({ passphrase: "legacy-secret" })],
    async () => ({ values: [], unreadable: false, present: false }),
  );

  assert.equal(result.keyPassphrasesById.get("key-1"), "legacy-secret");
  assert.equal(result.unreadablePassphraseCount, 0);
});

test("CSV credentials do not use stale path storage for an uninitialized legacy reference key", async () => {
  const result = await buildVaultCsvCredentialOptions(
    [host("key-1")],
    [referenceKey()],
    async () => ({ values: ["stale-secret"], unreadable: false, present: true }),
  );

  assert.equal(result.keyPassphrasesById.has("key-1"), false);
  assert.equal(result.unreadablePassphraseCount, 0);
});

test("CSV credentials include a matching Keychain passphrase for a direct key path", async (t) => {
  installEmptyLocalStorage(t);
  const result = await buildVaultCsvCredentialOptions(
    [host()],
    [referenceKey({ savePassphrase: true, passphrase: "keychain-secret" })],
  );

  assert.equal(
    result.keyPassphrases.get("/Users/alice/.ssh/id_ed25519"),
    "keychain-secret",
  );
  assert.equal(result.unreadablePassphraseCount, 0);
});

test("CSV credentials exclude an explicitly unsaved Keychain passphrase for a direct key path", async (t) => {
  const storage = installEmptyLocalStorage(t);
  storage.set(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES, JSON.stringify({
    "/Users/alice/.ssh/id_ed25519": "stale-side-secret",
  }));
  const result = await buildVaultCsvCredentialOptions(
    [host()],
    [referenceKey({ savePassphrase: false, passphrase: "stale-secret" })],
  );

  assert.equal(result.keyPassphrases.has("/Users/alice/.ssh/id_ed25519"), false);
  assert.equal(result.unreadablePassphraseCount, 0);
});

test("CSV credentials warn when a saved reference-key passphrase cannot be read", async () => {
  const result = await buildVaultCsvCredentialOptions(
    [host("key-1")],
    [referenceKey({ savePassphrase: true, passphrase: "enc:v1:djEwYWJj" })],
    async () => ({ values: [], unreadable: false, present: false }),
  );

  assert.equal(result.keyPassphrasesById.has("key-1"), false);
  assert.equal(result.unreadablePassphraseCount, 1);
});

test("CSV credentials never fall back to stale path storage for an unsaved reference key", async () => {
  const result = await buildVaultCsvCredentialOptions(
    [host("key-1")],
    [referenceKey({ savePassphrase: false })],
    async () => ({ values: ["stale-secret"], unreadable: false, present: true }),
  );

  assert.equal(result.keyPassphrasesById.has("key-1"), false);
  assert.equal(result.keyPassphrases.has("/Users/alice/.ssh/id_ed25519"), false);
  assert.equal(result.unreadablePassphraseCount, 0);
});

test("CSV credentials use readable path storage only when a reference key is marked saved", async () => {
  const result = await buildVaultCsvCredentialOptions(
    [host("key-1")],
    [referenceKey({ savePassphrase: true })],
    async () => ({ values: ["side-store-secret"], unreadable: false, present: true }),
  );

  assert.equal(result.keyPassphrasesById.get("key-1"), "side-store-secret");
  assert.equal(result.unreadablePassphraseCount, 0);
});

test("CSV credentials omit ambiguous path storage and warn", async () => {
  for (const read of [
    { values: ["stale-secret"], unreadable: true, present: true },
    { values: ["old-secret", "new-secret"], unreadable: false, present: true },
  ]) {
    const result = await buildVaultCsvCredentialOptions(
      [host("key-1")],
      [referenceKey({ savePassphrase: true })],
      async () => read,
    );

    assert.equal(result.keyPassphrasesById.has("key-1"), false);
    assert.equal(result.unreadablePassphraseCount, 1);
  }
});
