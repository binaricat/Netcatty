import test from "node:test";
import assert from "node:assert/strict";
import {
  clearKeyPassphrasesByIds,
  clearRememberedKeyPassphrases,
  clearReferenceKeyPassphrases,
  deleteVaultKey,
  loadDefaultKeyPassphrase,
  readDefaultKeyPassphraseForExport,
  readDefaultKeyPassphrasesForVerification,
  readRememberedKeyPassphrases,
  rememberImportedKeyPassphrase,
  rememberKeyPassphrase,
  removeDefaultKeyPassphraseAliases,
  saveDefaultKeyPassphrase,
  shouldUpdateReferenceKeyPassphrase,
} from "../defaultKeyPassphrases";
import { STORAGE_KEY_DEFAULT_KEY_PASSPHRASES } from "../../infrastructure/config/storageKeys";
import type { SSHKey } from "../../domain/models";

function installLocalStorage(t: test.TestContext): void {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty: undefined },
  });

  t.after(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
    Reflect.deleteProperty(globalThis, "window");
  });
}

const referenceKey = (): SSHKey => ({
  id: "reference-key",
  label: "id_ed25519",
  type: "ED25519",
  category: "key",
  source: "reference",
  filePath: "/Users/alice/.ssh/id_ed25519",
  privateKey: "",
  created: 1,
});

test("deleting a reference key also forgets its remembered passphrase", async (t) => {
  installLocalStorage(t);
  const key = referenceKey();
  let keys = [key];
  await saveDefaultKeyPassphrase(key.filePath!, "remembered-passphrase");

  await deleteVaultKey({
    keyId: key.id,
    getKeys: () => keys,
    updateKeys: (updated) => {
      keys = updated;
    },
  });

  assert.deepEqual(keys, []);
  assert.equal(await loadDefaultKeyPassphrase(key.filePath!), null);
});

test("deleting one reference keeps the passphrase while another key uses the same file", async (t) => {
  installLocalStorage(t);
  const key = referenceKey();
  const duplicate = { ...key, id: "duplicate-reference" };
  let keys = [key, duplicate];
  await saveDefaultKeyPassphrase(key.filePath!, "remembered-passphrase");

  await deleteVaultKey({
    keyId: key.id,
    getKeys: () => keys,
    updateKeys: (updated) => {
      keys = updated;
    },
  });

  assert.deepEqual(keys, [duplicate]);
  assert.equal(
    await loadDefaultKeyPassphrase(key.filePath!),
    "remembered-passphrase",
  );
});

test("deleting a key cannot overwrite a concurrent key-list update", async (t) => {
  installLocalStorage(t);
  const key = referenceKey();
  const concurrentReference = { ...key, id: "concurrent-reference" };
  let keys = [key];
  await saveDefaultKeyPassphrase(key.filePath!, "remembered-passphrase");
  let releaseHomeLookup: (() => void) | undefined;
  const homeLookup = new Promise<void>((resolve) => {
    releaseHomeLookup = resolve;
  });
  let homeLookupCount = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty: { getHomeDir: async () => {
      homeLookupCount += 1;
      await homeLookup;
      return "/Users/alice";
    } } },
  });

  const deletion = deleteVaultKey({
    keyId: key.id,
    getKeys: () => keys,
    updateKeys: (updated) => {
      keys = updated;
    },
  });
  assert.deepEqual(keys, []);
  keys = [concurrentReference];
  releaseHomeLookup?.();
  await deletion;

  assert.deepEqual(keys, [concurrentReference]);
  assert.equal(homeLookupCount, 1);
  assert.equal(
    await loadDefaultKeyPassphrase(key.filePath!),
    "remembered-passphrase",
  );
});

test("deleting a Windows reference clears remembered path aliases", async (t) => {
  installLocalStorage(t);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty: { getHomeDir: async () => "C:\\Users\\Alice" } },
  });
  const key = {
    ...referenceKey(),
    filePath: "~/.ssh/id_ed25519",
  };
  let keys = [key];
  globalThis.localStorage.setItem(
    STORAGE_KEY_DEFAULT_KEY_PASSPHRASES,
    JSON.stringify({
      "~/.ssh/id_ed25519": "old-relative",
      "C:\\Users\\Alice\\.ssh\\id_ed25519": "old-native",
      "C:/Users/Alice/.ssh/id_ed25519": "old-normalized",
      "C:/Users/Alice/.ssh/other": "keep",
    }),
  );

  await deleteVaultKey({
    keyId: key.id,
    getKeys: () => keys,
    updateKeys: (updated) => {
      keys = updated;
    },
  });

  assert.deepEqual(keys, []);
  assert.deepEqual(
    JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES) ?? "{}"),
    { "C:/Users/Alice/.ssh/other": "keep" },
  );
});

