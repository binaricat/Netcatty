/**
 * Remembers the exact local target path the user picked (via the Save As
 * dialog) for a given remote source path, so re-downloading the same source
 * overwrites the previous copy directly instead of re-showing the dialog's
 * overwrite confirmation.
 *
 * The exact selected path is remembered — not just its parent directory — so
 * a basename the user renamed in the dialog is preserved and a remote
 * filename containing separators-lookalikes (e.g. backslashes on Windows)
 * cannot escape the remembered directory.
 *
 * The memory is owned per surface (each mount of the consuming hook gets its
 * own instance), so the full SFTP view and terminal side panels do not share
 * remembered destinations.
 */
import { useCallback, useRef } from "react";

export type DownloadTargetMemoryKey = string;

export const makeDownloadTargetMemoryKey = (
  hostId: string | undefined,
  sourcePath: string,
): DownloadTargetMemoryKey => `${hostId ?? ""}:${sourcePath}`;

/** Bounded so very long sessions cannot grow the map without limit. */
export const DOWNLOAD_TARGET_MEMORY_LIMIT = 200;

export type SftpDownloadTargetMemory = {
  getRememberedDownloadTarget: (key: DownloadTargetMemoryKey) => string | undefined;
  rememberDownloadTarget: (key: DownloadTargetMemoryKey, targetPath: string) => void;
};

export const createSftpDownloadTargetMemory = (): SftpDownloadTargetMemory => {
  const downloadTargetBySource = new Map<DownloadTargetMemoryKey, string>();
  return {
    getRememberedDownloadTarget: (key: DownloadTargetMemoryKey): string | undefined => {
      const target = downloadTargetBySource.get(key);
      if (target === undefined) return undefined;
      // Re-insert so actively used entries are not evicted as least recently used.
      downloadTargetBySource.delete(key);
      downloadTargetBySource.set(key, target);
      return target;
    },
    rememberDownloadTarget: (key: DownloadTargetMemoryKey, targetPath: string): void => {
      if (!key || !targetPath) return;
      // Re-insert to refresh recency for the LRU bound.
      downloadTargetBySource.delete(key);
      downloadTargetBySource.set(key, targetPath);
      while (downloadTargetBySource.size > DOWNLOAD_TARGET_MEMORY_LIMIT) {
        const oldest = downloadTargetBySource.keys().next().value;
        if (oldest === undefined) break;
        downloadTargetBySource.delete(oldest);
      }
    },
  };
};

/** Application-state hook scoping the memory to the consuming surface's lifetime. */
export const useSftpDownloadTargetMemory = (): SftpDownloadTargetMemory => {
  const memoryRef = useRef<SftpDownloadTargetMemory | null>(null);
  if (!memoryRef.current) {
    memoryRef.current = createSftpDownloadTargetMemory();
  }
  const rememberDownloadTarget = useCallback(
    (key: DownloadTargetMemoryKey, targetPath: string) => memoryRef.current!.rememberDownloadTarget(key, targetPath),
    [],
  );
  const getRememberedDownloadTarget = useCallback(
    (key: DownloadTargetMemoryKey) => memoryRef.current!.getRememberedDownloadTarget(key),
    [],
  );
  return { getRememberedDownloadTarget, rememberDownloadTarget };
};
