const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { utils: sshUtils } = require("ssh2");

const {
  normalizePrivateKeyForSsh2,
  PrivateKeyPassphraseError,
  UnsupportedPrivateKeyError,
} = require("./privateKeyNormalizer.cjs");

function genRsa(encoding) {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: encoding,
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
}

const rsaPkcs8 = () => genRsa({ type: "pkcs8", format: "pem" });
const rsaPkcs1 = () => genRsa({ type: "pkcs1", format: "pem" });
const encryptedRsaPkcs8 = (passphrase) =>
  genRsa({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase });
const ecPkcs8 = () =>
  crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
const ed25519Pkcs8 = () =>
  crypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;

function parseOk(key) {
  const r = sshUtils.parseKey(key);
  return r && !(r instanceof Error) ? r : null;
}

test("converts unencrypted RSA PKCS#8 into an ssh2-parseable key", () => {
  const result = normalizePrivateKeyForSsh2(rsaPkcs8());
  assert.equal(result.converted, true);
  const parsed = parseOk(result.privateKey);
  assert.ok(parsed, "converted key should be parseable by ssh2");
  assert.equal(parsed.type, "ssh-rsa");
});

test("converts unencrypted EC PKCS#8 into an ssh2-parseable key", () => {
  const result = normalizePrivateKeyForSsh2(ecPkcs8());
  assert.equal(result.converted, true);
  const parsed = parseOk(result.privateKey);
  assert.ok(parsed);
  assert.equal(parsed.type, "ecdsa-sha2-nistp256");
});

test("leaves an already-supported PKCS#1 key untouched", () => {
  const key = rsaPkcs1();
  const result = normalizePrivateKeyForSsh2(key);
  assert.equal(result.converted, false);
  assert.equal(result.privateKey, key);
});

test("decrypts and converts an encrypted RSA PKCS#8 key with the correct passphrase", () => {
  const result = normalizePrivateKeyForSsh2(encryptedRsaPkcs8("secret"), "secret");
  assert.equal(result.converted, true);
  assert.equal(result.passphrase, undefined);
  const parsed = parseOk(result.privateKey);
  assert.ok(parsed);
  assert.equal(parsed.type, "ssh-rsa");
});

test("throws PrivateKeyPassphraseError for encrypted PKCS#8 with a wrong passphrase", () => {
  assert.throws(
    () => normalizePrivateKeyForSsh2(encryptedRsaPkcs8("secret"), "wrong"),
    (err) => err instanceof PrivateKeyPassphraseError,
  );
});

test("throws UnsupportedPrivateKeyError for Ed25519 PKCS#8 with a conversion hint", () => {
  assert.throws(
    () => normalizePrivateKeyForSsh2(ed25519Pkcs8()),
    (err) => err instanceof UnsupportedPrivateKeyError && /ssh-keygen/.test(err.message),
  );
});

test("passes through content that is not a PKCS#8 key", () => {
  const junk = "not a private key";
  const result = normalizePrivateKeyForSsh2(junk);
  assert.equal(result.converted, false);
  assert.equal(result.privateKey, junk);
});
