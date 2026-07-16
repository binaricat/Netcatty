import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConvergentSyncInvariantError,
  applyConvergentMutations,
  createConvergentSyncState,
  decodeSettingPath,
  encodeSettingPath,
  hydrateConvergentSyncState,
  materializeConvergentSyncState,
  mergeConvergentSyncStates,
  registerId,
  serializeConvergentSyncState,
  tickHybridLogicalClock,
  type ConvergentSyncStateV2,
} from './index.ts';

const BASE_TIME = 1_700_000_000_000;

function hostBase() {
  return applyConvergentMutations(createConvergentSyncState(), 'seed', [{
    kind: 'entity-upsert',
    collection: 'hosts',
    entityId: 'host-1',
    value: {
      id: 'host-1',
      label: 'Production',
      hostname: 'old.example.com',
      tags: ['prod'],
    },
    position: 0,
  }], BASE_TIME);
}

test('independent entity fields merge without conflict', () => {
  const base = hostBase();
  const left = applyConvergentMutations(base, 'device-a', [{
    kind: 'entity-field-set',
    collection: 'hosts',
    entityId: 'host-1',
    field: 'label',
    value: 'Primary',
  }], BASE_TIME + 1);
  const right = applyConvergentMutations(base, 'device-b', [{
    kind: 'entity-field-set',
    collection: 'hosts',
    entityId: 'host-1',
    field: 'hostname',
    value: 'new.example.com',
  }], BASE_TIME + 1);

  const materialized = materializeConvergentSyncState(
    mergeConvergentSyncStates(left, right),
  );

  assert.deepEqual(materialized.collections.hosts, [{
    id: 'host-1',
    hostname: 'new.example.com',
    label: 'Primary',
    tags: ['prod'],
  }]);
  assert.deepEqual(materialized.conflicts, []);
});

test('same-field concurrent values are retained with a deterministic winner', () => {
  const base = hostBase();
  const left = applyConvergentMutations(base, 'device-a', [{
    kind: 'entity-field-set',
    collection: 'hosts',
    entityId: 'host-1',
    field: 'label',
    value: 'Left',
  }], BASE_TIME + 1);
  const right = applyConvergentMutations(base, 'device-z', [{
    kind: 'entity-field-set',
    collection: 'hosts',
    entityId: 'host-1',
    field: 'label',
    value: 'Right',
  }], BASE_TIME + 1);

  const materialized = materializeConvergentSyncState(
    mergeConvergentSyncStates(right, left),
  );
  const conflict = materialized.conflicts.find(
    (item) => item.address.kind === 'entity-field' && item.address.field === 'label',
  );

  assert.equal(materialized.collections.hosts[0]?.label, 'Right');
  assert.equal(conflict?.candidates.length, 2);
  assert.deepEqual(
    conflict?.candidates.map((candidate) => candidate.value).sort(),
    ['Left', 'Right'],
  );
  assert.equal(conflict?.candidates.filter((candidate) => candidate.selected).length, 1);
});

test('concurrent delete and update remains visible as a presence conflict', () => {
  const base = hostBase();
  const deleted = applyConvergentMutations(base, 'device-a', [{
    kind: 'entity-delete',
    collection: 'hosts',
    entityId: 'host-1',
  }], BASE_TIME + 1);
  const updated = applyConvergentMutations(base, 'device-b', [{
    kind: 'entity-field-set',
    collection: 'hosts',
    entityId: 'host-1',
    field: 'hostname',
    value: 'edited.example.com',
  }], BASE_TIME + 1);

  const materialized = materializeConvergentSyncState(
    mergeConvergentSyncStates(deleted, updated),
  );

  assert.equal(materialized.collections.hosts.length, 1);
  assert.equal(materialized.collections.hosts[0]?.hostname, 'edited.example.com');
  assert.ok(materialized.conflicts.some(
    (conflict) => conflict.address.kind === 'entity-presence',
  ));
});

test('deleted entities suppress stale field and position conflicts', () => {
  const base = hostBase();
  const left = applyConvergentMutations(base, 'device-a', [{
    kind: 'entity-upsert',
    collection: 'hosts',
    entityId: 'host-1',
    value: {
      id: 'host-1',
      label: 'Left',
      hostname: 'old.example.com',
      tags: ['prod'],
    },
    position: 1,
  }], BASE_TIME + 1);
  const right = applyConvergentMutations(base, 'device-b', [{
    kind: 'entity-upsert',
    collection: 'hosts',
    entityId: 'host-1',
    value: {
      id: 'host-1',
      label: 'Right',
      hostname: 'old.example.com',
      tags: ['prod'],
    },
    position: 2,
  }], BASE_TIME + 1);
  const conflicted = mergeConvergentSyncStates(left, right);
  const deleted = applyConvergentMutations(conflicted, 'device-c', [{
    kind: 'entity-delete',
    collection: 'hosts',
    entityId: 'host-1',
  }], BASE_TIME + 2);
  const entity = deleted.collections.hosts.entities['host-1'];
  const materialized = materializeConvergentSyncState(deleted);

  assert.equal(entity.fields.label.candidates.length, 2);
  assert.equal(entity.position?.candidates.length, 2);
  assert.deepEqual(materialized.collections.hosts, []);
  assert.deepEqual(materialized.conflicts, []);
});

