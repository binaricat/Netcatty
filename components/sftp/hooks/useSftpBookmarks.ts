import { useCallback, useMemo } from "react";
import type { Host, SftpBookmark } from "../../../domain/models";
import { createSftpBookmark } from "../../../application/state/sftp/bookmarkHelpers";

interface UseSftpBookmarksParams {
    host: Host | undefined;
    currentPath: string | undefined;
    onUpdateHost: ((host: Host) => void) | undefined;
}

interface UseSftpBookmarksResult {
    bookmarks: SftpBookmark[];
    isCurrentPathBookmarked: boolean;
    toggleBookmark: () => void;
    deleteBookmark: (id: string) => void;
}

export const useSftpBookmarks = ({
    host,
    currentPath,
    onUpdateHost,
}: UseSftpBookmarksParams): UseSftpBookmarksResult => {
    const bookmarks = useMemo(() => host?.sftpBookmarks ?? [], [host]);

    const isCurrentPathBookmarked = useMemo(
        () =>
            !!currentPath && bookmarks.some((b) => b.path === currentPath),
        [currentPath, bookmarks],
    );

    const updateHostBookmarks = useCallback(
        (newBookmarks: SftpBookmark[]) => {
            if (!host || !onUpdateHost) return;
            onUpdateHost({ ...host, sftpBookmarks: newBookmarks });
        },
        [host, onUpdateHost],
    );

    const toggleBookmark = useCallback(() => {
        if (!currentPath || !host) return;
        if (isCurrentPathBookmarked) {
            updateHostBookmarks(bookmarks.filter((b) => b.path !== currentPath));
        } else {
            updateHostBookmarks([...bookmarks, createSftpBookmark(currentPath)]);
        }
    }, [currentPath, host, isCurrentPathBookmarked, bookmarks, updateHostBookmarks]);

    const deleteBookmark = useCallback(
        (id: string) => {
            updateHostBookmarks(bookmarks.filter((b) => b.id !== id));
        },
        [bookmarks, updateHostBookmarks],
    );

    return {
        bookmarks,
        isCurrentPathBookmarked,
        toggleBookmark,
        deleteBookmark,
    };
};
