import assert from 'node:assert/strict';
import test from 'node:test';

import { createConvergentSyncStateFromPayload } from '../../../domain/convergentSync/index.ts';
import { SYNC_STORAGE_KEYS, type MasterKeyConfig, type SyncPayload } from '../../../domain/sync.ts';
import {
  loadConvergentReplicaImpl,
  reencryptSyncStorageImpl,
  saveConvergentReplicaImpl,
} from './convergentSyncStorageMethods.ts';
import {
  decryptLocalStorageValue,
  encryptLocalStorageValue,
} from './encryptedLocalStorage.ts';
import { EncryptionService } from '../EncryptionService.ts';
import { changeMasterKeyImpl } from './stateAndSecurityMethods.ts';

const NOW = 1_700_000_000_000;

function payload(): SyncPayload {
  return {
    hosts: [],
    keys: [],
    snippets: [],
    customGroups: [],
    syncedAt: NOW,
  };
}

async function key(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

function manager(storage: Map<string, unknown>, derivedKey: CryptoKey) {
  return {
    state: { unlockedKey: { derivedKey } },
    loadFromStorage(storageKey: string) {
      return storage.get(storageKey) ?? null;
    },
    saveToStorage(storageKey: string, value: unknown) {
      storage.set(storageKey, value);
    },
    removeFromStorage(storageKey: string) {
      storage.delete(storageKey);
    },
    syncBaseKey(provider?: string) {
      return `${SYNC_STORAGE_KEYS.SYNC_BASE_PAYLOAD}${provider ? `_${provider}` : ''}`;
    },
    syncSnapshotsKey(provider?: string) {
      return `netcatty_sync_snapshots_v1${provider ? `_${provider}` : ''}`;
    },
    convergentProviderBaselineKey(provider: string) {
      return `${SYNC_STORAGE_KEYS.CONVERGENT_PROVIDER_BASELINE}_${provider}`;
    },
  };
}

test('canonical replica records are encrypted and fail closed when corrupted', async () => {
  const storage = new Map<string, unknown>();
  const encryptionKey = await key();
  const subject = manager(storage, encryptionKey);
  const state = createConvergentSyncStateFromPayload(payload(), 'device-a', NOW);

  await saveConvergentReplicaImpl.call(subject, { schemaVersion: 2, state, updatedAt: NOW });
  assert.equal(typeof storage.get(SYNC_STORAGE_KEYS.CONVERGENT_REPLICA), 'string');
  assert.equal((await loadConvergentReplicaImpl.call(subject))?.updatedAt, NOW);

  storage.set(SYNC_STORAGE_KEYS.CONVERGENT_REPLICA, 'not-valid-ciphertext');
  await assert.rejects(() => loadConvergentReplicaImpl.call(subject));
});

test('master key rotation re-encrypts all sync records before committing config', async () => {
  const storage = new Map<string, unknown>();
  const oldKey = await key();
  const newKey = await key();
  const subject = manager(storage, oldKey);
  const baseKey = subject.syncBaseKey('github');
  storage.set(baseKey, await encryptLocalStorageValue({ secret: 'value' }, oldKey));
  const oldConfig: MasterKeyConfig = {
    verificationHash: 'old',
    salt: 'old-salt',
    kdf: 'PBKDF2',
    createdAt: NOW,
  };
  const newConfig: MasterKeyConfig = { ...oldConfig, verificationHash: 'new', salt: 'new-salt' };
  storage.set(SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG, oldConfig);

  await reencryptSyncStorageImpl.call(subject, oldKey, newKey, newConfig);
  const encoded = storage.get(baseKey) as string;
  assert.deepEqual(await decryptLocalStorageValue(encoded, newKey), { secret: 'value' });
  await assert.rejects(() => decryptLocalStorageValue(encoded, oldKey));
  assert.deepEqual(storage.get(SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG), newConfig);
});

test('master key rotation rolls ciphertext back when the config commit fails', async () => {
  const storage = new Map<string, unknown>();
  const oldKey = await key();
  const newKey = await key();
  const subject = manager(storage, oldKey);
  const baseKey = subject.syncBaseKey('github');
  const original = await encryptLocalStorageValue({ secret: 'value' }, oldKey);
  storage.set(baseKey, original);
  const oldConfig: MasterKeyConfig = {
    verificationHash: 'old',
    salt: 'old-salt',
    kdf: 'PBKDF2',
    createdAt: NOW,
  };
  storage.set(SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG, oldConfig);
  let failConfigWrite = true;
  subject.saveToStorage = (storageKey: string, value: unknown) => {
    if (storageKey === SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG && failConfigWrite) {
      failConfigWrite = false;
      throw new Error('quota');
    }
    storage.set(storageKey, value);
  };

  await assert.rejects(
    () => reencryptSyncStorageImpl.call(subject, oldKey, newKey, { ...oldConfig, salt: 'new' }),
    /quota/,
  );
  assert.equal(storage.get(baseKey), original);
  assert.deepEqual(storage.get(SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG), oldConfig);
  assert.deepEqual(await decryptLocalStorageValue(original, oldKey), { secret: 'value' });
});

test('master key rotation aborts when an initially absent sync record appears', async () => {
  const storage = new Map<string, unknown>();
  const oldKey = await key();
  const newKey = await key();
  const subject = manager(storage, oldKey);
  const oldConfig: MasterKeyConfig = {
    verificationHash: 'old',
    salt: 'old-salt',
    kdf: 'PBKDF2',
    createdAt: NOW,
  };
  const newConfig: MasterKeyConfig = { ...oldConfig, verificationHash: 'new' };
  const appearedKey = subject.convergentProviderBaselineKey('github');
  const appearedCiphertext = await encryptLocalStorageValue({ created: 'concurrently' }, oldKey);
  storage.set(SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG, oldConfig);
  const loadFromStorage = subject.loadFromStorage.bind(subject);
  let appearedReads = 0;
  subject.loadFromStorage = (storageKey: string) => {
    if (storageKey === appearedKey) {
      appearedReads += 1;
      if (appearedReads === 1) return null;
      storage.set(appearedKey, appearedCiphertext);
      return appearedCiphertext;
    }
    return loadFromStorage(storageKey);
  };

  await assert.rejects(
    () => reencryptSyncStorageImpl.call(subject, oldKey, newKey, newConfig),
    /Sync data changed while the master key was being rotated/,
  );

  assert.deepEqual(storage.get(SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG), oldConfig);
  assert.equal(storage.get(appearedKey), appearedCiphertext);
  assert.deepEqual(await decryptLocalStorageValue(appearedCiphertext, oldKey), {
    created: 'concurrently',
  });
});

test('master key state changes only after derived-key records are re-encrypted', async () => {
  const oldChange = EncryptionService.changeMasterPassword;
  const oldUnlock = EncryptionService.unlockMasterKey;
  const oldConfig: MasterKeyConfig = {
    verificationHash: 'old',
    salt: 'old-salt',
    kdf: 'PBKDF2',
    createdAt: NOW,
  };
  const newConfig: MasterKeyConfig = { ...oldConfig, verificationHash: 'new', salt: 'new-salt' };
  const oldKey = await key();
  const newKey = await key();
  const calls: string[] = [];
  EncryptionService.changeMasterPassword = async () => newConfig;
  EncryptionService.unlockMasterKey = async (password) => ({
    derivedKey: password === 'old-password' ? oldKey : newKey,
    salt: new Uint8Array(),
    unlockedAt: NOW,
  });
  try {
    const subject = {
      state: {
        masterKeyConfig: oldConfig,
        securityState: 'UNLOCKED',
        unlockedKey: { derivedKey: oldKey },
        autoSyncEnabled: false,
      },
      masterPassword: 'old-password',
      reencryptSyncStorage: async () => {
        calls.push('reencrypt');
        assert.equal(subject.state.masterKeyConfig, oldConfig);
        assert.equal(subject.masterPassword, 'old-password');
      },
      bumpSyncSecurityGeneration: () => calls.push('generation'),
      emit: () => calls.push('emit'),
    };

    const changed = await changeMasterKeyImpl.call(subject, 'old-password', 'new-password');

    assert.equal(changed, true);
    assert.deepEqual(calls, ['reencrypt', 'generation', 'emit']);
    assert.equal(subject.state.masterKeyConfig, newConfig);
    assert.equal(subject.state.unlockedKey.derivedKey, newKey);
    assert.equal(subject.masterPassword, 'new-password');
  } finally {
    EncryptionService.changeMasterPassword = oldChange;
    EncryptionService.unlockMasterKey = oldUnlock;
  }
});

test('failed local re-encryption leaves the active master key unchanged', async () => {
  const oldChange = EncryptionService.changeMasterPassword;
  const oldUnlock = EncryptionService.unlockMasterKey;
  const oldConfig: MasterKeyConfig = {
    verificationHash: 'old',
    salt: 'old-salt',
    kdf: 'PBKDF2',
    createdAt: NOW,
  };
  const oldKey = await key();
  EncryptionService.changeMasterPassword = async () => ({ ...oldConfig, verificationHash: 'new' });
  EncryptionService.unlockMasterKey = async () => ({
    derivedKey: oldKey,
    salt: new Uint8Array(),
    unlockedAt: NOW,
  });
  try {
    const subject = {
      state: {
        masterKeyConfig: oldConfig,
        securityState: 'UNLOCKED',
        unlockedKey: { derivedKey: oldKey },
        autoSyncEnabled: false,
      },
      masterPassword: 'old-password',
      reencryptSyncStorage: async () => {
        throw new Error('storage failed');
      },
    };

    await assert.rejects(
      () => changeMasterKeyImpl.call(subject, 'old-password', 'new-password'),
      /storage failed/,
    );
    assert.equal(subject.state.masterKeyConfig, oldConfig);
    assert.equal(subject.masterPassword, 'old-password');
    assert.equal(subject.state.unlockedKey.derivedKey, oldKey);
  } finally {
    EncryptionService.changeMasterPassword = oldChange;
    EncryptionService.unlockMasterKey = oldUnlock;
  }
});