test('visible entities retain internal conflicts during a presence conflict', () => {
  const base = hostBase();
  const left = applyConvergentMutations(base, 'device-a', [{
    kind: 'entity-field-set',
    collection: 'hosts',
    entityId: 'host-1',
    field: 'label',
    value: 'Left',
  }], BASE_TIME + 1);
  const right = applyConvergentMutations(base, 'device-b', [{
    kind: 'entity-field-set',
    collection: 'hosts',
    entityId: 'host-1',
    field: 'label',
    value: 'Right',
  }], BASE_TIME + 1);
  const deleted = applyConvergentMutations(base, 'device-c', [{
    kind: 'entity-delete',
    collection: 'hosts',
    entityId: 'host-1',
  }], BASE_TIME + 1);
  const materialized = materializeConvergentSyncState(
    mergeConvergentSyncStates(mergeConvergentSyncStates(left, right), deleted),
  );

  assert.equal(materialized.collections.hosts.length, 1);
  assert.ok(materialized.conflicts.some(
    (conflict) => conflict.address.kind === 'entity-presence',
  ));
  assert.ok(materialized.conflicts.some(
    (conflict) => conflict.address.kind === 'entity-field'
      && conflict.address.field === 'label',
  ));
});

test('full entity upserts resolve an accepted presence conflict', () => {
  const base = hostBase();
  const deleted = applyConvergentMutations(base, 'device-a', [{
    kind: 'entity-delete',
    collection: 'hosts',
    entityId: 'host-1',
  }], BASE_TIME + 1);
  const updated = applyConvergentMutations(base, 'device-b', [{
    kind: 'entity-field-set',
    collection: 'hosts',
    entityId: 'host-1',
    field: 'hostname',
    value: 'edited.example.com',
  }], BASE_TIME + 1);
  const conflicted = mergeConvergentSyncStates(deleted, updated);
  const selected = materializeConvergentSyncState(conflicted).collections.hosts[0];
  const resolved = applyConvergentMutations(conflicted, 'resolver', [{
    kind: 'entity-upsert',
    collection: 'hosts',
    entityId: 'host-1',
    value: selected,
    position: 0,
  }], BASE_TIME + 2);
  const materialized = materializeConvergentSyncState(resolved);

  assert.equal(materialized.collections.hosts[0]?.hostname, 'edited.example.com');
  assert.equal(materialized.conflicts.length, 0);
  assert.equal(resolved.vector.resolver, 1);
});

test('full entity upserts resolve same-value field conflicts', () => {
  const base = hostBase();
  const left = applyConvergentMutations(base, 'device-a', [{
    kind: 'entity-field-set',
    collection: 'hosts',
    entityId: 'host-1',
    field: 'label',
    value: 'Left',
  }], BASE_TIME + 1);
  const right = applyConvergentMutations(base, 'device-z', [{
    kind: 'entity-field-set',
    collection: 'hosts',
    entityId: 'host-1',
    field: 'label',
    value: 'Right',
  }], BASE_TIME + 1);
  const conflicted = mergeConvergentSyncStates(left, right);
  const selected = materializeConvergentSyncState(conflicted).collections.hosts[0];
  const resolved = applyConvergentMutations(conflicted, 'resolver', [{
    kind: 'entity-upsert',
    collection: 'hosts',
    entityId: 'host-1',
    value: selected,
    position: 0,
  }], BASE_TIME + 2);
  const materialized = materializeConvergentSyncState(resolved);

  assert.equal(materialized.collections.hosts[0]?.label, 'Right');
  assert.equal(materialized.conflicts.length, 0);
  assert.equal(resolved.vector.resolver, 2);
});

test('full entity upserts resolve same-value position conflicts', () => {
  const base = hostBase();
  const value = materializeConvergentSyncState(base).collections.hosts[0];
  const left = applyConvergentMutations(base, 'device-a', [{
    kind: 'entity-upsert',
    collection: 'hosts',
    entityId: 'host-1',
    value,
    position: 1,
  }], BASE_TIME + 1);
  const right = applyConvergentMutations(base, 'device-z', [{
    kind: 'entity-upsert',
    collection: 'hosts',
    entityId: 'host-1',
    value,
    position: 2,
  }], BASE_TIME + 1);
  const conflicted = mergeConvergentSyncStates(left, right);
  const selected = materializeConvergentSyncState(conflicted).collections.hosts[0];
  const resolved = applyConvergentMutations(conflicted, 'resolver', [{
    kind: 'entity-upsert',
    collection: 'hosts',
    entityId: 'host-1',
    value: selected,
    position: 2,
  }], BASE_TIME + 2);

  assert.equal(materializeConvergentSyncState(resolved).conflicts.length, 0);
  assert.equal(resolved.vector.resolver, 2);
});

test('unchanged full entity upserts do not advance the replica clock', () => {
  const initial = hostBase();
  const value = materializeConvergentSyncState(initial).collections.hosts[0];
  const unchanged = applyConvergentMutations(initial, 'seed', [{
    kind: 'entity-upsert',
    collection: 'hosts',
    entityId: 'host-1',
    value,
    position: 0,
  }], BASE_TIME + 1);

  assert.equal(
    serializeConvergentSyncState(unchanged),
    serializeConvergentSyncState(initial),
  );
});

test('no-op field sets do not resurrect concurrent entity deletions', () => {
  const base = hostBase();
  const unchanged = applyConvergentMutations(base, 'device-b', [{
    kind: 'entity-field-set',
    collection: 'hosts',
    entityId: 'host-1',
    field: 'label',
    value: 'Production',
  }], BASE_TIME + 1);
  const deleted = applyConvergentMutations(base, 'device-a', [{
    kind: 'entity-delete',
    collection: 'hosts',
    entityId: 'host-1',
  }], BASE_TIME + 1);

  assert.equal(
    serializeConvergentSyncState(unchanged),
    serializeConvergentSyncState(base),
  );
  assert.deepEqual(
    materializeConvergentSyncState(
      mergeConvergentSyncStates(deleted, unchanged),
    ).collections.hosts,
    [],
  );
});

test('deleting an absent field is a no-op and does not refresh presence', () => {
  const base = hostBase();
  const unchanged = applyConvergentMutations(base, 'device-b', [{
    kind: 'entity-field-delete',
    collection: 'hosts',
    entityId: 'host-1',
    field: 'description',
  }], BASE_TIME + 1);

  assert.equal(
    serializeConvergentSyncState(unchanged),
    serializeConvergentSyncState(base),
  );
});

