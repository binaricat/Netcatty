const MIN_RUNTIME_REMOTE_CHECK_MS = 30_000;
const MAX_RUNTIME_REMOTE_CHECK_MS = 5 * 60_000;

export function getRuntimeRemoteCheckIntervalMs(autoSyncIntervalMinutes: number): number {
  const configuredMs = Math.max(1, Number(autoSyncIntervalMinutes) || 1) * 60_000;
  return Math.max(
    MIN_RUNTIME_REMOTE_CHECK_MS,
    Math.min(MAX_RUNTIME_REMOTE_CHECK_MS, Math.floor(configuredMs / 2)),
  );
}

export interface RuntimeRemoteCheckInput {
  hasAnyConnectedProvider: boolean;
  autoSyncEnabled: boolean;
  isUnlocked: boolean;
  startupRemoteCheckDone: boolean;
  isSyncing: boolean;
  isSyncRunning: boolean;
  remoteCheckInFlight: boolean;
  force?: boolean;
  now: number;
  lastRemoteCheckAt: number | null;
  minIntervalMs: number;
}

export function shouldRunRuntimeRemoteCheck(input: RuntimeRemoteCheckInput): boolean {
  if (!input.hasAnyConnectedProvider) return false;
  if (!input.autoSyncEnabled) return false;
  if (!input.isUnlocked) return false;
  if (!input.startupRemoteCheckDone) return false;
  if (input.isSyncing || input.isSyncRunning || input.remoteCheckInFlight) return false;
  if (input.force === true) return true;
  if (input.lastRemoteCheckAt == null) return true;
  return input.now - input.lastRemoteCheckAt >= input.minIntervalMs;
}
