const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  loadIdentityFileForAuth,
  preparePrivateKeyForAuth,
  isPassphraseCancelledError,
} = require("./sshAuthHelper.cjs");
const passphraseHandler = require("./passphraseHandler.cjs");

function createKey(t, passphrase) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-identity-file-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const keyPath = path.join(dir, "id_ed25519");
  const result = spawnSync("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    passphrase,
    "-f",
    keyPath,
    "-C",
    "netcatty-test",
  ], { encoding: "utf8" });

  if (result.status !== 0) {
    t.skip("ssh-keygen is unavailable");
    return null;
  }

  return keyPath;
}

function createEncryptedKey(t) {
  return createKey(t, "secret");
}

function createSender() {
  const events = [];
  return {
    events,
    sender: {
      isDestroyed: () => false,
      send: (channel, payload) => {
        events.push({ channel, payload });
      },
    },
  };
}

test("loadIdentityFileForAuth accepts an unencrypted Ed25519 private key", async (t) => {
  const keyPath = createKey(t, "");
  if (!keyPath) return;

  const identityFile = await loadIdentityFileForAuth({
    keyPath,
    hostname: "example.test",
  });

  assert.equal(identityFile.keyPath, keyPath);
  assert.match(identityFile.privateKey, /BEGIN OPENSSH PRIVATE KEY/);
});

test("loadIdentityFileForAuth rejects a public-only identity file", async (t) => {
  const keyPath = createKey(t, "");
  if (!keyPath) return;

  const publicKeyPath = `${keyPath}.pub`;
  const publicKey = fs.readFileSync(publicKeyPath, "utf8");

  await assert.rejects(
    () => loadIdentityFileForAuth({
      keyPath: publicKeyPath,
      hostname: "example.test",
    }),
    (err) => {
      assert.equal(err.code, "ERR_PRIVATE_KEY_INVALID");
      assert.ok(err.message.includes(publicKeyPath));
      assert.equal(err.message.includes(publicKey.trim()), false);
      return true;
    },
  );
});

test("preparePrivateKeyForAuth rejects a public-only inline key", async (t) => {
  const keyPath = createKey(t, "");
  if (!keyPath) return;

  const publicKey = fs.readFileSync(`${keyPath}.pub`, "utf8");

  await assert.rejects(
    () => preparePrivateKeyForAuth({
      privateKey: publicKey,
      keyName: "public-only",
      hostname: "example.test",
    }),
    (err) => {
      assert.equal(err.code, "ERR_PRIVATE_KEY_INVALID");
      assert.equal(err.message.includes(publicKey.trim()), false);
      return true;
    },
  );
});

test("loadIdentityFileForAuth rejects malformed key content without a raw fallback", async (t) => {
  const keyPath = createKey(t, "");
  if (!keyPath) return;
  fs.writeFileSync(keyPath, "not a private key");

  await assert.rejects(
    () => loadIdentityFileForAuth({
      keyPath,
      hostname: "example.test",
    }),
    (err) => {
      assert.equal(err.code, "ERR_PRIVATE_KEY_INVALID");
      assert.ok(err.message.includes(keyPath));
      assert.equal(err.message.includes("not a private key"), false);
      return true;
    },
  );
});

test("loadIdentityFileForAuth uses a valid saved passphrase without prompting", async (t) => {
  const keyPath = createEncryptedKey(t);
  if (!keyPath) return;

  const originalRequestPassphrase = passphraseHandler.requestPassphrase;
  t.after(() => {
    passphraseHandler.requestPassphrase = originalRequestPassphrase;
  });
  passphraseHandler.requestPassphrase = async () => {
    throw new Error("Unexpected passphrase prompt");
  };

  const { sender, events } = createSender();
  const identityFile = await loadIdentityFileForAuth({
    sender,
    keyPath,
    hostname: "example.test",
    initialPassphrase: "secret",
    logPrefix: "[Test]",
  });

  assert.equal(identityFile.passphrase, "secret");
  assert.match(identityFile.privateKey, /BEGIN OPENSSH PRIVATE KEY/);
  assert.deepEqual(events, []);
});

