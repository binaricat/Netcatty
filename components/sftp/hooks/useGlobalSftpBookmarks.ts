import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { SftpBookmark } from "../../../domain/models";
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";
import { STORAGE_KEY_SFTP_GLOBAL_BOOKMARKS } from "../../../infrastructure/config/storageKeys";

type Listener = () => void;
const listeners = new Set<Listener>();

let snapshot: SftpBookmark[] =
    localStorageAdapter.read<SftpBookmark[]>(STORAGE_KEY_SFTP_GLOBAL_BOOKMARKS) ?? [];

function subscribe(listener: Listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function getSnapshot() {
    return snapshot;
}

/** Re-read bookmarks from localStorage (e.g. after cloud sync import). */
export function rehydrateGlobalBookmarks() {
    snapshot = localStorageAdapter.read<SftpBookmark[]>(STORAGE_KEY_SFTP_GLOBAL_BOOKMARKS) ?? [];
    for (const l of listeners) l();
}

// Rehydrate when another window updates the same localStorage key
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY_SFTP_GLOBAL_BOOKMARKS) {
            rehydrateGlobalBookmarks();
        }
    });
}

function setBookmarks(next: SftpBookmark[] | ((prev: SftpBookmark[]) => SftpBookmark[])) {
    snapshot = typeof next === "function" ? next(snapshot) : next;
    localStorageAdapter.write(STORAGE_KEY_SFTP_GLOBAL_BOOKMARKS, snapshot);
    for (const l of listeners) l();
    window.dispatchEvent(new CustomEvent('sftp-bookmarks-changed'));
}

interface UseGlobalSftpBookmarksParams {
    currentPath: string | undefined;
}

export const useGlobalSftpBookmarks = ({
    currentPath,
}: UseGlobalSftpBookmarksParams) => {
    const bookmarks = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const isCurrentPathBookmarked = useMemo(
        () => !!currentPath && bookmarks.some((b) => b.path === currentPath),
        [currentPath, bookmarks],
    );

    const addBookmark = useCallback((path: string) => {
        if (!path) return;
        if (bookmarks.some((b) => b.path === path)) return;
        const isRoot = path === "/" || /^[A-Za-z]:\\?$/.test(path);
        const label = isRoot
            ? path
            : path.split(/[\\/]/).filter(Boolean).pop() || path;
        const newBookmark: SftpBookmark = {
            id: `gbm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            path,
            label,
            global: true,
        };
        setBookmarks((prev) => [...prev, newBookmark]);
    }, [bookmarks]);

    const deleteBookmark = useCallback((id: string) => {
        setBookmarks((prev) => prev.filter((b) => b.id !== id));
    }, []);

    return {
        bookmarks,
        isCurrentPathBookmarked,
        addBookmark,
        deleteBookmark,
    };
};
