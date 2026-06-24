import {
  STORAGE_KEY_SESSION_RESTORE,
} from "../../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../../infrastructure/persistence/localStorageAdapter";
import {
  SESSION_RESTORE_VERSION,
  sanitizeSessionRestorePayload,
  type SessionRestorePayload,
} from "../../domain/sessionRestore";

type RestoreStorageAdapter = {
  read<T>(key: string): T | null;
  write<T>(key: string, value: T): boolean;
  remove(key: string): void;
};

const isRestorePayload = (value: unknown): value is SessionRestorePayload => {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SessionRestorePayload>;
  return record.version === SESSION_RESTORE_VERSION
    && Array.isArray(record.sessions)
    && record.sessions.every((session) => (
      Boolean(session)
      && typeof session === "object"
      && typeof (session as { id?: unknown }).id === "string"
      && typeof (session as { hostId?: unknown }).hostId === "string"
      && typeof (session as { hostLabel?: unknown }).hostLabel === "string"
      && typeof (session as { hostname?: unknown }).hostname === "string"
      && typeof (session as { username?: unknown }).username === "string"
    ))
    && Array.isArray(record.workspaces)
    && record.workspaces.every((workspace) => (
      Boolean(workspace)
      && typeof workspace === "object"
      && typeof (workspace as { id?: unknown }).id === "string"
      && Boolean((workspace as { root?: unknown }).root)
      && typeof (workspace as { root?: unknown }).root === "object"
    ))
    && Array.isArray(record.tabOrder)
    && record.tabOrder.every((tabId) => typeof tabId === "string")
    && typeof record.activeTabId === "string";
};

export function createSessionRestoreStorage(adapter: RestoreStorageAdapter = localStorageAdapter) {
  return {
    read(): SessionRestorePayload | null {
      const payload = adapter.read<unknown>(STORAGE_KEY_SESSION_RESTORE);
      if (!isRestorePayload(payload)) {
        if (payload !== null) adapter.remove(STORAGE_KEY_SESSION_RESTORE);
        return null;
      }
      try {
        return sanitizeSessionRestorePayload(payload);
      } catch {
        adapter.remove(STORAGE_KEY_SESSION_RESTORE);
        return null;
      }
    },
    write(payload: SessionRestorePayload): boolean {
      return adapter.write(STORAGE_KEY_SESSION_RESTORE, sanitizeSessionRestorePayload(payload));
    },
    clear(): void {
      adapter.remove(STORAGE_KEY_SESSION_RESTORE);
    },
  };
}

export const sessionRestoreStorage = createSessionRestoreStorage();
