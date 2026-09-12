import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { SftpBookmark } from "../../../domain/models";
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";
import { STORAGE_KEY_SFTP_LOCAL_BOOKMARKS } from "../../../infrastructure/config/storageKeys";
import { createSftpBookmark, moveSftpBookmark, renameSftpBookmark } from "./bookmarkHelpers";

type Listener = () => void;

const listeners = new Set<Listener>();

let snapshot: SftpBookmark[] =
  localStorageAdapter.read<SftpBookmark[]>(STORAGE_KEY_SFTP_LOCAL_BOOKMARKS) ?? [];

export function subscribeLocalSftpBookmarks(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLocalSftpBookmarksSnapshot() {
  return snapshot;
}

export function rehydrateLocalSftpBookmarks() {
  snapshot = localStorageAdapter.read<SftpBookmark[]>(STORAGE_KEY_SFTP_LOCAL_BOOKMARKS) ?? [];
  for (const listener of listeners) listener();
}

export function setLocalSftpBookmarks(
  next: SftpBookmark[] | ((prev: SftpBookmark[]) => SftpBookmark[]),
) {
  snapshot = typeof next === "function" ? next(snapshot) : next;
  localStorageAdapter.write(STORAGE_KEY_SFTP_LOCAL_BOOKMARKS, snapshot);
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY_SFTP_LOCAL_BOOKMARKS) {
      rehydrateLocalSftpBookmarks();
    }
  });
}

interface UseLocalSftpBookmarksParams {
  currentPath: string | undefined;
}

export const useLocalSftpBookmarks = ({
  currentPath,
}: UseLocalSftpBookmarksParams) => {
  const bookmarks = useSyncExternalStore(
    subscribeLocalSftpBookmarks,
    getLocalSftpBookmarksSnapshot,
    getLocalSftpBookmarksSnapshot,
  );

  const isCurrentPathBookmarked = useMemo(
    () => !!currentPath && bookmarks.some((b) => b.path === currentPath),
    [currentPath, bookmarks],
  );

  const toggleBookmark = useCallback(() => {
    if (!currentPath) return;
    if (isCurrentPathBookmarked) {
      setLocalSftpBookmarks((prev) => prev.filter((b) => b.path !== currentPath));
    } else {
      setLocalSftpBookmarks((prev) => [...prev, createSftpBookmark(currentPath)]);
    }
  }, [currentPath, isCurrentPathBookmarked]);

  const deleteBookmark = useCallback((id: string) => {
    setLocalSftpBookmarks((prev) => prev.filter((b) => b.id !== id));
  }, []);

  const reorderBookmark = useCallback((fromId: string, toId: string) => {
    setLocalSftpBookmarks((prev) => moveSftpBookmark(prev, fromId, toId));
  }, []);

  const renameBookmark = useCallback((id: string, label: string) => {
    setLocalSftpBookmarks((prev) => renameSftpBookmark(prev, id, label));
  }, []);

  return {
    bookmarks,
    isCurrentPathBookmarked,
    toggleBookmark,
    deleteBookmark,
    reorderBookmark,
    renameBookmark,
  };
};
