import assert from 'node:assert/strict';
import test from 'node:test';

import type { SyncPayload } from '../domain/sync.ts';

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

const {
  applyProtectedSyncPayload,
  readInterruptedVaultApply,
} = await import('./localVaultBackups.ts');

function emptyPayload(): SyncPayload {
  return {
    hosts: [],
    keys: [],
    snippets: [],
    customGroups: [],
    syncedAt: 1,
  };
}

test.beforeEach(() => {
  localStorageValues.clear();
});

test('protected apply preparation failure does not leave a partial-apply sentinel', async () => {
  let snapshotBuilt = false;

  await assert.rejects(
    () => applyProtectedSyncPayload({
      buildPreApplyPayload: () => {
        snapshotBuilt = true;
        return emptyPayload();
      },
      prepareApply: async () => {
        throw new Error('replica unavailable');
      },
      translateProtectiveBackupFailure: (message) => message,
    }),
    /replica unavailable/,
  );

  assert.equal(snapshotBuilt, false);
  assert.equal(readInterruptedVaultApply(), null);
});

test('prepared apply callback runs after the snapshot with sentinel protection', async () => {
  const calls: string[] = [];
  let observedSentinel = false;

  await applyProtectedSyncPayload({
    buildPreApplyPayload: () => {
      calls.push('snapshot');
      return emptyPayload();
    },
    prepareApply: async () => {
      calls.push('prepare');
      return async () => {
        calls.push('apply');
        observedSentinel = readInterruptedVaultApply() !== null;
      };
    },
    translateProtectiveBackupFailure: (message) => message,
  });

  assert.deepEqual(calls, ['prepare', 'snapshot', 'apply']);
  assert.equal(observedSentinel, true);
  assert.equal(readInterruptedVaultApply(), null);
});
