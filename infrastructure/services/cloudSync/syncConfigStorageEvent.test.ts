import test from 'node:test';
import assert from 'node:assert/strict';

import { SYNC_CONSTANTS, SYNC_STORAGE_KEYS } from '../../../domain/sync.ts';
import { handleStorageEventImpl } from './stateAndSecurityMethods.ts';

test('SYNC_PREFERENCES storage event stops auto-sync when another window disables it', () => {
  const fakeStorage = {};
  const originalWindow = globalThis.window;
  let stopCount = 0;
  let startCount = 0;

  (globalThis as typeof globalThis & { window?: unknown }).window = {
    localStorage: fakeStorage,
  };

  const manager = {
    state: {
      autoSyncEnabled: true,
      autoSyncInterval: 5,
      localVersion: 1,
      localUpdatedAt: 1,
      remoteVersion: 1,
      remoteUpdatedAt: 1,
      syncStrategy: 'smartMerge',
      securityState: 'UNLOCKED',
    },
    loadFromStorage: () => null,
    safeJsonParse: (value: string | null) => (value ? JSON.parse(value) : null),
    startAutoSync: () => {
      startCount += 1;
    },
    stopAutoSync: () => {
      stopCount += 1;
    },
    notifyStateChange: () => {},
  };

  try {
    handleStorageEventImpl.call(manager, {
      storageArea: fakeStorage,
      key: SYNC_STORAGE_KEYS.SYNC_PREFERENCES,
      newValue: JSON.stringify({
        autoSync: false,
        interval: SYNC_CONSTANTS.DEFAULT_AUTO_SYNC_INTERVAL,
        syncStrategy: 'smartMerge',
      }),
    } as StorageEvent);
  } finally {
    (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
  }

  assert.equal(manager.state.autoSyncEnabled, false);
  assert.equal(stopCount, 1);
  assert.equal(startCount, 0);
});

test('version-only SYNC_CONFIG storage event does not rewrite preferences', () => {
  const fakeStorage = {};
  const originalWindow = globalThis.window;
  let stopCount = 0;

  (globalThis as typeof globalThis & { window?: unknown }).window = {
    localStorage: fakeStorage,
  };

  const manager = {
    state: {
      autoSyncEnabled: false,
      autoSyncInterval: 5,
      localVersion: 1,
      localUpdatedAt: 1,
      remoteVersion: 1,
      remoteUpdatedAt: 1,
      syncStrategy: 'smartMerge',
      securityState: 'UNLOCKED',
    },
    loadFromStorage: (key: string) => {
      if (key === SYNC_STORAGE_KEYS.SYNC_PREFERENCES) {
        return { autoSync: false, interval: 5, syncStrategy: 'smartMerge' };
      }
      return null;
    },
    safeJsonParse: (value: string | null) => (value ? JSON.parse(value) : null),
    startAutoSync: () => {},
    stopAutoSync: () => {
      stopCount += 1;
    },
    notifyStateChange: () => {},
  };

  try {
    handleStorageEventImpl.call(manager, {
      storageArea: fakeStorage,
      key: SYNC_STORAGE_KEYS.SYNC_CONFIG,
      newValue: JSON.stringify({
        localVersion: 2,
        localUpdatedAt: 2,
        remoteVersion: 2,
        remoteUpdatedAt: 2,
      }),
    } as StorageEvent);
  } finally {
    (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
  }

  assert.equal(manager.state.autoSyncEnabled, false);
  assert.equal(manager.state.localVersion, 2);
  assert.equal(stopCount, 0);
});

test('peer sync metadata does not cancel a provider write, but credential changes do', async () => {
  const fakeStorage = {};
  const originalWindow = globalThis.window;
  const previous = {
    provider: 'webdav',
    status: 'connected',
    config: { endpoint: 'https://example.test/dav', username: 'alice' },
    lastSync: 100,
    lastSyncVersion: 7,
  };
  let stored = previous;
  const manager = {
    state: { providers: { webdav: previous } },
    providerWriteSeq: { webdav: 3 },
    providerDecryptSeq: { webdav: 0 },
    providerDecrypted: { webdav: true },
    adapters: new Map(),
    loadProviderConnection: () => stored,
    notifyStateChange: () => {},
  };
  (globalThis as typeof globalThis & { window?: unknown }).window = {
    localStorage: fakeStorage,
  };

  const sendEvent = (next: typeof previous) => {
    const oldValue = JSON.stringify(stored);
    stored = next;
    handleStorageEventImpl.call(manager, {
      storageArea: fakeStorage,
      key: SYNC_STORAGE_KEYS.PROVIDER_WEBDAV,
      oldValue,
      newValue: JSON.stringify(next),
    } as StorageEvent);
  };

  try {
    sendEvent({ ...previous, lastSync: 200, lastSyncVersion: 8 });
    assert.equal(manager.providerWriteSeq.webdav, 3);
    await Promise.resolve();
    sendEvent({
      ...stored,
      config: { ...stored.config, username: 'bob' },
    });
    assert.equal(manager.providerWriteSeq.webdav, 4);
  } finally {
    (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
  }
});

test('legacy combined SYNC_CONFIG storage event still applies preferences when prefs key absent', () => {
  const fakeStorage = {};
  const originalWindow = globalThis.window;
  let stopCount = 0;

  (globalThis as typeof globalThis & { window?: unknown }).window = {
    localStorage: fakeStorage,
  };

  const manager = {
    state: {
      autoSyncEnabled: true,
      autoSyncInterval: 5,
      localVersion: 1,
      localUpdatedAt: 1,
      remoteVersion: 1,
      remoteUpdatedAt: 1,
      syncStrategy: 'smartMerge',
      securityState: 'UNLOCKED',
    },
    loadFromStorage: () => null,
    safeJsonParse: (value: string | null) => (value ? JSON.parse(value) : null),
    startAutoSync: () => {},
    stopAutoSync: () => {
      stopCount += 1;
    },
    notifyStateChange: () => {},
  };

  try {
    handleStorageEventImpl.call(manager, {
      storageArea: fakeStorage,
      key: SYNC_STORAGE_KEYS.SYNC_CONFIG,
      newValue: JSON.stringify({
        autoSync: false,
        interval: SYNC_CONSTANTS.DEFAULT_AUTO_SYNC_INTERVAL,
        localVersion: 2,
        localUpdatedAt: 2,
        remoteVersion: 2,
        remoteUpdatedAt: 2,
        syncStrategy: 'smartMerge',
      }),
    } as StorageEvent);
  } finally {
    (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
  }

  assert.equal(manager.state.autoSyncEnabled, false);
  assert.equal(manager.state.localVersion, 2);
  assert.equal(stopCount, 1);
});
