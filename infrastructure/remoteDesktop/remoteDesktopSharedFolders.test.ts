import assert from 'node:assert/strict';
import test from 'node:test';
import { STORAGE_KEY_REMOTE_DESKTOP_SHARED_FOLDERS } from '../config/storageKeys';
import {
  addRemoteDesktopSharedFolder,
  allocateNextSharedDriveDeviceId,
  loadRemoteDesktopSharedFolders,
  MIN_RDPDR_SHARED_DRIVE_DEVICE_ID,
  removeRemoteDesktopSharedFolder,
  saveRemoteDesktopSharedFolders,
  updateRemoteDesktopSharedFolder,
} from './remoteDesktopSharedFolders';

function installMockLocalStorage() {
  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
  Object.defineProperty(globalThis, 'localStorage', {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
  return store;
}

test('allocateNextSharedDriveDeviceId assigns smallest unused integer >= 10', () => {
  assert.equal(allocateNextSharedDriveDeviceId([]), MIN_RDPDR_SHARED_DRIVE_DEVICE_ID);
  assert.equal(allocateNextSharedDriveDeviceId([{ deviceId: 10 }, { deviceId: 11 }]), 12);
  assert.equal(allocateNextSharedDriveDeviceId([{ deviceId: 10 }, { deviceId: 12 }]), 11);
});

test('shared folders CRUD persists per host in localStorage with unique deviceId >= 10 and deduplicates paths', () => {
  const store = installMockLocalStorage();

  assert.deepEqual(loadRemoteDesktopSharedFolders('host-a'), []);

  const r1 = addRemoteDesktopSharedFolder('host-a', {
    path: '/Users/alice/Projects/',
    readOnly: false,
  });
  assert.equal(r1.duplicate, undefined);
  assert.ok(r1.added);
  assert.equal(r1.added.deviceId, 10);
  assert.equal(r1.added.name, 'Projects');
  assert.equal(r1.added.path, '/Users/alice/Projects');
  assert.equal(r1.added.readOnly, false);

  // Duplicate path (with trailing slash) is rejected cleanly
  const dup = addRemoteDesktopSharedFolder('host-a', {
    path: '/Users/alice/Projects',
    readOnly: true,
  });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.added, null);
  assert.equal(dup.folders.length, 1);

  // Adding a second folder with the same basename disambiguates share name & gets deviceId 11
  const r2 = addRemoteDesktopSharedFolder('host-a', {
    path: '/Volumes/Work/Projects',
    readOnly: true,
  });
  assert.ok(r2.added);
  assert.equal(r2.added.deviceId, 11);
  assert.equal(r2.added.name, 'Projects_2');
  assert.equal(r2.added.readOnly, true);

  // Host isolation
  const other = addRemoteDesktopSharedFolder('host-b', {
    path: '/tmp/shared',
    name: 'TempShare',
  });
  assert.equal(other.added?.deviceId, 10);
  assert.equal(loadRemoteDesktopSharedFolders('host-a').length, 2);
  assert.equal(loadRemoteDesktopSharedFolders('host-b').length, 1);

  // Toggle read-only
  const toggled = updateRemoteDesktopSharedFolder('host-a', r1.added.id, { readOnly: true });
  assert.equal(toggled.find((f) => f.id === r1.added!.id)?.readOnly, true);

  // Remove by deviceId & by id
  const afterRemove1 = removeRemoteDesktopSharedFolder('host-a', 10);
  assert.equal(afterRemove1.length, 1);
  assert.equal(afterRemove1[0].deviceId, 11);

  const afterRemove2 = removeRemoteDesktopSharedFolder('host-a', r2.added.id);
  assert.equal(afterRemove2.length, 0);

  // Save directly strips duplicates and enforces deviceId >= 10
  const saved = saveRemoteDesktopSharedFolders('host-c', [
    { id: 'f1', deviceId: 2, name: 'BadLowId', path: '/var/data', readOnly: false },
    { id: 'f2', deviceId: 10, name: 'DupPath', path: '/var/data/', readOnly: true },
  ]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].deviceId, 10);

  assert.ok(store.has(STORAGE_KEY_REMOTE_DESKTOP_SHARED_FOLDERS));
});