test('field deletion on a non-present entity does not recreate it', () => {
  const deleted = applyConvergentMutations(hostBase(), 'device-a', [{
    kind: 'entity-delete',
    collection: 'hosts',
    entityId: 'host-1',
  }], BASE_TIME + 1);
  const fieldDeleted = applyConvergentMutations(deleted, 'device-b', [{
    kind: 'entity-field-delete',
    collection: 'hosts',
    entityId: 'host-1',
    field: 'label',
  }], BASE_TIME + 2);

  assert.deepEqual(
    materializeConvergentSyncState(fieldDeleted).collections.hosts,
    [],
  );
  assert.equal(
    fieldDeleted.collections.hosts.entities['host-1'].presence.candidates[0]?.tombstone,
    true,
  );
  assert.equal(
    fieldDeleted.collections.hosts.entities['host-1'].fields.label.candidates[0]?.tombstone,
    true,
  );
});

test('causal deletion is not resurrected by a stale replica', () => {
  const base = hostBase();
  const deleted = applyConvergentMutations(base, 'device-a', [{
    kind: 'entity-delete',
    collection: 'hosts',
    entityId: 'host-1',
  }], BASE_TIME + 1);

  const merged = mergeConvergentSyncStates(base, deleted);
  assert.deepEqual(materializeConvergentSyncState(merged).collections.hosts, []);
  assert.equal(
    merged.collections.hosts.entities['host-1'].presence.candidates[0]?.tombstone,
    true,
  );
});

test('explicit recreation causally dominates a tombstone', () => {
  const deleted = applyConvergentMutations(hostBase(), 'device-a', [{
    kind: 'entity-delete',
    collection: 'hosts',
    entityId: 'host-1',
  }], BASE_TIME + 1);
  const recreated = applyConvergentMutations(deleted, 'device-b', [{
    kind: 'entity-upsert',
    collection: 'hosts',
    entityId: 'host-1',
    value: {
      id: 'host-1',
      label: 'Recreated',
      hostname: 'new.example.com',
      tags: [],
    },
  }], BASE_TIME + 2);

  const materialized = materializeConvergentSyncState(
    mergeConvergentSyncStates(deleted, recreated),
  );
  assert.equal(materialized.collections.hosts[0]?.label, 'Recreated');
  assert.equal(materialized.conflicts.length, 0);
});

test('conflict resolution dominates all candidates and survives stale joins', () => {
  const base = hostBase();
  const left = applyConvergentMutations(base, 'device-a', [{
    kind: 'entity-field-set',
    collection: 'hosts',
    entityId: 'host-1',
    field: 'label',
    value: 'Left',
  }], BASE_TIME + 1);
  const right = applyConvergentMutations(base, 'device-b', [{
    kind: 'entity-field-set',
    collection: 'hosts',
    entityId: 'host-1',
    field: 'label',
    value: 'Right',
  }], BASE_TIME + 1);
  const conflicted = mergeConvergentSyncStates(left, right);
  const resolved = applyConvergentMutations(conflicted, 'resolver', [{
    kind: 'resolve-register',
    address: {
      kind: 'entity-field',
      collection: 'hosts',
      entityId: 'host-1',
      field: 'label',
    },
    value: 'Reviewed',
  }], BASE_TIME + 2);

  const afterStaleJoin = materializeConvergentSyncState(
    mergeConvergentSyncStates(resolved, conflicted),
  );
  assert.equal(afterStaleJoin.collections.hosts[0]?.label, 'Reviewed');
  assert.equal(afterStaleJoin.conflicts.length, 0);
});

test('string collections use observed-remove presence and stable positions', () => {
  const base = applyConvergentMutations(createConvergentSyncState(), 'seed', [
    { kind: 'string-entry-add', collection: 'customGroups', value: 'Beta', position: 2 },
    { kind: 'string-entry-add', collection: 'customGroups', value: 'Alpha', position: 1 },
  ], BASE_TIME);
  const deleted = applyConvergentMutations(base, 'device-a', [{
    kind: 'string-entry-delete',
    collection: 'customGroups',
    value: 'Alpha',
  }], BASE_TIME + 1);

  assert.deepEqual(
    materializeConvergentSyncState(mergeConvergentSyncStates(base, deleted))
      .stringCollections.customGroups,
    ['Beta'],
  );
});

test('string-entry adds resolve a visible add/delete conflict', () => {
  const seeded = applyConvergentMutations(createConvergentSyncState(), 'seed', [{
    kind: 'string-entry-add',
    collection: 'customGroups',
    value: 'Alpha',
  }], BASE_TIME);
  const removed = applyConvergentMutations(seeded, 'device-a', [{
    kind: 'string-entry-delete',
    collection: 'customGroups',
    value: 'Alpha',
  }], BASE_TIME + 1);
  const concurrentAdd = applyConvergentMutations(createConvergentSyncState(), 'device-b', [{
    kind: 'string-entry-add',
    collection: 'customGroups',
    value: 'Alpha',
  }], BASE_TIME + 1);
  const conflicted = mergeConvergentSyncStates(removed, concurrentAdd);
  const resolved = applyConvergentMutations(conflicted, 'resolver', [{
    kind: 'string-entry-add',
    collection: 'customGroups',
    value: 'Alpha',
  }], BASE_TIME + 2);
  const materialized = materializeConvergentSyncState(resolved);

  assert.deepEqual(materialized.stringCollections.customGroups, ['Alpha']);
  assert.equal(materialized.conflicts.length, 0);
  assert.equal(resolved.vector.resolver, 1);
});

