import type { SyncPayload } from '../domain/sync';
import {
  STORAGE_KEY_LOCAL_VAULT_BACKUP_LAST_APP_VERSION,
  STORAGE_KEY_LOCAL_VAULT_BACKUP_MAX_COUNT,
  STORAGE_KEY_VAULT_APPLY_IN_PROGRESS,
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

/**
 * Thrown when a caller requires a protective backup and the backup
 * couldn't be written — safeStorage unavailable, bridge missing,
 * main-process rejection, disk error.
 *
 * Callers should surface this as a user-visible abort rather than
 * proceeding with the destructive apply. Separate from "nothing to
 * back up" (empty vault) which is returned as `null`.
 */
export class ProtectiveBackupUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectiveBackupUnavailableError';
  }
}

/**
 * Create a protective local backup before a destructive apply (restore
 * from backup list, restore from Gist revision, cloud download applied
 * over meaningful local state).
 *
 * Returns `null` when there is nothing meaningful to back up — in that
 * case the caller can safely proceed with the apply, because there is
 * no local data to lose.
 *
 * Throws `ProtectiveBackupUnavailableError` when pre-apply state IS
 * meaningful but the backup attempt failed. Callers MUST abort the
 * destructive apply in that case and surface the error to the user,
 * otherwise we regress the exact safety contract the backup system
 * was added to enforce (the `console.error`-and-proceed pattern that
 * previously swallowed safeStorage/keychain failures and continued).
 */
export async function createRequiredProtectiveLocalVaultBackup(
  payload: SyncPayload,
): Promise<LocalVaultBackupPreview | null> {
  if (!hasMeaningfulSyncData(payload)) {
    // Nothing to protect — an empty-vault backup would produce a
    // useless record, not a safety net.
    return null;
  }

  const bridge = netcattyBridge.get();
  if (!bridge?.createVaultBackup) {
    throw new ProtectiveBackupUnavailableError(
      'Vault backup bridge is not available in this environment.',
    );
  }

  try {
    const result = await bridge.createVaultBackup({
      payload,
      reason: 'before_restore',
      maxCount: getLocalVaultBackupMaxCount(),
    });
    return result?.backup ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProtectiveBackupUnavailableError(message);
  }
}

/**
 * How long each heartbeat extends the cross-window restore barrier.
 * Short enough that an abandoned lock (crashed window, hung task)
 * clears itself quickly without user intervention. The heartbeat
 * interval below refreshes the deadline as long as the caller's task
 * is still running, so large vaults or slow keychain unlocks cannot
 * expose a mid-apply window to concurrent auto-sync even when the
 * total apply time exceeds this value.
 */
const RESTORE_BARRIER_HOLD_MS = 60_000;

/**
 * How often the heartbeat refreshes the barrier. Picked to ensure at
 * least two refreshes land before the current deadline would expire,
 * so a single missed tick (event-loop stall, GC pause) cannot drop
 * the barrier prematurely.
 */
const RESTORE_BARRIER_HEARTBEAT_MS = Math.max(1_000, Math.floor(RESTORE_BARRIER_HOLD_MS / 3));

/**
 * Run `task` while holding a cross-window "restore in progress" barrier.
 *
 * The barrier is a localStorage key readable by every window of the same
 * origin. useAutoSync reads it on each auto-sync and on each data-change
 * debounce tick, refusing to push while the deadline is still in the
 * future. We write a time-bounded deadline (rather than a boolean) so a
 * crashed window can never leave sync permanently wedged.
 *
 * While the task runs, a heartbeat timer re-writes the deadline so a
 * slow apply (large vault, slow keychain) keeps the barrier held rather
 * than exposing a post-deadline window to concurrent auto-sync. The
 * heartbeat is cleared and the barrier is released in a finally block
 * so success, throw, and unexpected early-return all converge on the
 * same cleanup.
 */
