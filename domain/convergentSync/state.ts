import {
  compareStrings,
  dotKey,
  maxHybridLogicalClock,
  mergeVersionVectors,
  tickHybridLogicalClock,
} from './clock';
import { cloneJson, jsonValuesEqual } from './json';
import {
  createRegisterCandidate,
  compareCandidatesByDot,
  compareRegisterCandidates,
  isTombstoneCandidate,
  mergeMultiValueRegisters,
  registerCausalContext,
  registerHasConflict,
  selectRegisterWinner,
} from './register';
import {
  assertValidConvergentSyncState,
  canonicalizeConvergentSyncState,
  decodeSettingPath,
  encodeSettingPath,
} from './serialization';
import {
  createEmptyRecord,
  getOwnRecordValue,
  setOwnRecordValue,
} from './record';
import { registerId } from './registerId';
import {
  ConvergentSyncInvariantError,
  type CollectionPosition,
  type ConvergentCollectionState,
  type ConvergentConflictAddress,
  type ConvergentConflictCandidate,
  type ConvergentEntityState,
  type ConvergentFieldConflict,
  type ConvergentMutation,
  type ConvergentStringCollectionState,
  type ConvergentStringEntryState,
  type ConvergentSyncStateV2,
  type DotOriginIndex,
  type JsonObject,
  type JsonValue,
  type MaterializedConvergentSyncState,
  type MultiValueRegister,
  type RegisterAddress,
  type RegisterCandidate,
} from './types';

export function createConvergentSyncState(): ConvergentSyncStateV2 {
  return {
    schemaVersion: 2,
    vector: createEmptyRecord(),
    dotOrigins: createEmptyRecord(),
    hlc: { wallTime: 0, logical: 0 },
    collections: createEmptyRecord(),
    settings: createEmptyRecord(),
    stringCollections: createEmptyRecord(),
  };
}

function requireNonEmpty(value: string, label: string): void {
  if (value.length === 0) {
    throw new ConvergentSyncInvariantError(`${label} must not be empty`);
  }
}

function writeRegister<T extends JsonValue>(
  state: ConvergentSyncStateV2,
  deviceId: string,
  now: number,
  registerIdentity: string,
  currentRegister: MultiValueRegister<T> | undefined,
  value?: T,
  tombstone = false,
): MultiValueRegister<T> {
  requireNonEmpty(deviceId, 'Device ID');
  const context = registerCausalContext(currentRegister);
  const currentCounter = getOwnRecordValue(state.vector, deviceId) ?? 0;
  if (currentCounter >= Number.MAX_SAFE_INTEGER) {
    throw new ConvergentSyncInvariantError(`Device counter exhausted for ${deviceId}`);
  }
  const counter = currentCounter + 1;
  const dot = { deviceId, counter };
  setOwnRecordValue(state.vector, deviceId, counter);
  const deviceOrigins = getOwnRecordValue(state.dotOrigins, deviceId)
    ?? createEmptyRecord<string>();
  setOwnRecordValue(deviceOrigins, String(counter), registerIdentity);
  setOwnRecordValue(state.dotOrigins, deviceId, deviceOrigins);
  state.hlc = tickHybridLogicalClock(state.hlc, now);
  return {
    candidates: [createRegisterCandidate({
      dot,
      context,
      hlc: state.hlc,
      value,
      tombstone,
    })],
  };
}

function candidateValueEquals(
  register: MultiValueRegister | undefined,
  value: JsonValue,
): boolean {
  const winner = selectRegisterWinner(register);
  return Boolean(winner)
    && !isTombstoneCandidate(winner)
    && jsonValuesEqual(winner.value, value);
}

function registerIsPresent(register: MultiValueRegister<boolean> | undefined): boolean {
  const winner = selectRegisterWinner(register);
  return Boolean(winner) && !isTombstoneCandidate(winner);
}

function ensureCollection(
  state: ConvergentSyncStateV2,
  collectionName: string,
): ConvergentCollectionState {
  requireNonEmpty(collectionName, 'Collection name');
  const existing = getOwnRecordValue(state.collections, collectionName);
  if (existing) return existing;
  const collection = { entities: createEmptyRecord<ConvergentEntityState>() };
  setOwnRecordValue(state.collections, collectionName, collection);
  return collection;
}