test('string-entry adds resolve a same-value position conflict', () => {
  const seeded = applyConvergentMutations(createConvergentSyncState(), 'seed', [{
    kind: 'string-entry-add',
    collection: 'customGroups',
    value: 'Alpha',
    position: 0,
  }], BASE_TIME);
  const left = applyConvergentMutations(seeded, 'device-a', [{
    kind: 'string-entry-add',
    collection: 'customGroups',
    value: 'Alpha',
    position: 1,
  }], BASE_TIME + 1);
  const right = applyConvergentMutations(seeded, 'device-z', [{
    kind: 'string-entry-add',
    collection: 'customGroups',
    value: 'Alpha',
    position: 2,
  }], BASE_TIME + 1);
  const conflicted = mergeConvergentSyncStates(left, right);
  const resolved = applyConvergentMutations(conflicted, 'resolver', [{
    kind: 'string-entry-add',
    collection: 'customGroups',
    value: 'Alpha',
    position: 2,
  }], BASE_TIME + 2);
  const materialized = materializeConvergentSyncState(resolved);

  assert.deepEqual(materialized.stringCollections.customGroups, ['Alpha']);
  assert.equal(materialized.conflicts.length, 0);
  assert.equal(resolved.vector.resolver, 2);
});

test('deleted string entries suppress stale position conflicts', () => {
  const seeded = applyConvergentMutations(createConvergentSyncState(), 'seed', [{
    kind: 'string-entry-add',
    collection: 'customGroups',
    value: 'Alpha',
    position: 0,
  }], BASE_TIME);
  const left = applyConvergentMutations(seeded, 'device-a', [{
    kind: 'string-entry-add',
    collection: 'customGroups',
    value: 'Alpha',
    position: 1,
  }], BASE_TIME + 1);
  const right = applyConvergentMutations(seeded, 'device-b', [{
    kind: 'string-entry-add',
    collection: 'customGroups',
    value: 'Alpha',
    position: 2,
  }], BASE_TIME + 1);
  const conflicted = mergeConvergentSyncStates(left, right);
  const deleted = applyConvergentMutations(conflicted, 'device-c', [{
    kind: 'string-entry-delete',
    collection: 'customGroups',
    value: 'Alpha',
  }], BASE_TIME + 2);
  const entry = deleted.stringCollections.customGroups.entries.Alpha;
  const materialized = materializeConvergentSyncState(deleted);

  assert.equal(entry.position?.candidates.length, 2);
  assert.deepEqual(materialized.stringCollections.customGroups, []);
  assert.deepEqual(materialized.conflicts, []);
});

test('unchanged string-entry adds do not advance the replica clock', () => {
  const initial = applyConvergentMutations(createConvergentSyncState(), 'device-a', [{
    kind: 'string-entry-add',
    collection: 'customGroups',
    value: 'Alpha',
    position: 0,
  }], BASE_TIME);
  const unchanged = applyConvergentMutations(initial, 'device-a', [{
    kind: 'string-entry-add',
    collection: 'customGroups',
    value: 'Alpha',
    position: 0,
  }], BASE_TIME + 1);

  assert.equal(
    serializeConvergentSyncState(unchanged),
    serializeConvergentSyncState(initial),
  );
});

test('unobserved string-entry deletes are no-ops and do not conflict with concurrent adds', () => {
  const empty = createConvergentSyncState();
  const deleted = applyConvergentMutations(empty, 'device-a', [{
    kind: 'string-entry-delete',
    collection: 'customGroups',
    value: 'Alpha',
  }], BASE_TIME);
  const added = applyConvergentMutations(empty, 'device-b', [{
    kind: 'string-entry-add',
    collection: 'customGroups',
    value: 'Alpha',
  }], BASE_TIME);
  const merged = materializeConvergentSyncState(
    mergeConvergentSyncStates(deleted, added),
  );

  assert.equal(
    serializeConvergentSyncState(deleted),
    serializeConvergentSyncState(empty),
  );
  assert.deepEqual(merged.stringCollections.customGroups, ['Alpha']);
  assert.equal(merged.conflicts.length, 0);
});

test('string-entry deletes dominate a currently visible add/tombstone conflict', () => {
  const seeded = applyConvergentMutations(createConvergentSyncState(), 'seed', [{
    kind: 'string-entry-add',
    collection: 'customGroups',
    value: 'Alpha',
  }], BASE_TIME);
  const removed = applyConvergentMutations(seeded, 'device-a', [{
    kind: 'string-entry-delete',
    collection: 'customGroups',
    value: 'Alpha',
  }], BASE_TIME + 1);
  const concurrentAdd = applyConvergentMutations(createConvergentSyncState(), 'device-b', [{
    kind: 'string-entry-add',
    collection: 'customGroups',
    value: 'Alpha',
  }], BASE_TIME + 1);
  const conflicted = mergeConvergentSyncStates(removed, concurrentAdd);
  const resolved = applyConvergentMutations(conflicted, 'device-c', [{
    kind: 'string-entry-delete',
    collection: 'customGroups',
    value: 'Alpha',
  }], BASE_TIME + 2);
  const materialized = materializeConvergentSyncState(resolved);

  assert.deepEqual(materialized.stringCollections.customGroups, []);
  assert.equal(materialized.conflicts.length, 0);
});

test('repeated string-entry deletes do not advance the replica clock', () => {
  const added = applyConvergentMutations(createConvergentSyncState(), 'device-a', [{
    kind: 'string-entry-add',
    collection: 'customGroups',
    value: 'Alpha',
  }], BASE_TIME);
  const deleted = applyConvergentMutations(added, 'device-a', [{
    kind: 'string-entry-delete',
    collection: 'customGroups',
    value: 'Alpha',
  }], BASE_TIME + 1);
  const repeated = applyConvergentMutations(deleted, 'device-a', [{
    kind: 'string-entry-delete',
    collection: 'customGroups',
    value: 'Alpha',
  }], BASE_TIME + 2);

  assert.equal(
    serializeConvergentSyncState(repeated),
    serializeConvergentSyncState(deleted),
  );
});

