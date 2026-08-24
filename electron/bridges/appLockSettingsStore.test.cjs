const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createAppLockPasswordVerifier,
  createAppLockSettingsStore,
  canLockFromSettings,
  shouldLockOnBackgroundHide,
  verifyAppLockPassword,
} = require("./appLockSettingsStore.cjs");
const fs = require("node:fs");
const path = require("node:path");

const settingsStoreSource = fs.readFileSync(path.join(__dirname, "appLockSettingsStore.cjs"), "utf8");

test("password hashing uses the asynchronous crypto API", () => {
  assert.doesNotMatch(settingsStoreSource, /pbkdf2Sync/);
  assert.match(settingsStoreSource, /\bpbkdf2\b/);
});

const VALID_VERIFIER = {
  version: 1,
  algorithm: "PBKDF2-SHA256",
  iterations: 210000,
  salt: Buffer.alloc(16, 1).toString("base64"),
  hash: Buffer.alloc(32, 2).toString("base64"),
};

test("settings store loads disabled config when no persisted file exists", async () => {
  const store = createAppLockSettingsStore({
    filePath: "/tmp/app-lock-settings.json",
    readFile: async () => {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    },
    writeFile: async () => {},
  });

  const settings = await store.load();
  assert.deepEqual(settings, {
    enabled: false,
    timeoutMinutes: 15,
    systemUnlockEnabled: false,
    systemUnlockAutoPromptEnabled: false,
    passwordVerifier: null,
  });
  assert.deepEqual(store.getSnapshot(), settings);
});

test("settings store normalizes malformed persisted config to disabled defaults", async () => {
  const store = createAppLockSettingsStore({
    filePath: "/tmp/app-lock-settings.json",
    readFile: async () =>
      JSON.stringify({
        enabled: true,
        timeoutMinutes: 999,
        passwordVerifier: { hash: "invalid" },
      }),
    writeFile: async () => {},
  });

  const settings = await store.load();
  assert.deepEqual(settings, {
    enabled: false,
    timeoutMinutes: 15,
    systemUnlockEnabled: false,
    systemUnlockAutoPromptEnabled: false,
    passwordVerifier: null,
  });
});

test("settings store saves normalized settings and updates snapshot", async () => {
  let writeCall = null;
  const store = createAppLockSettingsStore({
    filePath: "/tmp/app-lock-settings.json",
    readFile: async () => {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    },
    writeFile: async (filePath, content, options) => {
      writeCall = { filePath, content, options };
    },
  });

  const saved = await store.save({
    enabled: true,
    timeoutMinutes: 0,
    systemUnlockEnabled: true,
    systemUnlockAutoPromptEnabled: true,
    passwordVerifier: VALID_VERIFIER,
  });

  assert.deepEqual(saved, {
    enabled: true,
    timeoutMinutes: 0,
    systemUnlockEnabled: true,
    systemUnlockAutoPromptEnabled: true,
    passwordVerifier: VALID_VERIFIER,
  });
  assert.deepEqual(store.getSnapshot(), saved);
  assert.deepEqual(writeCall, {
    filePath: "/tmp/app-lock-settings.json",
    content: `${JSON.stringify(saved, null, 2)}\n`,
    options: { mode: 0o600 },
  });
});

test("settings store clears system unlock when no valid verifier exists", async () => {
  const store = createAppLockSettingsStore({
    filePath: "/tmp/app-lock-settings.json",
    readFile: async () =>
      JSON.stringify({
        enabled: true,
        timeoutMinutes: 5,
        systemUnlockEnabled: true,
        systemUnlockAutoPromptEnabled: true,
        passwordVerifier: null,
      }),
    writeFile: async () => {},
  });

  const settings = await store.load();
  assert.deepEqual(settings, {
    enabled: false,
    timeoutMinutes: 5,
    systemUnlockEnabled: false,
    systemUnlockAutoPromptEnabled: false,
    passwordVerifier: null,
  });
});

test("canLockFromSettings requires enabled and a verifier", async () => {
  assert.equal(canLockFromSettings({ enabled: false, passwordVerifier: VALID_VERIFIER }), false);
  assert.equal(canLockFromSettings({ enabled: true, passwordVerifier: null }), false);
  assert.equal(canLockFromSettings({ enabled: true, passwordVerifier: { hash: "x" } }), false);
  assert.equal(canLockFromSettings({ enabled: true, passwordVerifier: VALID_VERIFIER }), true);
});

test("shouldLockOnBackgroundHide requires an automatic timeout", () => {
  assert.equal(shouldLockOnBackgroundHide({
    enabled: true,
    timeoutMinutes: 0,
    passwordVerifier: VALID_VERIFIER,
  }), false);
  assert.equal(shouldLockOnBackgroundHide({
    enabled: true,
    timeoutMinutes: 5,
    passwordVerifier: VALID_VERIFIER,
  }), true);
  assert.equal(shouldLockOnBackgroundHide({
    enabled: false,
    timeoutMinutes: 5,
    passwordVerifier: VALID_VERIFIER,
  }), false);
});

test("createAppLockPasswordVerifier stores a verifier that verifyAppLockPassword accepts", async () => {
  const verifier = await createAppLockPasswordVerifier("correct horse battery staple");

  assert.equal(verifier.version, 1);
  assert.equal(verifier.algorithm, "PBKDF2-SHA256");
  assert.ok(verifier.iterations >= 100000);
  assert.notEqual(verifier.salt, "");
  assert.notEqual(verifier.hash, "");

  assert.equal(await verifyAppLockPassword("correct horse battery staple", verifier), true);
  assert.equal(await verifyAppLockPassword("wrong password", verifier), false);
});
