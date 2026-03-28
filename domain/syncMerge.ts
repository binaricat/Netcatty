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

import type { SyncPayload } from './sync';

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

    if (!inBase && inLocal && !inRemote) {
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

    if (!inBase) {
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
    snippets: [],
    customGroups: [],
    snippetPackages: [],
    knownHosts: [],
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

  // Merge each entity type
  const hosts = mergeEntityArrays(b.hosts ?? [], local.hosts ?? [], remote.hosts ?? []);
  const keys = mergeEntityArrays(b.keys ?? [], local.keys ?? [], remote.keys ?? []);
  const identities = mergeEntityArrays(b.identities ?? [], local.identities ?? [], remote.identities ?? []);
  const snippets = mergeEntityArrays(b.snippets ?? [], local.snippets ?? [], remote.snippets ?? []);
  const knownHostsRaw = mergeEntityArrays(b.knownHosts ?? [], local.knownHosts ?? [], remote.knownHosts ?? []);
  // Deduplicate known hosts by (hostname, port, keyType) since IDs are random per device
  const knownHostSeen = new Set<string>();
  const knownHosts = {
    ...knownHostsRaw,
    merged: knownHostsRaw.merged.filter((kh) => {
      const entry = kh as unknown as { hostname: string; port: number; keyType: string };
      const fp = `${entry.hostname}:${entry.port}:${entry.keyType}`;
      if (knownHostSeen.has(fp)) return false;
      knownHostSeen.add(fp);
      return true;
    }),
  };
  const portForwardingRules = mergeEntityArrays(
    b.portForwardingRules ?? [],
    local.portForwardingRules ?? [],
    remote.portForwardingRules ?? [],
  );

  // Aggregate stats
  const entityResults = [hosts, keys, identities, snippets, knownHosts, portForwardingRules];
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
  );
  const snippetPackages = mergeStringArrays(
    b.snippetPackages ?? [],
    local.snippetPackages ?? [],
    remote.snippetPackages ?? [],
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

  const payload: SyncPayload = {
    hosts: hosts.merged,
    keys: keys.merged,
    identities: identities.merged,
    snippets: snippets.merged,
    customGroups,
    snippetPackages,
    knownHosts: knownHosts.merged,
    portForwardingRules: portForwardingRules.merged,
    settings,
    syncedAt: Date.now(),
  };

  return {
    payload,
    hadConflicts: summary.modified.conflicts > 0,
    summary,
  };
}