test("loadDefaultKeyPassphrase removes undecryptable credential placeholders", async (t) => {
  installLocalStorage(t);
  const keyPath = "/Users/alice/.ssh/id_ed25519";
  globalThis.localStorage.setItem(
    STORAGE_KEY_DEFAULT_KEY_PASSPHRASES,
    JSON.stringify({
      [keyPath]: "enc:v1:djEwYWJj",
      "/Users/alice/.ssh/id_rsa": "still-valid",
    }),
  );

  const result = await loadDefaultKeyPassphrase(keyPath);

  assert.equal(result, null);
  assert.deepEqual(
    JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES) ?? "{}"),
    { "/Users/alice/.ssh/id_rsa": "still-valid" },
  );
});

test("export read reports unavailable encrypted passphrases without deleting them", async (t) => {
  installLocalStorage(t);
  const keyPath = "/Users/alice/.ssh/id_ed25519";
  const encrypted = "enc:v1:djEwYWJj";
  globalThis.localStorage.setItem(
    STORAGE_KEY_DEFAULT_KEY_PASSPHRASES,
    JSON.stringify({ [keyPath]: encrypted }),
  );

  assert.deepEqual(
    await readDefaultKeyPassphraseForExport(keyPath),
    { status: "unreadable" },
  );
  assert.deepEqual(
    JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES) ?? "{}"),
    { [keyPath]: encrypted },
  );
});

test("export read retries when the passphrase changes during decryption", async (t) => {
  installLocalStorage(t);
  const keyPath = "/Users/alice/.ssh/id_ed25519";
  const encrypted = "enc:v1:djEwYWJj";
  let releaseDecrypt: (() => void) | undefined;
  const decryptGate = new Promise<void>((resolve) => {
    releaseDecrypt = resolve;
  });
  let firstDecryptStarted: (() => void) | undefined;
  const firstDecrypt = new Promise<void>((resolve) => {
    firstDecryptStarted = resolve;
  });
  let decryptCount = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        getHomeDir: async () => "/Users/alice",
        credentialsDecrypt: async (value: string) => {
          decryptCount += 1;
          if (decryptCount === 1) {
            firstDecryptStarted?.();
            await decryptGate;
            return "old-secret";
          }
          return value;
        },
      },
    },
  });
  globalThis.localStorage.setItem(
    STORAGE_KEY_DEFAULT_KEY_PASSPHRASES,
    JSON.stringify({ [keyPath]: encrypted }),
  );

  const pendingRead = readDefaultKeyPassphraseForExport(keyPath);
  await firstDecrypt;
  globalThis.localStorage.setItem(
    STORAGE_KEY_DEFAULT_KEY_PASSPHRASES,
    JSON.stringify({ [keyPath]: "new-secret" }),
  );
  releaseDecrypt?.();

  assert.deepEqual(await pendingRead, { status: "readable", value: "new-secret" });
});

test("remembered passphrase read includes Keychain reference-key values", async (t) => {
  installLocalStorage(t);
  const key = {
    ...referenceKey(),
    passphrase: "keychain-secret",
    savePassphrase: true,
  };

  assert.deepEqual(
    await readRememberedKeyPassphrases(key.filePath!, [key]),
    { values: ["keychain-secret"], unreadable: false },
  );
});

test("remembered passphrase read marks encrypted Keychain placeholders unreadable", async (t) => {
  installLocalStorage(t);
  const key = {
    ...referenceKey(),
    passphrase: "enc:v1:djEwYWJj",
    savePassphrase: true,
  };

  assert.deepEqual(
    await readRememberedKeyPassphrases(key.filePath!, [key]),
    { values: [], unreadable: true },
  );
});

