import assert from "node:assert/strict";
import test from "node:test";

import type { Host, SSHKey } from "../domain/models";
import { buildVaultCsvCredentialOptions } from "./vaultCsvExportCredentials";

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
