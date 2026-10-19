/**
 * - `smartMerge`        — three-way merge; deletions propagate (legacy default)
 * - `smartMergePreserve` — three-way merge that never propagates a one-sided
 *   deletion; an entity survives until *both* devices dropped it. Use when the
 *   same vault is edited from sessions, restores or partially-loaded states
 *   where a missing entry must not be read as "the user deleted this".
 * - `preferCloud` / `preferLocal` — whole-payload side wins
 */
export type CloudSyncStrategy =
  | 'smartMerge'
  | 'smartMergePreserve'
  | 'preferCloud'
  | 'preferLocal';

export type CloudSyncConflictAction = 'smart-merge' | 'download-remote' | 'upload-local';

export const DEFAULT_CLOUD_SYNC_STRATEGY: CloudSyncStrategy = 'smartMerge';

const CLOUD_SYNC_STRATEGIES: readonly CloudSyncStrategy[] = [
  'smartMerge',
  'smartMergePreserve',
  'preferCloud',
  'preferLocal',
] as const;

export function normalizeCloudSyncStrategy(value: unknown): CloudSyncStrategy {
  return CLOUD_SYNC_STRATEGIES.includes(value as CloudSyncStrategy)
    ? value as CloudSyncStrategy
    : DEFAULT_CLOUD_SYNC_STRATEGY;
}

/** True when the strategy merges with non-destructive (keep-all) semantics. */
export function isPreserveDeletionsStrategy(strategy: CloudSyncStrategy): boolean {
  return strategy === 'smartMergePreserve';
}

export function resolveCloudSyncConflictAction(
  strategy: CloudSyncStrategy,
  remoteState: { hasConflict: boolean; hasRemoteFile: boolean },
): CloudSyncConflictAction {
  if (!remoteState.hasConflict || !remoteState.hasRemoteFile) {
    return 'upload-local';
  }

  if (strategy === 'preferCloud') {
    return 'download-remote';
  }

  if (strategy === 'preferLocal') {
    return 'upload-local';
  }

  return 'smart-merge';
}
