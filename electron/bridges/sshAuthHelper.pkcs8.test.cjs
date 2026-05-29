const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
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

test("preparePrivateKeyForAuth recovers a mangled encrypted OpenSSH key via passphrase prompt", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mangled-openssh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyPath = path.join(dir, "id_ed25519");
  const gen = spawnSync(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "secret", "-f", keyPath, "-C", "netcatty-test"],
    { encoding: "utf8" },
  );
  if (gen.status !== 0) {
    t.skip("ssh-keygen is unavailable");
    return;
  }
  // Simulate a key whose line breaks were flattened into literal "\n" on paste.
  const mangled = fs.readFileSync(keyPath, "utf8").replace(/\n/g, "\\n");

  const originalRequest = passphraseHandler.requestPassphrase;
  t.after(() => {
    passphraseHandler.requestPassphrase = originalRequest;
  });
  let prompts = 0;
  passphraseHandler.requestPassphrase = async () => {
    prompts += 1;
    return { passphrase: "secret" };
  };

  const result = await preparePrivateKeyForAuth({
    sender,
    privateKey: mangled,
    keyName: "id_ed25519",
    hostname: "example.test",
    logPrefix: "[Test]",
  });

  assert.ok(result, "expected a prepared key");
  assert.equal(prompts, 1, "the encrypted key should trigger exactly one passphrase prompt");
  assert.equal(result.passphrase, "secret");
  const parsed = sshUtils.parseKey(result.privateKey, result.passphrase);
  assert.ok(parsed && !(parsed instanceof Error), "prepared key + passphrase should parse in ssh2");
});