function ensureEntity(
  state: ConvergentSyncStateV2,
  collectionName: string,
  entityId: string,
): { entity: ConvergentEntityState; created: boolean } {
  requireNonEmpty(entityId, 'Entity ID');
  const collection = ensureCollection(state, collectionName);
  const existing = getOwnRecordValue(collection.entities, entityId);
  if (existing) return { entity: existing, created: false };

  const entity: ConvergentEntityState = {
    // Filled before the batch is returned and validated.
    presence: { candidates: [] },
    fields: createEmptyRecord(),
  };
  setOwnRecordValue(collection.entities, entityId, entity);
  return { entity, created: true };
}

function ensureStringCollection(
  state: ConvergentSyncStateV2,
  collectionName: string,
): ConvergentStringCollectionState {
  requireNonEmpty(collectionName, 'String collection name');
  const existing = getOwnRecordValue(state.stringCollections, collectionName);
  if (existing) return existing;
  const collection = { entries: createEmptyRecord<ConvergentStringEntryState>() };
  setOwnRecordValue(state.stringCollections, collectionName, collection);
  return collection;
}

function ensureStringEntry(
  state: ConvergentSyncStateV2,
  collectionName: string,
  value: string,
): { entry: ConvergentStringEntryState; created: boolean } {
  requireNonEmpty(value, 'String collection value');
  const collection = ensureStringCollection(state, collectionName);
  const existing = getOwnRecordValue(collection.entries, value);
  if (existing) return { entry: existing, created: false };

  const entry: ConvergentStringEntryState = { presence: { candidates: [] } };
  setOwnRecordValue(collection.entries, value, entry);
  return { entry, created: true };
}

function applyEntityUpsert(
  state: ConvergentSyncStateV2,
  deviceId: string,
  mutation: Extract<ConvergentMutation, { kind: 'entity-upsert' }>,
  now: number,
): void {
  const structuralId = mutation.value.id;
  if (structuralId !== undefined && structuralId !== mutation.entityId) {
    throw new ConvergentSyncInvariantError('Entity value ID must match its structural ID');
  }

  const { entity, created } = ensureEntity(
    state,
    mutation.collection,
    mutation.entityId,
  );
  const presenceRegisterId = registerId({
    kind: 'entity-presence',
    collection: mutation.collection,
    entityId: mutation.entityId,
  });
  const positionRegisterId = registerId({
    kind: 'entity-position',
    collection: mutation.collection,
    entityId: mutation.entityId,
  });
  let changed = created
    || !registerIsPresent(entity.presence)
    || registerHasConflict(entity.presence);
  const incomingFields = Object.fromEntries(
    Object.entries(mutation.value).filter(([field]) => field !== 'id'),
  );
  const fieldNames = new Set([
    ...Object.keys(entity.fields),
    ...Object.keys(incomingFields),
  ]);

  for (const field of [...fieldNames].sort()) {
    requireNonEmpty(field, 'Entity field');
    const fieldRegisterId = registerId({
      kind: 'entity-field',
      collection: mutation.collection,
      entityId: mutation.entityId,
      field,
    });
    const incoming = getOwnRecordValue(incomingFields, field);
    const currentRegister = getOwnRecordValue(entity.fields, field);
    if (incoming === undefined) {
      const winner = selectRegisterWinner(currentRegister);
      if (winner && !isTombstoneCandidate(winner)) {
        setOwnRecordValue(
          entity.fields,
          field,
          writeRegister(
            state,
            deviceId,
            now,
            fieldRegisterId,
            currentRegister,
            undefined,
            true,
          ),
        );
        changed = true;
      }
    } else if (
      !currentRegister
      || registerHasConflict(currentRegister)
      || !candidateValueEquals(currentRegister, incoming)
    ) {
      setOwnRecordValue(
        entity.fields,
        field,
        writeRegister(
          state,
          deviceId,
          now,
          fieldRegisterId,
          currentRegister,
          incoming,
        ),
      );
      changed = true;
    }
  }

  if (
    mutation.position !== undefined
    && (
      !entity.position
      || registerHasConflict(entity.position)
      || !candidateValueEquals(entity.position, mutation.position)
    )
  ) {
    entity.position = writeRegister(
      state,
      deviceId,
      now,
      positionRegisterId,
      entity.position,
      mutation.position,
    );
    changed = true;
  }

  if (changed) {
    // Refreshing presence makes a concurrent delete/update visible as an
    // MV-register conflict instead of allowing a deletion to hide the edit.
    entity.presence = writeRegister(
      state,
      deviceId,
      now,
      presenceRegisterId,
      entity.presence,
      true,
    );
  }
}