export async function withRestoreBarrier<T>(
  task: () => Promise<T>,
  holdMs: number = RESTORE_BARRIER_HOLD_MS,
): Promise<T> {
  const writeDeadline = () => {
    try {
      localStorageAdapter.writeNumber(
        STORAGE_KEY_VAULT_RESTORE_IN_PROGRESS_UNTIL,
        Date.now() + holdMs,
      );
    } catch (error) {
      // If we can't write the barrier we still proceed — the UI-side
      // `isSyncBusy` guard and same-window debounce cancellation are a
      // secondary defense. Better to complete the restore than refuse on
      // a broken localStorage.
      console.warn('[localVaultBackups] Failed to set restore barrier:', error);
    }
  };

  writeDeadline();
  const heartbeat = setInterval(
    writeDeadline,
    Math.max(1_000, Math.min(holdMs / 3, RESTORE_BARRIER_HEARTBEAT_MS)),
  );

  try {
    return await task();
  } finally {
    clearInterval(heartbeat);
    try {
      localStorageAdapter.writeNumber(STORAGE_KEY_VAULT_RESTORE_IN_PROGRESS_UNTIL, 0);
    } catch {
      /* ignore — the deadline will expire naturally */
    }
  }
}

/**
 * Shape of the apply-in-progress sentinel record. Persisted as JSON in
 * `STORAGE_KEY_VAULT_APPLY_IN_PROGRESS` so the next session can
 * distinguish "the last apply completed cleanly" from "the last apply
 * crashed mid-way and the local vault is a partial mix of states."
 */
export interface VaultApplyInProgressRecord {
  startedAt: number;
  protectiveBackupId: string | null;
}

/**
 * Returns the persisted apply-in-progress record if a previous apply
 * was interrupted before clearing it. Callers (notably auto-sync) use
 * this to refuse to push a partial-apply local state over an intact
 * cloud copy. See `applyProtectedSyncPayload` for the write side.
 *
 * `null` here means "no interrupted apply detected" — either nothing
 * was ever applied, or the last apply finished cleanly.
 */
export function readInterruptedVaultApply(): VaultApplyInProgressRecord | null {
  try {
    const raw = localStorageAdapter.readString(STORAGE_KEY_VAULT_APPLY_IN_PROGRESS);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const startedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : 0;
    const protectiveBackupId =
      typeof parsed.protectiveBackupId === 'string' ? parsed.protectiveBackupId : null;
    if (!startedAt) return null;
    return { startedAt, protectiveBackupId };
  } catch {
    return null;
  }
}

/**
 * Clears the apply-in-progress sentinel. The normal completion path
 * inside `applyProtectedSyncPayload` clears it automatically; this
 * export exists so the user's explicit recovery action ("I've restored
 * from a backup, resume sync") can acknowledge the interrupted state
 * from the UI without re-running an apply.
 */
export function clearInterruptedVaultApply(): void {
  try {
    localStorageAdapter.remove(STORAGE_KEY_VAULT_APPLY_IN_PROGRESS);
  } catch {
    /* ignore — next clean apply will overwrite */
  }
}

function writeApplyInProgressSentinel(record: VaultApplyInProgressRecord): void {
  try {
    localStorageAdapter.writeString(
      STORAGE_KEY_VAULT_APPLY_IN_PROGRESS,
      JSON.stringify(record),
    );
  } catch (error) {
    // Sentinel write is best-effort: a failure here means a later crash
    // won't be detected, but does NOT compromise the apply itself.
    // Log so a systematic storage outage is diagnosable.
    console.warn('[localVaultBackups] Failed to set apply-in-progress sentinel:', error);
  }
}

