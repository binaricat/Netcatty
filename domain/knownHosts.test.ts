import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { describeHostKey } = require("../electron/bridges/hostKeyVerifier.cjs");
const { mintHostCertificates, legacyCertificate, sshString, sshKeygenSkip } = require("../electron/bridges/fixtures/hostCertificates.test.fixture.cjs");

import type { KnownHost } from "./models";
import {
  fingerprintFromPublicKey,
  normalizeKnownHost,
  normalizeKnownHosts,
  upsertKnownHost,
} from "./knownHosts";

const knownHost = (overrides: Partial<KnownHost> = {}): KnownHost => ({
  id: "kh-existing",
  hostname: "10.2.0.32",
  port: 22,
  keyType: "ssh-ed25519",
  publicKey: "ssh-ed25519 old-key",
  fingerprint: "old-fingerprint",
  discoveredAt: 100,
  ...overrides,
});

test("upsertKnownHost updates an existing host key instead of appending a duplicate", () => {
  const existing = knownHost({ convertedToHostId: "host-1" });
  const incoming = knownHost({
    id: "kh-new",
    publicKey: "ssh-ed25519 new-key",
    fingerprint: "new-fingerprint",
    discoveredAt: 200,
  });

  const result = upsertKnownHost([existing], incoming);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    ...existing,
    publicKey: "ssh-ed25519 new-key",
    fingerprint: "new-fingerprint",
    lastSeen: 200,
  });
});

test("upsertKnownHost updates by id even when the incoming key type is unknown", () => {
  const existing = knownHost({
    id: "kh-1",
    keyType: "ssh-ed25519",
    publicKey: "SHA256:old-key",
    fingerprint: "old-fingerprint",
    discoveredAt: 100,
  });
  const incoming = knownHost({
    id: "kh-1",
    keyType: "unknown",
    publicKey: undefined,
    fingerprint: "new-fingerprint",
    discoveredAt: 200,
  });

  const result = upsertKnownHost([existing], incoming);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "kh-1");
  assert.equal(result[0].keyType, "unknown");
  assert.equal(result[0].fingerprint, "new-fingerprint");
  assert.equal(result[0].lastSeen, 200);
});

test("upsertKnownHost prefers the matching id over an earlier selector match", () => {
  const duplicate = knownHost({
    id: "kh-duplicate",
    fingerprint: "duplicate-fingerprint",
    discoveredAt: 50,
  });
  const target = knownHost({
    id: "kh-target",
    fingerprint: "target-fingerprint",
    discoveredAt: 100,
  });
  const incoming = knownHost({
    id: "kh-target",
    fingerprint: "new-fingerprint",
    discoveredAt: 200,
  });

  const result = upsertKnownHost([duplicate, target], incoming);

  assert.equal(result.length, 2);
  assert.equal(result[0].fingerprint, "duplicate-fingerprint");
  assert.equal(result[1].id, "kh-target");
  assert.equal(result[1].fingerprint, "new-fingerprint");
});

test("upsertKnownHost appends genuinely new host keys", () => {
  const existing = knownHost();
  const incoming = knownHost({
    id: "kh-other",
    hostname: "10.2.0.33",
    fingerprint: "other-fingerprint",
  });

  const result = upsertKnownHost([existing], incoming);

  assert.deepEqual(result, [existing, incoming]);
});

// --- Fingerprint derivation -------------------------------------------------

const makeRawPublicKey = (keyType: string, body = "trusted imported host key") => {
  const type = Buffer.from(keyType);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(type.length, 0);
  return Buffer.concat([length, type, Buffer.from(body)]);
};

test("fingerprintFromPublicKey matches Node's SHA-256 over a base64-decoded OpenSSH line", () => {
  const rawKey = makeRawPublicKey("ssh-ed25519");
  const base64Body = rawKey.toString("base64");
  const expected = crypto.createHash("sha256").update(rawKey).digest("base64").replace(/=+$/g, "");

  assert.equal(fingerprintFromPublicKey(`ssh-ed25519 ${base64Body}`), expected);
  assert.equal(
    fingerprintFromPublicKey(`ssh-ed25519 ${base64Body} comment-tail`),
    expected,
    "trailing comment is ignored",
  );
});

