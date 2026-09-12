import test from "node:test";
import assert from "node:assert/strict";

import type { SSHKey } from "../../domain/models";
import { ENCRYPTED_CREDENTIAL_PLACEHOLDER } from "../../domain/credentialsTestFixtures";
import { STORAGE_KEY_KEYS } from "../config/storageKeys";
import { isEncryptedCredentialPlaceholder, sanitizeCredentialValue } from "../../domain/credentials";
import { localStorageAdapter } from "./localStorageAdapter.ts";
import {
  decryptField,
  decryptFieldResult,
  decryptKeySecrets,
  decryptKeys,
  encryptKeys,
  hydrateStoredKeySecrets,
  notifyKeysEncryptedWritePending,
} from "./secureFieldAdapter.ts";

const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----";

const storedKey = (overrides: Partial<SSHKey> = {}): SSHKey => ({
  id: "key-1",
  label: "Imported",
  type: "ED25519",
  privateKey: ENCRYPTED_CREDENTIAL_PLACEHOLDER,
  source: "imported",
  category: "key",
  created: 1,
  ...overrides,
});

function installLocalStorage(t: test.TestContext): Map<string, string> {
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
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  });
  return store;
}

function installBridge(
  t: test.TestContext,
  netcatty: { credentialsDecrypt?: (value: string) => Promise<string> } | undefined,
): void {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty },
  });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete (globalThis as { window?: unknown }).window;
  });
}

test("decryptField marks enc:v1 unread without treating it as plaintext when the bridge is missing", async (t) => {
  installBridge(t, undefined);
  const result = await decryptFieldResult(ENCRYPTED_CREDENTIAL_PLACEHOLDER);
  assert.equal(result.unread, true);
  assert.equal(result.value, ENCRYPTED_CREDENTIAL_PLACEHOLDER);
  assert.equal(await decryptField(ENCRYPTED_CREDENTIAL_PLACEHOLDER), ENCRYPTED_CREDENTIAL_PLACEHOLDER);
  assert.equal(sanitizeCredentialValue(result.value), undefined);
  assert.equal(await decryptField("plain-secret"), "plain-secret");
  assert.equal((await decryptFieldResult("plain-secret")).unread, false);
});

test("decryptField marks enc:v1 unread when decrypt returns the same value", async (t) => {
  installBridge(t, {
    credentialsDecrypt: async (value: string) => value,
  });
  const result = await decryptFieldResult(ENCRYPTED_CREDENTIAL_PLACEHOLDER);
  assert.equal(result.unread, true);
  assert.equal(result.value, ENCRYPTED_CREDENTIAL_PLACEHOLDER);
  assert.equal(sanitizeCredentialValue(result.value), undefined);
});

test("decryptField keeps enc:v1 ciphertext when decrypt throws", async (t) => {
  installBridge(t, {
    credentialsDecrypt: async () => {
      throw new Error("safeStorage unavailable");
    },
  });
  const result = await decryptFieldResult(ENCRYPTED_CREDENTIAL_PLACEHOLDER);
  assert.equal(result.unread, true);
  assert.equal(result.value, ENCRYPTED_CREDENTIAL_PLACEHOLDER);
});

test("decryptField returns plaintext once the credential bridge decrypts", async (t) => {
  installBridge(t, {
    credentialsDecrypt: async (value: string) => {
      assert.equal(value, ENCRYPTED_CREDENTIAL_PLACEHOLDER);
      return PRIVATE_KEY;
    },
  });
  const result = await decryptFieldResult(ENCRYPTED_CREDENTIAL_PLACEHOLDER);
  assert.equal(result.unread, false);
  assert.equal(result.value, PRIVATE_KEY);
  assert.equal(await decryptField(ENCRYPTED_CREDENTIAL_PLACEHOLDER), PRIVATE_KEY);
});

test("decryptKeySecrets keeps enc:v1 privateKey ciphertext until decrypt succeeds", async (t) => {
  installBridge(t, undefined);
  const decrypted = await decryptKeySecrets(storedKey());
  assert.equal(decrypted.privateKey, ENCRYPTED_CREDENTIAL_PLACEHOLDER);
  assert.equal(isEncryptedCredentialPlaceholder(decrypted.privateKey), true);
});

test("failed decrypt does not persist wiping enc:v1 key material", async (t) => {
  installLocalStorage(t);
  installBridge(t, undefined);
  const decrypted = await decryptKeys([storedKey()]);
  assert.equal(decrypted[0]?.privateKey, ENCRYPTED_CREDENTIAL_PLACEHOLDER);
  const encrypted = await encryptKeys(decrypted);
  assert.equal(encrypted[0]?.privateKey, ENCRYPTED_CREDENTIAL_PLACEHOLDER);
  localStorageAdapter.write(STORAGE_KEY_KEYS, encrypted);
  const stored = localStorageAdapter.read<SSHKey[]>(STORAGE_KEY_KEYS);
  assert.equal(stored?.[0]?.privateKey, ENCRYPTED_CREDENTIAL_PLACEHOLDER);
});

