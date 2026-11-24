import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeHostsForSync, type SyncPayload } from './sync.ts';
import { mergeSyncPayloads } from './syncMerge.ts';
import { withSyncReliabilityMeta } from './syncReliability.ts';
import { upsertGroup } from './vaultGroupAgentOps.ts';

function beforeMove(group = 'A'): SyncPayload {
  return {
    hosts: ['h1', 'h2'].map((id) => ({
      id, label: id, hostname: `${id}.example.test`, username: 'root',
      tags: [], os: 'linux', group,
    })),
    keys: [], snippets: [], customGroups: ['A', 'B', ...(group === 'A' ? [] : [group])],
    groupConfigs: [{ path: 'A', username: 'deploy', order: 1000 }, { path: 'B', order: 2000 }],
    syncedAt: 1700000000000,
  };
}

function movedRemote(base: SyncPayload): SyncPayload {
  return withSyncReliabilityMeta({
    ...base,
    hosts: base.hosts.map((host) => ({ ...host, group: `B/${host.group}` })),
    customGroups: base.customGroups.map((path) => path === 'B' ? path : `B/${path}`),
    groupConfigs: base.groupConfigs!.map((config) => (
      config.path === 'B' ? config : { ...config, path: `B/${config.path}` }
    )),
  }, base, { deviceId: 'PC1', now: base.syncedAt + 10 });
}

function assertRename(payload: SyncPayload, source: string, destination: string) {
  const renamed = upsertGroup({
    groups: payload.customGroups, configs: payload.groupConfigs ?? [],
    hosts: payload.hosts, managedSources: [],
  }, source, {}, [], [], { newPath: destination });
  assert.equal(renamed.ok, true, 'the retained occupied group must be editable');
  if (!renamed.ok) return;
  assert.deepEqual(renamed.state.hosts.map((host) => host.group), [destination, destination]);
  assert.ok(renamed.state.groups.includes(destination));
}

test('#4344: null-base merge keeps the explicit group and defaults of local-winning hosts', () => {
  const local = beforeMove();
  const remote = movedRemote(local);
  assert.ok(remote.syncMeta!.deletions.some((record) => record.entityType === 'customGroups' && record.id === 'A'));
  assert.ok(remote.syncMeta!.deletions.some((record) => record.entityType === 'groupConfigs' && record.id === 'A'));

  const merged = mergeSyncPayloads(null, local, remote).payload;
  assert.deepEqual(merged.hosts, sanitizeHostsForSync(local.hosts), 'retain the entire local host winners');
  assert.ok(merged.customGroups.includes('A'));
  assert.deepEqual(merged.groupConfigs!.find((config) => config.path === 'A'), local.groupConfigs![0]);
  assert.equal(merged.syncMeta?.deletions.some((record) => record.id === 'A') ?? false, false);
  assertRename(merged, 'A', 'Renamed');
  assertRename(merged, 'A', 'B/Renamed');

  // The remote explicit addition is independent of the old-path tombstones.
  assert.ok(merged.customGroups.includes('B/A'));
  const again = mergeSyncPayloads(null, merged, remote).payload;
  assert.ok(again.customGroups.includes('A'));
  assertRename(again, 'A', 'Renamed');
});

test('#4344: a valid shared baseline still lets unchanged stale hosts follow the remote move', () => {
  const base = beforeMove();
  const remote = movedRemote(base);
  const merged = mergeSyncPayloads(base, base, remote).payload;
  assert.deepEqual(merged.hosts, sanitizeHostsForSync(remote.hosts));
  assert.deepEqual(new Set(merged.customGroups), new Set(['B', 'B/A']));
  assert.deepEqual(new Set(merged.groupConfigs), new Set(remote.groupConfigs));
  assertRename(merged, 'B/A', 'B/Renamed');
});

test('a shared-baseline host conflict also retains the group of the local winner', () => {
  const base = beforeMove();
  const local = { ...base, hosts: base.hosts.map((host) => ({ ...host, notes: 'Local edit' })) };
  const merged = mergeSyncPayloads(base, local, movedRemote(base)).payload;
  assert.deepEqual(merged.hosts, sanitizeHostsForSync(local.hosts));
  assert.ok(merged.customGroups.includes('A'));
  assert.deepEqual(merged.groupConfigs!.find((config) => config.path === 'A'), base.groupConfigs![0]);
  assertRename(merged, 'A', 'Renamed');
});

test('retained nested hosts keep deleted ancestor groups and inherited defaults', () => {
  const local = beforeMove('A/child');
  const merged = mergeSyncPayloads(null, local, movedRemote(local)).payload;
  assert.ok(merged.customGroups.includes('A'));
  assert.ok(merged.customGroups.includes('A/child'));
  assert.deepEqual(merged.groupConfigs!.find((config) => config.path === 'A'), local.groupConfigs![0]);
  assertRename(merged, 'A/child', 'Renamed');
});

test('unoccupied old groups and configs are still deleted without a baseline', () => {
  const local = { ...beforeMove(), hosts: [] };
  const remote = movedRemote(local);
  const merged = mergeSyncPayloads(null, local, remote).payload;
  assert.deepEqual(new Set(merged.customGroups), new Set(['B', 'B/A']));
  assert.deepEqual(new Set(merged.groupConfigs), new Set(remote.groupConfigs));
  assert.ok(merged.syncMeta!.deletions.some((record) => record.entityType === 'customGroups' && record.id === 'A'));
});

test('deleting only group defaults still applies when the explicit occupied group survives', () => {
  const local = beforeMove();
  const remote = withSyncReliabilityMeta({ ...local, groupConfigs: [] }, local);
  const merged = mergeSyncPayloads(null, local, remote).payload;
  assert.deepEqual(merged.customGroups, local.customGroups);
  assert.deepEqual(merged.groupConfigs, []);
});
