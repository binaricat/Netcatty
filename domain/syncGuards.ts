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
        | 'knownHosts'
        | 'portForwardingRules'
        | 'groupConfigs';
      baseCount: number;
      outgoingCount: number;
      lost: number;
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
  'knownHosts',
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
): ShrinkFinding {
  if (!base) return { suspicious: false };

  for (const entityType of CHECKED_ENTITIES) {
    const baseCount = countOf(base, entityType);
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
      };
    }
  }

  return { suspicious: false };
}
