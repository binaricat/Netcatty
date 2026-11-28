import { selectConnectionLogForTerminalDataCapture } from '../../domain/connectionLog';
import type {
  ConnectionLog,
  RemoteDesktopRecordingClip,
  RemoteDesktopSessionEvent,
  RemoteDesktopSessionMetadata,
} from '../../domain/models';
import {
  buildAppendRecordingClipUpdate,
  buildClearRecordingsUpdate,
  getConnectionLogMediaIds,
} from '../../domain/remoteDesktopRecording';
import { STORAGE_KEY_CONNECTION_LOGS } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import {
  listRemoteDesktopAuditEntries,
  subscribeRemoteDesktopAuditLog,
  type RemoteDesktopAuditEntry,
} from '../../infrastructure/remoteDesktop/remoteDesktopAuditLog';
import {
  netcattyBridge,
  type RemoteDesktopRecordingsBridgeApi,
} from '../../infrastructure/services/netcattyBridge';
import {
  getConnectionLogsActions,
  getConnectionLogsSnapshot,
} from './connectionLogsStore';
import { withVaultImportLock } from './vaultManagedImportLock';

export type { RemoteDesktopAuditEntry };

export function getRemoteDesktopRecordingsBridge(): RemoteDesktopRecordingsBridgeApi | null {
  return netcattyBridge.get()?.remoteDesktopRecordings ?? null;
}

export function registerSessionLogFinalizer(
  finalize: () => void | Promise<void>,
): (() => void) | undefined {
  const unsub = netcattyBridge.get()?.onFinalizeSessionLogs?.(finalize);
  return typeof unsub === 'function' ? unsub : undefined;
}

export async function getSystemUserHostInfo(): Promise<{ username: string; hostname: string }> {
  try {
    const info = await netcattyBridge.get()?.getSystemInfo?.();
    return {
      username: info?.username || 'user',
      hostname: info?.hostname || 'localhost',
    };
  } catch {
    return { username: 'user', hostname: 'localhost' };
  }
}

export function listRemoteDesktopSessionAuditEntries(
  sessionId?: string,
): RemoteDesktopAuditEntry[] {
  return listRemoteDesktopAuditEntries(sessionId);
}

export function subscribeRemoteDesktopSessionAuditLog(listener: () => void): () => void {
  return subscribeRemoteDesktopAuditLog(listener);
}