test('settings are leaf registers while arrays remain atomic values', () => {
  const state = applyConvergentMutations(createConvergentSyncState(), 'device-a', [
    { kind: 'setting-set', path: ['terminal', 'fontSize'], value: 14 },
    { kind: 'setting-set', path: ['terminal', 'fallbackFonts'], value: ['A', 'B'] },
    { kind: 'setting-set', path: ['key/with~escapes'], value: true },
  ], BASE_TIME);

  assert.deepEqual(materializeConvergentSyncState(state).settings, {
    'key/with~escapes': true,
    terminal: {
      fallbackFonts: ['A', 'B'],
      fontSize: 14,
    },
  });
  assert.equal(encodeSettingPath(['key/with~escapes']), '/key~1with~0escapes');
  assert.deepEqual(decodeSettingPath('/key~1with~0escapes'), ['key/with~escapes']);
});

test('unchanged setting writes do not advance the replica clock', () => {
  const initial = applyConvergentMutations(createConvergentSyncState(), 'device-a', [{
    kind: 'setting-set',
    path: ['theme'],
    value: 'dark',
  }], BASE_TIME);
  const unchanged = applyConvergentMutations(initial, 'device-a', [{
    kind: 'setting-set',
    path: ['theme'],
    value: 'dark',
  }], BASE_TIME + 1);

  assert.equal(
    serializeConvergentSyncState(unchanged),
    serializeConvergentSyncState(initial),
  );
});

test('setting writes matching the selected conflict candidate still resolve the conflict', () => {
  const dark = applyConvergentMutations(createConvergentSyncState(), 'device-z', [{
    kind: 'setting-set',
    path: ['theme'],
    value: 'dark',
  }], BASE_TIME);
  const light = applyConvergentMutations(createConvergentSyncState(), 'device-a', [{
    kind: 'setting-set',
    path: ['theme'],
    value: 'light',
  }], BASE_TIME);
  const conflicted = mergeConvergentSyncStates(dark, light);
  const resolved = applyConvergentMutations(conflicted, 'resolver', [{
    kind: 'setting-set',
    path: ['theme'],
    value: 'dark',
  }], BASE_TIME + 1);
  const materialized = materializeConvergentSyncState(resolved);

  assert.equal(materialized.settings.theme, 'dark');
  assert.equal(materialized.conflicts.length, 0);
  assert.equal(resolved.vector.resolver, 1);
});

test('unchanged setting writes still tombstone overlapping active paths', () => {
  const parent = applyConvergentMutations(createConvergentSyncState(), 'device-a', [{
    kind: 'setting-set',
    path: ['terminal'],
    value: 'atomic',
  }], BASE_TIME);
  const child = applyConvergentMutations(createConvergentSyncState(), 'device-z', [{
    kind: 'setting-set',
    path: ['terminal', 'fontSize'],
    value: 14,
  }], BASE_TIME);
  const conflicted = mergeConvergentSyncStates(parent, child);
  const normalized = applyConvergentMutations(conflicted, 'resolver', [{
    kind: 'setting-set',
    path: ['terminal', 'fontSize'],
    value: 14,
  }], BASE_TIME + 1);
  const materialized = materializeConvergentSyncState(normalized);

  assert.deepEqual(materialized.settings, { terminal: { fontSize: 14 } });
  assert.equal(materialized.conflicts.length, 0);
  assert.equal(normalized.vector.resolver, 1);
  assert.deepEqual(
    normalized.settings['/terminal/fontSize'].candidates[0]?.dot,
    child.settings['/terminal/fontSize'].candidates[0]?.dot,
  );
});

test('repeated setting deletes do not advance the replica clock', () => {
  const initial = applyConvergentMutations(createConvergentSyncState(), 'device-a', [{
    kind: 'setting-set',
    path: ['theme'],
    value: 'dark',
  }], BASE_TIME);
  const deleted = applyConvergentMutations(initial, 'device-a', [{
    kind: 'setting-delete',
    path: ['theme'],
  }], BASE_TIME + 1);
  const repeated = applyConvergentMutations(deleted, 'device-a', [{
    kind: 'setting-delete',
    path: ['theme'],
  }], BASE_TIME + 2);

  assert.equal(
    serializeConvergentSyncState(repeated),
    serializeConvergentSyncState(deleted),
  );
});

test('causal setting shape changes tombstone overlapping leaf paths', () => {
  const nested = applyConvergentMutations(createConvergentSyncState(), 'device-a', [
    { kind: 'setting-set', path: ['terminal'], value: ['atomic'] },
    { kind: 'setting-set', path: ['terminal', 'fontSize'], value: 14 },
  ], BASE_TIME);
  const atomic = applyConvergentMutations(nested, 'device-a', [{
    kind: 'setting-set',
    path: ['terminal'],
    value: ['replacement'],
  }], BASE_TIME + 1);

  assert.deepEqual(materializeConvergentSyncState(nested).settings, {
    terminal: { fontSize: 14 },
  });
  assert.deepEqual(materializeConvergentSyncState(atomic).settings, {
    terminal: ['replacement'],
  });
  assert.equal(
    atomic.settings['/terminal/fontSize'].candidates[0]?.tombstone,
    true,
  );
});

