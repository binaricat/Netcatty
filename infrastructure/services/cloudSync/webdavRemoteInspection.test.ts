import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { SyncedFile, SyncPayload } from '../../../domain/sync';
import type { ProviderSyncAnchor } from '../CloudSyncManager';
import { createAdapter, type CloudAdapter } from '../adapters';
import { EncryptionService } from '../EncryptionService';
import { netcattyBridge } from '../netcattyBridge';
import { createSyncedFileSignature } from '../syncSignature.js';
import {
  commitRemoteInspectionImpl,
  inspectProviderRemoteImpl,
  inspectProviderRemoteStateImpl,
  saveSyncAnchorImpl,
} from './authMethods';
import { uploadToProviderImpl } from './providerSyncMethods';

const path = '/netcatty-vault.json';
const config = { endpoint: 'https://webdav.example.test', authType: 'basic' as const };
const file: SyncedFile = {
  meta: {
    version: 1, updatedAt: 10, deviceId: 'device', appVersion: '1.1.90',
    iv: 'iv', salt: 'salt', algorithm: 'AES-256-GCM', kdf: 'PBKDF2',
  },
  payload: 'ciphertext',
};
const payload: SyncPayload = { hosts: [], keys: [], snippets: [], customGroups: [], syncedAt: 10 };

async function setup(t: TestContext) {
  const storage = new Map<string, string>();
  const remote = { file, etag: '"v1"' as string | undefined };
  const requests: Array<string | undefined> = [];
  let bodyGets = 0;
  t.mock.method(netcattyBridge, 'get', () => ({
    cloudSyncWebdavInitialize: async () => ({ resourceId: path }),
    cloudSyncWebdavDownload: async (_config: unknown, etag?: string) => {
      requests.push(etag);
      if (etag && etag === remote.etag) return { syncedFile: null, notModified: true };
      bodyGets++;
      return { syncedFile: structuredClone(remote.file), etag: remote.etag };
    },
    cloudSyncWebdavUpload: async (_config: unknown, next: SyncedFile) => {
      remote.file = structuredClone(next);
      remote.etag = '"uploaded"';
      return { resourceId: path, etag: remote.etag };
    },
  }));
  const decrypt = t.mock.method(EncryptionService, 'decryptPayload', async () => payload);
  const adapter = await createAdapter('webdav', undefined, path, config);
  const manager = {
    adapters: new Map([['webdav', adapter]]),
    masterPassword: 'password',
    providerDecryptSeq: { webdav: 0 },
    state: {
      securityState: 'UNLOCKED',
      providers: { webdav: { resourceId: path, lastSync: 123 } },
      localVersion: 0, localUpdatedAt: 0, remoteVersion: 0, remoteUpdatedAt: 0,
    },
    syncAnchorKey: () => 'anchor:webdav',
    loadFromStorage: (key: string) => storage.has(key) ? JSON.parse(storage.get(key)!) : null,
    saveToStorage: (key: string, value: unknown) => storage.set(key, JSON.stringify(value)),
    createSyncedFileSignature,
    loadSyncAnchor: () => manager.loadFromStorage('anchor:webdav') as ProviderSyncAnchor | null,
    saveSyncAnchor: (_provider: string, next: SyncedFile | null, resourceId?: string) =>
      saveSyncAnchorImpl.call(manager, 'webdav', next, resourceId),
    getConnectedAdapter: async () => manager.adapters.get('webdav')!,
    inspectProviderRemoteState: (_provider: string, current: CloudAdapter, allowNotModified = false) =>
      inspectProviderRemoteStateImpl.call(manager, 'webdav', current, allowNotModified),
    saveSyncBase: async () => {},
    saveSyncConfig: () => {},
    saveProviderConnection: async () => {},
    notifyStateChange: () => {},
    addSyncHistoryEntry: () => {},
    updateProviderStatus: () => {},
    emit: () => {},
  };
  return {
    manager, adapter, remote, requests, decrypt,
    bodyGets: () => bodyGets,
    inspect: () => inspectProviderRemoteImpl.call(manager, 'webdav'),
    commit: (next: SyncedFile) => commitRemoteInspectionImpl.call(manager, 'webdav', next, payload),
    restart: async () => manager.adapters.set('webdav', await createAdapter('webdav', undefined, path, config)),
  };
}

test('WebDAV first download persists ETag in the anchor; inspection after restart skips the body', async (t) => {
  const h = await setup(t);
  const first = await h.inspect();
  assert.equal(first.remoteChanged, true);
  assert.deepEqual(first.remoteFile, file);
  await h.commit(first.remoteFile!);
  assert.equal(h.manager.loadSyncAnchor()?.webdavEtag, '"v1"');
  const lastSync = h.manager.state.providers.webdav.lastSync;
  await h.restart();
  assert.deepEqual(await h.inspect(), { remoteChanged: false, remoteFile: null, payload: null });
  assert.equal(h.bodyGets(), 1, 'unchanged inspection must not download a body');
  assert.deepEqual(h.requests, [undefined, '"v1"']);
  assert.equal(h.decrypt.mock.callCount(), 1);
  assert.equal(h.manager.state.providers.webdav.lastSync, lastSync);
});