function applyEntityFieldMutation(
  state: ConvergentSyncStateV2,
  deviceId: string,
  mutation: Extract<
    ConvergentMutation,
    { kind: 'entity-field-set' | 'entity-field-delete' }
  >,
  now: number,
): void {
  requireNonEmpty(mutation.field, 'Entity field');
  if (mutation.field === 'id') {
    throw new ConvergentSyncInvariantError('Entity IDs are structural and cannot be field registers');
  }
  const collection = getOwnRecordValue(state.collections, mutation.collection);
  const existingEntity = collection
    ? getOwnRecordValue(collection.entities, mutation.entityId)
    : undefined;
  if (mutation.kind === 'entity-field-delete' && !existingEntity) return;

  const { entity } = ensureEntity(state, mutation.collection, mutation.entityId);
  const fieldRegisterId = registerId({
    kind: 'entity-field',
    collection: mutation.collection,
    entityId: mutation.entityId,
    field: mutation.field,
  });
  const presenceRegisterId = registerId({
    kind: 'entity-presence',
    collection: mutation.collection,
    entityId: mutation.entityId,
  });
  const currentRegister = getOwnRecordValue(entity.fields, mutation.field);
  const currentWinner = selectRegisterWinner(currentRegister);

  if (mutation.kind === 'entity-field-delete') {
    if (!currentWinner || isTombstoneCandidate(currentWinner)) return;
    setOwnRecordValue(
      entity.fields,
      mutation.field,
      writeRegister(
        state,
        deviceId,
        now,
        fieldRegisterId,
        currentRegister,
        undefined,
        true,
      ),
    );
    if (registerIsPresent(entity.presence)) {
      entity.presence = writeRegister(
        state,
        deviceId,
        now,
        presenceRegisterId,
        entity.presence,
        true,
      );
    }
    return;
  }

  if (
    (!currentRegister || !registerHasConflict(currentRegister))
    && candidateValueEquals(currentRegister, mutation.value)
  ) {
    return;
  }
  setOwnRecordValue(
    entity.fields,
    mutation.field,
    writeRegister(
      state,
      deviceId,
      now,
      fieldRegisterId,
      currentRegister,
      mutation.value,
    ),
  );
  entity.presence = writeRegister(
    state,
    deviceId,
    now,
    presenceRegisterId,
    entity.presence,
    true,
  );
}

function settingPathIsPrefix(prefix: string[], path: string[]): boolean {
  return prefix.length <= path.length
    && prefix.every((segment, index) => segment === path[index]);
}

function settingPathsOverlap(left: string[], right: string[]): boolean {
  return settingPathIsPrefix(left, right) || settingPathIsPrefix(right, left);
}

function tombstoneRelatedSettingPaths(
  state: ConvergentSyncStateV2,
  deviceId: string,
  path: string[],
  now: number,
  includeAncestors: boolean,
): void {
  const encodedPath = encodeSettingPath(path);
  for (const otherEncodedPath of Object.keys(state.settings).sort()) {
    if (otherEncodedPath === encodedPath) continue;
    const otherPath = decodeSettingPath(otherEncodedPath);
    const isRelated = includeAncestors
      ? settingPathsOverlap(path, otherPath)
      : settingPathIsPrefix(path, otherPath);
    if (!isRelated) continue;
    const register = getOwnRecordValue(state.settings, otherEncodedPath);
    const winner = selectRegisterWinner(register);
    if (!winner || isTombstoneCandidate(winner)) continue;
    setOwnRecordValue(
      state.settings,
      otherEncodedPath,
      writeRegister(
        state,
        deviceId,
        now,
        registerId({ kind: 'setting', path: otherPath }),
        register,
        undefined,
        true,
      ),
    );
  }
}