test("loadIdentityFileForAuth clears an invalid saved passphrase before prompting", async (t) => {
  const keyPath = createEncryptedKey(t);
  if (!keyPath) return;

  const originalRequestPassphrase = passphraseHandler.requestPassphrase;
  t.after(() => {
    passphraseHandler.requestPassphrase = originalRequestPassphrase;
  });

  let promptCount = 0;
  passphraseHandler.requestPassphrase = async (_sender, promptedPath, keyName, hostname, passphraseInvalid) => {
    promptCount += 1;
    assert.equal(promptedPath, keyPath);
    assert.equal(keyName, "id_ed25519");
    assert.equal(hostname, "example.test");
    assert.equal(passphraseInvalid, true);
    return { passphrase: "secret" };
  };

  const { sender, events } = createSender();
  const identityFile = await loadIdentityFileForAuth({
    sender,
    keyPath,
    hostname: "example.test",
    initialPassphrase: "wrong",
    logPrefix: "[Test]",
  });

  assert.equal(promptCount, 1);
  assert.equal(identityFile.passphrase, "secret");
  assert.deepEqual(events, [
    {
      channel: "netcatty:passphrase-auth-failed",
      payload: { keyPaths: [keyPath] },
    },
  ]);
});

test("preparePrivateKeyForAuth prompts for encrypted inline private keys", async (t) => {
  const keyPath = createEncryptedKey(t);
  if (!keyPath) return;
  const privateKey = fs.readFileSync(keyPath, "utf8");

  const originalRequestPassphrase = passphraseHandler.requestPassphrase;
  t.after(() => {
    passphraseHandler.requestPassphrase = originalRequestPassphrase;
  });

  let promptCount = 0;
  const promptEvents = [];
  passphraseHandler.requestPassphrase = async (_sender, promptedPath, keyName, hostname, passphraseInvalid) => {
    promptCount += 1;
    promptEvents.push("request");
    assert.equal(promptedPath, "SSH key for export-key");
    assert.equal(keyName, "export-key");
    assert.equal(hostname, "example.test");
    assert.equal(passphraseInvalid, false);
    return { passphrase: "secret" };
  };

  const { sender, events } = createSender();
  const prepared = await preparePrivateKeyForAuth({
    sender,
    privateKey,
    keyId: "key-1",
    keyName: "export-key",
    hostname: "example.test",
    logPrefix: "[Test]",
    onPassphrasePromptShown: () => promptEvents.push("shown"),
    onPassphrasePromptResolved: () => promptEvents.push("resolved"),
  });

  assert.equal(promptCount, 1);
  assert.deepEqual(promptEvents, ["shown", "request", "resolved"]);
  assert.equal(prepared.passphrase, "secret");
  assert.equal(prepared.privateKey, privateKey);
  assert.deepEqual(events, []);
});

test("preparePrivateKeyForAuth clears invalid saved inline private key passphrases", async (t) => {
  const keyPath = createEncryptedKey(t);
  if (!keyPath) return;
  const privateKey = fs.readFileSync(keyPath, "utf8");

  const originalRequestPassphrase = passphraseHandler.requestPassphrase;
  t.after(() => {
    passphraseHandler.requestPassphrase = originalRequestPassphrase;
  });

  passphraseHandler.requestPassphrase = async (_sender, promptedPath, keyName, hostname, passphraseInvalid) => {
    assert.equal(promptedPath, "SSH key for export-key");
    assert.equal(keyName, "export-key");
    assert.equal(hostname, "example.test");
    assert.equal(passphraseInvalid, true);
    return { passphrase: "secret" };
  };

  const { sender, events } = createSender();
  const prepared = await preparePrivateKeyForAuth({
    sender,
    privateKey,
    keyId: "key-1",
    keyName: "export-key",
    hostname: "example.test",
    initialPassphrase: "wrong",
    logPrefix: "[Test]",
  });

  assert.equal(prepared.passphrase, "secret");
  assert.deepEqual(events, [
    {
      channel: "netcatty:passphrase-auth-failed",
      payload: { keyPaths: ["SSH key for export-key"], keyIds: ["key-1"] },
    },
  ]);
});

test("preparePrivateKeyForAuth throws when the passphrase prompt is cancelled", async (t) => {
  const keyPath = createEncryptedKey(t);
  if (!keyPath) return;
  const privateKey = fs.readFileSync(keyPath, "utf8");

  const originalRequestPassphrase = passphraseHandler.requestPassphrase;
  t.after(() => {
    passphraseHandler.requestPassphrase = originalRequestPassphrase;
  });

  passphraseHandler.requestPassphrase = async () => ({ cancelled: true });

  await assert.rejects(
    () => preparePrivateKeyForAuth({
      sender: createSender().sender,
      privateKey,
      keyId: "key-1",
      keyName: "export-key",
      hostname: "example.test",
      logPrefix: "[Test]",
    }),
    (err) => isPassphraseCancelledError(err),
  );
});