test('causal setting deletion tombstones the complete subtree', () => {
  const nested = applyConvergentMutations(createConvergentSyncState(), 'device-a', [
    { kind: 'setting-set', path: ['terminal', 'fontSize'], value: 14 },
    { kind: 'setting-set', path: ['terminal', 'fontFamily'], value: 'Mono' },
    { kind: 'setting-set', path: ['theme'], value: 'dark' },
  ], BASE_TIME);
  const deleted = applyConvergentMutations(nested, 'device-a', [{
    kind: 'setting-delete',
    path: ['terminal'],
  }], BASE_TIME + 1);

  assert.deepEqual(materializeConvergentSyncState(deleted).settings, {
    theme: 'dark',
  });
  assert.equal(deleted.settings['/terminal'].candidates[0]?.tombstone, true);
  assert.equal(
    deleted.settings['/terminal/fontFamily'].candidates[0]?.tombstone,
    true,
  );
  assert.equal(
    deleted.settings['/terminal/fontSize'].candidates[0]?.tombstone,
    true,
  );
  assert.deepEqual(
    materializeConvergentSyncState(
      mergeConvergentSyncStates(nested, deleted),
    ).settings,
    { theme: 'dark' },
  );
});

test('concurrent subtree deletion and descendant update remain a conflict', () => {
  const base = applyConvergentMutations(createConvergentSyncState(), 'seed', [{
    kind: 'setting-set',
    path: ['terminal', 'fontSize'],
    value: 14,
  }], BASE_TIME);
  const deleted = applyConvergentMutations(base, 'device-a', [{
    kind: 'setting-delete',
    path: ['terminal'],
  }], BASE_TIME + 1);
  const updated = applyConvergentMutations(base, 'device-b', [{
    kind: 'setting-set',
    path: ['terminal', 'fontSize'],
    value: 16,
  }], BASE_TIME + 1);

  const materialized = materializeConvergentSyncState(
    mergeConvergentSyncStates(deleted, updated),
  );
  const conflict = materialized.conflicts.find(
    (item) => item.address.kind === 'setting'
      && item.address.path.join('/') === 'terminal/fontSize',
  );

  assert.deepEqual(materialized.settings, { terminal: { fontSize: 16 } });
  assert.equal(conflict?.candidates.length, 2);
  assert.equal(
    conflict?.candidates.some((candidate) => candidate.tombstone),
    true,
  );
});

test('concurrent setting shape changes materialize deterministically and remain resolvable', () => {
  const parent = applyConvergentMutations(createConvergentSyncState(), 'device-a', [{
    kind: 'setting-set',
    path: ['terminal'],
    value: ['atomic'],
  }], BASE_TIME);
  const child = applyConvergentMutations(createConvergentSyncState(), 'device-z', [{
    kind: 'setting-set',
    path: ['terminal', 'fontSize'],
    value: 14,
  }], BASE_TIME);
  const merged = mergeConvergentSyncStates(parent, child);
  const materialized = materializeConvergentSyncState(merged);
  const structureConflict = materialized.conflicts.find(
    (conflict) => conflict.address.kind === 'setting-structure',
  );

  assert.deepEqual(materialized.settings, { terminal: { fontSize: 14 } });
  assert.deepEqual(
    structureConflict?.address.kind === 'setting-structure'
      ? structureConflict.address.paths
      : [],
    [['terminal'], ['terminal', 'fontSize']],
  );
  assert.equal(structureConflict?.candidates.length, 2);
  assert.deepEqual(
    structureConflict?.candidates.filter((candidate) => candidate.selected)
      .map((candidate) => candidate.settingPath),
    [['terminal', 'fontSize']],
  );

  const resolved = applyConvergentMutations(merged, 'resolver', [{
    kind: 'resolve-register',
    address: { kind: 'setting', path: ['terminal'] },
    value: ['reviewed'],
  }], BASE_TIME + 1);
  const resolvedMaterialized = materializeConvergentSyncState(resolved);
  assert.deepEqual(resolvedMaterialized.settings, { terminal: ['reviewed'] });
  assert.equal(
    resolvedMaterialized.conflicts.some(
      (conflict) => conflict.address.kind === 'setting-structure',
    ),
    false,
  );
});

test('setting structure selection keeps non-overlapping siblings', () => {
  const parent = applyConvergentMutations(createConvergentSyncState(), 'device-a', [{
    kind: 'setting-set',
    path: ['terminal'],
    value: 'atomic',
  }], BASE_TIME);
  const children = applyConvergentMutations(createConvergentSyncState(), 'device-z', [
    { kind: 'setting-set', path: ['terminal', 'fontSize'], value: 14 },
    { kind: 'setting-set', path: ['terminal', 'fontFamily'], value: 'Mono' },
  ], BASE_TIME);

  assert.deepEqual(
    materializeConvergentSyncState(mergeConvergentSyncStates(parent, children)).settings,
    { terminal: { fontFamily: 'Mono', fontSize: 14 } },
  );
});

test('canonical serialization is stable and hydration validates the state', () => {
  const first = applyConvergentMutations(createConvergentSyncState(), 'device-a', [
    { kind: 'setting-set', path: ['z'], value: { b: 2, a: 1 } },
    { kind: 'setting-set', path: ['a'], value: ['x'] },
  ], BASE_TIME);
  const second = hydrateConvergentSyncState(serializeConvergentSyncState(first));

  assert.equal(serializeConvergentSyncState(first), serializeConvergentSyncState(second));
  assert.throws(
    () => hydrateConvergentSyncState('{"schemaVersion":3}'),
    ConvergentSyncInvariantError,
  );
});

test('validation rejects vector counters without a retained causal witness', () => {
  const local = applyConvergentMutations(createConvergentSyncState(), 'device-a', [{
    kind: 'setting-set',
    path: ['theme'],
    value: 'dark',
  }], BASE_TIME);
  const missingCandidate = createConvergentSyncState();
  missingCandidate.vector['device-a'] = 1;
  missingCandidate.dotOrigins['device-a'] = {
    1: registerId({ kind: 'setting', path: ['theme'] }),
  };
  const inflatedVector = JSON.parse(
    serializeConvergentSyncState(local),
  ) as ConvergentSyncStateV2;
  inflatedVector.vector['device-a'] = 2;
  inflatedVector.dotOrigins['device-a']['2'] = registerId({
    kind: 'setting',
    path: ['theme'],
  });

  assert.throws(
    () => hydrateConvergentSyncState(JSON.stringify(missingCandidate)),
    /vector\.device-a is not witnessed/,
  );
  assert.throws(
    () => mergeConvergentSyncStates(local, missingCandidate),
    /vector\.device-a is not witnessed/,
  );
  assert.throws(
    () => hydrateConvergentSyncState(JSON.stringify(inflatedVector)),
    /vector\.device-a is not witnessed/,
  );
});