test('changed WebDAV ETag downloads and commits the new validator before subsequent skips', async (t) => {
  const h = await setup(t);
  await h.commit((await h.inspect()).remoteFile!);
  h.remote.file = { ...file, payload: 'changed-ciphertext' };
  h.remote.etag = '"v2"';
  const changed = await h.inspect();
  assert.equal(changed.remoteChanged, true);
  assert.deepEqual(changed.remoteFile, h.remote.file);
  assert.equal(h.bodyGets(), 2, 'changed inspection should fetch exactly one body');
  // Until local apply commits, the old anchor must still force a download.
  await h.inspect();
  assert.equal(h.bodyGets(), 3);
  await h.commit(changed.remoteFile!);
  assert.equal(h.manager.loadSyncAnchor()?.webdavEtag, '"v2"');
  await h.restart();
  assert.equal((await h.inspect()).remoteChanged, false);
  assert.equal(h.bodyGets(), 3);
});

test('WebDAV legacy anchor without ETag downloads once and persists the validator without changing lastSync', async (t) => {
  const h = await setup(t);
  await h.manager.saveSyncAnchor('webdav', file, path);
  assert.equal(h.manager.loadSyncAnchor()?.webdavEtag, undefined);
  assert.equal((await h.inspect()).remoteChanged, false);
  assert.equal(h.manager.loadSyncAnchor()?.webdavEtag, '"v1"');
  assert.equal(h.manager.state.providers.webdav.lastSync, 123);
  await h.restart();
  await h.inspect();
  assert.equal(h.bodyGets(), 1);
});

test('WebDAV server without validators keeps the full-download fallback', async (t) => {
  const h = await setup(t);
  h.remote.etag = undefined;
  await h.commit((await h.inspect()).remoteFile!);
  assert.equal(h.manager.loadSyncAnchor()?.webdavEtag, undefined);
  await h.restart();
  assert.equal((await h.inspect()).remoteChanged, false);
  assert.equal(h.bodyGets(), 2);
  assert.deepEqual(h.requests, [undefined, undefined]);
});

test('WebDAV upload through the production wrapper persists its ETag for the next inspect', async (t) => {
  const h = await setup(t);
  const uploaded = { ...file, payload: 'uploaded-ciphertext' };
  const result = await uploadToProviderImpl.call(h.manager, 'webdav', h.adapter, uploaded, payload);
  assert.equal(result.success, true);
  assert.equal(h.manager.loadSyncAnchor()?.webdavEtag, '"uploaded"');
  await h.restart();
  assert.equal((await h.inspect()).remoteChanged, false);
  assert.equal(h.bodyGets(), 0);
});

test('WebDAV changed ETag with identical contents refreshes the anchor without a local apply', async (t) => {
  const h = await setup(t);
  await h.commit((await h.inspect()).remoteFile!);
  const lastSync = h.manager.state.providers.webdav.lastSync;
  h.remote.etag = '"new-etag-same-file"';
  assert.equal((await h.inspect()).remoteChanged, false);
  assert.equal(h.manager.loadSyncAnchor()?.webdavEtag, h.remote.etag);
  assert.equal(h.manager.state.providers.webdav.lastSync, lastSync);
  await h.restart();
  await h.inspect();
  assert.equal(h.bodyGets(), 2);
});

test('WebDAV ETag must belong to the snapshot being anchored', async (t) => {
  const h = await setup(t);
  await h.adapter.download();
  await h.manager.saveSyncAnchor('webdav', { ...file, payload: 'different-snapshot' }, path);
  assert.equal(h.manager.loadSyncAnchor()?.webdavEtag, undefined);
  assert.equal((await h.inspect()).remoteChanged, true);
  assert.equal(h.bodyGets(), 2);
});

test('WebDAV upload preflight still returns the full remote payload with a matching ETag', async (t) => {
  const h = await setup(t);
  await h.commit((await h.inspect()).remoteFile!);
  const check = await inspectProviderRemoteStateImpl.call(h.manager, 'webdav', h.adapter);
  assert.equal(check.remoteChanged, false);
  assert.deepEqual(check.remoteFile, file);
  assert.deepEqual(h.requests, [undefined, undefined]);
  assert.equal(h.bodyGets(), 2);
});

test('other providers continue to use download during remote inspection', async () => {
  let downloads = 0;
  const adapter = { resourceId: 'gist', download: async () => { downloads++; return file; } };
  const manager = {
    state: { providers: { github: { resourceId: 'gist' } } },
    loadSyncAnchor: () => null,
    createSyncedFileSignature,
  };
  const result = await inspectProviderRemoteStateImpl.call(manager, 'github', adapter as CloudAdapter, true);
  assert.equal(result.remoteChanged, true);
  assert.deepEqual(result.remoteFile, file);
  assert.equal(downloads, 1);
});