function readPersistedConnectionLogs(): ConnectionLog[] {
  try {
    const stored = localStorageAdapter.read<ConnectionLog[]>(STORAGE_KEY_CONNECTION_LOGS);
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

/**
 * Collect all protected media IDs (video clips + thumbnails) across bookmarked
 * connection logs from BOTH the in-memory store and persisted localStorage.
 * Works identically in the main window and detached Settings window.
 */
export function collectProtectedRemoteDesktopMediaIds(): string[] {
  const protectedSet = new Set<string>();
  const { connectionLogs } = getConnectionLogsSnapshot();
  for (const log of connectionLogs) {
    if (log.saved) {
      for (const mediaId of getConnectionLogMediaIds(log)) {
        protectedSet.add(mediaId);
      }
    }
  }
  for (const log of readPersistedConnectionLogs()) {
    if (log.saved) {
      for (const mediaId of getConnectionLogMediaIds(log)) {
        protectedSet.add(mediaId);
      }
    }
  }
  return Array.from(protectedSet);
}

export async function appendRemoteDesktopClipToConnectionLog(
  sessionId: string,
  clip: RemoteDesktopRecordingClip,
  options?: { stampEndTime?: boolean },
): Promise<boolean> {
  const { connectionLogs } = getConnectionLogsSnapshot();
  const actions = getConnectionLogsActions();
  if (!actions?.updateConnectionLog) return false;
  const matchingLog = selectConnectionLogForTerminalDataCapture(
    [...connectionLogs],
    { sessionId },
  );
  if (!matchingLog) return false;
  const updates = buildAppendRecordingClipUpdate(matchingLog, clip, {
    stampEndTime: options?.stampEndTime ? Date.now() : undefined,
  });
  await Promise.resolve(actions.updateConnectionLog(matchingLog.id, updates));
  return true;
}

export async function updateRemoteDesktopConnectionLogActivity(
  sessionId: string,
  updater: (current: {
    events: RemoteDesktopSessionEvent[];
    meta: RemoteDesktopSessionMetadata | undefined;
  }) => {
    events?: RemoteDesktopSessionEvent[];
    meta?: RemoteDesktopSessionMetadata;
  },
): Promise<boolean> {
  const actions = getConnectionLogsActions();
  if (!actions?.updateConnectionLog) return false;
  const { connectionLogs } = getConnectionLogsSnapshot();
  const matchingLog = selectConnectionLogForTerminalDataCapture(
    [...connectionLogs],
    { sessionId },
  );
  if (!matchingLog) return false;
  const next = updater({
    events: Array.isArray(matchingLog.remoteDesktopEvents) ? matchingLog.remoteDesktopEvents : [],
    meta: matchingLog.remoteDesktopMeta,
  });
  const patch: Partial<ConnectionLog> = {};
  if (next.events) patch.remoteDesktopEvents = next.events;
  if (next.meta) patch.remoteDesktopMeta = next.meta;
  if (Object.keys(patch).length === 0) return false;
  await Promise.resolve(actions.updateConnectionLog(matchingLog.id, patch));
  return true;
}

export async function saveRemoteDesktopThumbnail(options: {
  id?: string;
  data: Uint8Array;
}): Promise<{ ok: boolean; id?: string; url?: string; bytes?: number } | null> {
  const bridge = getRemoteDesktopRecordingsBridge();
  if (!bridge?.saveThumbnail) return null;
  return bridge.saveThumbnail(options);
}

/**
 * Clear all unprotected remote desktop recordings on disk and atomically clear
 * their references from connection logs. Safe to invoke from detached windows
 * (such as Settings -> System) where `useVaultState` is not mounted.
 */
export async function clearAllRemoteDesktopRecordingsAndSyncLogs(): Promise<{ deleted: number }> {
  const bridge = getRemoteDesktopRecordingsBridge();
  if (!bridge?.clearAll) return { deleted: 0 };

  const protectedIds = collectProtectedRemoteDesktopMediaIds();
  const protectedSet = new Set(protectedIds);
  const res = await bridge.clearAll({ protectedIds });

  const actions = getConnectionLogsActions();
  if (actions?.updateConnectionLog) {
    // Call `actions.updateConnectionLog` OUTSIDE `withVaultImportLock('connection-logs')`
    // because `useVaultState.commitConnectionLogs` acquires that same non-reentrant Web Lock.
    const { connectionLogs } = getConnectionLogsSnapshot();
    const persistedById = new Map(readPersistedConnectionLogs().map((log) => [log.id, log]));
    const targets = new Map<string, ConnectionLog>();
    for (const log of connectionLogs) targets.set(log.id, log);
    for (const [id, log] of persistedById) {
      if (!targets.has(id)) targets.set(id, log);
    }
    for (const log of targets.values()) {
      const updates = buildClearRecordingsUpdate(log, protectedSet);
      if (updates) {
        await Promise.resolve(actions.updateConnectionLog(log.id, updates));
      }
    }
  } else {
    // Detached window (e.g. Settings -> System without Sync tab mounted): update
    // localStorage atomically under the shared cross-window Web Lock.
    await withVaultImportLock('connection-logs', async () => {
      const persisted = readPersistedConnectionLogs();
      let changed = false;
      const nextPersisted = persisted.map((log) => {
        const updates = buildClearRecordingsUpdate(log, protectedSet);
        if (!updates) return log;
        changed = true;
        return { ...log, ...updates };
      });
      if (changed) {
        localStorageAdapter.write(STORAGE_KEY_CONNECTION_LOGS, nextPersisted);
      }
    });
  }

  return { deleted: res?.deleted ?? 0 };
}
