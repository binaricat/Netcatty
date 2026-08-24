const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { utils: sshUtils } = require("ssh2");

const { convertPpkToOpenSsh, serializePpk } = require("./ppkConverter.cjs");
const {
  normalizePrivateKeyForSsh2,
  PrivateKeyPassphraseError,
  UnsupportedPrivateKeyError,
} = require("./privateKeyNormalizer.cjs");
const { preparePrivateKeyForAuth, isKeyEncrypted } = require("./sshAuthHelper.cjs");

const hasArgon2 = typeof crypto.argon2Sync === "function";

function u32(value) {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32BE(value);
  return buf;
}

function writeBytes(buf) {
  return Buffer.concat([u32(buf.length), buf]);
}

function writeString(value) {
  return writeBytes(Buffer.from(value, "utf8"));
}

function writeMpint(buf) {
  let value = buf;
  while (value.length > 1 && value[0] === 0) value = value.subarray(1);
  if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return writeBytes(value);
}

function parseOk(key) {
  const parsed = sshUtils.parseKey(key);
  return parsed && !(parsed instanceof Error) ? parsed : null;
}

function ed25519Blobs() {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const seed = Buffer.from(jwk.d, "base64url");
  const pub = Buffer.from(jwk.x, "base64url");
  return {
    seed,
    pub,
    publicBlob: Buffer.concat([writeString("ssh-ed25519"), writeBytes(pub)]),
    privateBlob: writeBytes(seed),
  };
}

function ecdsaP256Blobs() {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const d = Buffer.from(jwk.d, "base64url");
  const point = Buffer.concat([Buffer.from([0x04]), x, y]);
  return {
    publicBlob: Buffer.concat([
      writeString("ecdsa-sha2-nistp256"),
      writeString("nistp256"),
      writeBytes(point),
    ]),
    privateBlob: writeMpint(d),
  };
}

function rsaBlobs() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" });
  const n = Buffer.from(jwk.n, "base64url");
  const e = Buffer.from(jwk.e, "base64url");
  const d = Buffer.from(jwk.d, "base64url");
  const p = Buffer.from(jwk.p, "base64url");
  const q = Buffer.from(jwk.q, "base64url");
  const qi = Buffer.from(jwk.qi, "base64url");
  return {
    publicBlob: Buffer.concat([writeString("ssh-rsa"), writeMpint(e), writeMpint(n)]),
    privateBlob: Buffer.concat([writeMpint(d), writeMpint(p), writeMpint(q), writeMpint(qi)]),
  };
}

function ed25519Ppk(options = {}) {
  const blobs = ed25519Blobs();
  const ppk = serializePpk({
    version: options.version ?? 2,
    type: "ssh-ed25519",
    comment: options.comment ?? "ed25519-test",
    publicBlob: blobs.publicBlob,
    privateBlob: blobs.privateBlob,
    passphrase: options.passphrase,
  });
  return { ...blobs, ppk };
}

test("ssh2 cannot parse an encrypted Ed25519 PPK v2 even with the correct passphrase", () => {
  const { ppk } = ed25519Ppk({ passphrase: "correct horse" });
  assert.match(ppk, /^PuTTY-User-Key-File-2: ssh-ed25519/m);
  const parsed = sshUtils.parseKey(ppk, "correct horse");
  assert.ok(parsed instanceof Error, "ssh2 should reject Ed25519 PPK");
});

test("converts an encrypted Ed25519 PPK v2 into an ssh2-parseable OpenSSH key", () => {
  const { ppk, pub } = ed25519Ppk({ passphrase: "secret" });
  const result = normalizePrivateKeyForSsh2(ppk, "secret");
  assert.equal(result.converted, true);
  assert.equal(result.passphrase, undefined);
  const parsed = parseOk(result.privateKey);
  assert.ok(parsed);
  assert.equal(parsed.type, "ssh-ed25519");
  assert.deepEqual(parsed.getPublicSSH().subarray(-32), pub);
});

