import type { SyncPayload } from '../sync';
import { normalizeJsonValue } from './json';
import { encodeSettingPath } from './serialization';
import { applyConvergentMutations } from './state';
import type {
  ConvergentMutation,
  ConvergentSyncStateV2,
  JsonValue,
} from './types';
import {
  CONVERGENT_ENTITY_COLLECTIONS,
  CONVERGENT_STRING_COLLECTIONS,
} from './payload';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function fingerprint(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function hasDefinedOwnProperty(payload: SyncPayload, property: string): boolean {
  const record = payload as unknown as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, property)
    && record[property] !== undefined;
}

/** Preserve fields that an older client did not provide for safety checks. */
export function inheritOmittedLegacySyncFields(
  baseline: SyncPayload,
  legacy: SyncPayload,
): SyncPayload {
  const result = { ...legacy } as SyncPayload;
  const resultRecord = result as unknown as Record<string, unknown>;
  const baselineRecord = baseline as unknown as Record<string, unknown>;
  for (const property of [
    ...CONVERGENT_ENTITY_COLLECTIONS,
    ...CONVERGENT_STRING_COLLECTIONS,
    'settings',
  ]) {
    if (!hasDefinedOwnProperty(legacy, property)) {
      resultRecord[property] = baselineRecord[property];
    }
  }
  return result;
}

function normalizedEntityValue(
  collection: string,
  id: string,
  value: Record<string, unknown>,
): Extract<ConvergentMutation, { kind: 'entity-upsert' }>['value'] {
  try {
    const normalized = normalizeJsonValue({ ...value, id });
    if (!isRecord(normalized)) throw new TypeError('Entity is not an object');
    return normalized as Extract<ConvergentMutation, { kind: 'entity-upsert' }>['value'];
  } catch {
    throw new Error(`${collection}/${id} contains a value that cannot be represented as JSON`);
  }
}

function entityId(collection: string, value: Record<string, unknown>): string | undefined {
  const id = collection === 'groupConfigs' ? value.path : value.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function entityMap(payload: SyncPayload, collection: string): Map<string, Record<string, unknown>> {
  const values = (payload as unknown as Record<string, unknown>)[collection];
  const result = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(values)) return result;
  for (const value of values) {
    if (!isRecord(value)) continue;
    const id = entityId(collection, value);
    if (id) result.set(id, value);
  }
  return result;
}

function stringSet(payload: SyncPayload, collection: string): Set<string> {
  const values = (payload as unknown as Record<string, unknown>)[collection];
  return new Set(Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : []);
}

function positionMap(values: Iterable<string>): Map<string, number> {
  const positions = new Map<string, number>();
  let position = 0;
  for (const value of values) {
    positions.set(value, position);
    position += 1;
  }
  return positions;
}

function flattenSettings(
  value: unknown,
  path: string[] = [],
  output: Map<string, { path: string[]; value: JsonValue }> = new Map(),
): Map<string, { path: string[]; value: JsonValue }> {
  if (isRecord(value) && Object.keys(value).length > 0) {
    for (const key of Object.keys(value).sort()) {
      flattenSettings(value[key], [...path, key], output);
    }
  } else if (path.length > 0 && value !== undefined) {
    output.set(encodeSettingPath(path), { path, value: value as JsonValue });
  }
  return output;
}

/** Compare only cloud materialized data; timestamps and reliability metadata are transport details. */
export function cloudSyncPayloadsEqual(left: SyncPayload, right: SyncPayload): boolean {
  const project = (payload: SyncPayload) => ({
    ...Object.fromEntries(
      [...CONVERGENT_ENTITY_COLLECTIONS, ...CONVERGENT_STRING_COLLECTIONS]
        .map((key) => [key, (payload as unknown as Record<string, unknown>)[key] ?? []]),
    ),
    settings: payload.settings ?? {},
  });
  return fingerprint(project(left)) === fingerprint(project(right));
}

/**
 * Convert a trusted v1 baseline diff into deterministic CRDT writes. A missing
 * or undefined optional top-level collection is treated as "unsupported by
 * that client", while an explicitly present empty collection is a real
 * deletion.
 */
export function diffLegacySyncPayload(
  baseline: SyncPayload,
  legacy: SyncPayload,
): ConvergentMutation[] {
  const mutations: ConvergentMutation[] = [];
  for (const collection of CONVERGENT_ENTITY_COLLECTIONS) {
    if (!hasDefinedOwnProperty(legacy, collection)) continue;
    const before = entityMap(baseline, collection);
    const after = entityMap(legacy, collection);
    const beforePositions = positionMap(before.keys());
    const afterPositions = positionMap(after.keys());
    const ids = new Set([...before.keys(), ...after.keys()]);
    for (const id of [...ids].sort()) {
      const previous = before.get(id);
      const next = after.get(id);
      if (previous && !next) {
        mutations.push({ kind: 'entity-delete', collection, entityId: id });
      } else if (
        next
        && (
          !previous
          || fingerprint(previous) !== fingerprint(next)
          || beforePositions.get(id) !== afterPositions.get(id)
        )
      ) {
        mutations.push({
          kind: 'entity-upsert',
          collection,
          entityId: id,
          value: normalizedEntityValue(collection, id, next),
          position: afterPositions.get(id),
        });
      }
    }
  }
  for (const collection of CONVERGENT_STRING_COLLECTIONS) {
    if (!hasDefinedOwnProperty(legacy, collection)) continue;
    const before = stringSet(baseline, collection);
    const after = stringSet(legacy, collection);
    const beforePositions = positionMap(before);
    const afterPositions = positionMap(after);
    for (const value of [...before].sort()) {
      if (!after.has(value)) mutations.push({ kind: 'string-entry-delete', collection, value });
    }
    for (const value of [...after].sort()) {
      if (!before.has(value) || beforePositions.get(value) !== afterPositions.get(value)) {
        mutations.push({
          kind: 'string-entry-add',
          collection,
          value,
          position: afterPositions.get(value),
        });
      }
    }
  }
  if (hasDefinedOwnProperty(legacy, 'settings')) {
    const before = flattenSettings(baseline.settings);
    const after = flattenSettings(legacy.settings);
    const paths = new Set([...before.keys(), ...after.keys()]);
    for (const encodedPath of [...paths].sort()) {
      const previous = before.get(encodedPath);
      const next = after.get(encodedPath);
      if (previous && !next) {
        mutations.push({ kind: 'setting-delete', path: previous.path });
      } else if (next && (!previous || fingerprint(previous.value) !== fingerprint(next.value))) {
        mutations.push({ kind: 'setting-set', path: next.path, value: next.value });
      }
    }
  }
  return mutations;
}

export function applyLegacySyncPayload(
  state: ConvergentSyncStateV2,
  baseline: SyncPayload,
  legacy: SyncPayload,
  syntheticDeviceId: string,
  now: number,
): ConvergentSyncStateV2 {
  return applyConvergentMutations(
    state,
    syntheticDeviceId,
    diffLegacySyncPayload(baseline, legacy),
    now,
  );
}