test("fingerprintFromPublicKey strips a SHA256: prefix and trailing padding", () => {
  assert.equal(fingerprintFromPublicKey("SHA256:abc123=="), "abc123");
  assert.equal(fingerprintFromPublicKey("sha256:abc123"), "abc123");
});

test("fingerprintFromPublicKey returns empty string on missing input", () => {
  assert.equal(fingerprintFromPublicKey(undefined), "");
  assert.equal(fingerprintFromPublicKey(null), "");
  assert.equal(fingerprintFromPublicKey(""), "");
});

// --- Migration --------------------------------------------------------------

for (const options of [
  { type: "ed25519" },
  { type: "rsa", bits: 2048 },
  ...[256, 384, 521].map((bits) => ({ type: "ecdsa", bits })),
  { type: "ed25519", sk: true },
  { type: "ecdsa", bits: 256, sk: true },
]) {
  test(`renderer certificate fingerprint and migration agree with verifier: ${JSON.stringify(options)}`, { skip: sshKeygenSkip }, (t) => {
    const { first, renewed, different } = mintHostCertificates(t, options);
    const expected = describeHostKey(first.blob).fingerprint;
    assert.equal(fingerprintFromPublicKey(first.line), expected);
    assert.equal(expected, first.publicKeyFingerprint);
    assert.equal(fingerprintFromPublicKey(renewed.line), expected);
    assert.notEqual(fingerprintFromPublicKey(different.line), expected);
    assert.equal(fingerprintFromPublicKey(first.plain.line), expected);

    const legacy = knownHost({
      keyType: first.keyType,
      publicKey: first.line,
      fingerprint: crypto.createHash("sha256").update(first.blob).digest("base64").replace(/=+$/g, ""),
    });
    const migrated = normalizeKnownHost(legacy);
    assert.equal(migrated.fingerprint, expected);
    assert.equal(migrated.keyType, first.keyType);
    assert.equal(migrated.publicKey, first.line);
    assert.equal(normalizeKnownHost(migrated), migrated, "migration is idempotent");
    assert.equal(normalizeKnownHost({ ...legacy, fingerprint: undefined }).fingerprint, expected);
    assert.equal(normalizeKnownHost({ ...legacy, keyType: "" }).keyType, first.keyType);
    const unrelated = { ...legacy, fingerprint: "unrelated-explicit-fingerprint" };
    assert.equal(normalizeKnownHost(unrelated), unrelated);
    const opaque = { ...legacy, publicKey: `SHA256:${legacy.fingerprint}` };
    assert.equal(normalizeKnownHost(opaque), opaque);
    const fingerprintOnly = { ...legacy, publicKey: undefined };
    assert.equal(normalizeKnownHost(fingerprintOnly), fingerprintOnly);
  });
}

test("renderer fingerprints v00 certificates and falls back for unparseable certificates", () => {
  const cert = legacyCertificate("ssh-rsa", ["exponent", "modulus"]);
  assert.equal(fingerprintFromPublicKey(cert.line), describeHostKey(cert.plain).fingerprint);
  const malformed = Buffer.concat([
    sshString("ssh-ed25519-cert-v01@openssh.com"), sshString("nonce"), sshString(Buffer.alloc(32)),
  ]);
  const line = `ssh-ed25519-cert-v01@openssh.com ${malformed.toString("base64")}`;
  const fullHash = crypto.createHash("sha256").update(malformed).digest("base64").replace(/=+$/g, "");
  assert.equal(fingerprintFromPublicKey(line), fullHash);
  assert.equal(fingerprintFromPublicKey(line), describeHostKey(malformed).fingerprint);
});

test("normalizeKnownHost backfills fingerprint when only publicKey is stored", () => {
  const rawKey = makeRawPublicKey("ssh-ed25519");
  const base64Body = rawKey.toString("base64");
  const expected = crypto.createHash("sha256").update(rawKey).digest("base64").replace(/=+$/g, "");

  const stored: KnownHost = {
    id: "kh-1",
    hostname: "vps-1.example.com",
    port: 22,
    keyType: "ssh-ed25519",
    publicKey: `ssh-ed25519 ${base64Body}`,
    discoveredAt: 1,
  };

  const migrated = normalizeKnownHost(stored);
  assert.notEqual(migrated, stored, "should return a new object when fingerprint is added");
  assert.equal(migrated.fingerprint, expected);
  assert.equal(migrated.keyType, "ssh-ed25519");
});