test("converts an unencrypted Ed25519 PPK v2", () => {
  const { ppk } = ed25519Ppk();
  const result = normalizePrivateKeyForSsh2(ppk);
  assert.equal(result.converted, true);
  assert.ok(parseOk(result.privateKey));
});

test("converts an encrypted Ed25519 PPK with CRLF line endings", () => {
  const { ppk } = ed25519Ppk({ passphrase: "secret" });
  const crlf = ppk.replace(/\n/g, "\r\n");
  const result = normalizePrivateKeyForSsh2(crlf, "secret");
  assert.equal(result.converted, true);
  assert.ok(parseOk(result.privateKey));
});

function stubEncryptedPpkV3({ memory = 8192, passes = 2, parallelism = 1 } = {}) {
  return [
    "PuTTY-User-Key-File-3: ssh-ed25519",
    "Encryption: aes256-cbc",
    "Comment: stub",
    "Public-Lines: 1",
    "AAAA",
    "Key-Derivation: Argon2id",
    `Argon2-Memory: ${memory}`,
    `Argon2-Passes: ${passes}`,
    `Argon2-Parallelism: ${parallelism}`,
    "Argon2-Salt: 00112233445566778899aabbccddeeff",
    "Private-Lines: 1",
    "AAAA",
    "Private-MAC: 00",
    "",
  ].join("\n");
}

test("rejects an encrypted PPK v3 with unbounded Argon2 memory before deriving keys", () => {
  const started = Date.now();
  assert.throws(
    () => normalizePrivateKeyForSsh2(stubEncryptedPpkV3({ memory: 999999999 }), "secret"),
    (err) => err instanceof UnsupportedPrivateKeyError && /Argon2 parameters exceed supported limits/.test(err.message),
  );
  assert.ok(Date.now() - started < 250, "oversized Argon2 work factors must be rejected without deriving");
});

test("rejects an encrypted PPK v3 with a non-positive Argon2 pass count", () => {
  assert.throws(
    () => normalizePrivateKeyForSsh2(stubEncryptedPpkV3({ passes: 0 }), "secret"),
    (err) => err instanceof UnsupportedPrivateKeyError && /Argon2 parameters exceed supported limits/.test(err.message),
  );
});

test("throws PrivateKeyPassphraseError for encrypted Ed25519 PPK with the wrong passphrase", () => {
  const { ppk } = ed25519Ppk({ passphrase: "secret" });
  assert.throws(
    () => normalizePrivateKeyForSsh2(ppk, "wrong"),
    (err) => err instanceof PrivateKeyPassphraseError,
  );
});

test("throws PrivateKeyPassphraseError when an encrypted PPK has no passphrase", () => {
  const { ppk } = ed25519Ppk({ passphrase: "secret" });
  assert.throws(
    () => normalizePrivateKeyForSsh2(ppk),
    (err) => err instanceof PrivateKeyPassphraseError,
  );
});

test("converts an encrypted Ed25519 PPK v3 using Argon2id", { skip: !hasArgon2 }, () => {
  const { ppk, pub } = ed25519Ppk({ version: 3, passphrase: "secret" });
  assert.match(ppk, /^PuTTY-User-Key-File-3: ssh-ed25519/m);
  assert.match(ppk, /^Key-Derivation: Argon2id/m);
  const ssh2Parsed = sshUtils.parseKey(ppk, "secret");
  assert.ok(ssh2Parsed instanceof Error, "ssh2 should reject PPK v3");
  const result = normalizePrivateKeyForSsh2(ppk, "secret");
  assert.equal(result.converted, true);
  const parsed = parseOk(result.privateKey);
  assert.ok(parsed);
  assert.equal(parsed.type, "ssh-ed25519");
  assert.deepEqual(parsed.getPublicSSH().subarray(-32), pub);
});

test("converts an encrypted ECDSA P-256 PPK v2", () => {
  const blobs = ecdsaP256Blobs();
  const ppk = serializePpk({
    version: 2,
    type: "ecdsa-sha2-nistp256",
    comment: "ecdsa-test",
    publicBlob: blobs.publicBlob,
    privateBlob: blobs.privateBlob,
    passphrase: "secret",
  });
  const result = normalizePrivateKeyForSsh2(ppk, "secret");
  assert.equal(result.converted, true);
  const parsed = parseOk(result.privateKey);
  assert.ok(parsed);
  assert.equal(parsed.type, "ecdsa-sha2-nistp256");
});

