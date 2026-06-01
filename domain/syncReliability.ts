import {
  CLOUD_SYNC_PAYLOAD_ENTITY_KEYS,
  type CloudSyncPayloadEntityKey,
  type SyncChangeEntityKey,
  type SyncChangeSummary,
  type SyncDeletionRecord,
  type SyncEntityChangeCounts,
  type SyncPayload,
  type SyncReliabilityMeta,
} from './sync';

type EntityValue = { id?: string; path?: string } | string;

export const SYNC_SNAPSHOT_LIMIT = 5;

const EMPTY_COUNTS = (): SyncEntityChangeCounts => ({
  added: { local: 0, remote: 0 },
  modified: { local: 0, remote: 0 },
  deleted: { local: 0, remote: 0 },
});
const OPTIONAL_ENTITY_KEYS = new Set<CloudSyncPayloadEntityKey>([
  'identities',
  'proxyProfiles',
  'snippetPackages',
  'portForwardingRules',
  'groupConfigs',
]);

function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = (v as Record<string, unknown>)[k];
        return acc;
      }, {});
    }
    return v;
  });
}

function entityId(value: EntityValue): string {
  return typeof value === 'string' ? value : value.id ?? value.path ?? '';
}

function entityMap(values: unknown): Map<string, EntityValue> {
  if (!Array.isArray(values)) return new Map();
  return new Map(
    values
      .filter((value): value is EntityValue =>
        typeof value === 'string'
        || (
          Boolean(value)
          && typeof value === 'object'
          && (
            typeof (value as { id?: unknown }).id === 'string'
            || typeof (value as { path?: unknown }).path === 'string'
          )
        ),
      )
      .map((value) => [entityId(value), value]),
  );
}

function payloadValues(
  payload: SyncPayload,
  entityType: CloudSyncPayloadEntityKey,
  base?: SyncPayload,
): unknown {
  if (
    base
    && OPTIONAL_ENTITY_KEYS.has(entityType)
    && !Object.prototype.hasOwnProperty.call(payload, entityType)
  ) {
    return base[entityType];
  }
  return payload[entityType];
}

function incrementEntity(
  summary: SyncChangeSummary,
  entityType: SyncChangeEntityKey,
  updater: (counts: SyncEntityChangeCounts) => void,
): void {
  const counts = summary.byEntity[entityType] ?? EMPTY_COUNTS();
  updater(counts);
  summary.byEntity[entityType] = counts;
}

function recordEntityChanges(
  summary: SyncChangeSummary,
  entityType: CloudSyncPayloadEntityKey,
  baseValues: unknown,
  localValues: unknown,
  remoteValues?: unknown,
): void {
  const base = entityMap(baseValues);
  const local = entityMap(localValues);
  const remote = remoteValues === undefined ? null : entityMap(remoteValues);
  const ids = new Set([
    ...base.keys(),
    ...local.keys(),
    ...(remote ? remote.keys() : []),
  ]);

  for (const id of ids) {
    const baseItem = base.get(id);
    const localItem = local.get(id);
    const remoteItem = remote?.get(id);
    const localAdded = !baseItem && Boolean(localItem);
    const localDeleted = Boolean(baseItem) && !localItem;
    const localModified = Boolean(baseItem && localItem)
      && fingerprint(baseItem) !== fingerprint(localItem);

    if (localAdded) {
      summary.hasLocalChanges = true;
      incrementEntity(summary, entityType, (counts) => { counts.added.local += 1; });
    }
    if (localDeleted) {
      summary.hasLocalChanges = true;
      incrementEntity(summary, entityType, (counts) => { counts.deleted.local += 1; });
    }
    if (localModified) {
      summary.hasLocalChanges = true;
      incrementEntity(summary, entityType, (counts) => { counts.modified.local += 1; });
    }

    if (!remote) continue;

    const remoteAdded = !baseItem && Boolean(remoteItem);
    const remoteDeleted = Boolean(baseItem) && !remoteItem;
    const remoteModified = Boolean(baseItem && remoteItem)
      && fingerprint(baseItem) !== fingerprint(remoteItem);

    if (remoteAdded) {
      summary.hasRemoteChanges = true;
      incrementEntity(summary, entityType, (counts) => { counts.added.remote += 1; });
    }
    if (remoteDeleted) {
      summary.hasRemoteChanges = true;
      incrementEntity(summary, entityType, (counts) => { counts.deleted.remote += 1; });
    }
    if (remoteModified) {
      summary.hasRemoteChanges = true;
      incrementEntity(summary, entityType, (counts) => { counts.modified.remote += 1; });
    }

    if (localAdded && remoteAdded && fingerprint(localItem) !== fingerprint(remoteItem)) {
      summary.hasConflicts = true;
      summary.conflicts.push({ entityType, id, kind: 'both-added' });
    } else if (localModified && remoteModified && fingerprint(localItem) !== fingerprint(remoteItem)) {
      summary.hasConflicts = true;
      summary.conflicts.push({ entityType, id, kind: 'both-modified' });
    } else if (localDeleted && remoteModified) {
      summary.hasConflicts = true;
      summary.conflicts.push({ entityType, id, kind: 'local-deleted-remote-modified' });
    } else if (remoteDeleted && localModified) {
      summary.hasConflicts = true;
      summary.conflicts.push({ entityType, id, kind: 'remote-deleted-local-modified' });
    }
  }
}

