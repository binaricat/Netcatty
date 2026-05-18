import type { SftpBookmark } from "../../../domain/models";
import { STORAGE_KEY_SFTP_GLOBAL_BOOKMARKS } from "../../../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";

type Listener = () => void;

const listeners = new Set<Listener>();

let snapshot: SftpBookmark[] =
  localStorageAdapter.read<SftpBookmark[]>(STORAGE_KEY_SFTP_GLOBAL_BOOKMARKS) ?? [];

export function subscribeGlobalSftpBookmarks(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getGlobalSftpBookmarksSnapshot() {
  return snapshot;
}

export function rehydrateGlobalSftpBookmarks() {
  snapshot = localStorageAdapter.read<SftpBookmark[]>(STORAGE_KEY_SFTP_GLOBAL_BOOKMARKS) ?? [];
  for (const listener of listeners) listener();
}

export function setGlobalSftpBookmarks(
  next: SftpBookmark[] | ((prev: SftpBookmark[]) => SftpBookmark[]),
) {
  snapshot = typeof next === "function" ? next(snapshot) : next;
  localStorageAdapter.write(STORAGE_KEY_SFTP_GLOBAL_BOOKMARKS, snapshot);
  for (const listener of listeners) listener();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("sftp-bookmarks-changed"));
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY_SFTP_GLOBAL_BOOKMARKS) {
      rehydrateGlobalSftpBookmarks();
    }
  });
}
