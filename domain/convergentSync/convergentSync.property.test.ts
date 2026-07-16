import assert from 'node:assert/strict';
import test from 'node:test';

import fc from 'fast-check';

import {
  applyConvergentMutations,
  createConvergentSyncState,
  materializeConvergentSyncState,
  mergeConvergentSyncStates,
  serializeConvergentSyncState,
  type ConvergentMutation,
  type JsonValue,
} from './index.ts';

const jsonValueArbitrary: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.integer({ min: -1_000, max: 1_000 }),
  fc.boolean(),
  fc.array(fc.integer({ min: 0, max: 20 }), { maxLength: 5 }),
  fc.record({ enabled: fc.boolean(), label: fc.string({ maxLength: 10 }) }),
);

const settingPathArbitrary: fc.Arbitrary<string[]> = fc.constantFrom(
  'theme',
  'terminalRoot',
  'fontSize',
  'palette',
).map((value) => {
  if (value === 'theme') return ['theme'];
  if (value === 'terminalRoot') return ['terminal'];
  return ['terminal', value];
});

const mutationArbitrary: fc.Arbitrary<ConvergentMutation> = fc.oneof(
  fc.record({
    kind: fc.constant<'setting-set'>('setting-set'),
    path: settingPathArbitrary,
    value: jsonValueArbitrary,
  }),
  fc.record({
    kind: fc.constant<'setting-delete'>('setting-delete'),
    path: settingPathArbitrary,
  }),
  fc.record({
    kind: fc.constant<'entity-field-set'>('entity-field-set'),
    collection: fc.constant('hosts'),
    entityId: fc.constantFrom('host-0', 'host-1', 'host-2'),
    field: fc.constantFrom('label', 'hostname', 'tags'),
    value: jsonValueArbitrary,
  }),
  fc.record({
    kind: fc.constant<'entity-delete'>('entity-delete'),
    collection: fc.constant('hosts'),
    entityId: fc.constantFrom('host-0', 'host-1', 'host-2'),
  }),
  fc.record({
    kind: fc.constant<'string-entry-add'>('string-entry-add'),
    collection: fc.constant('customGroups'),
    value: fc.constantFrom('alpha', 'beta', 'gamma'),
    position: fc.integer({ min: 0, max: 10 }),
  }),
  fc.record({
    kind: fc.constant<'string-entry-delete'>('string-entry-delete'),
    collection: fc.constant('customGroups'),
    value: fc.constantFrom('alpha', 'beta', 'gamma'),
  }),
);

const mutationListArbitrary = fc.array(mutationArbitrary, { maxLength: 16 });

function replica(deviceId: string, mutations: ConvergentMutation[], time: number) {
  return applyConvergentMutations(
    createConvergentSyncState(),
    deviceId,
    mutations,
    time,
  );
}

test('merge is commutative', () => {
  fc.assert(fc.property(
    mutationListArbitrary,
    mutationListArbitrary,
    (leftMutations, rightMutations) => {
      const left = replica('device-a', leftMutations, 100);
      const right = replica('device-b', rightMutations, 100);
      const leftRight = mergeConvergentSyncStates(left, right);
      const rightLeft = mergeConvergentSyncStates(right, left);
      assert.equal(
        serializeConvergentSyncState(leftRight),
        serializeConvergentSyncState(rightLeft),
      );
      assert.deepEqual(
        materializeConvergentSyncState(leftRight),
        materializeConvergentSyncState(rightLeft),
      );
    },
  ), { numRuns: 150 });
});

test('merge is associative', () => {
  fc.assert(fc.property(
    mutationListArbitrary,
    mutationListArbitrary,
    mutationListArbitrary,
    (aMutations, bMutations, cMutations) => {
      const a = replica('device-a', aMutations, 100);
      const b = replica('device-b', bMutations, 100);
      const c = replica('device-c', cMutations, 100);
      const leftGrouped = mergeConvergentSyncStates(
        mergeConvergentSyncStates(a, b),
        c,
      );
      const rightGrouped = mergeConvergentSyncStates(
        a,
        mergeConvergentSyncStates(b, c),
      );
      assert.equal(
        serializeConvergentSyncState(leftGrouped),
        serializeConvergentSyncState(rightGrouped),
      );
    },
  ), { numRuns: 120 });
});

test('merge is idempotent', () => {
  fc.assert(fc.property(mutationListArbitrary, (mutations) => {
    const state = replica('device-a', mutations, 100);
    assert.equal(
      serializeConvergentSyncState(mergeConvergentSyncStates(state, state)),
      serializeConvergentSyncState(state),
    );
  }), { numRuns: 150 });
});

test('causal parent deletion removes every generated descendant', () => {
  fc.assert(fc.property(
    fc.array(
      fc.tuple(
        fc.constantFrom('fontSize', 'fontFamily', 'palette', 'cursor'),
        jsonValueArbitrary,
      ),
      { minLength: 1, maxLength: 12 },
    ),
    (leaves) => {
      const populated = applyConvergentMutations(
        createConvergentSyncState(),
        'device-a',
        leaves.map(([leaf, value]) => ({
          kind: 'setting-set' as const,
          path: ['terminal', leaf],
          value,
        })),
        100,
      );
      const deleted = applyConvergentMutations(populated, 'device-a', [{
        kind: 'setting-delete',
        path: ['terminal'],
      }], 101);

      assert.equal(
        Object.hasOwn(materializeConvergentSyncState(deleted).settings, 'terminal'),
        false,
      );
      assert.equal(
        Object.hasOwn(
          materializeConvergentSyncState(
            mergeConvergentSyncStates(populated, deleted),
          ).settings,
          'terminal',
        ),
        false,
      );
    },
  ), { numRuns: 100 });
});

test('2-20 offline replicas converge across reordering, partitions, and duplicates', () => {
  fc.assert(fc.property(
    fc.array(mutationListArbitrary, { minLength: 2, maxLength: 20 }),
    fc.array(fc.integer(), { minLength: 20, maxLength: 20 }),
    (replicaMutations, orderKeys) => {
      const replicas = replicaMutations.map((mutations, index) =>
        replica(`device-${index.toString().padStart(2, '0')}`, mutations, 100 + index),
      );
      const baseline = replicas.reduce(mergeConvergentSyncStates);
      const order = replicas
        .map((state, index) => ({ state, key: orderKeys[index] ?? index }))
        .sort((left, right) => left.key - right.key)
        .map((item) => item.state);
      const reordered = order.reduce(mergeConvergentSyncStates);
      const split = Math.max(1, Math.floor(order.length / 2));
      const leftPartition = order.slice(0, split).reduce(mergeConvergentSyncStates);
      const rightPartition = order.slice(split).reduce(mergeConvergentSyncStates);
      const partitioned = mergeConvergentSyncStates(
        mergeConvergentSyncStates(leftPartition, leftPartition),
        mergeConvergentSyncStates(rightPartition, rightPartition),
      );

      assert.equal(
        serializeConvergentSyncState(reordered),
        serializeConvergentSyncState(baseline),
      );
      assert.equal(
        serializeConvergentSyncState(partitioned),
        serializeConvergentSyncState(baseline),
      );
    },
  ), { numRuns: 60 });
});
