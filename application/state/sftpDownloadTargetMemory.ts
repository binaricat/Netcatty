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
 */
export type DownloadTargetMemoryKey = string;

export const makeDownloadTargetMemoryKey = (
  hostId: string | undefined,
  sourcePath: string,
): DownloadTargetMemoryKey => `${hostId ?? ""}:${sourcePath}`;

/** Bounded so very long sessions cannot grow the map without limit. */
export const DOWNLOAD_TARGET_MEMORY_LIMIT = 200;

const downloadTargetBySource = new Map<DownloadTargetMemoryKey, string>();

export const getRememberedDownloadTarget = (key: DownloadTargetMemoryKey): string | undefined =>
  downloadTargetBySource.get(key);

export const rememberDownloadTarget = (key: DownloadTargetMemoryKey, targetPath: string): void => {
  if (!key || !targetPath) return;
  // Re-insert to refresh recency for the LRU bound.
  downloadTargetBySource.delete(key);
  downloadTargetBySource.set(key, targetPath);
  while (downloadTargetBySource.size > DOWNLOAD_TARGET_MEMORY_LIMIT) {
    const oldest = downloadTargetBySource.keys().next().value;
    if (oldest === undefined) break;
    downloadTargetBySource.delete(oldest);
  }
};