function recordSettingsChanges(
  summary: SyncChangeSummary,
  base: SyncPayload,
  local: SyncPayload,
  remote?: SyncPayload,
): void {
  const localChanged = fingerprint(local.settings) !== fingerprint(base.settings);
  const remoteChanged = remote !== undefined
    && fingerprint(remote.settings) !== fingerprint(base.settings);

  if (localChanged) {
    summary.hasLocalChanges = true;
    incrementEntity(summary, 'settings', (counts) => { counts.modified.local += 1; });
  }
  if (remoteChanged) {
    summary.hasRemoteChanges = true;
    incrementEntity(summary, 'settings', (counts) => { counts.modified.remote += 1; });
  }
  if (
    localChanged
    && remoteChanged
    && fingerprint(local.settings) !== fingerprint(remote?.settings)
  ) {
    summary.hasConflicts = true;
    summary.conflicts.push({ entityType: 'settings', kind: 'both-modified' });
  }
}

export function summarizeSyncChanges(
  base: SyncPayload | null,
  local: SyncPayload,
  remote?: SyncPayload,
): SyncChangeSummary {
  const reference = base ?? {
    hosts: [],
    keys: [],
    identities: [],
    proxyProfiles: [],
    snippets: [],
    customGroups: [],
    snippetPackages: [],
    portForwardingRules: [],
    groupConfigs: [],
    settings: undefined,
    syncedAt: 0,
  };
  const summary: SyncChangeSummary = {
    hasLocalChanges: false,
    hasRemoteChanges: false,
    hasConflicts: false,
    byEntity: {},
    conflicts: [],
  };

  for (const entityType of CLOUD_SYNC_PAYLOAD_ENTITY_KEYS) {
    recordEntityChanges(
      summary,
      entityType,
      reference[entityType],
      payloadValues(local, entityType, reference),
      remote ? payloadValues(remote, entityType, reference) : undefined,
    );
  }
  recordSettingsChanges(summary, reference, local, remote);

  return summary;
}

export function collectSyncDeletions(
  base: SyncPayload | null,
  current: SyncPayload,
  opts: { deletedAt: number; deviceId?: string },
): SyncDeletionRecord[] {
  if (!base) return [];
  const deletions: SyncDeletionRecord[] = [];

  for (const entityType of CLOUD_SYNC_PAYLOAD_ENTITY_KEYS) {
    const baseItems = entityMap(base[entityType]);
    const currentItems = entityMap(payloadValues(current, entityType, base));
    for (const id of baseItems.keys()) {
      if (!currentItems.has(id)) {
        deletions.push({
          entityType,
          id,
          deletedAt: opts.deletedAt,
          ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
        });
      }
    }
  }

  return deletions;
}

function mergeDeletionRecords(
  payload: SyncPayload,
  newDeletions: SyncDeletionRecord[],
): SyncDeletionRecord[] {
  const byKey = new Map<string, SyncDeletionRecord>();
  for (const record of [...(payload.syncMeta?.deletions ?? []), ...newDeletions]) {
    const currentItems = entityMap(payload[record.entityType]);
    if (currentItems.has(record.id)) continue;
    const key = `${record.entityType}:${record.id}`;
    const previous = byKey.get(key);
    if (!previous || record.deletedAt >= previous.deletedAt) {
      byKey.set(key, record);
    }
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.entityType.localeCompare(b.entityType) || a.id.localeCompare(b.id),
  );
}

export function withSyncReliabilityMeta(
  payload: SyncPayload,
  base: SyncPayload | null,
  opts: { deviceId?: string; now?: number } = {},
): SyncPayload {
  const generatedAt = opts.now ?? Date.now();
  const changeSummary = summarizeSyncChanges(base, payload);
  const deletions = mergeDeletionRecords(
    payload,
    collectSyncDeletions(base, payload, {
      deletedAt: generatedAt,
      ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
    }),
  );
  const meta: SyncReliabilityMeta = {
    schemaVersion: 1,
    generatedAt,
    ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
    ...(base?.syncedAt ? { baseSyncedAt: base.syncedAt } : {}),
    localChanged: changeSummary.hasLocalChanges,
    deletions,
    changeSummary,
  };

  return {
    ...payload,
    syncMeta: meta,
  };
}

export function carryForwardSyncDeletions(
  payload: SyncPayload,
  sources: SyncPayload[],
  opts: { generatedAt?: number; deviceId?: string } = {},
): SyncPayload {
  const sourceDeletions = sources.flatMap((source) => source.syncMeta?.deletions ?? []);
  const deletions = mergeDeletionRecords(
    {
      ...payload,
      syncMeta: {
        schemaVersion: 1,
        generatedAt: opts.generatedAt ?? Date.now(),
        ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
        localChanged: false,
        deletions: sourceDeletions,
        changeSummary: summarizeSyncChanges(null, payload),
      },
    },
    [],
  );

  if (deletions.length === 0) return payload;

  return {
    ...payload,
    syncMeta: {
      schemaVersion: 1,
      generatedAt: opts.generatedAt ?? Date.now(),
      ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
      localChanged: false,
      deletions,
      changeSummary: summarizeSyncChanges(null, payload),
    },
  };
}

export function getDeletedEntityIds(
  payload: SyncPayload,
  entityType: CloudSyncPayloadEntityKey,
): Set<string> {
  return new Set(
    (payload.syncMeta?.deletions ?? [])
      .filter((record) => record.entityType === entityType)
      .map((record) => record.id),
  );
}