/**
 * Shared "apply a remote-sourced payload safely" helper.
 *
 * Holds the cross-window restore barrier, snapshots the pre-apply vault
 * into a protective backup, persists an apply-in-progress sentinel, and
 * only then runs the supplied `applyPayload` callback. Every destructive
 * apply path (startup merge, conflict resolution, empty-vault restore,
 * manual Gist-revision restore) must go through this so the protections
 * can't drift out of sync between the main window and the settings
 * window.
 *
 * The sentinel closes the partial-apply-then-crash window: `applyPayload`
 * writes to several localStorage keys non-atomically (hosts, keys, port-
 * forwarding rules, settings). A crash mid-sequence leaves the vault in
 * a state that is neither pre-apply nor post-apply, and the next
 * auto-sync would otherwise push that partial state over an intact cloud
 * copy. The sentinel flags "local may be inconsistent" for the next
 * session; `readInterruptedVaultApply` exposes that to callers that
 * enforce "don't auto-push a half-applied vault."
 *
 * `buildPreApplyPayload` is invoked *before* the apply to snapshot the
 * current vault. Callers pass their own React-closure builder (hosts,
 * keys, port-forwarding rules) because the caller owns that state.
 *
 * `translateProtectiveBackupFailure` converts the
 * `ProtectiveBackupUnavailableError` into a user-visible message in the
 * caller's locale. It runs only on the thrown-and-caught path.
 */
export function applyProtectedSyncPayload(options: {
  buildPreApplyPayload: () => SyncPayload;
  applyPayload: () => void | Promise<void>;
  translateProtectiveBackupFailure: (message: string) => string;
}): Promise<void> {
  const { buildPreApplyPayload, applyPayload, translateProtectiveBackupFailure } = options;
  return withRestoreBarrier(async () => {
    const pre = buildPreApplyPayload();
    let protectiveBackupId: string | null = null;
    try {
      const backup = await createRequiredProtectiveLocalVaultBackup(pre);
      protectiveBackupId = backup?.id ?? null;
    } catch (error) {
      // Destructive apply without a working safety net is exactly the
      // overwrite-without-recovery regression this module was added to
      // prevent. Surface the failure to the caller; every call site
      // currently aborts the apply and shows a user-visible error.
      if (error instanceof ProtectiveBackupUnavailableError) {
        throw new Error(translateProtectiveBackupFailure(error.message));
      }
      throw error;
    }

    // Mark the apply as in-progress. If the renderer crashes between
    // the first localStorage write inside `applyPayload` and the
    // successful completion below, the next session will observe this
    // sentinel and refuse to auto-sync the partial state.
    writeApplyInProgressSentinel({
      startedAt: Date.now(),
      protectiveBackupId,
    });

    // Only clear the sentinel on successful completion. A throw from
    // `applyPayload` deliberately leaves the sentinel set: the partial
    // write is still on disk, and the next session must observe the
    // flag so auto-sync refuses to push the half-applied state.
    await applyPayload();
    clearInterruptedVaultApply();
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
  const payloadIsMeaningful = hasMeaningfulSyncData(payload);
  if (payloadIsMeaningful) {
    backup = await createLocalVaultBackup(payload, {
      reason: 'app_version_change',
      sourceAppVersion: previousVersion,
      targetAppVersion: normalizedVersion,
    });
  }

  // Only advance the stored version stamp when we actually wrote a
  // backup. Two failure modes we must NOT collapse into "advance":
  //
  //   1. Meaningful payload + backup failed (transient keychain lock,
  //      disk error) — leaving the stamp unchanged means the next
  //      launch retries, instead of turning a transient error into a
  //      permanent "the version-change backup never happened" hole.
  //
  //   2. Non-meaningful payload at the moment we checked — on startup
  //      the async vault rehydrate may not have finished yet, so
  //      `hasMeaningfulSyncData` can return false transiently even
  //      though the user has real data. Advancing in that window would
  //      burn the one-shot upgrade opportunity; holding keeps the
  //      retry available on the next launch when rehydrate has
  //      completed (or when the user genuinely starts from empty and
  //      the next migration-boundary arrives).
  //
  // Trade-off: a user who truly starts empty and never adds data will
  // hit this branch on every launch until they do. That's cheap (a
  // single meaningful-data check) and strictly safer than silently
  // skipping the first real upgrade backup.
  const shouldAdvanceVersion = payloadIsMeaningful && backup !== null;
  if (shouldAdvanceVersion) {
    localStorageAdapter.writeString(STORAGE_KEY_LOCAL_VAULT_BACKUP_LAST_APP_VERSION, normalizedVersion);
  }

  return {
    created: Boolean(backup),
    backup,
  };
}