function writeSettingRegister(
  state: ConvergentSyncStateV2,
  deviceId: string,
  path: string[],
  now: number,
  value?: JsonValue,
  tombstone = false,
): void {
  // Replacements remove both atomic ancestors and nested descendants to keep
  // the causal leaf set prefix-free. Deletions represent subtree removal, so
  // they remove descendants without erasing an atomic ancestor when a caller
  // targets a path beneath it.
  tombstoneRelatedSettingPaths(state, deviceId, path, now, !tombstone);
  const encodedPath = encodeSettingPath(path);
  const currentRegister = getOwnRecordValue(state.settings, encodedPath);
  const currentWinner = selectRegisterWinner(currentRegister);
  if (
    currentRegister
    && !registerHasConflict(currentRegister)
    && (
      (tombstone && currentWinner && isTombstoneCandidate(currentWinner))
      || (!tombstone && value !== undefined && candidateValueEquals(currentRegister, value))
    )
  ) {
    return;
  }
  setOwnRecordValue(
    state.settings,
    encodedPath,
    writeRegister(
      state,
      deviceId,
      now,
      registerId({ kind: 'setting', path }),
      currentRegister,
      value,
      tombstone,
    ),
  );
}

function findEntity(
  state: ConvergentSyncStateV2,
  collectionName: string,
  entityId: string,
): ConvergentEntityState | undefined {
  const collection = getOwnRecordValue(state.collections, collectionName);
  return collection
    ? getOwnRecordValue(collection.entities, entityId)
    : undefined;
}

function findStringEntry(
  state: ConvergentSyncStateV2,
  collectionName: string,
  value: string,
): ConvergentStringEntryState | undefined {
  const collection = getOwnRecordValue(state.stringCollections, collectionName);
  return collection
    ? getOwnRecordValue(collection.entries, value)
    : undefined;
}

function getRegisterAtAddress(
  state: ConvergentSyncStateV2,
  address: RegisterAddress,
): MultiValueRegister | undefined {
  switch (address.kind) {
    case 'entity-presence':
      return findEntity(state, address.collection, address.entityId)?.presence;
    case 'entity-position':
      return findEntity(state, address.collection, address.entityId)?.position;
    case 'entity-field': {
      const entity = findEntity(state, address.collection, address.entityId);
      return entity ? getOwnRecordValue(entity.fields, address.field) : undefined;
    }
    case 'setting':
      return getOwnRecordValue(state.settings, encodeSettingPath(address.path));
    case 'string-entry-presence':
      return findStringEntry(state, address.collection, address.value)?.presence;
    case 'string-entry-position':
      return findStringEntry(state, address.collection, address.value)?.position;
  }
}

function setRegisterAtAddress(
  state: ConvergentSyncStateV2,
  address: RegisterAddress,
  register: MultiValueRegister,
): void {
  switch (address.kind) {
    case 'entity-presence':
      ensureEntity(state, address.collection, address.entityId).entity.presence = register as MultiValueRegister<boolean>;
      break;
    case 'entity-position':
      ensureEntity(state, address.collection, address.entityId).entity.position = register as MultiValueRegister<CollectionPosition>;
      break;
    case 'entity-field':
      requireNonEmpty(address.field, 'Entity field');
      setOwnRecordValue(
        ensureEntity(state, address.collection, address.entityId).entity.fields,
        address.field,
        register,
      );
      break;
    case 'setting':
      setOwnRecordValue(state.settings, encodeSettingPath(address.path), register);
      break;
    case 'string-entry-presence':
      ensureStringEntry(state, address.collection, address.value).entry.presence = register as MultiValueRegister<boolean>;
      break;
    case 'string-entry-position':
      ensureStringEntry(state, address.collection, address.value).entry.position = register as MultiValueRegister<CollectionPosition>;
      break;
  }
}