test("normalizeKnownHost backfills keyType from an OpenSSH-format publicKey", () => {
  const rawKey = makeRawPublicKey("ssh-rsa");
  const base64Body = rawKey.toString("base64");

  const stored: KnownHost = {
    id: "kh-1",
    hostname: "vps-1.example.com",
    port: 22,
    keyType: "",
    publicKey: `ssh-rsa ${base64Body}`,
    discoveredAt: 1,
  };

  const migrated = normalizeKnownHost(stored);
  assert.equal(migrated.keyType, "ssh-rsa");
});

test("normalizeKnownHost returns the same reference when nothing needs backfilling", () => {
  const rawKey = makeRawPublicKey("ssh-ed25519");
  const fp = crypto.createHash("sha256").update(rawKey).digest("base64").replace(/=+$/g, "");

  const stored: KnownHost = {
    id: "kh-1",
    hostname: "vps-1.example.com",
    port: 22,
    keyType: "ssh-ed25519",
    publicKey: `ssh-ed25519 ${rawKey.toString("base64")}`,
    fingerprint: fp,
    discoveredAt: 1,
  };

  assert.equal(normalizeKnownHost(stored), stored);
});

test("normalizeKnownHost is a no-op when publicKey is opaque and nothing else is known", () => {
  const stored: KnownHost = {
    id: "kh-1",
    hostname: "vps-1.example.com",
    port: 22,
    keyType: "unknown",
    publicKey: "SHA256:already-just-a-fingerprint",
    discoveredAt: 1,
  };

  const migrated = normalizeKnownHost(stored);
  // The SHA256: prefix becomes the fingerprint; keyType stays as "unknown" since
  // we cannot recover it from a bare fingerprint.
  assert.equal(migrated.fingerprint, "already-just-a-fingerprint");
  assert.equal(migrated.keyType, "unknown");
});

test("normalizeKnownHosts returns the same array reference when nothing needs migration", () => {
  const rawKey = makeRawPublicKey("ssh-ed25519");
  const fp = crypto.createHash("sha256").update(rawKey).digest("base64").replace(/=+$/g, "");

  const list: KnownHost[] = [{
    id: "kh-1",
    hostname: "vps-1.example.com",
    port: 22,
    keyType: "ssh-ed25519",
    publicKey: `ssh-ed25519 ${rawKey.toString("base64")}`,
    fingerprint: fp,
    discoveredAt: 1,
  }];

  assert.equal(normalizeKnownHosts(list), list);
});

test("normalizeKnownHosts migrates each entry that needs backfilling", () => {
  const rawKeyA = makeRawPublicKey("ssh-ed25519", "host-a-key");
  const rawKeyB = makeRawPublicKey("ssh-rsa", "host-b-key");
  const fpA = crypto.createHash("sha256").update(rawKeyA).digest("base64").replace(/=+$/g, "");
  const fpB = crypto.createHash("sha256").update(rawKeyB).digest("base64").replace(/=+$/g, "");

  const list: KnownHost[] = [
    {
      id: "kh-1",
      hostname: "vps-1.example.com",
      port: 22,
      keyType: "ssh-ed25519",
      publicKey: `ssh-ed25519 ${rawKeyA.toString("base64")}`,
      discoveredAt: 1,
    },
    {
      id: "kh-2",
      hostname: "vps-2.example.com",
      port: 22,
      keyType: "",
      publicKey: `ssh-rsa ${rawKeyB.toString("base64")}`,
      discoveredAt: 2,
    },
  ];

  const migrated = normalizeKnownHosts(list);
  assert.notEqual(migrated, list);
  assert.equal(migrated[0].fingerprint, fpA);
  assert.equal(migrated[1].fingerprint, fpB);
  assert.equal(migrated[1].keyType, "ssh-rsa");
});
