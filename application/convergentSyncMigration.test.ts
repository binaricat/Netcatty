import assert from 'node:assert/strict';
import test from 'node:test';

import type { SyncPayload } from '../domain/sync.ts';
import type { CloudSyncManager } from '../infrastructure/services/CloudSyncManager.ts';

const NOW = 1_700_000_000_000;
const localStorageValues = new Map<string, string>();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => localStorageValues.set(key, value),
    removeItem: (key: string) => localStorageValues.delete(key),
    clear: () => localStorageValues.clear(),
  },
});

const { planConvergentSyncMigration } = await import('../domain/convergentSync/index.ts');
const { getConvergentSyncLocalConfig } = await import('../infrastructure/services/convergentSyncConfig.ts');
const { initializePreparedConvergentMigration } = await import('./convergentSyncMigration.ts');

function payload(): SyncPayload {
  return {
    hosts: [],
    keys: [],
    snippets: [],
    customGroups: [],
    syncedAt: NOW,
  };
}

test.beforeEach(() => {
  localStorageValues.clear();
});

test('initialization applies the protected preview before persisting and enabling the replica', async () => {
  const localPayload = payload();
  const liveLocalPayload = { ...payload(), knownHosts: [] };
  const plan = planConvergentSyncMigration({
    localPayload,
    localTrustedBaseline: null,
    providers: [],
    deviceId: 'device-a',
    now: NOW,
  });
  assert.equal(plan.preview.canInitialize, true);
  const calls: string[] = [];
  const manager = {
    isUnlocked: () => true,
    saveConvergentReplica: async () => {
      calls.push('replica');
    },
    saveConvergentProviderBaseline: async () => {
      calls.push('baseline');
    },
  } as unknown as CloudSyncManager;

  await initializePreparedConvergentMigration({
    prepared: { plan, providerBaselines: [] },
    manager,
    now: NOW,
    buildPreApplyPayload: () => {
      calls.push('snapshot');
      return liveLocalPayload;
    },
    translateProtectiveBackupFailure: (message) => message,
    applyPayload: async (incoming) => {
      calls.push('apply');
      assert.equal(incoming.convergentSync?.schemaVersion, 2);
    },
    runProtectedApply: async (options) => {
      calls.push('protect');
      assert.equal(options.buildPreApplyPayload(), liveLocalPayload);
      await options.applyPayload();
    },
  });

  assert.deepEqual(calls, ['protect', 'snapshot', 'apply', 'replica']);
  assert.deepEqual(getConvergentSyncLocalConfig(), { enabled: true, initialized: true });
});

test('blocked previews cannot enter the protected initialization transaction', async () => {
  const localPayload = payload();
  const plan = planConvergentSyncMigration({
    localPayload,
    localTrustedBaseline: null,
    providers: [{ provider: 'github', status: 'unavailable', message: 'offline' }],
    deviceId: 'device-a',
    now: NOW,
  });
  let entered = false;

  await assert.rejects(
    () => initializePreparedConvergentMigration({
      prepared: { plan, providerBaselines: [] },
      manager: {} as CloudSyncManager,
      buildPreApplyPayload: () => localPayload,
      translateProtectiveBackupFailure: (message) => message,
      applyPayload: () => {},
      runProtectedApply: async () => {
        entered = true;
      },
    }),
    /migration is blocked/,
  );
  assert.equal(entered, false);
  assert.deepEqual(getConvergentSyncLocalConfig(), { enabled: false, initialized: false });
});

test('a locked manager cannot enter the protected initialization transaction', async () => {
  const localPayload = payload();
  const plan = planConvergentSyncMigration({
    localPayload,
    localTrustedBaseline: null,
    providers: [],
    deviceId: 'device-a',
    now: NOW,
  });
  let entered = false;
  let applied = false;
  let snapshotBuilt = false;
  const manager = {
    isUnlocked: () => false,
  } as unknown as CloudSyncManager;

  await assert.rejects(
    () => initializePreparedConvergentMigration({
      prepared: { plan, providerBaselines: [] },
      manager,
      buildPreApplyPayload: () => {
        snapshotBuilt = true;
        return localPayload;
      },
      translateProtectiveBackupFailure: (message) => message,
      applyPayload: () => {
        applied = true;
      },
      runProtectedApply: async () => {
        entered = true;
      },
    }),
    /Unlock cloud sync before initializing convergent migration/,
  );

  assert.equal(entered, false);
  assert.equal(snapshotBuilt, false);
  assert.equal(applied, false);
  assert.deepEqual(getConvergentSyncLocalConfig(), { enabled: false, initialized: false });
});