test("converts an encrypted RSA PPK v3 that ssh2 cannot parse", { skip: !hasArgon2 }, () => {
  const blobs = rsaBlobs();
  const ppk = serializePpk({
    version: 3,
    type: "ssh-rsa",
    comment: "rsa-v3",
    publicBlob: blobs.publicBlob,
    privateBlob: blobs.privateBlob,
    passphrase: "secret",
  });
  assert.ok(sshUtils.parseKey(ppk, "secret") instanceof Error);
  const result = normalizePrivateKeyForSsh2(ppk, "secret");
  assert.equal(result.converted, true);
  const parsed = parseOk(result.privateKey);
  assert.ok(parsed);
  assert.equal(parsed.type, "ssh-rsa");
});

test("leaves a PPK v2 RSA key to ssh2 when it can already parse it", () => {
  const blobs = rsaBlobs();
  const ppk = serializePpk({
    version: 2,
    type: "ssh-rsa",
    comment: "rsa-v2",
    publicBlob: blobs.publicBlob,
    privateBlob: blobs.privateBlob,
    passphrase: "secret",
  });
  const ssh2Parsed = sshUtils.parseKey(ppk, "secret");
  assert.ok(ssh2Parsed && !(ssh2Parsed instanceof Error), "ssh2 should still parse RSA PPK v2");
  const result = normalizePrivateKeyForSsh2(ppk, "secret");
  assert.equal(result.converted, false);
  assert.equal(result.privateKey, ppk);
});

test("convertPpkToOpenSsh returns null for non-PPK input", () => {
  assert.equal(convertPpkToOpenSsh("-----BEGIN OPENSSH PRIVATE KEY-----"), null);
});

test("rejects an unsupported PPK algorithm with UnsupportedPrivateKeyError", () => {
  const ppk = [
    "PuTTY-User-Key-File-2: ssh-unknown",
    "Encryption: none",
    "Comment: nope",
    "Public-Lines: 1",
    "AAAA",
    "Private-Lines: 1",
    "AAAA",
    "Private-MAC: 00",
    "",
  ].join("\n");
  assert.throws(
    () => normalizePrivateKeyForSsh2(ppk),
    (err) => err instanceof UnsupportedPrivateKeyError && /ssh-unknown/.test(err.message),
  );
});

// Real PuTTYgen fixtures from SshAgentLib (passphrase: "correct horse battery staple").
const PUTTYGEN_ED25519_V2 = `PuTTY-User-Key-File-2: ssh-ed25519
Encryption: aes256-cbc
Comment: eddsa-key-20220506
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAIH+QE+UNYtz7N9RX2FseJmmzIroOs24UzTsJP6kj
0gxU
Private-Lines: 1
ssG0o2XpU0dez67/t5sffDp5j41eXMt7ViZpeB7O1jtA7NLOQ3Q3UjAPBQJCR/Vs
Private-MAC: 8d45d4218f19b0677d6b51529ef43236468f0de9
`;

const PUTTYGEN_ED25519_V3_NONE = `PuTTY-User-Key-File-3: ssh-ed25519
Encryption: none
Comment: eddsa-key-20220506
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAIH+QE+UNYtz7N9RX2FseJmmzIroOs24UzTsJP6kj
0gxU
Private-Lines: 1
AAAAIAOsb28qs/Ob4JfyCCGqcONFEtlWkqquOryLlfbjebBp
Private-MAC: fd89c96303e82b9c7f3ddbec3884ebd5a3500da8d4f2e9716c0494f3c207fffa
`;