test("passphrase verification reads every alias and preserves unreadable state", async (t) => {
  installLocalStorage(t);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        getHomeDir: async () => "/Users/alice",
        credentialsDecrypt: async (value: string) => value,
      },
    },
  });
  globalThis.localStorage.setItem(
    STORAGE_KEY_DEFAULT_KEY_PASSPHRASES,
    JSON.stringify({
      "~/.ssh/id_ed25519": "readable-secret",
      "/Users/alice/.ssh/id_ed25519": "enc:v1:djEwYWJj",
    }),
  );

  assert.deepEqual(
    await readDefaultKeyPassphrasesForVerification("~/.ssh/id_ed25519"),
    { values: ["readable-secret"], unreadable: true, present: true },
  );
  assert.deepEqual(
    await readRememberedKeyPassphrases("~/.ssh/id_ed25519", []),
    { values: ["readable-secret"], unreadable: true },
  );
});

test("passphrase verification preserves conflicting readable alias values", async (t) => {
  installLocalStorage(t);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty: { getHomeDir: async () => "/Users/alice" } },
  });
  globalThis.localStorage.setItem(
    STORAGE_KEY_DEFAULT_KEY_PASSPHRASES,
    JSON.stringify({
      "~/.ssh/id_ed25519": "relative-secret",
      "/Users/alice/.ssh/id_ed25519": "absolute-secret",
    }),
  );

  const read = await readRememberedKeyPassphrases("~/.ssh/id_ed25519", []);
  assert.deepEqual(new Set(read.values), new Set(["relative-secret", "absolute-secret"]));
  assert.equal(read.unreadable, false);
});

test("imported passphrase cannot overwrite a correction queued first", async (t) => {
  installLocalStorage(t);
  let releaseEncrypt: (() => void) | undefined;
  const encryptGate = new Promise<void>((resolve) => {
    releaseEncrypt = resolve;
  });
  let encryptStarted: (() => void) | undefined;
  const firstEncrypt = new Promise<void>((resolve) => {
    encryptStarted = resolve;
  });
  let encryptCount = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        credentialsEncrypt: async (value: string) => {
          encryptCount += 1;
          if (encryptCount === 1) {
            encryptStarted?.();
            await encryptGate;
          }
          return value;
        },
      },
    },
  });

  const correction = saveDefaultKeyPassphrase("~/.ssh/id_ed25519", "current-secret");
  await firstEncrypt;
  const imported = rememberImportedKeyPassphrase({
    keyPath: "~/.ssh/id_ed25519",
    passphrase: "stale-import-secret",
    keys: [],
    updateKeys: () => {},
  });
  releaseEncrypt?.();

  await correction;
  assert.equal(await imported, "conflict");
  assert.equal(await loadDefaultKeyPassphrase("~/.ssh/id_ed25519"), "current-secret");
});

test("imported passphrase cannot overwrite a direct key correction during validation", async (t) => {
  installLocalStorage(t);
  let releaseEncrypt: (() => void) | undefined;
  const encryptGate = new Promise<void>((resolve) => {
    releaseEncrypt = resolve;
  });
  let encryptStarted: (() => void) | undefined;
  const encryption = new Promise<void>((resolve) => {
    encryptStarted = resolve;
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        getHomeDir: async () => "/Users/alice",
        credentialsEncrypt: async (value: string) => {
          encryptStarted?.();
          await encryptGate;
          return value;
        },
      },
    },
  });
  let keys: SSHKey[] = [{
    ...referenceKey(),
    passphrase: "stale-import",
    savePassphrase: true,
  }];

  const imported = rememberImportedKeyPassphrase({
    keyPath: "/Users/alice/.ssh/id_ed25519",
    passphrase: "stale-import",
    keys,
    getKeys: () => keys,
    setCurrentKeys: (updated) => {
      keys = updated;
    },
    updateKeys: () => undefined,
  });
  await encryption;
  keys = [{ ...keys[0], passphrase: "user-correction" }];
  releaseEncrypt?.();

  assert.equal(await imported, "conflict");
  assert.equal(keys[0]?.passphrase, "user-correction");
  assert.equal(await loadDefaultKeyPassphrase("/Users/alice/.ssh/id_ed25519"), null);
});

