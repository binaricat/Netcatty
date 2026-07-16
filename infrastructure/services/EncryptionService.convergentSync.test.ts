import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createConvergentSyncStateFromPayload,
  serializeConvergentSyncState,
  validateConvergentSyncPayload,
  withConvergentSyncEnvelope,
} from '../../domain/convergentSync/index.ts';
import type { SyncPayload } from '../../domain/sync.ts';
import { EncryptionService } from './EncryptionService.ts';

test('v2 metadata exposes only the schema while the envelope remains encrypted', async () => {
  const now = 1_700_000_000_000;
  const legacy: SyncPayload = {
    hosts: [],
    keys: [{
      id: 'key-1',
      label: 'Secret key',
      type: 'ED25519',
      privateKey: 'never-plaintext',
      source: 'imported',
      category: 'key',
      created: now,
    }],
    snippets: [],
    customGroups: [],
    syncedAt: now,
  };
  const state = createConvergentSyncStateFromPayload(legacy, 'device-a', now);
  const payload = withConvergentSyncEnvelope(state, { syncedAt: now });
  const file = await EncryptionService.encryptPayload(
    payload,
    'correct horse battery staple',
    'device-a',
    'Device A',
    '1.0.0',
  );

  assert.equal(file.meta.syncSchemaVersion, 2);
  assert.equal(JSON.stringify(file.meta).includes('never-plaintext'), false);
  assert.equal(file.payload.includes('never-plaintext'), false);
  const decrypted = await EncryptionService.decryptPayload(
    file,
    'correct horse battery staple',
  );
  assert.equal(
    serializeConvergentSyncState(validateConvergentSyncPayload(file.meta, decrypted)!),
    serializeConvergentSyncState(state),
  );
});
