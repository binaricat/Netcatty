export type AutoSyncHashDecision = 'skip-applied' | 'unchanged' | 'sync';

export function resolveAutoSyncHashDecision({
  currentHash,
  lastSyncedHash,
  appliedSkipHash,
}: {
  currentHash: string;
  lastSyncedHash: string;
  appliedSkipHash: string | null;
}): AutoSyncHashDecision {
  if (appliedSkipHash !== null) {
    return currentHash === appliedSkipHash ? 'skip-applied' : 'sync';
  }
  return currentHash === lastSyncedHash ? 'unchanged' : 'sync';
}