test("loadDefaultKeyPassphrase cleanup preserves a passphrase saved concurrently", async (t) => {
  installLocalStorage(t);
  let releaseFirstHomeLookup: (() => void) | undefined;
  const firstHomeLookup = new Promise<void>((resolve) => {
    releaseFirstHomeLookup = resolve;
  });
  let homeLookupCount = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        getHomeDir: async () => {
          homeLookupCount += 1;
          if (homeLookupCount === 1) await firstHomeLookup;
          return "/Users/alice";
        },
      },
    },
  });
  globalThis.localStorage.setItem(
    STORAGE_KEY_DEFAULT_KEY_PASSPHRASES,
    JSON.stringify({ "/Users/alice/.ssh/id_old": "enc:v1:djEwYWJj" }),
  );

  const pendingLoad = loadDefaultKeyPassphrase("/Users/alice/.ssh/id_old");
  await saveDefaultKeyPassphrase("/Users/alice/.ssh/id_new", "new-passphrase");
  releaseFirstHomeLookup?.();

  assert.equal(await pendingLoad, null);
  assert.equal(
    await loadDefaultKeyPassphrase("/Users/alice/.ssh/id_new"),
    "new-passphrase",
  );
});

test("loadDefaultKeyPassphrase retries when the same path is saved concurrently", async (t) => {
  installLocalStorage(t);
  let releaseFirstHomeLookup: (() => void) | undefined;
  const firstHomeLookup = new Promise<void>((resolve) => {
    releaseFirstHomeLookup = resolve;
  });
  let homeLookupCount = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        getHomeDir: async () => {
          homeLookupCount += 1;
          if (homeLookupCount === 1) await firstHomeLookup;
          return "/Users/alice";
        },
      },
    },
  });
  const keyPath = "/Users/alice/.ssh/id_ed25519";
  globalThis.localStorage.setItem(
    STORAGE_KEY_DEFAULT_KEY_PASSPHRASES,
    JSON.stringify({ [keyPath]: "old-passphrase" }),
  );

  const pendingLoad = loadDefaultKeyPassphrase(keyPath);
  await saveDefaultKeyPassphrase(keyPath, "new-passphrase");
  releaseFirstHomeLookup?.();

  assert.equal(await pendingLoad, "new-passphrase");
});

test("loadDefaultKeyPassphrase returns plain stored passphrases", async (t) => {
  installLocalStorage(t);
  const keyPath = "/Users/alice/.ssh/id_ed25519";
  globalThis.localStorage.setItem(
    STORAGE_KEY_DEFAULT_KEY_PASSPHRASES,
    JSON.stringify({ [keyPath]: "correct horse battery staple" }),
  );

  assert.equal(await loadDefaultKeyPassphrase(keyPath), "correct horse battery staple");
});

test("saveDefaultKeyPassphrase makes the passphrase available to the connection prompt", async (t) => {
  installLocalStorage(t);
  const keyPath = "/Users/alice/.ssh/id_ed25519";

  await saveDefaultKeyPassphrase(keyPath, "saved by agent");

  assert.equal(await loadDefaultKeyPassphrase(keyPath), "saved by agent");
});

test("loadDefaultKeyPassphrase matches an expanded connection path to a saved home-relative path", async (t) => {
  installLocalStorage(t);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        getHomeDir: async () => "/Users/alice",
      },
    },
  });

  await saveDefaultKeyPassphrase("~/.ssh/id_ed25519", "saved by agent");

  assert.equal(
    await loadDefaultKeyPassphrase("/Users/alice/.ssh/id_ed25519"),
    "saved by agent",
  );
});

test("loadDefaultKeyPassphrase prefers an exact saved path over a stale alias", async (t) => {
  installLocalStorage(t);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty: { getHomeDir: async () => "/Users/alice" } },
  });
  globalThis.localStorage.setItem(
    STORAGE_KEY_DEFAULT_KEY_PASSPHRASES,
    JSON.stringify({
      "~/.ssh/id_ed25519": "enc:v1:djEwYWJj",
      "/Users/alice/.ssh/id_ed25519": "valid-exact-passphrase",
    }),
  );

  assert.equal(
    await loadDefaultKeyPassphrase("/Users/alice/.ssh/id_ed25519"),
    "valid-exact-passphrase",
  );
  assert.deepEqual(
    JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES) ?? "{}"),
    { "/Users/alice/.ssh/id_ed25519": "valid-exact-passphrase" },
  );
});

