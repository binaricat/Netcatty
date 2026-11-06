"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { PluginCredentialCatalog } = require("./credentialCatalog.cjs");

function encrypted(value) {
  return `enc:v1:${Buffer.from(`cipher:${value}`).toString("base64")}`;
}

test("Vault credential catalog keeps only encrypted opaque references and decrypts on lease consumption", async () => {
  const catalog = new PluginCredentialCatalog({
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "keychain",
      decryptString: (value) => value.toString().replace(/^cipher:/u, ""),
    },
  });
  assert.equal(catalog.update([{
    id: "credential-reference-0001",
    ciphertext: encrypted("correct horse battery staple"),
  }]), 1);
  await catalog.assertReference({ kind: "credential", id: "credential-reference-0001" });
  assert.equal(
    await catalog.resolve({ kind: "credential", id: "credential-reference-0001" }),
    "correct horse battery staple",
  );
  await assert.rejects(
    catalog.assertReference({ kind: "credential", id: "credential-reference-missing" }),
    /not found/i,
  );
  assert.throws(() => catalog.update([{
    id: "credential-reference-0002",
    ciphertext: "plaintext-secret",
  }]), /OS-backed encryption/i);
});

test("Vault credential catalog fails closed when secure storage is unavailable", async () => {
  let encryptionAvailable = true;
  let backend = "keychain";
  const catalog = new PluginCredentialCatalog({
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable,
      getSelectedStorageBackend: () => backend,
      decryptString: (value) => value.toString().replace(/^cipher:/u, ""),
    },
  });
  const entry = {
    id: "credential-reference-0001",
    ciphertext: encrypted("secret"),
  };
  assert.equal(catalog.update([entry]), 1);
  backend = "basic_text";
  assert.throws(() => catalog.update([entry]), /unavailable/i);
  await assert.rejects(
    catalog.assertReference({ kind: "credential", id: "credential-reference-0001" }),
    /not found/i,
  );

  backend = "keychain";
  encryptionAvailable = false;
  assert.throws(() => catalog.update([entry]), /unavailable/i);
  await assert.rejects(
    catalog.resolve({ kind: "credential", id: "credential-reference-0001" }),
    /unavailable|not found/i,
  );
});

test("availability reporting does not unlock a missing OS vault", () => {
  const catalog = new PluginCredentialCatalog({ safeStorage: { isEncryptionAvailable: () => false } });
  assert.equal(catalog.isAvailable(), false);
  assert.throws(() => catalog.update([]), /OS-backed Vault/);
});
