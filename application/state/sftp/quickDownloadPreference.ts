import {
  STORAGE_KEY_SFTP_LAST_DOWNLOAD_DIR,
  STORAGE_KEY_SFTP_QUICK_DOWNLOAD,
} from "../../../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";

/** Off by default: keep the Save As dialog unless the user opts in. */
export const DEFAULT_SFTP_QUICK_DOWNLOAD = false;

export function resolveSftpQuickDownloadEnabled(
  stored: boolean | null | undefined,
): boolean {
  return stored == null ? DEFAULT_SFTP_QUICK_DOWNLOAD : stored;
}

export function readSftpQuickDownloadEnabled(): boolean {
  return resolveSftpQuickDownloadEnabled(
    localStorageAdapter.readBoolean(STORAGE_KEY_SFTP_QUICK_DOWNLOAD),
  );
}

/**
 * Destination directory for quick downloads, or null when quick download is
 * disabled or no directory has been remembered yet. Read at call time so
 * callbacks never see a stale preference.
 */
export function readSftpQuickDownloadDir(): string | null {
  if (!readSftpQuickDownloadEnabled()) return null;
  const dir = localStorageAdapter.readString(STORAGE_KEY_SFTP_LAST_DOWNLOAD_DIR) || "";
  return dir ? dir : null;
}

/** Remember the directory used for a download (Save As / folder picker). */
export function rememberSftpLastDownloadDir(dir: string | null | undefined): void {
  // Store verbatim: POSIX directory names may legitimately end in whitespace,
  // and trimming would redirect later quick downloads to a different path.
  // Only an actually empty value is rejected.
  if (typeof dir !== "string" || !dir) return;
  try {
    localStorageAdapter.writeString(STORAGE_KEY_SFTP_LAST_DOWNLOAD_DIR, dir);
  } catch {
    // Persistence is best-effort; quick download just falls back to the dialog.
  }
}
