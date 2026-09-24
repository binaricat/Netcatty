import type { SftpFilenameEncoding } from "../../domain/models/sftp";

/**
 * The side panel file list can be stale: a file deleted and recreated in the
 * terminal keeps its old listed size until the next refresh. The transfer's
 * planned snapshot size must match the real source at transfer start — a stale
 * larger size plans reads past the new EOF and the download fails
 * ("Download stream finished before the full source was received") whenever
 * the regenerated file ended up smaller. A stale smaller size also fails the
 * post-transfer prefix verification. Re-stat right before the download and
 * fall back to the listed size only when the stat itself fails.
 */
export type DownloadSourceSnapshot = {
  /** Fresh source size, or null when unknown (caller keeps the listed size). */
  size: number | null;
  /**
   * Fresh directory classification, or null to keep the listed entry's type.
   * Only corrects plain file/directory entries: stat() follows symlinks, so a
   * "symlink" result means the link could not be resolved and the listed
   * entry's classification stays authoritative.
   */
  isDirectory: boolean | null;
};

const NO_SNAPSHOT: DownloadSourceSnapshot = { size: null, isDirectory: null };

export const resolveDownloadSourceSnapshot = async (
  statSftp: (
    (sftpId: string, path: string, encoding?: SftpFilenameEncoding) => Promise<SftpStatResult>
  ) | undefined,
  sftpId: string,
  sourcePath: string,
  encoding: SftpFilenameEncoding | undefined,
): Promise<DownloadSourceSnapshot> => {
  if (!statSftp) return NO_SNAPSHOT;
  try {
    const stat = await statSftp(sftpId, sourcePath, encoding);
    if (!stat) return NO_SNAPSHOT;
    const sizeKnown = stat.sizeKnown !== false
      && Number.isFinite(stat.size)
      && stat.size >= 0;
    return {
      size: sizeKnown ? stat.size : null,
      isDirectory: stat.type === "file" || stat.type === "directory"
        ? stat.type === "directory"
        : null,
    };
  } catch {
    // Source may have vanished mid-listing; the transfer's own error handling
    // covers that. Keep the listed entry as the fallback plan.
    return NO_SNAPSHOT;
  }
};

export const makeDownloadTargetMemoryKey = (
  hostId: string | undefined,
  sourcePath: string,
): string => `${hostId ?? ""}:${sourcePath}`;

/** Bounded so very long sessions cannot grow the map without limit. */
export const DOWNLOAD_TARGET_MEMORY_LIMIT = 200;

const downloadTargetDirBySource = new Map<string, string>();

export const getRememberedDownloadTargetDir = (key: string): string | undefined =>
  downloadTargetDirBySource.get(key);

/**
 * Remember the local directory chosen for a given remote source path so
 * re-downloading the same file overwrites the previous copy directly instead
 * of re-showing the save dialog's overwrite confirmation.
 */
export const rememberDownloadTargetDir = (key: string, dir: string): void => {
  if (!key || !dir) return;
  // Re-insert to refresh recency for the LRU bound.
  downloadTargetDirBySource.delete(key);
  downloadTargetDirBySource.set(key, dir);
  while (downloadTargetDirBySource.size > DOWNLOAD_TARGET_MEMORY_LIMIT) {
    const oldest = downloadTargetDirBySource.keys().next().value;
    if (oldest === undefined) break;
    downloadTargetDirBySource.delete(oldest);
  }
};
