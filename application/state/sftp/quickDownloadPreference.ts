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

/**
 * The repeat-download memory verifies a published target through
 * `statLocal`/`lstatLocal`, and those bridge calls deliberately omit `dev`,
 * `ino`, and the nanosecond timestamps on Windows. Without them every
 * remember attempt is refused before a target can be stored, so the opt-in
 * would silently never remember a Save As path there; treat the setting as
 * unavailable on Windows instead (Codex P2 on PR #3516).
 */
export function isSftpQuickDownloadPlatformSupported(): boolean {
  if (typeof navigator === "undefined") return true;
  return !/^win/i.test(navigator.platform ?? "")
    && !/Windows NT/.test(navigator.userAgent ?? "");
}

export function readSftpQuickDownloadEnabled(): boolean {
  if (!isSftpQuickDownloadPlatformSupported()) return false;
  return resolveSftpQuickDownloadEnabled(
    localStorageAdapter.readBoolean(STORAGE_KEY_SFTP_QUICK_DOWNLOAD),
  );
}