test("loadDefaultKeyPassphrase falls back to a valid alias and removes an invalid exact value", async (t) => {
  installLocalStorage(t);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty: { getHomeDir: async () => "/Users/alice" } },
  });
  globalThis.localStorage.setItem(
    STORAGE_KEY_DEFAULT_KEY_PASSPHRASES,
    JSON.stringify({
      "~/.ssh/id_ed25519": "valid-alias-passphrase",
      "/Users/alice/.ssh/id_ed25519": "enc:v1:djEwYWJj",
    }),
  );

  assert.equal(
    await loadDefaultKeyPassphrase("/Users/alice/.ssh/id_ed25519"),
    "valid-alias-passphrase",
  );
  assert.deepEqual(
    JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES) ?? "{}"),
    { "~/.ssh/id_ed25519": "valid-alias-passphrase" },
  );
});

test("loadDefaultKeyPassphrase consolidates conflicting valid aliases around the exact path", async (t) => {
  installLocalStorage(t);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty: { getHomeDir: async () => "/Users/alice" } },
  });
  globalThis.localStorage.setItem(
    STORAGE_KEY_DEFAULT_KEY_PASSPHRASES,
    JSON.stringify({
      "~/.ssh/id_ed25519": "old-alias-passphrase",
      "/Users/alice/.ssh/id_ed25519": "new-exact-passphrase",
    }),
  );

  assert.equal(
    await loadDefaultKeyPassphrase("/Users/alice/.ssh/id_ed25519"),
    "new-exact-passphrase",
  );
  assert.equal(
    await loadDefaultKeyPassphrase("~/.ssh/id_ed25519"),
    "new-exact-passphrase",
  );
});

test("saveDefaultKeyPassphrase replaces stale values stored under path aliases", async (t) => {
  installLocalStorage(t);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty: { getHomeDir: async () => "/Users/alice" } },
  });
  globalThis.localStorage.setItem(
    STORAGE_KEY_DEFAULT_KEY_PASSPHRASES,
    JSON.stringify({
      "~/.ssh/id_ed25519": "old-relative",
      "/Users/alice/.ssh/id_ed25519": "old-absolute",
    }),
  );

  await saveDefaultKeyPassphrase("~/.ssh/id_ed25519", "replacement");

  const stored = JSON.parse(
    globalThis.localStorage.getItem(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES) ?? "{}",
  ) as Record<string, string>;
  assert.equal(stored["/Users/alice/.ssh/id_ed25519"], undefined);
  assert.equal(await loadDefaultKeyPassphrase("/Users/alice/.ssh/id_ed25519"), "replacement");
});

test("removeDefaultKeyPassphraseAliases clears relative and expanded paths", async (t) => {
  installLocalStorage(t);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty: { getHomeDir: async () => "/Users/alice" } },
  });
  globalThis.localStorage.setItem(
    STORAGE_KEY_DEFAULT_KEY_PASSPHRASES,
    JSON.stringify({
      "~/.ssh/id_ed25519": "old-relative",
      "/Users/alice/.ssh/id_ed25519": "old-absolute",
      "/Users/alice/.ssh/other": "keep",
    }),
  );

  const aliases = await removeDefaultKeyPassphraseAliases(["~/.ssh/id_ed25519"]);

  assert.deepEqual(new Set(aliases), new Set([
    "~/.ssh/id_ed25519",
    "/Users/alice/.ssh/id_ed25519",
  ]));
  assert.deepEqual(
    JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES) ?? "{}"),
    { "/Users/alice/.ssh/other": "keep" },
  );
  const clearedKeys = clearReferenceKeyPassphrases([
    { ...referenceKey(), passphrase: "old", savePassphrase: true },
  ], aliases);
  assert.equal(clearedKeys[0].passphrase, undefined);
  assert.equal(clearedKeys[0].savePassphrase, false);
});

test("passphrase removal and save mutations run in request order", async (t) => {
  installLocalStorage(t);
  let releaseFirstHomeLookup: (() => void) | undefined;
  const firstHomeLookup = new Promise<void>((resolve) => {
    releaseFirstHomeLookup = resolve;
  });
  let homeLookupCount = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        getHomeDir: async () => {
          homeLookupCount += 1;
          if (homeLookupCount === 1) await firstHomeLookup;
          return "/Users/alice";
        },
      },
    },
  });
  const keyPath = "/Users/alice/.ssh/id_ed25519";
  globalThis.localStorage.setItem(
    STORAGE_KEY_DEFAULT_KEY_PASSPHRASES,
    JSON.stringify({ [keyPath]: "old-passphrase" }),
  );

  const pendingRemoval = removeDefaultKeyPassphraseAliases([keyPath]);
  const pendingSave = saveDefaultKeyPassphrase(keyPath, "corrected-passphrase");
  releaseFirstHomeLookup?.();

  assert.deepEqual(await pendingRemoval, [keyPath, "~/.ssh/id_ed25519"]);
  await pendingSave;
  assert.equal(await loadDefaultKeyPassphrase(keyPath), "corrected-passphrase");
});

