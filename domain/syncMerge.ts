/**
 * Three-Way Merge for Cloud Sync Payloads
 *
 * Implements a Git-style three-way merge using a stored "base" snapshot
 * (the last successfully synced payload) to detect per-entity changes
 * on both the local and remote sides.
 *
 * Algorithm:
 *   For each entity (identified by `id`):
 *     - Only in local  → local addition  → keep
 *     - Only in remote → remote addition → keep
 *     - In base, removed locally   → local deletion  → remove (unless remote modified)
 *     - In base, removed remotely  → remote deletion → remove (unless local modified)
 *     - Modified only locally      → keep local version
 *     - Modified only remotely     → keep remote version
 *     - Modified on both sides     → prefer local (conflict logged)
 *
 * When no base is available (first sync), falls back to a set-union
 * merge by entity ID, preferring local for duplicates.
 */

import { carryForwardSyncDeletions, getDeletedEntityIds } from './syncReliability';
import type { CloudSyncPayloadEntityKey, SyncPayload } from './sync';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface MergeSummary {
  added: { local: number; remote: number };
  deleted: { local: number; remote: number };
  modified: { local: number; remote: number; conflicts: number };
}

interface MergeResult {
  payload: SyncPayload;
  /** True when both sides modified the same entity (resolved by preferring local) */
  hadConflicts: boolean;
  summary: MergeSummary;
}

