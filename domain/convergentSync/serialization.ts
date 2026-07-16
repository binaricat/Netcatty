import {
  compareCandidatesByDot,
  isTombstoneCandidate,
} from './register';
import { compareHybridLogicalClocks, dotKey } from './clock';
import { canonicalizeJson, cloneJson, isJsonValue } from './json';
import { getOwnRecordValue } from './record';
import {
  ConvergentSyncInvariantError,
  type ConvergentCollectionState,
  type ConvergentEntityState,
  type ConvergentStringCollectionState,
  type ConvergentStringEntryState,
  type ConvergentSyncStateV2,
  type JsonValue,
  type MultiValueRegister,
  type RegisterCandidate,
  type VersionVector,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ConvergentSyncInvariantError(`${label} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ConvergentSyncInvariantError(`${label} must be a positive integer`);
  }
}

function assertNonEmptyKey(value: string, label: string): void {
  if (value.length === 0) {
    throw new ConvergentSyncInvariantError(`${label} must not be empty`);
  }
}

function assertVersionVector(value: unknown, label: string): asserts value is VersionVector {
  if (!isRecord(value)) {
    throw new ConvergentSyncInvariantError(`${label} must be an object`);
  }
  for (const [deviceId, counter] of Object.entries(value)) {
    assertNonEmptyKey(deviceId, `${label} device ID`);
    assertPositiveInteger(counter, `${label}.${deviceId}`);
  }
}

function assertClock(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new ConvergentSyncInvariantError(`${label} must be an object`);
  }
  assertNonNegativeInteger(value.wallTime, `${label}.wallTime`);
  assertNonNegativeInteger(value.logical, `${label}.logical`);
}

function assertCandidate(
  value: unknown,
  state: ConvergentSyncStateV2,
  label: string,
  globalDots: Map<string, string>,
): asserts value is RegisterCandidate {
  if (!isRecord(value) || !isRecord(value.dot)) {
    throw new ConvergentSyncInvariantError(`${label} must contain a dot`);
  }
  const deviceId = value.dot.deviceId;
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new ConvergentSyncInvariantError(`${label}.dot.deviceId must not be empty`);
  }
  assertPositiveInteger(value.dot.counter, `${label}.dot.counter`);
  if ((getOwnRecordValue(state.vector, deviceId) ?? 0) < value.dot.counter) {
    throw new ConvergentSyncInvariantError(`${label}.dot is not covered by the state vector`);
  }

  assertVersionVector(value.context, `${label}.context`);
  for (const [contextDeviceId, counter] of Object.entries(value.context)) {
    if ((getOwnRecordValue(state.vector, contextDeviceId) ?? 0) < counter) {
      throw new ConvergentSyncInvariantError(`${label}.context exceeds the state vector`);
    }
  }
  if ((getOwnRecordValue(value.context, deviceId) ?? 0) >= value.dot.counter) {
    throw new ConvergentSyncInvariantError(`${label}.context must precede its own dot`);
  }

  assertClock(value.hlc, `${label}.hlc`);
  const candidateClock = value.hlc as { wallTime: number; logical: number };
  if (compareHybridLogicalClocks(candidateClock, state.hlc) > 0) {
    throw new ConvergentSyncInvariantError(`${label}.hlc exceeds the state clock`);
  }

  if (
    value.tombstone !== undefined
    && value.tombstone !== false
    && value.tombstone !== true
  ) {
    throw new ConvergentSyncInvariantError(`${label}.tombstone must be a boolean`);
  }
  const tombstone = value.tombstone === true;
  if (!tombstone && !isJsonValue(value.value)) {
    throw new ConvergentSyncInvariantError(`${label}.value must be valid JSON`);
  }
  if (tombstone && Object.prototype.hasOwnProperty.call(value, 'value')) {
    throw new ConvergentSyncInvariantError(`${label} tombstones must not contain a value`);
  }

  const key = dotKey({ deviceId, counter: value.dot.counter });
  const previousAddress = globalDots.get(key);
  if (previousAddress) {
    throw new ConvergentSyncInvariantError(
      `Dot ${key} is reused by ${previousAddress} and ${label}`,
    );
  }
  globalDots.set(key, label);
}

function assertRegister(
  value: unknown,
  state: ConvergentSyncStateV2,
  label: string,
  globalDots: Map<string, string>,
  valueValidator?: (candidate: RegisterCandidate, label: string) => void,
): asserts value is MultiValueRegister {
  if (!isRecord(value) || !Array.isArray(value.candidates) || value.candidates.length === 0) {
    throw new ConvergentSyncInvariantError(`${label} must contain at least one candidate`);
  }
  value.candidates.forEach((candidate, index) => {
    const candidateLabel = `${label}.candidates[${index}]`;
    assertCandidate(candidate, state, candidateLabel, globalDots);
    valueValidator?.(candidate, candidateLabel);
  });
}

function assertPresenceCandidate(candidate: RegisterCandidate, label: string): void {
  if (!isTombstoneCandidate(candidate) && candidate.value !== true) {
    throw new ConvergentSyncInvariantError(`${label} presence values must be true`);
  }
}

function assertPositionCandidate(candidate: RegisterCandidate, label: string): void {
  if (
    !isTombstoneCandidate(candidate)
    && typeof candidate.value !== 'string'
    && typeof candidate.value !== 'number'
  ) {
    throw new ConvergentSyncInvariantError(`${label} position must be a string or number`);
  }
}

export function encodeSettingPath(path: string[]): string {
  if (path.length === 0 || path.some((segment) => segment.length === 0)) {
    throw new ConvergentSyncInvariantError('Setting paths require non-empty segments');
  }
  return `/${path.map((segment) => segment.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

export function decodeSettingPath(encoded: string): string[] {
  if (!encoded.startsWith('/') || encoded.length === 1) {
    throw new ConvergentSyncInvariantError(`Invalid encoded setting path: ${encoded}`);
  }
  const path = encoded.slice(1).split('/').map((segment) =>
    segment.replaceAll('~1', '/').replaceAll('~0', '~'),
  );
  if (encodeSettingPath(path) !== encoded) {
    throw new ConvergentSyncInvariantError(`Non-canonical setting path: ${encoded}`);
  }
  return path;
}

export function assertValidConvergentSyncState(
  value: unknown,
): asserts value is ConvergentSyncStateV2 {
  if (!isRecord(value) || value.schemaVersion !== 2) {
    throw new ConvergentSyncInvariantError('Expected convergent sync schema version 2');
  }
  assertVersionVector(value.vector, 'vector');
  assertClock(value.hlc, 'hlc');
  if (!isRecord(value.collections) || !isRecord(value.settings) || !isRecord(value.stringCollections)) {
    throw new ConvergentSyncInvariantError('Collections, settings, and stringCollections must be objects');
  }

  const state = value as unknown as ConvergentSyncStateV2;
  const globalDots = new Map<string, string>();
  for (const [collectionName, collection] of Object.entries(state.collections)) {
    assertNonEmptyKey(collectionName, 'Collection name');
    if (!isRecord(collection) || !isRecord(collection.entities)) {
      throw new ConvergentSyncInvariantError(`Collection ${collectionName} must contain entities`);
    }
    for (const [entityId, entity] of Object.entries(collection.entities)) {
      assertNonEmptyKey(entityId, `Entity ID in ${collectionName}`);
      if (!isRecord(entity) || !isRecord(entity.fields)) {
        throw new ConvergentSyncInvariantError(`Entity ${collectionName}/${entityId} is invalid`);
      }
      const entityLabel = `collections.${collectionName}.${entityId}`;
      assertRegister(entity.presence, state, `${entityLabel}.presence`, globalDots, assertPresenceCandidate);
      if (entity.position !== undefined) {
        assertRegister(entity.position, state, `${entityLabel}.position`, globalDots, assertPositionCandidate);
      }
      for (const [field, register] of Object.entries(entity.fields)) {
        assertNonEmptyKey(field, `${entityLabel} field`);
        if (field === 'id') {
          throw new ConvergentSyncInvariantError(`${entityLabel} must not store structural ID as a field`);
        }
        assertRegister(register, state, `${entityLabel}.fields.${field}`, globalDots);
      }
    }
  }

  for (const [encodedPath, register] of Object.entries(state.settings)) {
    decodeSettingPath(encodedPath);
    assertRegister(register, state, `settings.${encodedPath}`, globalDots);
  }

  for (const [collectionName, collection] of Object.entries(state.stringCollections)) {
    assertNonEmptyKey(collectionName, 'String collection name');
    if (!isRecord(collection) || !isRecord(collection.entries)) {
      throw new ConvergentSyncInvariantError(`String collection ${collectionName} must contain entries`);
    }
    for (const [entryValue, entry] of Object.entries(collection.entries)) {
      assertNonEmptyKey(entryValue, `Entry value in ${collectionName}`);
      if (!isRecord(entry)) {
        throw new ConvergentSyncInvariantError(`String entry ${collectionName}/${entryValue} is invalid`);
      }
      const entryLabel = `stringCollections.${collectionName}.${entryValue}`;
      assertRegister(entry.presence, state, `${entryLabel}.presence`, globalDots, assertPresenceCandidate);
      if (entry.position !== undefined) {
        assertRegister(entry.position, state, `${entryLabel}.position`, globalDots, assertPositionCandidate);
      }
    }
  }
}

function sortRecord<T>(record: Record<string, T>, clone: (value: T) => T): Record<string, T> {
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, clone(record[key])]),
  );
}

function canonicalCandidate<T extends JsonValue>(
  candidate: RegisterCandidate<T>,
): RegisterCandidate<T> {
  const base = {
    dot: {
      deviceId: candidate.dot.deviceId,
      counter: candidate.dot.counter,
    },
    context: sortRecord(candidate.context, (counter) => counter),
    hlc: {
      wallTime: candidate.hlc.wallTime,
      logical: candidate.hlc.logical,
    },
  };
  if (isTombstoneCandidate(candidate)) return { ...base, tombstone: true };
  return { ...base, value: canonicalizeJson(cloneJson(candidate.value)) };
}

function canonicalRegister<T extends JsonValue>(
  register: MultiValueRegister<T>,
): MultiValueRegister<T> {
  return {
    candidates: register.candidates
      .map(canonicalCandidate)
      .sort(compareCandidatesByDot),
  };
}

function canonicalEntity(entity: ConvergentEntityState): ConvergentEntityState {
  return {
    presence: canonicalRegister(entity.presence),
    ...(entity.position ? { position: canonicalRegister(entity.position) } : {}),
    fields: sortRecord(entity.fields, canonicalRegister),
  };
}

function canonicalCollection(collection: ConvergentCollectionState): ConvergentCollectionState {
  return { entities: sortRecord(collection.entities, canonicalEntity) };
}

function canonicalStringEntry(entry: ConvergentStringEntryState): ConvergentStringEntryState {
  return {
    presence: canonicalRegister(entry.presence),
    ...(entry.position ? { position: canonicalRegister(entry.position) } : {}),
  };
}

function canonicalStringCollection(
  collection: ConvergentStringCollectionState,
): ConvergentStringCollectionState {
  return { entries: sortRecord(collection.entries, canonicalStringEntry) };
}

export function canonicalizeConvergentSyncState(
  state: ConvergentSyncStateV2,
): ConvergentSyncStateV2 {
  assertValidConvergentSyncState(state);
  return {
    schemaVersion: 2,
    vector: sortRecord(state.vector, (counter) => counter),
    hlc: {
      wallTime: state.hlc.wallTime,
      logical: state.hlc.logical,
    },
    collections: sortRecord(state.collections, canonicalCollection),
    settings: sortRecord(state.settings, canonicalRegister),
    stringCollections: sortRecord(state.stringCollections, canonicalStringCollection),
  };
}

export function serializeConvergentSyncState(state: ConvergentSyncStateV2): string {
  return JSON.stringify(canonicalizeConvergentSyncState(state));
}

export function hydrateConvergentSyncState(serialized: string): ConvergentSyncStateV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new ConvergentSyncInvariantError(
      `Invalid convergent sync JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertValidConvergentSyncState(parsed);
  return canonicalizeConvergentSyncState(parsed);
}
