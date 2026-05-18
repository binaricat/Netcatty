import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
    getGlobalSftpBookmarksSnapshot,
    setGlobalSftpBookmarks,
    subscribeGlobalSftpBookmarks,
} from "../../../application/state/sftp/globalSftpBookmarks";
import { createSftpBookmark } from "../../../application/state/sftp/bookmarkHelpers";

interface UseGlobalSftpBookmarksParams {
    currentPath: string | undefined;
}

export const useGlobalSftpBookmarks = ({
    currentPath,
}: UseGlobalSftpBookmarksParams) => {
    const bookmarks = useSyncExternalStore(
        subscribeGlobalSftpBookmarks,
        getGlobalSftpBookmarksSnapshot,
        getGlobalSftpBookmarksSnapshot,
    );

    const isCurrentPathBookmarked = useMemo(
        () => !!currentPath && bookmarks.some((b) => b.path === currentPath),
        [currentPath, bookmarks],
    );

    const addBookmark = useCallback((path: string) => {
        if (!path) return;
        if (bookmarks.some((b) => b.path === path)) return;
        setGlobalSftpBookmarks((prev) => [...prev, createSftpBookmark(path, { global: true })]);
    }, [bookmarks]);

    const deleteBookmark = useCallback((id: string) => {
        setGlobalSftpBookmarks((prev) => prev.filter((b) => b.id !== id));
    }, []);

    return {
        bookmarks,
        isCurrentPathBookmarked,
        addBookmark,
        deleteBookmark,
    };
};
