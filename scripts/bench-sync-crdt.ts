import {
  applyConvergentMutations,
  createConvergentSyncState,
  mergeConvergentSyncStates,
  type ConvergentMutation,
} from '../domain/convergentSync/index.ts';

function elapsedMs<T>(operation: () => T): { value: T; duration: number } {
  const startedAt = performance.now();
  const value = operation();
  return { value, duration: performance.now() - startedAt };
}

function buildMutations(count: number): ConvergentMutation[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'entity-upsert' as const,
    collection: 'hosts',
    entityId: `host-${index.toString().padStart(5, '0')}`,
    value: {
      id: `host-${index.toString().padStart(5, '0')}`,
      label: `Host ${index}`,
      hostname: `host-${index}.example.com`,
      tags: [`group-${index % 20}`],
    },
    position: index,
  }));
}

function run(size: number): void {
  const created = elapsedMs(() => applyConvergentMutations(
    createConvergentSyncState(),
    'seed',
    buildMutations(size),
    1_700_000_000_000,
  ));
  const left = applyConvergentMutations(created.value, 'device-a', [{
    kind: 'entity-field-set',
    collection: 'hosts',
    entityId: `host-${Math.floor(size / 3).toString().padStart(5, '0')}`,
    field: 'label',
    value: 'Edited on A',
  }], 1_700_000_000_001);
  const right = applyConvergentMutations(created.value, 'device-b', [{
    kind: 'entity-field-set',
    collection: 'hosts',
    entityId: `host-${Math.floor(size / 2).toString().padStart(5, '0')}`,
    field: 'hostname',
    value: 'edited.example.com',
  }], 1_700_000_000_001);
  const merged = elapsedMs(() => mergeConvergentSyncStates(left, right));

  console.log(JSON.stringify({
    entities: size,
    registers: Object.values(merged.value.collections.hosts.entities)
      .reduce((total, entity) => total + 1 + (entity.position ? 1 : 0)
        + Object.keys(entity.fields).length, 0),
    createMs: Number(created.duration.toFixed(2)),
    mergeMs: Number(merged.duration.toFixed(2)),
  }));
}

for (const size of [1_000, 5_000, 10_000]) run(size);
