import test from "node:test";
import assert from "node:assert/strict";
import {
  findSyncPayloadEncryptedCredentialPaths,
  healPoisonedSecretsForMerge,
  isEncryptedCredentialPlaceholder,
  isVaultStoredKeySource,
  needsVaultStoredKeyHydration,
  stripSyncPayloadEncryptedCredentials,
} from "./credentials.ts";
import type { SyncPayload } from "./sync.ts";

const completeBlob = Buffer.alloc(19, 0);
Buffer.from("v10", "utf8").copy(completeBlob, 0);
const ENC = `enc:v1:${completeBlob.toString("base64")}`;

function samplePayload(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return {
    hosts: [
      {
        id: "h1",
        label: "prod",
        hostname: "prod.example",
        username: "root",
        password: ENC,
        port: 22,
        os: "linux",
        group: "",
        tags: [],
        protocol: "ssh",
      },
    ],
    keys: [
      {
        id: "k1",
        label: "key",
        type: "ED25519",
        privateKey: ENC,
        source: "imported",
        category: "key",
        created: 1,
      },
    ],
    identities: [],
    snippets: [],
    customGroups: [],
    syncedAt: 1,
    ...overrides,
  };
}

test("isEncryptedCredentialPlaceholder detects complete v10 device-bound ciphertext", () => {
  assert.equal(isEncryptedCredentialPlaceholder(ENC), true);
});

test("isEncryptedCredentialPlaceholder rejects intermediate v10 lengths that are neither CBC nor GCM", () => {
  const body = Buffer.alloc(24, 0);
  Buffer.from("v10", "utf8").copy(body, 0);
  assert.equal(isEncryptedCredentialPlaceholder(`enc:v1:${body.toString("base64")}`), false);
});

test("isEncryptedCredentialPlaceholder detects real Windows DPAPI base64 prefixes", () => {
  const body = Buffer.from([
    0x01, 0x00, 0x00, 0x00,
    0xd0, 0x8c, 0x9d, 0xdf, 0x01, 0x15, 0xd1, 0x11,
    0x8c, 0x7a, 0x00, 0xc0, 0x4f, 0xc2, 0x97, 0xeb,
    0xaa,
  ]);
  const encoded = body.toString("base64");
  assert.equal(encoded.startsWith("AQAAANCMnd8"), true);
  assert.equal(isEncryptedCredentialPlaceholder(`enc:v1:${encoded}`), true);
});

test("isEncryptedCredentialPlaceholder rejects header-only enc:v1 payloads", () => {
  assert.equal(isEncryptedCredentialPlaceholder("enc:v1:djEw"), false);
});

test("needsVaultStoredKeyHydration waits for imported or generated ciphertext and empty keys", () => {
  assert.equal(isVaultStoredKeySource("imported"), true);
  assert.equal(isVaultStoredKeySource("generated"), true);
  assert.equal(isVaultStoredKeySource("reference"), false);
  assert.equal(needsVaultStoredKeyHydration({
    source: "imported",
    privateKey: ENC,
  }), true);
  assert.equal(needsVaultStoredKeyHydration({
    source: "generated",
    privateKey: "",
  }), true);
  assert.equal(needsVaultStoredKeyHydration({
    source: "imported",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
  }), false);
  assert.equal(needsVaultStoredKeyHydration({
    source: "reference",
    privateKey: ENC,
  }), false);
});

test("findSyncPayloadEncryptedCredentialPaths reports host and key secrets", () => {
  const paths = findSyncPayloadEncryptedCredentialPaths(samplePayload());
  assert.deepEqual(paths, ["hosts[0].password", "keys[0].privateKey"]);
});

test("stripSyncPayloadEncryptedCredentials clears device-bound placeholders for recovery", () => {
  const stripped = stripSyncPayloadEncryptedCredentials(samplePayload());
  assert.equal(stripped.hosts[0]?.password, undefined);
  assert.equal(stripped.keys[0]?.privateKey, "");
  assert.equal(findSyncPayloadEncryptedCredentialPaths(stripped).length, 0);
});

test("healPoisonedSecretsForMerge keeps usable preferred passwords over poisoned enc:v1", () => {
  const poisoned = samplePayload();
  const preferred = samplePayload({
    hosts: [{
      ...samplePayload().hosts[0]!,
      password: "preferred-secret",
    }],
    keys: [{
      ...samplePayload().keys[0]!,
      privateKey: "PREFERRED_PRIVATE_KEY",
    }],
  });
  const fallback = samplePayload({
    hosts: [{
      ...samplePayload().hosts[0]!,
      password: "base-secret",
    }],
  });
  const healed = healPoisonedSecretsForMerge(poisoned, preferred, fallback);
  assert.equal(healed.hosts[0]?.password, "preferred-secret");
  assert.equal(healed.keys[0]?.privateKey, "PREFERRED_PRIVATE_KEY");
});

test("healPoisonedSecretsForMerge heals local poison from remote then base", () => {
  const local = samplePayload();
  const remote = samplePayload({
    hosts: [{
      ...samplePayload().hosts[0]!,
      password: "remote-secret",
    }],
    keys: [{
      ...samplePayload().keys[0]!,
      privateKey: ENC,
    }],
  });
  const base = samplePayload({
    keys: [{
      ...samplePayload().keys[0]!,
      privateKey: "BASE_PRIVATE_KEY",
    }],
  });
  const healed = healPoisonedSecretsForMerge(local, remote, base);
  assert.equal(healed.hosts[0]?.password, "remote-secret");
  assert.equal(healed.keys[0]?.privateKey, "BASE_PRIVATE_KEY");
});

test("healPoisonedSecretsForMerge preserves explicit preferred credential deletions", () => {
  const poisoned = samplePayload({
    hosts: [{
      ...samplePayload().hosts[0]!,
      label: "renamed-on-poisoned-device",
      password: ENC,
    }],
  });
  const preferred = samplePayload({
    hosts: [{
      ...samplePayload().hosts[0]!,
      label: "renamed-on-poisoned-device",
      password: undefined,
    }],
  });
  const fallback = samplePayload({
    hosts: [{
      ...samplePayload().hosts[0]!,
      password: "base-secret",
    }],
  });
  const healed = healPoisonedSecretsForMerge(poisoned, preferred, fallback);
  assert.equal(healed.hosts[0]?.password, undefined);
  assert.equal(healed.hosts[0]?.label, "renamed-on-poisoned-device");
});