const PUTTYGEN_ED25519_V3 = `PuTTY-User-Key-File-3: ssh-ed25519
Encryption: aes256-cbc
Comment: eddsa-key-20220506
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAIH+QE+UNYtz7N9RX2FseJmmzIroOs24UzTsJP6kj
0gxU
Key-Derivation: Argon2id
Argon2-Memory: 8192
Argon2-Passes: 1
Argon2-Parallelism: 1
Argon2-Salt: 28cb68bdb97eaae0d3a71cb285dff1e0
Private-Lines: 1
mqR8KyKjLx8vZlOMIaP5ira+8z5uV9DsmiChSpOK0ut4FyQJtYkRKi6InQcdz1Sa
Private-MAC: 0a0cc345089719caa38a7990ed9b6dd9b38792fd553a84e54be01885d240df83
`;

const PUTTYGEN_PASSPHRASE = "correct horse battery staple";

test("converts a real PuTTYgen unencrypted Ed25519 PPK v3", () => {
  const result = normalizePrivateKeyForSsh2(PUTTYGEN_ED25519_V3_NONE);
  assert.equal(result.converted, true);
  const parsed = parseOk(result.privateKey);
  assert.ok(parsed);
  assert.equal(parsed.type, "ssh-ed25519");
});

test("converts an unencrypted generated Ed25519 PPK v3", () => {
  const { ppk } = ed25519Ppk({ version: 3 });
  assert.match(ppk, /^PuTTY-User-Key-File-3: ssh-ed25519/m);
  assert.match(ppk, /^Encryption: none/m);
  const result = normalizePrivateKeyForSsh2(ppk);
  assert.equal(result.converted, true);
  assert.ok(parseOk(result.privateKey));
});

test("preparePrivateKeyForAuth returns an unlocked OpenSSH key for encrypted PPK", async () => {
  const { ppk } = ed25519Ppk({ passphrase: "secret" });
  const result = await preparePrivateKeyForAuth({
    sender: { isDestroyed: () => false, send: () => {} },
    privateKey: ppk,
    keyName: "putty-ed25519.ppk",
    hostname: "example.test",
    initialPassphrase: "secret",
    logPrefix: "[Test]",
  });
  assert.ok(result);
  assert.equal(isKeyEncrypted(ppk), true);
  assert.equal(isKeyEncrypted(result.privateKey), false);
  assert.equal(result.passphrase, undefined);
});

test("decrypts a real PuTTYgen encrypted Ed25519 PPK v2", () => {
  assert.ok(sshUtils.parseKey(PUTTYGEN_ED25519_V2, PUTTYGEN_PASSPHRASE) instanceof Error);
  const result = normalizePrivateKeyForSsh2(PUTTYGEN_ED25519_V2, PUTTYGEN_PASSPHRASE);
  assert.equal(result.converted, true);
  const parsed = parseOk(result.privateKey);
  assert.ok(parsed);
  assert.equal(parsed.type, "ssh-ed25519");
  assert.equal(parsed.comment, "eddsa-key-20220506");
});

test("decrypts a real PuTTYgen encrypted Ed25519 PPK v3 (Argon2id)", { skip: !hasArgon2 }, () => {
  assert.ok(sshUtils.parseKey(PUTTYGEN_ED25519_V3, PUTTYGEN_PASSPHRASE) instanceof Error);
  const result = normalizePrivateKeyForSsh2(PUTTYGEN_ED25519_V3, PUTTYGEN_PASSPHRASE);
  assert.equal(result.converted, true);
  const parsed = parseOk(result.privateKey);
  assert.ok(parsed);
  assert.equal(parsed.type, "ssh-ed25519");
  assert.equal(parsed.comment, "eddsa-key-20220506");
});

test("preparePrivateKeyForAuth decrypts an encrypted Ed25519 PPK", async () => {
  const { ppk } = ed25519Ppk({ passphrase: "secret" });
  const result = await preparePrivateKeyForAuth({
    sender: { isDestroyed: () => false, send: () => {} },
    privateKey: ppk,
    keyName: "putty-ed25519.ppk",
    hostname: "example.test",
    initialPassphrase: "secret",
    logPrefix: "[Test]",
  });
  assert.ok(result);
  assert.ok(parseOk(result.privateKey));
  assert.equal(result.passphrase, undefined);
});
