import type { SyncPayload } from '../domain/sync';
import {
  STORAGE_KEY_LOCAL_VAULT_BACKUP_LAST_APP_VERSION,
  STORAGE_KEY_LOCAL_VAULT_BACKUP_MAX_COUNT,
  STORAGE_KEY_VAULT_RESTORE_IN_PROGRESS_UNTIL,
} from '../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../infrastructure/persistence/localStorageAdapter';
import { netcattyBridge } from '../infrastructure/services/netcattyBridge';
import { hasMeaningfulSyncData } from './syncPayload';

export type LocalVaultBackupReason = 'app_version_change' | 'before_restore';

export interface LocalVaultBackupPreview {
  id: string;
  createdAt: number;
  reason: LocalVaultBackupReason;
  sourceAppVersion?: string;
  targetAppVersion?: string;
  fingerprint: string;
  preview: {
    hostCount: number;
    keyCount: number;
    snippetCount: number;
    identityCount: number;
    portForwardingRuleCount: number;
  };
}

export interface LocalVaultBackupDetails {
  backup: LocalVaultBackupPreview;
  payload: SyncPayload;
}

export const DEFAULT_LOCAL_VAULT_BACKUP_MAX_COUNT = 20;
export const MIN_LOCAL_VAULT_BACKUP_MAX_COUNT = 1;
export const MAX_LOCAL_VAULT_BACKUP_MAX_COUNT = 100;

export const sanitizeLocalVaultBackupMaxCount = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_LOCAL_VAULT_BACKUP_MAX_COUNT;
  return Math.max(
    MIN_LOCAL_VAULT_BACKUP_MAX_COUNT,
    Math.min(MAX_LOCAL_VAULT_BACKUP_MAX_COUNT, Math.round(value)),
  );
};

export const getLocalVaultBackupMaxCount = (): number => {
  const stored = localStorageAdapter.readNumber(STORAGE_KEY_LOCAL_VAULT_BACKUP_MAX_COUNT);
  return sanitizeLocalVaultBackupMaxCount(
    stored ?? DEFAULT_LOCAL_VAULT_BACKUP_MAX_COUNT,
  );
};

export const setLocalVaultBackupMaxCount = (value: number): number => {
  const sanitized = sanitizeLocalVaultBackupMaxCount(value);
  localStorageAdapter.writeNumber(STORAGE_KEY_LOCAL_VAULT_BACKUP_MAX_COUNT, sanitized);
  return sanitized;
};

export async function trimLocalVaultBackups(maxCount = getLocalVaultBackupMaxCount()): Promise<void> {
  const bridge = netcattyBridge.get();
  await bridge?.trimVaultBackups?.({ maxCount });
}

export async function getLocalVaultBackupCapabilities(): Promise<{
  encryptionAvailable: boolean;
}> {
  const bridge = netcattyBridge.get();
  const caps = await bridge?.getVaultBackupCapabilities?.();
  // Conservatively treat a missing bridge (non-Electron environments, early
  // boot) as unavailable so callers fall back to the locked-down UI path
  // instead of assuming capabilities they can't verify.
  return { encryptionAvailable: Boolean(caps?.encryptionAvailable) };
}

export async function listLocalVaultBackups(): Promise<LocalVaultBackupPreview[]> {
  const bridge = netcattyBridge.get();
  const entries = await bridge?.listVaultBackups?.();
  return Array.isArray(entries) ? entries : [];
}

export async function readLocalVaultBackup(id: string): Promise<LocalVaultBackupDetails | null> {
  const bridge = netcattyBridge.get();
  if (!bridge?.readVaultBackup) return null;
  return bridge.readVaultBackup({ id });
}

export async function openLocalVaultBackupDir(): Promise<void> {
  const bridge = netcattyBridge.get();
  await bridge?.openVaultBackupDir?.();
}