test('candidate context can witness causally dominated vector counters', () => {
  const first = applyConvergentMutations(createConvergentSyncState(), 'device-a', [{
    kind: 'setting-set',
    path: ['theme'],
    value: 'dark',
  }], BASE_TIME);
  const overwritten = applyConvergentMutations(first, 'device-b', [{
    kind: 'setting-set',
    path: ['theme'],
    value: 'light',
  }], BASE_TIME + 1);

  assert.deepEqual(overwritten.settings['/theme'].candidates[0]?.context, [{
    deviceId: 'device-a',
    counter: 1,
  }]);
  assert.deepEqual(
    hydrateConvergentSyncState(serializeConvergentSyncState(overwritten)),
    overwritten,
  );
});

test('unrelated register context cannot witness an omitted register', () => {
  const local = applyConvergentMutations(createConvergentSyncState(), 'device-a', [{
    kind: 'setting-set',
    path: ['theme'],
    value: 'dark',
  }], BASE_TIME);
  const remote = applyConvergentMutations(local, 'device-b', [{
    kind: 'setting-set',
    path: ['terminal', 'fontSize'],
    value: 14,
  }], BASE_TIME + 1);
  delete remote.settings['/theme'];

  assert.deepEqual(
    remote.settings['/terminal/fontSize'].candidates[0]?.context,
    [],
  );
  assert.throws(
    () => hydrateConvergentSyncState(JSON.stringify(remote)),
    /vector\.device-a is not witnessed/,
  );
  assert.throws(
    () => mergeConvergentSyncStates(local, remote),
    /vector\.device-a is not witnessed/,
  );
});

test('copied cross-register context cannot witness an omitted register', () => {
  const state = applyConvergentMutations(createConvergentSyncState(), 'device-a', [
    { kind: 'setting-set', path: ['theme'], value: 'dark' },
    { kind: 'setting-set', path: ['terminal', 'fontSize'], value: 14 },
  ], BASE_TIME);
  const corrupted = JSON.parse(
    serializeConvergentSyncState(state),
  ) as ConvergentSyncStateV2;
  const omittedDot = { ...corrupted.settings['/theme'].candidates[0].dot };
  delete corrupted.settings['/theme'];
  corrupted.settings['/terminal/fontSize'].candidates[0].context = [omittedDot];

  assert.throws(
    () => hydrateConvergentSyncState(JSON.stringify(corrupted)),
    /context\[0\] is assigned to a different register origin/,
  );
  assert.throws(
    () => mergeConvergentSyncStates(state, corrupted),
    /context\[0\] is assigned to a different register origin/,
  );
});

test('exact contexts detect missing dots between writes to the same register', () => {
  const state = applyConvergentMutations(createConvergentSyncState(), 'device-a', [
    { kind: 'setting-set', path: ['theme'], value: 'dark' },
    { kind: 'setting-set', path: ['terminal', 'fontSize'], value: 14 },
    { kind: 'setting-set', path: ['theme'], value: 'light' },
  ], BASE_TIME);
  const partial = JSON.parse(
    serializeConvergentSyncState(state),
  ) as ConvergentSyncStateV2;
  delete partial.settings['/terminal/fontSize'];

  assert.deepEqual(state.settings['/theme'].candidates[0]?.context, [{
    deviceId: 'device-a',
    counter: 1,
  }]);
  assert.throws(
    () => hydrateConvergentSyncState(JSON.stringify(partial)),
    /vector\.device-a is not witnessed/,
  );
});

test('validation rejects a context dot retained in another register', () => {
  const state = applyConvergentMutations(createConvergentSyncState(), 'device-a', [
    { kind: 'setting-set', path: ['theme'], value: 'dark' },
    { kind: 'setting-set', path: ['terminal', 'fontSize'], value: 14 },
  ], BASE_TIME);
  const corrupted = JSON.parse(
    serializeConvergentSyncState(state),
  ) as ConvergentSyncStateV2;
  corrupted.settings['/terminal/fontSize'].candidates[0].context = [{
    ...corrupted.settings['/theme'].candidates[0].dot,
  }];

  assert.throws(
    () => hydrateConvergentSyncState(JSON.stringify(corrupted)),
    /context\[0\] is assigned to a different register origin/,
  );
});

test('validation rejects causal cycles between retained candidates', () => {
  const left = applyConvergentMutations(createConvergentSyncState(), 'device-a', [{
    kind: 'setting-set',
    path: ['theme'],
    value: 'left',
  }], BASE_TIME);
  const right = applyConvergentMutations(createConvergentSyncState(), 'device-b', [{
    kind: 'setting-set',
    path: ['theme'],
    value: 'right',
  }], BASE_TIME);
  const corrupted = mergeConvergentSyncStates(left, right);
  const [first, second] = corrupted.settings['/theme'].candidates;
  first.context = [{ ...second.dot }];
  second.context = [{ ...first.dot }];

  assert.throws(
    () => hydrateConvergentSyncState(JSON.stringify(corrupted)),
    /references candidate dot device-b:1 retained in the same register/,
  );
  assert.throws(
    () => mergeConvergentSyncStates(corrupted, corrupted),
    /references candidate dot device-b:1 retained in the same register/,
  );
});

