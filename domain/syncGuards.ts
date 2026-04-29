import type { SyncPayload } from './sync';

export type ShrinkFinding =
  | { suspicious: false }
  | {
      suspicious: true;
      reason: 'bulk-shrink' | 'large-shrink';
      entityType:
        | 'hosts'
        | 'keys'
        | 'identities'
        | 'snippets'
        | 'customGroups'
        | 'snippetPackages'
        | 'portForwardingRules'
        | 'groupConfigs';
      baseCount: number;
      outgoingCount: number;
      lost: number;
      /** True when the comparison reference was the current remote (base was null). */
      viaRemote?: boolean;
    };

// Keep in sync with all array-typed fields of SyncPayload. When a new
// array entity type is added there, add it here too — there is no
// compile-time check enforcing this.
const CHECKED_ENTITIES = [
  'hosts',
  'keys',
  'identities',
  'snippets',
  'customGroups',
  'snippetPackages',
  'portForwardingRules',
  'groupConfigs',
] as const;

type CheckedEntityType = typeof CHECKED_ENTITIES[number];

const BULK_SHRINK_RATIO = 0.5;
const BULK_SHRINK_MIN_ABSOLUTE = 3;
const LARGE_SHRINK_ABSOLUTE = 10;

function countOf(p: SyncPayload, key: CheckedEntityType): number {
  const v = p[key];
  return Array.isArray(v) ? v.length : 0;
}

export function detectSuspiciousShrink(
  outgoing: SyncPayload,
  base: SyncPayload | null,
  remote?: SyncPayload | null,
): ShrinkFinding {
  // Fall back to the current remote when we have no stored base — a null base
  // happens on first sync, after unlock key re-derivation, or when the base
  // blob failed to decrypt. Without this fallback, a degraded/empty local
  // payload would be admitted unconditionally and could overwrite populated
  // remote data (#779). We only use `remote` when `base` is unavailable so
  // legitimate resurrections (device that legitimately grew past an older
  // remote snapshot) remain unaffected.
  const reference = base ?? remote ?? null;
  const viaRemote = !base && !!remote;
  if (!reference) return { suspicious: false };

  for (const entityType of CHECKED_ENTITIES) {
    const baseCount = countOf(reference, entityType);
    const outgoingCount = countOf(outgoing, entityType);
    const lost = baseCount - outgoingCount;
    if (lost <= 0) continue;

    if (lost >= LARGE_SHRINK_ABSOLUTE) {
      return {
        suspicious: true,
        reason: 'large-shrink',
        entityType,
        baseCount,
        outgoingCount,
        lost,
        ...(viaRemote ? { viaRemote: true } : {}),
      };
    }

    if (baseCount > 0 && lost / baseCount >= BULK_SHRINK_RATIO && lost >= BULK_SHRINK_MIN_ABSOLUTE) {
      return {
        suspicious: true,
        reason: 'bulk-shrink',
        entityType,
        baseCount,
        outgoingCount,
        lost,
        ...(viaRemote ? { viaRemote: true } : {}),
      };
    }
  }

  return { suspicious: false };
}