export async function createLocalVaultBackup(
  payload: SyncPayload,
  options: {
    reason: LocalVaultBackupReason;
    sourceAppVersion?: string;
    targetAppVersion?: string;
    maxCount?: number;
  },
): Promise<LocalVaultBackupPreview | null> {
  // Intentional: an empty-vault backup has nothing to restore from, so we
  // early-return instead of writing a zero-entry record. Callers that rely
  // on a backup (protective-before-restore, version-change on first run)
  // must treat `null` as "no safety net this time" and continue — blocking
  // the user's flow on a missing backup would be worse than allowing the
  // apply to proceed without one.
  if (!hasMeaningfulSyncData(payload)) {
    return null;
  }

  const bridge = netcattyBridge.get();
  if (!bridge?.createVaultBackup) {
    return null;
  }

  try {
    const result = await bridge.createVaultBackup({
      payload,
      reason: options.reason,
      sourceAppVersion: options.sourceAppVersion,
      targetAppVersion: options.targetAppVersion,
      maxCount: options.maxCount ?? getLocalVaultBackupMaxCount(),
    });
    return result?.backup ?? null;
  } catch (error) {
    // The main-process bridge refuses to write backups when safeStorage is
    // unavailable (VAULT_BACKUP_ENCRYPTION_UNAVAILABLE) because SyncPayload
    // carries plaintext credentials that must never touch disk unencrypted.
    // Callers (startup version-change, protective-before-restore) intentionally
    // continue without a backup rather than blocking the user's flow, so we
    // log and return null here.
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[localVaultBackups] Backup skipped:', message);
    return null;
  }
}

export async function createProtectiveLocalVaultBackup(
  payload: SyncPayload,
): Promise<LocalVaultBackupPreview | null> {
  return createLocalVaultBackup(payload, {
    reason: 'before_restore',
  });
}

/**
 * How long to hold the cross-window restore barrier. Long enough to
 * cover a slow protective-backup write + applySyncPayload on a large
 * vault, short enough that an abandoned lock (crashed window) clears
 * itself without user intervention.
 */
const RESTORE_BARRIER_HOLD_MS = 60_000;

/**
 * Run `task` while holding a cross-window "restore in progress" barrier.
 *
 * The barrier is a localStorage key readable by every window of the same
 * origin. useAutoSync reads it on each auto-sync and on each data-change
 * debounce tick, refusing to push while the deadline is still in the
 * future. We write a time-bounded deadline (rather than a boolean) so a
 * crashed window can never leave sync permanently wedged.
 *
 * Always clears the barrier — success, throw, or crash-after-set — via
 * a try/finally around the caller's task. The caller is responsible for
 * the actual vault mutation inside `task`.
 */
export async function withRestoreBarrier<T>(
  task: () => Promise<T>,
  holdMs: number = RESTORE_BARRIER_HOLD_MS,
): Promise<T> {
  const deadline = Date.now() + holdMs;
  try {
    localStorageAdapter.writeNumber(STORAGE_KEY_VAULT_RESTORE_IN_PROGRESS_UNTIL, deadline);
  } catch (error) {
    // If we can't write the barrier we still proceed — the UI-side
    // `isSyncBusy` guard and same-window debounce cancellation are a
    // secondary defense. Better to complete the restore than refuse on
    // a broken localStorage.
    console.warn('[localVaultBackups] Failed to set restore barrier:', error);
  }
  try {
    return await task();
  } finally {
    try {
      localStorageAdapter.writeNumber(STORAGE_KEY_VAULT_RESTORE_IN_PROGRESS_UNTIL, 0);
    } catch {
      /* ignore — the deadline will expire naturally */
    }
  }
}

export async function ensureVersionChangeBackup(
  payload: SyncPayload,
  currentAppVersion: string | null | undefined,
): Promise<{ created: boolean; backup: LocalVaultBackupPreview | null }> {
  const normalizedVersion = currentAppVersion?.trim() || '';
  if (!normalizedVersion) {
    return { created: false, backup: null };
  }

  const previousVersion =
    localStorageAdapter.readString(STORAGE_KEY_LOCAL_VAULT_BACKUP_LAST_APP_VERSION)?.trim() || '';

  if (!previousVersion) {
    localStorageAdapter.writeString(STORAGE_KEY_LOCAL_VAULT_BACKUP_LAST_APP_VERSION, normalizedVersion);
    return { created: false, backup: null };
  }

  if (previousVersion === normalizedVersion) {
    return { created: false, backup: null };
  }

  let backup: LocalVaultBackupPreview | null = null;
  if (hasMeaningfulSyncData(payload)) {
    backup = await createLocalVaultBackup(payload, {
      reason: 'app_version_change',
      sourceAppVersion: previousVersion,
      targetAppVersion: normalizedVersion,
    });
  }

  localStorageAdapter.writeString(STORAGE_KEY_LOCAL_VAULT_BACKUP_LAST_APP_VERSION, normalizedVersion);

  return {
    created: Boolean(backup),
    backup,
  };
}
