import type { SyncPayload } from '../domain/sync';
import {
  STORAGE_KEY_LOCAL_VAULT_BACKUP_LAST_APP_VERSION,
  STORAGE_KEY_LOCAL_VAULT_BACKUP_MAX_COUNT,
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
  if (!hasMeaningfulSyncData(payload)) {
    return null;
  }

  const bridge = netcattyBridge.get();
  if (!bridge?.createVaultBackup) {
    return null;
  }

  const result = await bridge.createVaultBackup({
    payload,
    reason: options.reason,
    sourceAppVersion: options.sourceAppVersion,
    targetAppVersion: options.targetAppVersion,
    maxCount: options.maxCount ?? getLocalVaultBackupMaxCount(),
  });

  return result?.backup ?? null;
}

export async function createProtectiveLocalVaultBackup(
  payload: SyncPayload,
): Promise<LocalVaultBackupPreview | null> {
  return createLocalVaultBackup(payload, {
    reason: 'before_restore',
  });
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
