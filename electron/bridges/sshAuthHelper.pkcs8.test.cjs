const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { utils: sshUtils } = require("ssh2");

const {
  preparePrivateKeyForAuth,
  loadIdentityFileForAuth,
} = require("./sshAuthHelper.cjs");
const passphraseHandler = require("./passphraseHandler.cjs");

function genRsaPkcs8(passphrase) {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: passphrase
      ? { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase }
      : { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
}

function isParseable(key) {
  const parsed = sshUtils.parseKey(key);
  return !!parsed && !(parsed instanceof Error);
}

const sender = { isDestroyed: () => false, send: () => {} };

test("preparePrivateKeyForAuth converts an unencrypted PKCS#8 key for ssh2", async () => {
  const result = await preparePrivateKeyForAuth({
    sender,
    privateKey: genRsaPkcs8(),
    keyName: "oracle.key",
    hostname: "example.test",
    logPrefix: "[Test]",
  });

  assert.ok(result, "expected a prepared key");
  assert.ok(isParseable(result.privateKey), "prepared key should be parseable by ssh2");
});

test("preparePrivateKeyForAuth decrypts and converts an encrypted PKCS#8 key", async (t) => {
  const original = passphraseHandler.requestPassphrase;
  t.after(() => {
    passphraseHandler.requestPassphrase = original;
  });

  let calls = 0;
  passphraseHandler.requestPassphrase = async () => {
    calls += 1;
    return calls === 1 ? { passphrase: "secret" } : { passphrase: null };
  };

  const result = await preparePrivateKeyForAuth({
    sender,
    privateKey: genRsaPkcs8("secret"),
    keyName: "oracle.key",
    hostname: "example.test",
    logPrefix: "[Test]",
  });

  assert.ok(result, "expected a prepared key");
  assert.equal(calls, 1, "correct passphrase should not be re-prompted");
  assert.ok(isParseable(result.privateKey), "prepared key should be parseable by ssh2");
  assert.equal(result.passphrase, undefined, "passphrase is unnecessary after conversion");
});

test("loadIdentityFileForAuth converts an unencrypted PKCS#8 identity file", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-pkcs8-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyPath = path.join(dir, "oracle.key");
  fs.writeFileSync(keyPath, genRsaPkcs8(), "utf8");

  const result = await loadIdentityFileForAuth({
    sender,
    keyPath,
    hostname: "example.test",
    logPrefix: "[Test]",
  });

  assert.ok(result, "expected a loaded identity file");
  assert.ok(isParseable(result.privateKey), "prepared key should be parseable by ssh2");
});