test("hydrateStoredKeySecrets waits until ciphertext decrypts", async (t) => {
  installLocalStorage(t);
  let attempts = 0;
  installBridge(t, {
    credentialsDecrypt: async (value: string) => {
      attempts += 1;
      if (attempts < 3) return value;
      return PRIVATE_KEY;
    },
  });
  const hydrated = await hydrateStoredKeySecrets(storedKey(), {
    timeoutMs: 500,
    retryDelayMs: 10,
  });
  assert.equal(hydrated.unreadable, false);
  assert.equal(hydrated.key.privateKey, PRIVATE_KEY);
  assert.ok(attempts >= 3);
});

test("hydrateStoredKeySecrets re-reads storage when in-memory privateKey was stripped", async (t) => {
  const store = installLocalStorage(t);
  store.set(STORAGE_KEY_KEYS, JSON.stringify([storedKey()]));
  installBridge(t, {
    credentialsDecrypt: async (value: string) => {
      assert.equal(value, ENCRYPTED_CREDENTIAL_PLACEHOLDER);
      return PRIVATE_KEY;
    },
  });
  const hydrated = await hydrateStoredKeySecrets(storedKey({ privateKey: "" }), {
    timeoutMs: 100,
    retryDelayMs: 10,
  });
  assert.equal(hydrated.unreadable, false);
  assert.equal(hydrated.key.privateKey, PRIVATE_KEY);
});

test("hydrateStoredKeySecrets does not revive a stale persisted key while the vault write is pending", async (t) => {
  const store = installLocalStorage(t);
  store.set(
    STORAGE_KEY_KEYS,
    JSON.stringify([storedKey({ privateKey: ENCRYPTED_CREDENTIAL_PLACEHOLDER })]),
  );
  installBridge(t, {
    credentialsDecrypt: async (value: string) => {
      assert.equal(value, ENCRYPTED_CREDENTIAL_PLACEHOLDER);
      return PRIVATE_KEY;
    },
  });

  const keyAfterRecovery = storedKey({ privateKey: "" });
  let landWrite: () => void = () => {};
  const pendingWrite = new Promise<void>((resolve) => {
    landWrite = () => {
      // A sync/import recovery replaced the key with an empty private key; the
      // async encrypted write publishes that state when it lands.
      store.set(STORAGE_KEY_KEYS, JSON.stringify([keyAfterRecovery]));
      resolve();
    };
  });
  notifyKeysEncryptedWritePending(pendingWrite);
  t.after(() => notifyKeysEncryptedWritePending(null));

  let hydrationSettled = false;
  const hydration = hydrateStoredKeySecrets(keyAfterRecovery, {
    timeoutMs: 2000,
    retryDelayMs: 10,
  }).then((result) => {
    hydrationSettled = true;
    return result;
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  // Without the gate the stale persisted ciphertext would hydrate immediately.
  assert.equal(hydrationSettled, false);

  landWrite();
  const hydrated = await hydration;
  assert.equal(hydrated.unreadable, false);
  assert.equal(hydrated.key.privateKey, "");
  assert.equal(hydrated.key.passphrase, undefined);
});

test("hydrateStoredKeySecrets hydrates from settled storage after the vault write lands", async (t) => {
  const store = installLocalStorage(t);
  installBridge(t, {
    credentialsDecrypt: async () => PRIVATE_KEY,
  });

  let landWrite: () => void = () => {};
  const pendingWrite = new Promise<void>((resolve) => {
    landWrite = () => {
      store.set(STORAGE_KEY_KEYS, JSON.stringify([storedKey()]));
      resolve();
    };
  });
  notifyKeysEncryptedWritePending(pendingWrite);
  t.after(() => notifyKeysEncryptedWritePending(null));

  const hydration = hydrateStoredKeySecrets(storedKey({ privateKey: "" }), {
    timeoutMs: 2000,
    retryDelayMs: 10,
  });
  landWrite();
  const hydrated = await hydration;
  assert.equal(hydrated.unreadable, false);
  assert.equal(hydrated.key.privateKey, PRIVATE_KEY);
});

test("hydrateStoredKeySecrets does not wait when there is no decrypt bridge", async (t) => {
  installBridge(t, undefined);
  const started = Date.now();
  const hydrated = await hydrateStoredKeySecrets(storedKey(), {
    timeoutMs: 2000,
    retryDelayMs: 50,
  });
  assert.equal(hydrated.unreadable, true);
  assert.equal(hydrated.key.privateKey, "");
  assert.ok(Date.now() - started < 200);
});
