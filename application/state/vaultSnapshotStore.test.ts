import assert from 'node:assert/strict';
import test from 'node:test';

import type { Host } from '../../domain/models.ts';
import {
  EMPTY_VAULT_SNAPSHOT,
  getVaultSnapshot,
  getVaultSnapshotActions,
  publishVaultSnapshot,
  registerVaultSnapshotActions,
  subscribeVaultSnapshot,
  vaultSnapshotsEqual,
  type VaultSnapshotActions,
} from './vaultSnapshotStore.ts';

function makeHost(id: string): Host {
  return { id, label: id, hostname: `${id}.example`, username: 'root' } as Host;
}

test('vaultSnapshotStore notifies only when a field identity changes', () => {
  const seen: number[] = [];
  const unsubscribe = subscribeVaultSnapshot(() => {
    seen.push(getVaultSnapshot().hosts.length);
  });

  const hosts = [makeHost('h1')];
  const snapshot = { ...EMPTY_VAULT_SNAPSHOT, isVaultInitialized: true, hosts };
  publishVaultSnapshot(snapshot);
  assert.deepEqual(seen, [1]);
  assert.equal(getVaultSnapshot().hosts, hosts);
  assert.equal(getVaultSnapshot().isVaultInitialized, true);

  // Same field identities in a fresh object must not wake subscribers.
  publishVaultSnapshot({ ...snapshot });
  assert.deepEqual(seen, [1]);

  const moreHosts = [...hosts, makeHost('h2')];
  publishVaultSnapshot({ ...snapshot, hosts: moreHosts });
  assert.deepEqual(seen, [1, 2]);

  unsubscribe();
  publishVaultSnapshot(EMPTY_VAULT_SNAPSHOT);
  assert.deepEqual(seen, [1, 2]);
});

test('vaultSnapshotsEqual compares every published field', () => {
  assert.equal(vaultSnapshotsEqual(EMPTY_VAULT_SNAPSHOT, { ...EMPTY_VAULT_SNAPSHOT }), true);
  assert.equal(
    vaultSnapshotsEqual(EMPTY_VAULT_SNAPSHOT, { ...EMPTY_VAULT_SNAPSHOT, groupConfigs: [] }),
    false,
  );
  assert.equal(
    vaultSnapshotsEqual(EMPTY_VAULT_SNAPSHOT, {
      ...EMPTY_VAULT_SNAPSHOT,
      isVaultInitialized: true,
    }),
    false,
  );
});

test('vault actions register and unregister', () => {
  assert.equal(getVaultSnapshotActions(), null);
  const calls: string[] = [];
  const noop = (() => {}) as never;
  registerVaultSnapshotActions({
    updateHosts: ((() => {
      calls.push('hosts');
    }) as unknown) as VaultSnapshotActions['updateHosts'],
    updateKeys: noop,
    importOrReuseKey: noop,
    updateIdentities: noop,
    updateProxyProfiles: noop,
    updateSnippets: noop,
    updateSnippetPackages: noop,
    updateCustomGroups: noop,
    updateKnownHosts: noop,
    updateManagedSources: noop,
    updateGroupConfigs: noop,
    convertKnownHostToHost: noop,
    readPersistedHosts: noop,
    readPersistedManagedSources: noop,
    commitPluginImporterData: noop,
    commitVaultImportTransaction: noop,
    commitVaultGroupMutation: noop,
    updateHostDistro: noop,
    updateHostLastConnected: noop,
    addShellHistoryEntry: noop,
    removeShellHistoryEntry: noop,
    clearAllCommandHistory: noop,
  });
  getVaultSnapshotActions()?.updateHosts([]);
  assert.deepEqual(calls, ['hosts']);

  registerVaultSnapshotActions(null);
  assert.equal(getVaultSnapshotActions(), null);
});
