export type CloudSyncStrategy = 'smartMerge' | 'preferCloud' | 'preferLocal';

export type CloudSyncConflictAction = 'smart-merge' | 'download-remote' | 'upload-local';

export const DEFAULT_CLOUD_SYNC_STRATEGY: CloudSyncStrategy = 'smartMerge';

const CLOUD_SYNC_STRATEGIES: readonly CloudSyncStrategy[] = [
  'smartMerge',
  'preferCloud',
  'preferLocal',
] as const;

export function normalizeCloudSyncStrategy(value: unknown): CloudSyncStrategy {
  return CLOUD_SYNC_STRATEGIES.includes(value as CloudSyncStrategy)
    ? value as CloudSyncStrategy
    : DEFAULT_CLOUD_SYNC_STRATEGY;
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