function applyMutation(
  state: ConvergentSyncStateV2,
  deviceId: string,
  mutation: ConvergentMutation,
  now: number,
): void {
  switch (mutation.kind) {
    case 'entity-upsert':
      applyEntityUpsert(state, deviceId, mutation, now);
      break;
    case 'entity-field-set':
    case 'entity-field-delete':
      applyEntityFieldMutation(state, deviceId, mutation, now);
      break;
    case 'entity-delete': {
      const { entity } = ensureEntity(state, mutation.collection, mutation.entityId);
      entity.presence = writeRegister(
        state,
        deviceId,
        now,
        registerId({
          kind: 'entity-presence',
          collection: mutation.collection,
          entityId: mutation.entityId,
        }),
        entity.presence,
        undefined,
        true,
      );
      break;
    }
    case 'setting-set':
      writeSettingRegister(
        state,
        deviceId,
        mutation.path,
        now,
        mutation.value,
      );
      break;
    case 'setting-delete':
      writeSettingRegister(
        state,
        deviceId,
        mutation.path,
        now,
        undefined,
        true,
      );
      break;
    case 'string-entry-add': {
      const { entry, created } = ensureStringEntry(state, mutation.collection, mutation.value);
      let changed = created
        || !registerIsPresent(entry.presence)
        || registerHasConflict(entry.presence);
      if (
        mutation.position !== undefined
        && (
          !entry.position
          || registerHasConflict(entry.position)
          || !candidateValueEquals(entry.position, mutation.position)
        )
      ) {
        entry.position = writeRegister(
          state,
          deviceId,
          now,
          registerId({
            kind: 'string-entry-position',
            collection: mutation.collection,
            value: mutation.value,
          }),
          entry.position,
          mutation.position,
        );
        changed = true;
      }
      if (changed) {
        entry.presence = writeRegister(
          state,
          deviceId,
          now,
          registerId({
            kind: 'string-entry-presence',
            collection: mutation.collection,
            value: mutation.value,
          }),
          entry.presence,
          true,
        );
      }
      break;
    }
    case 'string-entry-delete': {
      requireNonEmpty(mutation.collection, 'String collection name');
      requireNonEmpty(mutation.value, 'String collection value');
      const collection = getOwnRecordValue(
        state.stringCollections,
        mutation.collection,
      );
      const entry = collection
        ? getOwnRecordValue(collection.entries, mutation.value)
        : undefined;
      if (!entry || !registerIsPresent(entry.presence)) break;
      entry.presence = writeRegister(
        state,
        deviceId,
        now,
        registerId({
          kind: 'string-entry-presence',
          collection: mutation.collection,
          value: mutation.value,
        }),
        entry.presence,
        undefined,
        true,
      );
      break;
    }
    case 'resolve-register': {
      const currentRegister = getRegisterAtAddress(state, mutation.address);
      if (!currentRegister) {
        throw new ConvergentSyncInvariantError('Cannot resolve a register that does not exist');
      }
      if (mutation.tombstone && mutation.value !== undefined) {
        throw new ConvergentSyncInvariantError('A tombstone resolution cannot contain a value');
      }
      if (!mutation.tombstone && mutation.value === undefined) {
        throw new ConvergentSyncInvariantError('A value resolution requires a value');
      }
      if (mutation.address.kind === 'setting') {
        writeSettingRegister(
          state,
          deviceId,
          mutation.address.path,
          now,
          mutation.value,
          mutation.tombstone === true,
        );
        break;
      }
      setRegisterAtAddress(
        state,
        mutation.address,
        writeRegister(
          state,
          deviceId,
          now,
          registerId(mutation.address),
          currentRegister,
          mutation.value,
          mutation.tombstone === true,
        ),
      );
      break;
    }
  }
}

/**
 * Apply a batch with one structural clone. Import and migration can therefore
 * create thousands of registers without repeatedly copying the full replica.
 */
export function applyConvergentMutations(
  state: ConvergentSyncStateV2,
  deviceId: string,
  mutations: ConvergentMutation[],
  now: number,
): ConvergentSyncStateV2 {
  assertValidConvergentSyncState(state);
  requireNonEmpty(deviceId, 'Device ID');
  const next = canonicalizeConvergentSyncState(state);
  for (const mutation of mutations) applyMutation(next, deviceId, mutation, now);
  assertValidConvergentSyncState(next);
  return canonicalizeConvergentSyncState(next);
}

function mergeRecord<T>(
  left: Record<string, T>,
  right: Record<string, T>,
  merge: (leftValue: T | undefined, rightValue: T | undefined) => T | undefined,
): Record<string, T> {
  const result = createEmptyRecord<T>();
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of [...keys].sort()) {
    const merged = merge(
      getOwnRecordValue(left, key),
      getOwnRecordValue(right, key),
    );
    if (merged !== undefined) setOwnRecordValue(result, key, merged);
  }
  return result;
}

function mergeDotOrigins(
  left: DotOriginIndex,
  right: DotOriginIndex,
): DotOriginIndex {
  return mergeRecord(left, right, (leftDevice, rightDevice) =>
    mergeRecord(
      leftDevice ?? createEmptyRecord<string>(),
      rightDevice ?? createEmptyRecord<string>(),
      (leftOrigin, rightOrigin) => {
        if (leftOrigin && rightOrigin && leftOrigin !== rightOrigin) {
          throw new ConvergentSyncInvariantError(
            `Dot origin mismatch: ${leftOrigin} !== ${rightOrigin}`,
          );
        }
        return leftOrigin ?? rightOrigin;
      },
    ),
  );
}

