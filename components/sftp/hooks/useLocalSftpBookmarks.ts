import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { SftpBookmark } from "../../../domain/models";
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";
import { STORAGE_KEY_SFTP_LOCAL_BOOKMARKS } from "../../../infrastructure/config/storageKeys";
import { createSftpBookmark } from "../../../application/state/sftp/bookmarkHelpers";

// ── Shared external store so every hook instance sees the same bookmarks ──

type Listener = () => void;
const listeners = new Set<Listener>();

let snapshot: SftpBookmark[] =
    localStorageAdapter.read<SftpBookmark[]>(STORAGE_KEY_SFTP_LOCAL_BOOKMARKS) ?? [];

function subscribe(listener: Listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function getSnapshot() {
    return snapshot;
}

function setBookmarks(next: SftpBookmark[] | ((prev: SftpBookmark[]) => SftpBookmark[])) {
    snapshot = typeof next === "function" ? next(snapshot) : next;
    localStorageAdapter.write(STORAGE_KEY_SFTP_LOCAL_BOOKMARKS, snapshot);
    for (const l of listeners) l();
}

// ── Hook ──

interface UseLocalSftpBookmarksParams {
    currentPath: string | undefined;
}

export const useLocalSftpBookmarks = ({
    currentPath,
}: UseLocalSftpBookmarksParams) => {
    const bookmarks = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const isCurrentPathBookmarked = useMemo(
        () => !!currentPath && bookmarks.some((b) => b.path === currentPath),
        [currentPath, bookmarks],
    );

    const toggleBookmark = useCallback(() => {
        if (!currentPath) return;
        if (isCurrentPathBookmarked) {
            setBookmarks((prev) => prev.filter((b) => b.path !== currentPath));
        } else {
            setBookmarks((prev) => [...prev, createSftpBookmark(currentPath)]);
        }
    }, [currentPath, isCurrentPathBookmarked]);

    const deleteBookmark = useCallback((id: string) => {
        setBookmarks((prev) => prev.filter((b) => b.id !== id));
    }, []);

    return {
        bookmarks,
        isCurrentPathBookmarked,
        toggleBookmark,
        deleteBookmark,
    };
};