test("credential clearing holds the mutation queue until key state is persisted", async (t) => {
  installLocalStorage(t);
  const keyPath = "/Users/alice/.ssh/id_ed25519";
  let keys: SSHKey[] = [{
    ...referenceKey(),
    passphrase: "old-secret",
    savePassphrase: true,
  }];
  await saveDefaultKeyPassphrase(keyPath, "old-secret");
  let releaseClear: (() => void) | undefined;
  const clearPersisted = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  let clearUpdateStarted: (() => void) | undefined;
  const clearStarted = new Promise<void>((resolve) => {
    clearUpdateStarted = resolve;
  });

  const clearing = clearRememberedKeyPassphrases({
    keyPaths: [keyPath],
    getKeys: () => keys,
    setCurrentKeys: (updated) => {
      keys = updated;
    },
    updateKeys: async () => {
      clearUpdateStarted?.();
      await clearPersisted;
    },
  });
  await clearStarted;
  let importFinished = false;
  const importing = rememberImportedKeyPassphrase({
    keyPath,
    passphrase: "imported-secret",
    keys,
    getKeys: () => keys,
    setCurrentKeys: (updated) => {
      keys = updated;
    },
    updateKeys: () => undefined,
  }).then((result) => {
    importFinished = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(importFinished, false);

  releaseClear?.();
  await clearing;
  assert.equal(await importing, "saved");
  assert.equal(keys[0]?.passphrase, "imported-secret");
});

test("rememberKeyPassphrase updates a reference key stored under an expanded alias", async (t) => {
  installLocalStorage(t);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty: { getHomeDir: async () => "/Users/alice" } },
  });
  let updatedKeys: SSHKey[] | undefined;

  await rememberKeyPassphrase({
    keyPath: "~/.ssh/id_ed25519",
    passphrase: "replacement",
    keys: [{ ...referenceKey(), passphrase: "old", savePassphrase: true }],
    updateKeys: (keys) => {
      updatedKeys = keys;
    },
  });

  assert.equal(updatedKeys?.[0].passphrase, "replacement");
  assert.equal(updatedKeys?.[0].savePassphrase, true);
});

test("rememberKeyPassphrase reads the latest keys after saving the credential", async (t) => {
  installLocalStorage(t);
  const keyPath = "/Users/alice/.ssh/id_ed25519";
  let currentKeys: SSHKey[] = [{
    id: "key-1",
    name: "Original",
    type: "ed25519",
    source: "reference",
    filePath: keyPath,
    createdAt: 1,
  }];
  const staleKeys = currentKeys;
  const updatedNames: string[] = [];
  currentKeys = [{ ...currentKeys[0], name: "Concurrent edit" }];

  await rememberKeyPassphrase({
    keyPath,
    passphrase: "secret",
    keys: staleKeys,
    getKeys: () => currentKeys,
    updateKeys: (updated) => {
      currentKeys = updated;
      updatedNames.push(updated[0]?.name ?? "");
    },
  });

  assert.deepEqual(updatedNames, ["Concurrent edit"]);
  assert.equal(currentKeys[0]?.passphrase, "secret");
});

test("path aliases replace and clear Windows reference-key spellings", async (t) => {
  installLocalStorage(t);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty: { getHomeDir: async () => "C:\\Users\\Alice" } },
  });
  const windowsReferenceKey: SSHKey = {
    ...referenceKey(),
    filePath: "c:\\users\\alice\\.ssh\\id_ed25519",
    passphrase: "old",
    savePassphrase: true,
  };
  let updatedKeys: SSHKey[] | undefined;

  await rememberKeyPassphrase({
    keyPath: "~/.ssh/id_ed25519",
    passphrase: "replacement",
    keys: [windowsReferenceKey],
    updateKeys: (keys) => {
      updatedKeys = keys;
    },
  });

  assert.equal(updatedKeys?.[0].passphrase, "replacement");
  assert.equal(
    await loadDefaultKeyPassphrase("C:\\Users\\Alice\\.ssh\\id_ed25519"),
    "replacement",
  );

  const aliases = await removeDefaultKeyPassphraseAliases(["~/.ssh/id_ed25519"]);
  const clearedKeys = clearReferenceKeyPassphrases(updatedKeys ?? [], aliases);
  assert.equal(clearedKeys[0].passphrase, undefined);
  assert.equal(await loadDefaultKeyPassphrase("c:\\users\\alice\\.ssh\\id_ed25519"), null);
});