export function mergeConvergentSyncStates(
  left: ConvergentSyncStateV2,
  right: ConvergentSyncStateV2,
): ConvergentSyncStateV2 {
  assertValidConvergentSyncState(left);
  assertValidConvergentSyncState(right);

  const mergeRegister = <T extends JsonValue>(
    leftRegister: MultiValueRegister<T> | undefined,
    rightRegister: MultiValueRegister<T> | undefined,
  ): MultiValueRegister<T> | undefined => mergeMultiValueRegisters(
    leftRegister,
    rightRegister,
  );

  const collections = mergeRecord(
    left.collections,
    right.collections,
    (leftCollection, rightCollection) => {
      const entities = mergeRecord(
        leftCollection?.entities ?? {},
        rightCollection?.entities ?? {},
        (leftEntity, rightEntity) => {
          const presence = mergeRegister(leftEntity?.presence, rightEntity?.presence);
          if (!presence) return undefined;
          const position = mergeRegister(leftEntity?.position, rightEntity?.position);
          const fields = mergeRecord(
            leftEntity?.fields ?? {},
            rightEntity?.fields ?? {},
            mergeRegister,
          );
          return { presence, ...(position ? { position } : {}), fields };
        },
      );
      return Object.keys(entities).length > 0 ? { entities } : undefined;
    },
  );

  const settings = mergeRecord(left.settings, right.settings, mergeRegister);
  const stringCollections = mergeRecord(
    left.stringCollections,
    right.stringCollections,
    (leftCollection, rightCollection) => {
      const entries = mergeRecord(
        leftCollection?.entries ?? {},
        rightCollection?.entries ?? {},
        (leftEntry, rightEntry) => {
          const presence = mergeRegister(leftEntry?.presence, rightEntry?.presence);
          if (!presence) return undefined;
          const position = mergeRegister(leftEntry?.position, rightEntry?.position);
          return { presence, ...(position ? { position } : {}) };
        },
      );
      return Object.keys(entries).length > 0 ? { entries } : undefined;
    },
  );

  const merged: ConvergentSyncStateV2 = {
    schemaVersion: 2,
    vector: mergeVersionVectors(left.vector, right.vector),
    dotOrigins: mergeDotOrigins(left.dotOrigins, right.dotOrigins),
    hlc: maxHybridLogicalClock(left.hlc, right.hlc),
    collections,
    settings,
    stringCollections,
  };
  assertValidConvergentSyncState(merged);
  return canonicalizeConvergentSyncState(merged);
}

function comparePositions(
  left: CollectionPosition | undefined,
  right: CollectionPosition | undefined,
): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'number') return -1;
  if (typeof right === 'number') return 1;
  return compareStrings(left, right);
}

function materializedValue(register: MultiValueRegister | undefined): JsonValue | undefined {
  const winner = selectRegisterWinner(register);
  if (!winner || isTombstoneCandidate(winner)) return undefined;
  return cloneJson(winner.value);
}

function conflictCandidate(
  candidate: RegisterCandidate,
  selectedDot: string,
  settingPath?: string[],
): ConvergentConflictCandidate {
  return {
    dot: {
      deviceId: candidate.dot.deviceId,
      counter: candidate.dot.counter,
    },
    hlc: {
      wallTime: candidate.hlc.wallTime,
      logical: candidate.hlc.logical,
    },
    tombstone: isTombstoneCandidate(candidate),
    ...(!isTombstoneCandidate(candidate) ? { value: cloneJson(candidate.value) } : {}),
    ...(settingPath ? { settingPath: [...settingPath] } : {}),
    selected: dotKey(candidate.dot) === selectedDot,
  };
}

function maybeRecordConflict(
  conflicts: ConvergentFieldConflict[],
  address: RegisterAddress,
  register: MultiValueRegister | undefined,
): void {
  if (!register || !registerHasConflict(register)) return;
  const winner = selectRegisterWinner(register);
  if (!winner) return;
  conflicts.push({
    address,
    candidates: [...register.candidates]
      .sort(compareCandidatesByDot)
      .map((candidate) => conflictCandidate(candidate, dotKey(winner.dot))),
  });
}

