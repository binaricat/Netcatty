import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createConvergentSyncStateFromPayload,
  materializeSyncPayloadFromConvergentState,
} from '../domain/convergentSync/index.ts';
import type { SyncPayload } from '../domain/sync.ts';
import type { CloudSyncManager } from '../infrastructure/services/CloudSyncManager.ts';
import { prepareRestoredPayloadConvergentWrites } from './convergentSyncReplica.ts';

const NOW = 1_700_000_000_000;

function payload(label: string): SyncPayload {
  return {
    hosts: [{
      id: 'host-1',
      label,
      hostname: 'example.com',
      username: 'root',
      tags: [],
      os: 'linux',
    }],
    keys: [],
    snippets: [],
    customGroups: [],
    syncedAt: NOW,
  };
}

test('local restore is recorded as writes on the active replica instead of replacing it', async () => {
  const state = createConvergentSyncStateFromPayload(payload('Before'), 'seed', NOW);
  let savedState = state;
  let saveCount = 0;
  const manager = {
    loadConvergentReplica: async () => ({ schemaVersion: 2 as const, state, updatedAt: NOW }),
    getState: () => ({ deviceId: 'local-device' }),
    saveConvergentReplica: async (record: { state: typeof state }) => {
      saveCount += 1;
      savedState = record.state;
    },
  } as unknown as CloudSyncManager;

  const commit = await prepareRestoredPayloadConvergentWrites(
    payload('Restored'),
    NOW + 1,
    { manager, initialized: true },
  );
  assert.equal(saveCount, 0);

  await commit();

  const materialized = materializeSyncPayloadFromConvergentState(savedState, { syncedAt: NOW + 1 });
  assert.equal(saveCount, 1);
  assert.equal(materialized.hosts[0].label, 'Restored');
  assert.equal(savedState.vector['local-device'] > 0, true);
  assert.equal(savedState.vector.seed > 0, true);
});

test('an initialized configuration fails closed when its active replica is missing', async () => {
  const manager = {
    loadConvergentReplica: async () => null,
  } as unknown as CloudSyncManager;

  await assert.rejects(
    () => prepareRestoredPayloadConvergentWrites(
      payload('Restored'),
      NOW,
      { manager, initialized: true },
    ),
    /local replica is missing/,
  );
});
