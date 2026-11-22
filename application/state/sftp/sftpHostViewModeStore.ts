import { useCallback } from "react";
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";
import { STORAGE_KEY_SFTP_HOST_VIEW_MODES } from "../../../infrastructure/config/storageKeys";
import { createExternalStore } from "../createExternalStore";

// Shared external store for per-host SFTP view mode preferences

type ViewMode = 'list' | 'tree';

const store = createExternalStore<Record<string, ViewMode>>(
  localStorageAdapter.read<Record<string, ViewMode>>(STORAGE_KEY_SFTP_HOST_VIEW_MODES) ?? {},
  { isEqual: () => false },
);

function persist(next: Record<string, ViewMode>) {
  localStorageAdapter.write(STORAGE_KEY_SFTP_HOST_VIEW_MODES, next);
  store.setSnapshot(next);
}

// Sync across windows/tabs via storage events
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY_SFTP_HOST_VIEW_MODES) return;
    try {
      store.setSnapshot(
        e.newValue ? (JSON.parse(e.newValue) as Record<string, ViewMode>) : {},
      );
    } catch {
      store.setSnapshot({});
    }
  });
}

/** Get the saved view mode for a specific host, or null if none saved. */
export function getHostViewMode(hostId: string): ViewMode | null {
  return store.getSnapshot()[hostId] ?? null;
}

/** Save the view mode preference for a specific host. */
export function setHostViewMode(hostId: string, mode: ViewMode): void {
  const current = store.getSnapshot();
  if (current[hostId] === mode) return;
  persist({ ...current, [hostId]: mode });
}

export function useSftpHostViewMode(hostId: string | undefined) {
  const snapshot = store.useStore();

  const mode: ViewMode | null = hostId ? (snapshot[hostId] ?? null) : null;

  const setMode = useCallback((newMode: ViewMode) => {
    if (hostId) {
      setHostViewMode(hostId, newMode);
    }
  }, [hostId]);

  return { hostViewMode: mode, setHostViewMode: setMode };
}
