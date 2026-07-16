import type {
  CloudSyncPayloadEntityKey,
  SyncFileMeta,
  SyncPayload,
  SyncReliabilityMeta,
} from '../sync';
import { dotKey } from './clock';
import {
  cloneJson,
  isJsonValue,
  jsonValuesEqual,
  normalizeJsonValue,
} from './json';
import { selectRegisterWinner, isTombstoneCandidate } from './register';
import { createEmptyRecord, setOwnRecordValue } from './record';
import {
  assertValidConvergentSyncState,
  canonicalizeConvergentSyncState,
  decodeSettingPath,
} from './serialization';
import {
  applyConvergentMutations,
  createConvergentSyncState,
  materializeConvergentSyncState,
} from './state';
import type {
  CollectionPosition,
  ConvergentEnvelopeCandidate,
  ConvergentEnvelopeCollectionState,
  ConvergentEnvelopeEntityState,
  ConvergentEnvelopeRegister,
  ConvergentEnvelopeStateV2,
  ConvergentEnvelopeStringCollectionState,
  ConvergentEnvelopeStringEntryState,
  ConvergentMutation,
  ConvergentSyncEnvelopeV2,
  ConvergentSyncStateV2,
  JsonObject,
  JsonValue,
  MultiValueRegister,
  RegisterCandidate,
} from './types';

export const CONVERGENT_ENTITY_COLLECTIONS = [
  'hosts',
  'keys',
  'identities',
  'proxyProfiles',
  'snippets',
  'notes',
  'portForwardingRules',
  'groupConfigs',
] as const satisfies readonly CloudSyncPayloadEntityKey[];

export const CONVERGENT_STRING_COLLECTIONS = [
  'customGroups',
  'snippetPackages',
  'noteGroups',
] as const satisfies readonly CloudSyncPayloadEntityKey[];

type ConvergentEntityCollection = typeof CONVERGENT_ENTITY_COLLECTIONS[number];
type ConvergentStringCollection = typeof CONVERGENT_STRING_COLLECTIONS[number];

