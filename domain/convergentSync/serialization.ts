import {
  compareCandidatesByDot,
  isTombstoneCandidate,
} from './register';
import { compareDots, compareHybridLogicalClocks, dotKey } from './clock';
import { canonicalizeJson, cloneJson, isJsonValue } from './json';
import { getOwnRecordValue } from './record';
import { registerId } from './registerId';
import {
  ConvergentSyncInvariantError,
  type ConvergentCollectionState,
  type ConvergentEntityState,
  type ConvergentStringCollectionState,
  type ConvergentStringEntryState,
  type ConvergentSyncStateV2,
  type Dot,
  type DotOriginIndex,
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

function assertDotOrigins(
  value: unknown,
  vector: VersionVector,
): asserts value is DotOriginIndex {
  if (!isRecord(value)) {
    throw new ConvergentSyncInvariantError('dotOrigins must be an object');
  }
  for (const [deviceId, origins] of Object.entries(value)) {
    assertNonEmptyKey(deviceId, 'dotOrigins device ID');
    if (!isRecord(origins)) {
      throw new ConvergentSyncInvariantError(`dotOrigins.${deviceId} must be an object`);
    }
    const vectorCounter = getOwnRecordValue(vector, deviceId);
    if (!vectorCounter || Object.keys(origins).length !== vectorCounter) {
      throw new ConvergentSyncInvariantError(
        `dotOrigins.${deviceId} must cover every counter in the state vector`,
      );
    }
    for (let counter = 1; counter <= vectorCounter; counter += 1) {
      const origin = getOwnRecordValue(origins, String(counter));
      if (typeof origin !== 'string' || origin.length === 0) {
        throw new ConvergentSyncInvariantError(
          `dotOrigins.${deviceId}.${counter} must contain a register identity`,
        );
      }
    }
  }
  for (const deviceId of Object.keys(vector)) {
    if (!Object.hasOwn(value, deviceId)) {
      throw new ConvergentSyncInvariantError(
        `dotOrigins.${deviceId} must cover every counter in the state vector`,
      );
    }
  }
}

function assertClock(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new ConvergentSyncInvariantError(`${label} must be an object`);
  }
  assertNonNegativeInteger(value.wallTime, `${label}.wallTime`);
  assertNonNegativeInteger(value.logical, `${label}.logical`);
}

function assertCoveredDot(
  value: unknown,
  state: ConvergentSyncStateV2,
  label: string,
): asserts value is Dot {
  if (!isRecord(value)) {
    throw new ConvergentSyncInvariantError(`${label} must be a dot`);
  }
  if (typeof value.deviceId !== 'string' || value.deviceId.length === 0) {
    throw new ConvergentSyncInvariantError(`${label}.deviceId must not be empty`);
  }
  assertPositiveInteger(value.counter, `${label}.counter`);
  if ((getOwnRecordValue(state.vector, value.deviceId) ?? 0) < value.counter) {
    throw new ConvergentSyncInvariantError(`${label} is not covered by the state vector`);
  }
}

function recordVectorWitness(
  witnessedDots: Map<string, Set<number>>,
  dot: Dot,
): void {
  const counters = witnessedDots.get(dot.deviceId) ?? new Set<number>();
  counters.add(dot.counter);
  witnessedDots.set(dot.deviceId, counters);
}

interface DotLocation {
  candidateLabel: string;
  registerIdentity: string;
}

interface ContextReference {
  key: string;
  label: string;
  registerIdentity: string;
}

function assertDotOrigin(
  state: ConvergentSyncStateV2,
  dot: Dot,
  expectedRegisterId: string,
  label: string,
): void {
  const deviceOrigins = getOwnRecordValue(state.dotOrigins, dot.deviceId);
  const origin = deviceOrigins
    ? getOwnRecordValue(deviceOrigins, String(dot.counter))
    : undefined;
  if (origin !== expectedRegisterId) {
    throw new ConvergentSyncInvariantError(
      `${label} is assigned to a different register origin`,
    );
  }
}

