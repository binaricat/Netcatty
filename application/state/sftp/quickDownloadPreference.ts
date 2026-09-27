import {
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