test('candidate ordering uses locale-independent code-unit comparison', () => {
  const ascii = applyConvergentMutations(createConvergentSyncState(), 'device-z', [{
    kind: 'setting-set',
    path: ['theme'],
    value: 'ascii',
  }], BASE_TIME);
  const nonAscii = applyConvergentMutations(createConvergentSyncState(), 'device-ä', [{
    kind: 'setting-set',
    path: ['theme'],
    value: 'non-ascii',
  }], BASE_TIME);
  const merged = mergeConvergentSyncStates(ascii, nonAscii);

  assert.deepEqual(
    merged.settings['/theme'].candidates.map((candidate) => candidate.dot.deviceId),
    ['device-z', 'device-ä'],
  );
  assert.equal(materializeConvergentSyncState(merged).settings.theme, 'non-ascii');
});

test('candidate metadata key order cannot change canonical serialization or merge identity', () => {
  const first = applyConvergentMutations(createConvergentSyncState(), 'device-a', [{
    kind: 'setting-set',
    path: ['theme'],
    value: 'dark',
  }], BASE_TIME);
  const state = applyConvergentMutations(first, 'device-b', [{
    kind: 'setting-set',
    path: ['theme'],
    value: 'light',
  }], BASE_TIME + 1);
  const reordered = JSON.parse(
    serializeConvergentSyncState(state),
  ) as ConvergentSyncStateV2;
  const candidate = reordered.settings['/theme'].candidates[0];
  candidate.dot = {
    counter: candidate.dot.counter,
    deviceId: candidate.dot.deviceId,
  };
  candidate.hlc = {
    logical: candidate.hlc.logical,
    wallTime: candidate.hlc.wallTime,
  };
  candidate.context[0] = {
    counter: candidate.context[0].counter,
    deviceId: candidate.context[0].deviceId,
  };
  reordered.hlc = {
    logical: reordered.hlc.logical,
    wallTime: reordered.hlc.wallTime,
  };

  assert.equal(
    serializeConvergentSyncState(reordered),
    serializeConvergentSyncState(state),
  );
  assert.equal(
    serializeConvergentSyncState(mergeConvergentSyncStates(state, reordered)),
    serializeConvergentSyncState(state),
  );
});

test('device counters are monotonic across different register kinds', () => {
  const state = applyConvergentMutations(createConvergentSyncState(), 'device-a', [
    {
      kind: 'entity-field-set',
      collection: 'hosts',
      entityId: 'host-1',
      field: 'label',
      value: 'Host',
    },
    { kind: 'setting-set', path: ['theme'], value: 'dark' },
    { kind: 'string-entry-add', collection: 'customGroups', value: 'prod' },
  ], BASE_TIME);
  const counters = [
    state.collections.hosts.entities['host-1'].fields.label.candidates[0].dot.counter,
    state.collections.hosts.entities['host-1'].presence.candidates[0].dot.counter,
    state.settings['/theme'].candidates[0].dot.counter,
    state.stringCollections.customGroups.entries.prod.presence.candidates[0].dot.counter,
  ];

  assert.deepEqual(counters, [1, 2, 3, 4]);
  assert.equal(state.vector['device-a'], 4);
});

test('hydration fails closed when a dot is reused by two registers', () => {
  const state = applyConvergentMutations(createConvergentSyncState(), 'device-a', [
    { kind: 'setting-set', path: ['a'], value: 1 },
    { kind: 'setting-set', path: ['b'], value: 2 },
  ], BASE_TIME);
  const corrupted = JSON.parse(
    serializeConvergentSyncState(state),
  ) as ConvergentSyncStateV2;
  corrupted.settings['/b'].candidates[0].dot = {
    ...corrupted.settings['/a'].candidates[0].dot,
  };
  corrupted.settings['/b'].candidates[0].context =
    corrupted.settings['/a'].candidates[0].context.map((dot) => ({ ...dot }));

  assert.throws(
    () => hydrateConvergentSyncState(JSON.stringify(corrupted)),
    /dot is assigned to a different register origin/,
  );
});

test('merge rejects the same dot allocated to different register origins', () => {
  const left = applyConvergentMutations(createConvergentSyncState(), 'device-a', [{
    kind: 'setting-set',
    path: ['theme'],
    value: 'dark',
  }], BASE_TIME);
  const right = applyConvergentMutations(createConvergentSyncState(), 'device-a', [{
    kind: 'setting-set',
    path: ['terminal', 'fontSize'],
    value: 14,
  }], BASE_TIME);

  assert.throws(
    () => mergeConvergentSyncStates(left, right),
    /Dot origin mismatch/,
  );
});

test('record identifiers cannot escape into the object prototype chain', () => {
  const state = applyConvergentMutations(createConvergentSyncState(), '__proto__', [
    {
      kind: 'entity-field-set',
      collection: 'constructor',
      entityId: '__proto__',
      field: 'constructor',
      value: 'safe',
    },
    { kind: 'setting-set', path: ['__proto__'], value: 'safe-setting' },
    {
      kind: 'string-entry-add',
      collection: '__proto__',
      value: 'constructor',
    },
  ], BASE_TIME);
  const materialized = materializeConvergentSyncState(state);

  assert.equal(Object.hasOwn(state.vector, '__proto__'), true);
  assert.equal(materialized.collections.constructor[0]?.constructor, 'safe');
  assert.equal(materialized.settings.__proto__, 'safe-setting');
  assert.deepEqual(materialized.stringCollections.__proto__, ['constructor']);
  assert.equal(Object.getPrototypeOf(materialized.settings), Object.prototype);
});

test('HLC stays monotonic when wall time moves backwards', () => {
  const first = tickHybridLogicalClock({ wallTime: 100, logical: 4 }, 90);
  const second = tickHybridLogicalClock(first, 100);
  const third = tickHybridLogicalClock(second, 101);

  assert.deepEqual(first, { wallTime: 100, logical: 5 });
  assert.deepEqual(second, { wallTime: 100, logical: 6 });
  assert.deepEqual(third, { wallTime: 101, logical: 0 });
});