function assertVectorIsExactlyWitnessed(
  vector: VersionVector,
  witnessedDots: Map<string, Set<number>>,
): void {
  for (const [deviceId, counter] of Object.entries(vector)) {
    const counters = witnessedDots.get(deviceId);
    if (!counters || counters.size !== counter || !counters.has(counter)) {
      throw new ConvergentSyncInvariantError(
        `vector.${deviceId} is not witnessed by retained candidate dots and contexts`,
      );
    }
  }
}

function assertCandidate(
  value: unknown,
  state: ConvergentSyncStateV2,
  label: string,
  registerIdentity: string,
  globalDots: Map<string, DotLocation>,
  witnessedDots: Map<string, Set<number>>,
  contextReferences: ContextReference[],
): asserts value is RegisterCandidate {
  if (!isRecord(value)) {
    throw new ConvergentSyncInvariantError(`${label} must contain a dot`);
  }
  const candidateDot = value.dot;
  assertCoveredDot(candidateDot, state, `${label}.dot`);
  assertDotOrigin(state, candidateDot, registerIdentity, `${label}.dot`);
  if (!Array.isArray(value.context)) {
    throw new ConvergentSyncInvariantError(`${label}.context must be an array of dots`);
  }
  const contextKeys = new Set<string>();
  value.context.forEach((contextDot, index) => {
    const contextLabel = `${label}.context[${index}]`;
    assertCoveredDot(contextDot, state, contextLabel);
    assertDotOrigin(state, contextDot, registerIdentity, contextLabel);
    const contextKey = dotKey(contextDot);
    if (contextKeys.has(contextKey)) {
      throw new ConvergentSyncInvariantError(`${label}.context contains duplicate dot ${contextKey}`);
    }
    if (contextKey === dotKey(candidateDot)) {
      throw new ConvergentSyncInvariantError(`${label}.context must not contain its own dot`);
    }
    if (
      contextDot.deviceId === candidateDot.deviceId
      && contextDot.counter >= candidateDot.counter
    ) {
      throw new ConvergentSyncInvariantError(`${contextLabel} must precede its own device dot`);
    }
    contextKeys.add(contextKey);
    contextReferences.push({ key: contextKey, label: contextLabel, registerIdentity });
    recordVectorWitness(witnessedDots, contextDot);
  });

  const deviceId = candidateDot.deviceId;

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

  const key = dotKey({ deviceId, counter: candidateDot.counter });
  const previousLocation = globalDots.get(key);
  if (previousLocation) {
    throw new ConvergentSyncInvariantError(
      `Dot ${key} is reused by ${previousLocation.candidateLabel} and ${label}`,
    );
  }
  globalDots.set(key, { candidateLabel: label, registerIdentity });
  recordVectorWitness(witnessedDots, candidateDot);
}