function addressSortKey(address: ConvergentConflictAddress): string {
  switch (address.kind) {
    case 'entity-presence':
      return `0:${address.collection}:${address.entityId}:0`;
    case 'entity-position':
      return `0:${address.collection}:${address.entityId}:1`;
    case 'entity-field':
      return `0:${address.collection}:${address.entityId}:2:${address.field}`;
    case 'setting':
      return `1:0:${encodeSettingPath(address.path)}`;
    case 'setting-structure':
      return `1:1:${address.paths.map(encodeSettingPath).join('|')}`;
    case 'string-entry-presence':
      return `2:${address.collection}:${address.value}:0`;
    case 'string-entry-position':
      return `2:${address.collection}:${address.value}:1`;
  }
}

function setNestedSetting(root: JsonObject, path: string[], value: JsonValue): void {
  let target = root;
  for (const segment of path.slice(0, -1)) {
    const existing = getOwnRecordValue(target, segment);
    if (existing === undefined) {
      const nested = createEmptyRecord<JsonValue>();
      setOwnRecordValue(target, segment, nested);
      target = nested;
    } else if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      target = existing;
    } else {
      throw new ConvergentSyncInvariantError(
        `Setting path ${encodeSettingPath(path)} overlaps an atomic parent value`,
      );
    }
  }
  setOwnRecordValue(target, path[path.length - 1], cloneJson(value));
}

interface ActiveSettingEntry {
  encodedPath: string;
  path: string[];
  register: MultiValueRegister;
  winner: RegisterCandidate;
  value: JsonValue;
}

function selectMaterializedSettingEntries(
  entries: ActiveSettingEntry[],
): Set<string> {
  const selectedPaths = new Set<string>();
  const selectedPrefixes = new Set<string>();
  const prioritized = [...entries].sort((left, right) => {
    const candidateOrder = compareRegisterCandidates(right.winner, left.winner);
    return candidateOrder !== 0
      ? candidateOrder
      : compareStrings(left.encodedPath, right.encodedPath);
  });

  for (const entry of prioritized) {
    const hasSelectedAncestor = entry.path.slice(0, -1).some((_, index) =>
      selectedPaths.has(encodeSettingPath(entry.path.slice(0, index + 1))),
    );
    const hasSelectedDescendant = selectedPrefixes.has(entry.encodedPath);
    if (hasSelectedAncestor || hasSelectedDescendant) continue;

    selectedPaths.add(entry.encodedPath);
    for (let length = 1; length < entry.path.length; length += 1) {
      selectedPrefixes.add(encodeSettingPath(entry.path.slice(0, length)));
    }
  }
  return selectedPaths;
}

function recordSettingStructureConflicts(
  entries: ActiveSettingEntry[],
  selectedPaths: Set<string>,
  conflicts: ConvergentFieldConflict[],
): void {
  const byEncodedPath = new Map(entries.map((entry) => [entry.encodedPath, entry]));
  const groups = new Map<string, ActiveSettingEntry[]>();

  for (const entry of entries) {
    let rootPath = entry.encodedPath;
    for (let length = 1; length < entry.path.length; length += 1) {
      const ancestor = encodeSettingPath(entry.path.slice(0, length));
      if (byEncodedPath.has(ancestor)) {
        rootPath = ancestor;
        break;
      }
    }
    const group = groups.get(rootPath) ?? [];
    group.push(entry);
    groups.set(rootPath, group);
  }

  for (const rootPath of [...groups.keys()].sort()) {
    const group = groups.get(rootPath);
    if (!group || group.length < 2) continue;
    group.sort((left, right) => compareStrings(left.encodedPath, right.encodedPath));
    conflicts.push({
      address: {
        kind: 'setting-structure',
        paths: group.map((entry) => [...entry.path]),
      },
      candidates: group.flatMap((entry) =>
        [...entry.register.candidates]
          .sort(compareCandidatesByDot)
          .map((candidate) => conflictCandidate(
            candidate,
            selectedPaths.has(entry.encodedPath) ? dotKey(entry.winner.dot) : '',
            entry.path,
          )),
      ),
    });
  }
}