const ENTITY_COLLECTION_SET = new Set<string>(CONVERGENT_ENTITY_COLLECTIONS);
const STRING_COLLECTION_SET = new Set<string>(CONVERGENT_STRING_COLLECTIONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toJsonValue(value: unknown, label: string): JsonValue {
  try {
    return normalizeJsonValue(value);
  } catch {
    throw new Error(`${label} contains a value that cannot be represented as JSON`);
  }
}

function entityId(collection: ConvergentEntityCollection, value: Record<string, unknown>): string {
  const raw = collection === 'groupConfigs' ? value.path : value.id;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${collection} contains an entity without a stable identifier`);
  }
  return raw;
}

function entityJson(
  collection: ConvergentEntityCollection,
  value: Record<string, unknown>,
): JsonObject {
  const id = entityId(collection, value);
  const json = toJsonValue(value, `${collection}/${id}`);
  if (!isRecord(json)) throw new Error(`${collection}/${id} must be a JSON object`);
  return {
    ...json,
    id,
  } as JsonObject;
}

function payloadEntityValues(
  payload: SyncPayload,
  collection: ConvergentEntityCollection,
): Record<string, unknown>[] {
  const values = payload[collection];
  return Array.isArray(values) ? values as unknown as Record<string, unknown>[] : [];
}

function payloadStringValues(
  payload: SyncPayload,
  collection: ConvergentStringCollection,
): string[] {
  const values = payload[collection];
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string')
    : [];
}

function appendSettingMutations(
  value: unknown,
  path: string[],
  mutations: ConvergentMutation[],
): void {
  if (isRecord(value) && Object.keys(value).length > 0) {
    for (const key of Object.keys(value).sort()) {
      appendSettingMutations(value[key], [...path, key], mutations);
    }
    return;
  }
  if (path.length === 0 || value === undefined) return;
  mutations.push({
    kind: 'setting-set',
    path,
    value: toJsonValue(value, `settings.${path.join('.')}`),
  });
}

export function syncPayloadToConvergentMutations(payload: SyncPayload): ConvergentMutation[] {
  const mutations: ConvergentMutation[] = [];
  for (const collection of CONVERGENT_ENTITY_COLLECTIONS) {
    payloadEntityValues(payload, collection).forEach((value, position) => {
      const id = entityId(collection, value);
      mutations.push({
        kind: 'entity-upsert',
        collection,
        entityId: id,
        value: entityJson(collection, value),
        position,
      });
    });
  }
  for (const collection of CONVERGENT_STRING_COLLECTIONS) {
    payloadStringValues(payload, collection).forEach((value, position) => {
      mutations.push({ kind: 'string-entry-add', collection, value, position });
    });
  }
  appendSettingMutations(payload.settings, [], mutations);
  return mutations;
}

export function createConvergentSyncStateFromPayload(
  payload: SyncPayload,
  deviceId: string,
  now: number,
): ConvergentSyncStateV2 {
  return applyConvergentMutations(
    createConvergentSyncState(),
    deviceId,
    syncPayloadToConvergentMutations(payload),
    now,
  );
}

function requireKnownCollections(state: ConvergentSyncStateV2): void {
  for (const collection of Object.keys(state.collections)) {
    if (!ENTITY_COLLECTION_SET.has(collection)) {
      throw new Error(`Unsupported convergent entity collection: ${collection}`);
    }
  }
  for (const collection of Object.keys(state.stringCollections)) {
    if (!STRING_COLLECTION_SET.has(collection)) {
      throw new Error(`Unsupported convergent string collection: ${collection}`);
    }
  }
}

function collectionValues(
  collections: Record<string, JsonObject[]>,
  collection: ConvergentEntityCollection,
): JsonObject[] {
  return collections[collection] ?? [];
}

function typedCollection<T>(
  collections: Record<string, JsonObject[]>,
  collection: Exclude<ConvergentEntityCollection, 'groupConfigs'>,
): T[] {
  return collectionValues(collections, collection) as unknown as T[];
}

export function materializeSyncPayloadFromConvergentState(
  state: ConvergentSyncStateV2,
  options: {
    syncedAt: number;
    syncMeta?: SyncReliabilityMeta;
  },
): SyncPayload {
  requireKnownCollections(state);
  const materialized = materializeConvergentSyncState(state);
  const groupConfigs = collectionValues(materialized.collections, 'groupConfigs').map((value) => {
    const { id: _id, ...groupConfig } = value;
    return groupConfig as unknown as import('../models').GroupConfig;
  });
  const settings = Object.keys(materialized.settings).length > 0
    ? materialized.settings as unknown as NonNullable<SyncPayload['settings']>
    : undefined;
  return {
    hosts: typedCollection<import('../models').Host>(materialized.collections, 'hosts'),
    keys: typedCollection<import('../models').SSHKey>(materialized.collections, 'keys'),
    identities: typedCollection<import('../models').Identity>(materialized.collections, 'identities'),
    proxyProfiles: typedCollection<import('../models').ProxyProfile>(materialized.collections, 'proxyProfiles'),
    snippets: typedCollection<import('../models').Snippet>(materialized.collections, 'snippets'),
    customGroups: materialized.stringCollections.customGroups ?? [],
    snippetPackages: materialized.stringCollections.snippetPackages ?? [],
    notes: typedCollection<import('../models').VaultNote>(materialized.collections, 'notes'),
    noteGroups: materialized.stringCollections.noteGroups ?? [],
    portForwardingRules: typedCollection<import('../models').PortForwardingRule>(materialized.collections, 'portForwardingRules'),
    groupConfigs,
    settings,
    syncedAt: options.syncedAt,
    ...(options.syncMeta ? { syncMeta: options.syncMeta } : {}),
  };
}

function materializedEntity(
  payload: SyncPayload,
  collection: string,
  id: string,
): Record<string, unknown> | undefined {
  if (!ENTITY_COLLECTION_SET.has(collection)) return undefined;
  const values = payloadEntityValues(payload, collection as ConvergentEntityCollection);
  return values.find((value) => entityId(collection as ConvergentEntityCollection, value) === id);
}

function nestedSetting(payload: SyncPayload, path: string[]): unknown {
  let value: unknown = payload.settings;
  for (const segment of path) {
    if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

function stableUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableUnknown);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableUnknown(value[key])]),
    );
  }
  return value;
}

function materializedCloudFingerprint(payload: SyncPayload): string {
  return JSON.stringify(stableUnknown({
    ...Object.fromEntries(
      CONVERGENT_ENTITY_COLLECTIONS.map((collection) => [
        collection,
        payloadEntityValues(payload, collection),
      ]),
    ),
    ...Object.fromEntries(
      CONVERGENT_STRING_COLLECTIONS.map((collection) => [
        collection,
        payloadStringValues(payload, collection),
      ]),
    ),
    settings: payload.settings ?? {},
  }));
}

function assertMaterializedPayloadMatchesState(
  state: ConvergentSyncStateV2,
  payload: SyncPayload,
): void {
  const expected = materializeSyncPayloadFromConvergentState(state, { syncedAt: 0 });
  if (materializedCloudFingerprint(expected) !== materializedCloudFingerprint(payload)) {
    throw new Error('Convergent envelope does not match its materialized v1 snapshot');
  }
}

function compactRegister<T extends JsonValue>(
  register: MultiValueRegister<T>,
  materializedValue?: unknown,
  allowMaterializedValue = false,
): ConvergentEnvelopeRegister<T> {
  const winner = selectRegisterWinner(register);
  return {
    candidates: register.candidates.map((candidate): ConvergentEnvelopeCandidate<T> => {
      const base = {
        dot: { ...candidate.dot },
        context: candidate.context.map((dot) => ({ ...dot })),
        hlc: { ...candidate.hlc },
      };
      if (isTombstoneCandidate(candidate)) return { ...base, tombstone: true };
      if (
        allowMaterializedValue
        && winner
        && dotKey(candidate.dot) === dotKey(winner.dot)
        && isJsonValue(materializedValue)
        && jsonValuesEqual(candidate.value, materializedValue)
      ) {
        return { ...base, materialized: true };
      }
      return { ...base, value: cloneJson(candidate.value) };
    }),
  };
}

export function createConvergentSyncEnvelope(
  state: ConvergentSyncStateV2,
  materializedPayload: SyncPayload,
): ConvergentSyncEnvelopeV2 {
  const canonical = canonicalizeConvergentSyncState(state);
  requireKnownCollections(canonical);
  assertMaterializedPayloadMatchesState(canonical, materializedPayload);
  const collections = createEmptyRecord<ConvergentEnvelopeCollectionState>();
  for (const [collectionName, collection] of Object.entries(canonical.collections)) {
    const entities = createEmptyRecord<ConvergentEnvelopeEntityState>();
    for (const [id, entity] of Object.entries(collection.entities)) {
      const materialized = materializedEntity(materializedPayload, collectionName, id);
      const fields = createEmptyRecord<ConvergentEnvelopeRegister>();
      for (const [field, register] of Object.entries(entity.fields)) {
        setOwnRecordValue(fields, field, compactRegister(register, materialized?.[field], true));
      }
      setOwnRecordValue(entities, id, {
        presence: compactRegister(entity.presence),
        ...(entity.position ? { position: compactRegister(entity.position) } : {}),
        fields,
      });
    }
    setOwnRecordValue(collections, collectionName, { entities });
  }
  const settings = createEmptyRecord<ConvergentEnvelopeRegister>();
  for (const [encodedPath, register] of Object.entries(canonical.settings)) {
    setOwnRecordValue(settings, encodedPath, compactRegister(
      register,
      nestedSetting(materializedPayload, decodeSettingPath(encodedPath)),
      true,
    ));
  }
  const stringCollections = createEmptyRecord<ConvergentEnvelopeStringCollectionState>();
  for (const [collectionName, collection] of Object.entries(canonical.stringCollections)) {
    const entries = createEmptyRecord<ConvergentEnvelopeStringEntryState>();
    for (const [value, entry] of Object.entries(collection.entries)) {
      setOwnRecordValue(entries, value, {
        presence: compactRegister(entry.presence),
        ...(entry.position ? { position: compactRegister(entry.position) } : {}),
      });
    }
    setOwnRecordValue(stringCollections, collectionName, { entries });
  }
  return {
    schemaVersion: 2,
    encoding: 'materialized-winner-v1',
    state: {
      vector: Object.fromEntries(Object.entries(canonical.vector)),
      dotOrigins: Object.fromEntries(
        Object.entries(canonical.dotOrigins).map(([deviceId, origins]) => [deviceId, { ...origins }]),
      ),
      hlc: { ...canonical.hlc },
      collections,
      settings,
      stringCollections,
    },
  };
}

function hydrateRegister<T extends JsonValue>(
  register: ConvergentEnvelopeRegister<T>,
  materializedValue: unknown,
  label: string,
): MultiValueRegister<T> {
  if (!register || !Array.isArray(register.candidates) || register.candidates.length === 0) {
    throw new Error(`${label} has no candidates`);
  }
  return {
    candidates: register.candidates.map((candidate, index): RegisterCandidate<T> => {
      const candidateLabel = `${label}.candidates[${index}]`;
      const base = {
        dot: { ...candidate.dot },
        context: candidate.context.map((dot) => ({ ...dot })),
        hlc: { ...candidate.hlc },
      };
      if (
        candidate.tombstone !== undefined
        && candidate.tombstone !== true
        && candidate.tombstone !== false
      ) {
        throw new Error(`${candidateLabel} has an invalid tombstone marker`);
      }
      if (
        'materialized' in candidate
        && candidate.materialized !== undefined
        && candidate.materialized !== true
      ) {
        throw new Error(`${candidateLabel} has an invalid materialized marker`);
      }
      if (candidate.tombstone === true) {
        if ('materialized' in candidate || 'value' in candidate) {
          throw new Error(`${candidateLabel} tombstone contains a value marker`);
        }
        return { ...base, tombstone: true };
      }
      if ('materialized' in candidate && candidate.materialized === true) {
        if ('value' in candidate || !isJsonValue(materializedValue)) {
          throw new Error(`${candidateLabel} cannot reconstruct its materialized value`);
        }
        return { ...base, value: cloneJson(materializedValue) as T };
      }
      if (!('value' in candidate) || !isJsonValue(candidate.value)) {
        throw new Error(`${candidateLabel} is missing a JSON value`);
      }
      return { ...base, value: cloneJson(candidate.value) as T };
    }),
  };
}

function envelopeState(value: unknown): ConvergentEnvelopeStateV2 {
  if (!isRecord(value)) throw new Error('Convergent sync envelope state is invalid');
  return value as unknown as ConvergentEnvelopeStateV2;
}

export function hydrateConvergentSyncEnvelope(
  envelope: ConvergentSyncEnvelopeV2,
  materializedPayload: SyncPayload,
): ConvergentSyncStateV2 {
  if (
    !envelope
    || envelope.schemaVersion !== 2
    || envelope.encoding !== 'materialized-winner-v1'
  ) {
    throw new Error('Unsupported convergent sync envelope');
  }
  const encoded = envelopeState(envelope.state);
  const collections = createEmptyRecord<ConvergentSyncStateV2['collections'][string]>();
  for (const [collectionName, collection] of Object.entries(encoded.collections ?? {})) {
    if (!ENTITY_COLLECTION_SET.has(collectionName) || !isRecord(collection?.entities)) {
      throw new Error(`Unsupported or invalid convergent collection: ${collectionName}`);
    }
    const entities = createEmptyRecord<ConvergentSyncStateV2['collections'][string]['entities'][string]>();
    for (const [id, entity] of Object.entries(collection.entities)) {
      if (!isRecord(entity) || !isRecord(entity.fields)) {
        throw new Error(`Invalid convergent entity: ${collectionName}/${id}`);
      }
      const materialized = materializedEntity(materializedPayload, collectionName, id);
      const fields = createEmptyRecord<MultiValueRegister>();
      for (const [field, register] of Object.entries(entity.fields)) {
        setOwnRecordValue(fields, field, hydrateRegister(
          register,
          materialized?.[field],
          `${collectionName}/${id}/${field}`,
        ));
      }
      setOwnRecordValue(entities, id, {
        presence: hydrateRegister(entity.presence, true, `${collectionName}/${id}/presence`),
        ...(entity.position
          ? { position: hydrateRegister<CollectionPosition>(entity.position, undefined, `${collectionName}/${id}/position`) }
          : {}),
        fields,
      });
    }
    setOwnRecordValue(collections, collectionName, { entities });
  }
  const settings = createEmptyRecord<MultiValueRegister>();
  for (const [path, register] of Object.entries(encoded.settings ?? {})) {
    setOwnRecordValue(settings, path, hydrateRegister(
      register,
      nestedSetting(materializedPayload, decodeSettingPath(path)),
      `settings/${path}`,
    ));
  }
  const stringCollections = createEmptyRecord<ConvergentSyncStateV2['stringCollections'][string]>();
  for (const [collectionName, collection] of Object.entries(encoded.stringCollections ?? {})) {
    if (!STRING_COLLECTION_SET.has(collectionName) || !isRecord(collection?.entries)) {
      throw new Error(`Unsupported or invalid convergent string collection: ${collectionName}`);
    }
    const entries = createEmptyRecord<ConvergentSyncStateV2['stringCollections'][string]['entries'][string]>();
    for (const [value, entry] of Object.entries(collection.entries)) {
      if (!isRecord(entry)) throw new Error(`Invalid convergent string entry: ${collectionName}/${value}`);
      setOwnRecordValue(entries, value, {
        presence: hydrateRegister(entry.presence, true, `${collectionName}/${value}/presence`),
        ...(entry.position
          ? { position: hydrateRegister<CollectionPosition>(entry.position, undefined, `${collectionName}/${value}/position`) }
          : {}),
      });
    }
    setOwnRecordValue(stringCollections, collectionName, { entries });
  }
  const state: ConvergentSyncStateV2 = {
    schemaVersion: 2,
    vector: encoded.vector,
    dotOrigins: encoded.dotOrigins,
    hlc: encoded.hlc,
    collections,
    settings,
    stringCollections,
  };
  assertValidConvergentSyncState(state);
  const canonical = canonicalizeConvergentSyncState(state);
  assertMaterializedPayloadMatchesState(canonical, materializedPayload);
  return canonical;
}

export function withConvergentSyncEnvelope(
  state: ConvergentSyncStateV2,
  options: { syncedAt: number; syncMeta?: SyncReliabilityMeta },
): SyncPayload {
  const payload = materializeSyncPayloadFromConvergentState(state, options);
  return {
    ...payload,
    convergentSync: createConvergentSyncEnvelope(state, payload),
  };
}

export function validateConvergentSyncPayload(
  meta: Pick<SyncFileMeta, 'syncSchemaVersion'>,
  payload: SyncPayload,
): ConvergentSyncStateV2 | null {
  const schemaVersion = (meta as { syncSchemaVersion?: unknown }).syncSchemaVersion;
  if (schemaVersion === undefined) {
    if (payload.convergentSync !== undefined) {
      throw new Error('Convergent sync envelope is present without schema metadata');
    }
    return null;
  }
  if (schemaVersion !== 2) {
    throw new Error(`Unsupported sync schema version: ${String(schemaVersion)}`);
  }
  if (!payload.convergentSync) {
    throw new Error('Sync schema v2 payload is missing its convergent envelope');
  }
  return hydrateConvergentSyncEnvelope(payload.convergentSync, payload);
}

/** Prevent the legacy snapshot writer from silently erasing v2/future metadata. */
export function assertConvergentSyncWriteCompatible(
  remoteMeta: Pick<SyncFileMeta, 'syncSchemaVersion'> | null | undefined,
  outgoingPayload: SyncPayload,
): void {
  if (!remoteMeta) return;
  const remoteSchema = (remoteMeta as { syncSchemaVersion?: unknown }).syncSchemaVersion;
  if (remoteSchema === undefined) return;
  if (remoteSchema !== 2) {
    throw new Error(`Cannot overwrite unsupported sync schema version: ${String(remoteSchema)}`);
  }
  if (!outgoingPayload.convergentSync) {
    throw new Error(
      'Cloud data uses convergent sync v2. Enable or migrate convergent sync before uploading.',
    );
  }
}

export function stripConvergentSyncEnvelope(payload: SyncPayload): SyncPayload {
  const { convergentSync: _convergentSync, ...legacyPayload } = payload;
  return legacyPayload;
}
