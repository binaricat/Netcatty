import {
  buildSftpDownloadDialogDirectoryOptions,
  type SftpDownloadDialogDirectoryOptions,
} from "../../../domain/sftpDownloadLocation";
import { STORAGE_KEY_SFTP_DEFAULT_DOWNLOAD_DIR } from "../../../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";

/**
 * Read the device-local default download folder at call time so every SFTP
 * surface (main view, terminal side panel, other windows) sees the latest
 * value without threading it through props.
 */
export const getSftpDownloadDialogDirectoryOptions = (): SftpDownloadDialogDirectoryOptions => {
  let stored: string | null = null;
  try {
    stored = localStorageAdapter.readString(STORAGE_KEY_SFTP_DEFAULT_DOWNLOAD_DIR);
  } catch {
    // Storage unavailable (non-browser host); fall back to system Downloads.
  }
  return buildSftpDownloadDialogDirectoryOptions(stored);
};
