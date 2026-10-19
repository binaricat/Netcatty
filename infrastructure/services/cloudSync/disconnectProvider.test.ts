import assert from 'node:assert/strict';
import test from 'node:test';
import { providerConnectionStorageKey, type ProviderConnection } from '../../../domain/sync';
import { disconnectProviderImpl } from './authMethods';
import { saveProviderConnectionImpl } from './stateAndSecurityMethods';

function harness(failure?: 'throw' | 'quota') {
  const original: ProviderConnection = {
    provider: 'webdav', status: 'connected',
    config: { endpoint: 'https://fixture.invalid', username: 'fixture', password: 'fixture', authType: 'basic' },
  };
  const storage = new Map<string, unknown>([
    [providerConnectionStorageKey('webdav'), original],
    ['backup-history', ['fixture-backup']],
    ['sync-password', 'fixture-password'],
    ['auto-sync', true],
    ['base', {}], ['convergent-base', {}], ['anchor', {}], ['account', 'fixture'],
  ]);
  let notifications = 0;
  let signOuts = 0;
  let fail = failure;
  const adapter = { signOut: () => { signOuts += 1; } };
  const manager = {
    adapters: new Map([['webdav', adapter]]),
    providerDecryptSeq: { webdav: 0 },
    providerWriteSeq: { webdav: 0 },
    state: { providers: { webdav: original }, syncState: 'IDLE' },
    cancelProviderAuthAttempt() {},
    loadFromStorage: (key: string) => storage.get(key) ?? null,
    saveToStorage(key: string, value: unknown) {
      if (fail === 'throw') throw new Error('storage denied');
      if (fail === 'quota') return false;
      storage.set(key, value);
      return true;
    },
    removeFromStorage: (key: string) => { storage.delete(key); },
    syncBaseKey: () => 'base',
    convergentProviderBaselineKey: () => 'convergent-base',
    clearSyncAnchor: () => { storage.delete('anchor'); },
    providerAccountIdKey: () => 'account',
    exitBlockedState() {},
    notifyStateChange: () => { notifications += 1; },
    async saveProviderConnection(_provider: string, connection: ProviderConnection) {
      await saveProviderConnectionImpl.call(manager, 'webdav', connection);
    },
  };
  return {
    manager, storage, original,
    recover: () => { fail = undefined; },
    notifications: () => notifications,
    signOuts: () => signOuts,
  };
}

test('disconnect clears provider connection and merge state while retaining local data', async () => {
  const h = harness();
  await disconnectProviderImpl.call(h.manager, 'webdav');
  assert.deepEqual(h.storage.get(providerConnectionStorageKey('webdav')), { provider: 'webdav', status: 'disconnected' });
  for (const key of ['base', 'convergent-base', 'anchor', 'account']) assert.equal(h.storage.has(key), false);
  assert.deepEqual(h.storage.get('backup-history'), ['fixture-backup']);
  assert.equal(h.storage.get('sync-password'), 'fixture-password');
  assert.equal(h.storage.get('auto-sync'), true);
  assert.equal(h.notifications(), 1);
  assert.equal(h.signOuts(), 1);
});

for (const failure of ['throw', 'quota'] as const) {
  test(`disconnect rejects ${failure} save failures and allows retry`, async () => {
    const h = harness(failure);
    await assert.rejects(disconnectProviderImpl.call(h.manager, 'webdav'));
    assert.equal(h.storage.get(providerConnectionStorageKey('webdav')), h.original);
    assert.equal(h.manager.state.providers.webdav, h.original);
    assert.equal(h.notifications(), 0);
    assert.equal(h.signOuts(), 0);
    h.recover();
    await disconnectProviderImpl.call(h.manager, 'webdav');
    assert.equal(h.manager.state.providers.webdav.status, 'disconnected');
    assert.equal(h.signOuts(), 1);
    assert.equal(h.notifications(), 1);
  });
}
