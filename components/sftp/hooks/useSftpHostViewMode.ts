import { useCallback, useSyncExternalStore } from "react";
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";
import { STORAGE_KEY_SFTP_HOST_VIEW_MODES } from "../../../infrastructure/config/storageKeys";

// ── Shared external store for per-host SFTP view mode preferences ──

type ViewMode = 'list' | 'tree';
type Listener = () => void;

const listeners = new Set<Listener>();

let snapshot: Record<string, ViewMode> =
    localStorageAdapter.read<Record<string, ViewMode>>(STORAGE_KEY_SFTP_HOST_VIEW_MODES) ?? {};

function subscribe(listener: Listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function getSnapshot() {
    return snapshot;
}

function persist(next: Record<string, ViewMode>) {
    snapshot = next;
    localStorageAdapter.write(STORAGE_KEY_SFTP_HOST_VIEW_MODES, snapshot);
    for (const l of listeners) l();
}

// Sync across windows/tabs via storage events
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
        if (e.key !== STORAGE_KEY_SFTP_HOST_VIEW_MODES) return;
        try {
            snapshot = e.newValue
                ? (JSON.parse(e.newValue) as Record<string, ViewMode>)
                : {};
        } catch {
            snapshot = {};
        }
        for (const l of listeners) l();
    });
}

/** Get the saved view mode for a specific host, or null if none saved. */
export function getHostViewMode(hostId: string): ViewMode | null {
    return snapshot[hostId] ?? null;
}

/** Save the view mode preference for a specific host. */
export function setHostViewMode(hostId: string, mode: ViewMode): void {
    if (snapshot[hostId] === mode) return;
    persist({ ...snapshot, [hostId]: mode });
}

// ── Hook ──

export function useSftpHostViewMode(hostId: string | undefined) {
    const store = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const mode: ViewMode | null = hostId ? (store[hostId] ?? null) : null;

    const setMode = useCallback((newMode: ViewMode) => {
        if (hostId) {
            setHostViewMode(hostId, newMode);
        }
    }, [hostId]);

    return { hostViewMode: mode, setHostViewMode: setMode };
}