function materializeSettings(
  state: ConvergentSyncStateV2,
  settings: JsonObject,
  conflicts: ConvergentFieldConflict[],
): void {
  const activeEntries: ActiveSettingEntry[] = [];
  for (const encodedPath of Object.keys(state.settings).sort()) {
    const register = getOwnRecordValue(state.settings, encodedPath);
    if (!register) continue;
    const path = decodeSettingPath(encodedPath);
    maybeRecordConflict(conflicts, { kind: 'setting', path }, register);
    const winner = selectRegisterWinner(register);
    if (!winner || isTombstoneCandidate(winner)) continue;
    activeEntries.push({
      encodedPath,
      path,
      register,
      winner,
      value: cloneJson(winner.value),
    });
  }

  const selectedPaths = selectMaterializedSettingEntries(activeEntries);
  recordSettingStructureConflicts(activeEntries, selectedPaths, conflicts);
  for (const entry of activeEntries) {
    if (selectedPaths.has(entry.encodedPath)) {
      setNestedSetting(settings, entry.path, entry.value);
    }
  }
}

export function materializeConvergentSyncState(
  state: ConvergentSyncStateV2,
): MaterializedConvergentSyncState {
  assertValidConvergentSyncState(state);
  const collections = createEmptyRecord<JsonObject[]>();
  const settings = createEmptyRecord<JsonValue>();
  const stringCollections = createEmptyRecord<string[]>();
  const conflicts: ConvergentFieldConflict[] = [];

  for (const collectionName of Object.keys(state.collections).sort()) {
    const materializedEntities: Array<{
      id: string;
      position?: CollectionPosition;
      value: JsonObject;
    }> = [];
    const collection = getOwnRecordValue(state.collections, collectionName);
    if (!collection) continue;
    for (const entityId of Object.keys(collection.entities).sort()) {
      const entity = getOwnRecordValue(collection.entities, entityId);
      if (!entity) continue;
      maybeRecordConflict(conflicts, {
        kind: 'entity-presence',
        collection: collectionName,
        entityId,
      }, entity.presence);
      if (!registerIsPresent(entity.presence)) continue;
      maybeRecordConflict(conflicts, {
        kind: 'entity-position',
        collection: collectionName,
        entityId,
      }, entity.position);
      for (const field of Object.keys(entity.fields).sort()) {
        maybeRecordConflict(conflicts, {
          kind: 'entity-field',
          collection: collectionName,
          entityId,
          field,
        }, getOwnRecordValue(entity.fields, field));
      }

      const value: JsonObject = { id: entityId };
      for (const field of Object.keys(entity.fields).sort()) {
        const fieldValue = materializedValue(getOwnRecordValue(entity.fields, field));
        if (fieldValue !== undefined) setOwnRecordValue(value, field, fieldValue);
      }
      const rawPosition = materializedValue(entity.position);
      const position = typeof rawPosition === 'string' || typeof rawPosition === 'number'
        ? rawPosition
        : undefined;
      materializedEntities.push({ id: entityId, position, value });
    }
    materializedEntities.sort((left, right) =>
      comparePositions(left.position, right.position) || compareStrings(left.id, right.id),
    );
    setOwnRecordValue(
      collections,
      collectionName,
      materializedEntities.map((entity) => entity.value),
    );
  }

  materializeSettings(state, settings, conflicts);

  for (const collectionName of Object.keys(state.stringCollections).sort()) {
    const entries: Array<{ value: string; position?: CollectionPosition }> = [];
    const collection = getOwnRecordValue(state.stringCollections, collectionName);
    if (!collection) continue;
    for (const value of Object.keys(collection.entries).sort()) {
      const entry = getOwnRecordValue(collection.entries, value);
      if (!entry) continue;
      maybeRecordConflict(conflicts, {
        kind: 'string-entry-presence',
        collection: collectionName,
        value,
      }, entry.presence);
      if (!registerIsPresent(entry.presence)) continue;
      maybeRecordConflict(conflicts, {
        kind: 'string-entry-position',
        collection: collectionName,
        value,
      }, entry.position);
      const rawPosition = materializedValue(entry.position);
      const position = typeof rawPosition === 'string' || typeof rawPosition === 'number'
        ? rawPosition
        : undefined;
      entries.push({ value, position });
    }
    entries.sort((left, right) =>
      comparePositions(left.position, right.position) || compareStrings(left.value, right.value),
    );
    setOwnRecordValue(
      stringCollections,
      collectionName,
      entries.map((entry) => entry.value),
    );
  }

  conflicts.sort((left, right) =>
    compareStrings(addressSortKey(left.address), addressSortKey(right.address)),
  );
  return { collections, settings, stringCollections, conflicts };
}