function assertRegister(
  value: unknown,
  state: ConvergentSyncStateV2,
  label: string,
  registerIdentity: string,
  globalDots: Map<string, DotLocation>,
  witnessedDots: Map<string, Set<number>>,
  contextReferences: ContextReference[],
  valueValidator?: (candidate: RegisterCandidate, label: string) => void,
): asserts value is MultiValueRegister {
  if (!isRecord(value) || !Array.isArray(value.candidates) || value.candidates.length === 0) {
    throw new ConvergentSyncInvariantError(`${label} must contain at least one candidate`);
  }
  value.candidates.forEach((candidate, index) => {
    const candidateLabel = `${label}.candidates[${index}]`;
    assertCandidate(
      candidate,
      state,
      candidateLabel,
      registerIdentity,
      globalDots,
      witnessedDots,
      contextReferences,
    );
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
  assertDotOrigins(value.dotOrigins, value.vector);
  assertClock(value.hlc, 'hlc');
  if (!isRecord(value.collections) || !isRecord(value.settings) || !isRecord(value.stringCollections)) {
    throw new ConvergentSyncInvariantError('Collections, settings, and stringCollections must be objects');
  }

  const state = value as unknown as ConvergentSyncStateV2;
  const globalDots = new Map<string, DotLocation>();
  const witnessedDots = new Map<string, Set<number>>();
  const contextReferences: ContextReference[] = [];
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
      assertRegister(
        entity.presence,
        state,
        `${entityLabel}.presence`,
        registerId({ kind: 'entity-presence', collection: collectionName, entityId }),
        globalDots,
        witnessedDots,
        contextReferences,
        assertPresenceCandidate,
      );
      if (entity.position !== undefined) {
        assertRegister(
          entity.position,
          state,
          `${entityLabel}.position`,
          registerId({ kind: 'entity-position', collection: collectionName, entityId }),
          globalDots,
          witnessedDots,
          contextReferences,
          assertPositionCandidate,
        );
      }
      for (const [field, register] of Object.entries(entity.fields)) {
        assertNonEmptyKey(field, `${entityLabel} field`);
        if (field === 'id') {
          throw new ConvergentSyncInvariantError(`${entityLabel} must not store structural ID as a field`);
        }
        assertRegister(
          register,
          state,
          `${entityLabel}.fields.${field}`,
          registerId({ kind: 'entity-field', collection: collectionName, entityId, field }),
          globalDots,
          witnessedDots,
          contextReferences,
        );
      }
    }
  }

  for (const [encodedPath, register] of Object.entries(state.settings)) {
    decodeSettingPath(encodedPath);
    assertRegister(
      register,
      state,
      `settings.${encodedPath}`,
      registerId({ kind: 'setting', path: decodeSettingPath(encodedPath) }),
      globalDots,
      witnessedDots,
      contextReferences,
    );
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
      assertRegister(
        entry.presence,
        state,
        `${entryLabel}.presence`,
        registerId({
          kind: 'string-entry-presence',
          collection: collectionName,
          value: entryValue,
        }),
        globalDots,
        witnessedDots,
        contextReferences,
        assertPresenceCandidate,
      );
      if (entry.position !== undefined) {
        assertRegister(
          entry.position,
          state,
          `${entryLabel}.position`,
          registerId({
            kind: 'string-entry-position',
            collection: collectionName,
            value: entryValue,
          }),
          globalDots,
          witnessedDots,
          contextReferences,
          assertPositionCandidate,
        );
      }
    }
  }

  for (const reference of contextReferences) {
    const retainedLocation = globalDots.get(reference.key);
    if (retainedLocation) {
      const location = retainedLocation.registerIdentity === reference.registerIdentity
        ? 'the same register'
        : 'another register';
      throw new ConvergentSyncInvariantError(
        `${reference.label} references candidate dot ${reference.key} retained in ${location}`,
      );
    }
  }
  assertVectorIsExactlyWitnessed(state.vector, witnessedDots);
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
    context: candidate.context
      .map((dot) => ({
        deviceId: dot.deviceId,
        counter: dot.counter,
      }))
      .sort(compareDots),
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

function canonicalDotOrigins(origins: DotOriginIndex): DotOriginIndex {
  return Object.fromEntries(
    Object.keys(origins).sort().map((deviceId) => [
      deviceId,
      Object.fromEntries(
        Object.entries(origins[deviceId])
          .sort(([left], [right]) => Number(left) - Number(right)),
      ),
    ]),
  );
}

export function canonicalizeConvergentSyncState(
  state: ConvergentSyncStateV2,
): ConvergentSyncStateV2 {
  assertValidConvergentSyncState(state);
  return {
    schemaVersion: 2,
    vector: sortRecord(state.vector, (counter) => counter),
    dotOrigins: canonicalDotOrigins(state.dotOrigins),
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