test("POSIX backslashes remain distinct from path separators", async (t) => {
  installLocalStorage(t);

  await saveDefaultKeyPassphrase("/home/alice/.ssh/team\\key", "backslash-name");
  await saveDefaultKeyPassphrase("/home/alice/.ssh/team/key", "nested-path");

  assert.equal(
    await loadDefaultKeyPassphrase("/home/alice/.ssh/team\\key"),
    "backslash-name",
  );
  assert.equal(
    await loadDefaultKeyPassphrase("/home/alice/.ssh/team/key"),
    "nested-path",
  );
});

test("clearReferenceKeyPassphrases clears matching reference key paths only", () => {
  const keys: SSHKey[] = [
    {
      ...referenceKey(),
      passphrase: "bad",
      savePassphrase: true,
    },
    {
      ...referenceKey(),
      id: "other-key",
      label: "other",
      filePath: "/Users/alice/.ssh/other",
      passphrase: "keep",
      savePassphrase: true,
    },
  ];

  const updated = clearReferenceKeyPassphrases(keys, ["/Users/alice/.ssh/id_ed25519"]);

  assert.equal(updated[0].passphrase, undefined);
  assert.equal(updated[0].savePassphrase, false);
  assert.equal(updated[1].passphrase, "keep");
});

test("clearKeyPassphrasesByIds clears matching saved key passphrases", () => {
  const keys: SSHKey[] = [
    {
      ...referenceKey(),
      id: "inline-key",
      source: "imported",
      filePath: undefined,
      privateKey: "PRIVATE KEY",
      passphrase: "bad",
      savePassphrase: true,
    },
    {
      ...referenceKey(),
      id: "other-key",
      label: "other",
      passphrase: "keep",
      savePassphrase: true,
    },
  ];

  const updated = clearKeyPassphrasesByIds(keys, ["inline-key"]);

  assert.equal(updated[0].passphrase, undefined);
  assert.equal(updated[0].savePassphrase, false);
  assert.equal(updated[1].passphrase, "keep");
});

test("shouldUpdateReferenceKeyPassphrase replaces missing or undecryptable passphrases", () => {
  assert.equal(shouldUpdateReferenceKeyPassphrase(null), false);
  assert.equal(shouldUpdateReferenceKeyPassphrase(referenceKey()), true);
  assert.equal(
    shouldUpdateReferenceKeyPassphrase({
      ...referenceKey(),
      passphrase: "enc:v1:djEwAAAA",
    }),
    true,
  );
  assert.equal(
    shouldUpdateReferenceKeyPassphrase({
      ...referenceKey(),
      passphrase: "saved",
    }),
    false,
  );
});

test("rememberKeyPassphrase updates reference key state before completing", async (t) => {
  installLocalStorage(t);
  const keys = [referenceKey()];
  let currentKeys = keys;
  let releaseUpdate: (() => void) | undefined;
  let rememberPromise: Promise<void> | undefined;
  const updateStarted = new Promise<void>((resolve) => {
    const updateKeys = async (updated: SSHKey[]) => {
      assert.equal(currentKeys[0].passphrase, "saved");
      assert.equal(updated[0].passphrase, "saved");
      resolve();
      await new Promise<void>((release) => {
        releaseUpdate = release;
      });
    };

    rememberPromise = rememberKeyPassphrase({
      keyPath: "/Users/alice/.ssh/id_ed25519",
      passphrase: "saved",
      keys,
      updateKeys,
      setCurrentKeys: (updated) => {
        currentKeys = updated;
      },
    });
  });

  await updateStarted;
  assert.equal(currentKeys[0].passphrase, "saved");
  releaseUpdate?.();
  await rememberPromise;
});