const OPTIONAL_ENTITY_KEYS = new Set<CloudSyncPayloadEntityKey>([
  'identities',
  'proxyProfiles',
  'snippetPackages',
  'notes',
  'noteGroups',
  'portForwardingRules',
  'groupConfigs',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON string for content comparison.
 * Sorts object keys to avoid false diffs from key ordering.
 */
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

function entityArray<T>(
  payload: SyncPayload,
  key: CloudSyncPayloadEntityKey,
  fallback: T[],
): T[] {
  if (
    OPTIONAL_ENTITY_KEYS.has(key)
    && !Object.prototype.hasOwnProperty.call(payload, key)
  ) {
    return fallback;
  }
  const value = payload[key];
  return Array.isArray(value) ? value as T[] : [];
}

// ---------------------------------------------------------------------------
// Entity-array merge (hosts, keys, identities, snippets, etc.)
// ---------------------------------------------------------------------------

interface EntityMergeResult<T> {
  merged: T[];
  conflicts: number;
  added: { local: number; remote: number };
  deleted: { local: number; remote: number };
  modified: { local: number; remote: number };
}

function mergeEntityArrays<T extends { id: string }>(
  base: T[],
  local: T[],
  remote: T[],
  tombstones?: { local: Set<string>; remote: Set<string> },
): EntityMergeResult<T> {
  const baseMap = new Map(base.map((e) => [e.id, e]));
  const localMap = new Map(local.map((e) => [e.id, e]));
  const remoteMap = new Map(remote.map((e) => [e.id, e]));

  const allIds = new Set([
    ...baseMap.keys(),
    ...localMap.keys(),
    ...remoteMap.keys(),
  ]);

  const merged: T[] = [];
  let conflicts = 0;
  const added = { local: 0, remote: 0 };
  const deleted = { local: 0, remote: 0 };
  const modified = { local: 0, remote: 0 };

  for (const id of allIds) {
    const baseItem = baseMap.get(id);
    const localItem = localMap.get(id);
    const remoteItem = remoteMap.get(id);

    const inBase = baseItem !== undefined;
    const inLocal = localItem !== undefined;
    const inRemote = remoteItem !== undefined;

    if (!inBase && inLocal && !inRemote && tombstones?.remote.has(id)) {
      // Remote explicitly records this entity as deleted. When no base is
      // available, this tombstone is the only durable signal that absence is
      // intentional rather than an old client omitting the entity.
      deleted.remote++;
    } else if (!inBase && !inLocal && inRemote && tombstones?.local.has(id)) {
      deleted.local++;
    } else if (!inBase && inLocal && !inRemote) {
      // Local addition
      merged.push(localItem);
      added.local++;
    } else if (!inBase && !inLocal && inRemote) {
      // Remote addition
      merged.push(remoteItem);
      added.remote++;
    } else if (!inBase && inLocal && inRemote) {
      // Both added same ID — prefer local
      merged.push(localItem);
      if (fingerprint(localItem) !== fingerprint(remoteItem)) {
        conflicts++;
      }
    } else if (inBase && inLocal && inRemote) {
      // Exists in all three — compare changes
      const localChanged = fingerprint(localItem) !== fingerprint(baseItem);
      const remoteChanged = fingerprint(remoteItem) !== fingerprint(baseItem);

      if (!localChanged && !remoteChanged) {
        merged.push(baseItem);
      } else if (localChanged && !remoteChanged) {
        merged.push(localItem);
        modified.local++;
      } else if (!localChanged && remoteChanged) {
        merged.push(remoteItem);
        modified.remote++;
      } else {
        // Both changed — prefer local
        merged.push(localItem);
        if (fingerprint(localItem) !== fingerprint(remoteItem)) {
          conflicts++;
        }
        modified.local++;
        modified.remote++;
      }
    } else if (inBase && !inLocal && inRemote) {
      // Local deleted
      const remoteChanged = fingerprint(remoteItem) !== fingerprint(baseItem);
      if (remoteChanged) {
        // Remote modified + local deleted → keep modification (safer)
        merged.push(remoteItem);
        conflicts++;
      } else {
        deleted.local++;
      }
    } else if (inBase && inLocal && !inRemote) {
      // Remote deleted
      const localChanged = fingerprint(localItem) !== fingerprint(baseItem);
      if (localChanged) {
        // Local modified + remote deleted → keep modification (safer)
        merged.push(localItem);
        conflicts++;
      } else {
        deleted.remote++;
      }
    }
    // inBase && !inLocal && !inRemote → both deleted → gone
  }

  return { merged, conflicts, added, deleted, modified };
}

// ---------------------------------------------------------------------------
// String-array merge (customGroups, snippetPackages)
// ---------------------------------------------------------------------------

function mergeStringArrays(
  base: string[],
  local: string[],
  remote: string[],
  tombstones?: { local: Set<string>; remote: Set<string> },
): string[] {
  const baseSet = new Set(base);
  const localSet = new Set(local);
  const remoteSet = new Set(remote);

  const result = new Set<string>();

  // Start with base items, then apply additions/deletions
  const allValues = new Set([...baseSet, ...localSet, ...remoteSet]);

  for (const value of allValues) {
    const inBase = baseSet.has(value);
    const inLocal = localSet.has(value);
    const inRemote = remoteSet.has(value);

    if (!inBase && inLocal && !inRemote && tombstones?.remote.has(value)) {
      // Remote tombstone wins over a stale local value when no base exists.
    } else if (!inBase && !inLocal && inRemote && tombstones?.local.has(value)) {
      // Local tombstone wins over a stale remote value when no base exists.
    } else if (!inBase) {
      // Addition — keep if either side added it
      if (inLocal || inRemote) result.add(value);
    } else {
      // Was in base — keep unless both sides deleted
      const localDeleted = !inLocal;
      const remoteDeleted = !inRemote;
      if (localDeleted && remoteDeleted) {
        // Both deleted — gone
      } else if (localDeleted || remoteDeleted) {
        // Only one side deleted — honour the deletion
        // (If the other side didn't touch it, it's still in their set from base)
      } else {
        result.add(value);
      }
    }
  }

  return [...result];
}

// ---------------------------------------------------------------------------
// Settings merge (flat key-value)
// ---------------------------------------------------------------------------

type SettingsObj = NonNullable<SyncPayload['settings']>;

/** Check if an array contains objects with `id` fields (for entity merge). */
function isIdArray(arr: unknown[]): boolean {
  return arr.length > 0 && typeof arr[0] === 'object' && arr[0] !== null && 'id' in arr[0];
}

/** Recursively merge two plain objects against a base using three-way logic. */
function mergeSettingsDeep(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
): Record<string, unknown> {
  const allKeys = new Set([
    ...Object.keys(base),
    ...Object.keys(local),
    ...Object.keys(remote),
  ]);
  const merged: Record<string, unknown> = {};
  for (const key of allKeys) {
    const bVal = base[key];
    const lVal = local[key];
    const rVal = remote[key];
    const lChanged = fingerprint(lVal) !== fingerprint(bVal);
    const rChanged = fingerprint(rVal) !== fingerprint(bVal);

    if (!lChanged && !rChanged) {
      if (bVal !== undefined) merged[key] = bVal;
    } else if (lChanged && !rChanged) {
      if (lVal !== undefined) merged[key] = lVal;
    } else if (!lChanged && rChanged) {
      if (rVal !== undefined) merged[key] = rVal;
    } else {
      // Both changed — recurse if both are plain objects, else prefer local
      if (
        lVal && rVal &&
        typeof lVal === 'object' && !Array.isArray(lVal) &&
        typeof rVal === 'object' && !Array.isArray(rVal)
      ) {
        merged[key] = mergeSettingsDeep(
          (bVal && typeof bVal === 'object' && !Array.isArray(bVal) ? bVal : {}) as Record<string, unknown>,
          lVal as Record<string, unknown>,
          rVal as Record<string, unknown>,
        );
      } else if (lVal !== undefined) {
        merged[key] = lVal;
      }
    }
  }
  return merged;
}

function mergeSettings(
  base: SettingsObj | undefined,
  local: SettingsObj | undefined,
  remote: SettingsObj | undefined,
): SettingsObj | undefined {
  if (!local && !remote) return undefined;
  if (!local) return remote;
  if (!remote) return local;

  const b = base ?? {};
  const allKeys = new Set([
    ...Object.keys(b),
    ...Object.keys(local),
    ...Object.keys(remote),
  ]);

  const merged: Record<string, unknown> = {};

  for (const key of allKeys) {
    const bVal = (b as Record<string, unknown>)[key];
    const lVal = (local as Record<string, unknown>)[key];
    const rVal = (remote as Record<string, unknown>)[key];

    const lChanged = fingerprint(lVal) !== fingerprint(bVal);
    const rChanged = fingerprint(rVal) !== fingerprint(bVal);

    if (!lChanged && !rChanged) {
      if (bVal !== undefined) merged[key] = bVal;
    } else if (lChanged && !rChanged) {
      if (lVal !== undefined) merged[key] = lVal;
    } else if (!lChanged && rChanged) {
      if (rVal !== undefined) merged[key] = rVal;
    } else {
      // Both changed — deep merge if both are plain objects, else prefer local
      if (
        lVal && rVal &&
        typeof lVal === 'object' && !Array.isArray(lVal) &&
        typeof rVal === 'object' && !Array.isArray(rVal)
      ) {
        merged[key] = mergeSettingsDeep(
          (bVal && typeof bVal === 'object' && !Array.isArray(bVal) ? bVal : {}) as Record<string, unknown>,
          lVal as Record<string, unknown>,
          rVal as Record<string, unknown>,
        );
      } else if (
        Array.isArray(lVal) && Array.isArray(rVal) &&
        (isIdArray(lVal) || isIdArray(rVal) || isIdArray(Array.isArray(bVal) ? bVal as unknown[] : []))
      ) {
        // Array of objects with `id` (e.g. customTerminalThemes) — entity merge
        const bArr = Array.isArray(bVal) ? bVal as Array<{ id: string }> : [];
        const result = mergeEntityArrays(bArr, lVal as Array<{ id: string }>, rVal as Array<{ id: string }>);
        merged[key] = result.merged;
      } else if (lVal !== undefined) {
        merged[key] = lVal;
      }
    }
  }

  return Object.keys(merged).length > 0 ? (merged as SettingsObj) : undefined;
}

// ---------------------------------------------------------------------------
// Main merge function
// ---------------------------------------------------------------------------

/**
 * Three-way merge of sync payloads.
 *
 * @param base  - The last successfully synced payload (null if unavailable)
 * @param local - The current device's data
 * @param remote - The other device's data (downloaded from cloud)
 */
export function mergeSyncPayloads(
  base: SyncPayload | null,
  local: SyncPayload,
  remote: SyncPayload,
): MergeResult {
  const emptyBase: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    proxyProfiles: [],
    snippets: [],
    customGroups: [],
    snippetPackages: [],
    notes: [],
    noteGroups: [],
    portForwardingRules: [],
    settings: undefined,
    syncedAt: 0,
  };
  const b = base ?? emptyBase;

  const summary: MergeSummary = {
    added: { local: 0, remote: 0 },
    deleted: { local: 0, remote: 0 },
    modified: { local: 0, remote: 0, conflicts: 0 },
  };
  const tombstones = (entityType: CloudSyncPayloadEntityKey) => ({
    local: getDeletedEntityIds(local, entityType),
    remote: getDeletedEntityIds(remote, entityType),
  });

  // Merge each entity type
  const hosts = mergeEntityArrays(b.hosts ?? [], local.hosts ?? [], remote.hosts ?? [], tombstones('hosts'));
  const keys = mergeEntityArrays(b.keys ?? [], local.keys ?? [], remote.keys ?? [], tombstones('keys'));
  const baseIdentities = b.identities ?? [];
  const identities = mergeEntityArrays(
    baseIdentities,
    entityArray(local, 'identities', baseIdentities),
    entityArray(remote, 'identities', baseIdentities),
    tombstones('identities'),
  );
  const baseProxyProfiles = b.proxyProfiles ?? [];
  const proxyProfiles = mergeEntityArrays(
    baseProxyProfiles,
    entityArray(local, 'proxyProfiles', baseProxyProfiles),
    entityArray(remote, 'proxyProfiles', baseProxyProfiles),
    tombstones('proxyProfiles'),
  );
  const snippets = mergeEntityArrays(b.snippets ?? [], local.snippets ?? [], remote.snippets ?? [], tombstones('snippets'));
  const baseNotes = b.notes ?? [];
  const notes = mergeEntityArrays(
    baseNotes,
    entityArray(local, 'notes', baseNotes),
    entityArray(remote, 'notes', baseNotes),
    tombstones('notes'),
  );
  const basePortForwardingRules = b.portForwardingRules ?? [];
  const portForwardingRules = mergeEntityArrays(
    basePortForwardingRules,
    entityArray(local, 'portForwardingRules', basePortForwardingRules),
    entityArray(remote, 'portForwardingRules', basePortForwardingRules),
    tombstones('portForwardingRules'),
  );

  // Merge group configs (keyed by path — wrap with virtual id for entity merge)
  type GCWithId = import('./models').GroupConfig & { id: string };
  const wrapGC = (arr: import('./models').GroupConfig[] | undefined): GCWithId[] =>
    (arr ?? []).map(gc => ({ ...gc, id: gc.path }));
  const unwrapGC = (arr: GCWithId[]): import('./models').GroupConfig[] =>
    arr.map(({ id: _id, ...rest }) => rest as import('./models').GroupConfig);
  const baseGroupConfigs = b.groupConfigs ?? [];
  const groupConfigsResult = mergeEntityArrays(
    wrapGC(baseGroupConfigs),
    wrapGC(entityArray(local, 'groupConfigs', baseGroupConfigs)),
    wrapGC(entityArray(remote, 'groupConfigs', baseGroupConfigs)),
    tombstones('groupConfigs'),
  );

  // Aggregate stats
  const entityResults: Pick<EntityMergeResult<unknown>, 'added' | 'deleted' | 'modified' | 'conflicts'>[] =
    [hosts, keys, identities, proxyProfiles, snippets, notes, portForwardingRules, groupConfigsResult];
  for (const r of entityResults) {
    summary.added.local += r.added.local;
    summary.added.remote += r.added.remote;
    summary.deleted.local += r.deleted.local;
    summary.deleted.remote += r.deleted.remote;
    summary.modified.local += r.modified.local;
    summary.modified.remote += r.modified.remote;
    summary.modified.conflicts += r.conflicts;
  }

  // Merge string arrays
  const customGroups = mergeStringArrays(
    b.customGroups ?? [],
    local.customGroups ?? [],
    remote.customGroups ?? [],
    tombstones('customGroups'),
  );
  const baseSnippetPackages = b.snippetPackages ?? [];
  const snippetPackages = mergeStringArrays(
    baseSnippetPackages,
    entityArray<string>(local, 'snippetPackages', baseSnippetPackages),
    entityArray<string>(remote, 'snippetPackages', baseSnippetPackages),
    tombstones('snippetPackages'),
  );
  const baseNoteGroups = b.noteGroups ?? [];
  const noteGroups = mergeStringArrays(
    baseNoteGroups,
    entityArray<string>(local, 'noteGroups', baseNoteGroups),
    entityArray<string>(remote, 'noteGroups', baseNoteGroups),
    tombstones('noteGroups'),
  );

  // Merge settings
  const settings = mergeSettings(b.settings, local.settings, remote.settings);

  // Deduplicate global SFTP bookmarks by path (IDs are random per device)
  if (settings?.sftpGlobalBookmarks && settings.sftpGlobalBookmarks.length > 0) {
    const seenPaths = new Set<string>();
    settings.sftpGlobalBookmarks = settings.sftpGlobalBookmarks.filter((bm) => {
      if (seenPaths.has(bm.path)) return false;
      seenPaths.add(bm.path);
      return true;
    });
  }

  const groupConfigs = unwrapGC(groupConfigsResult.merged);

  const payload: SyncPayload = carryForwardSyncDeletions({
    hosts: hosts.merged,
    keys: keys.merged,
    identities: identities.merged,
    proxyProfiles: proxyProfiles.merged,
    snippets: snippets.merged,
    customGroups,
    snippetPackages,
    notes: notes.merged,
    noteGroups,
    portForwardingRules: portForwardingRules.merged,
    groupConfigs,
    settings,
    syncedAt: Date.now(),
  }, [local, remote]);

  return {
    payload,
    hadConflicts: summary.modified.conflicts > 0,
    summary,
  };
}
