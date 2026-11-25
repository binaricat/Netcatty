/**
 * Pure rules for where SFTP download dialogs open (#4353).
 *
 * The user may pick a default local download folder in SFTP settings. When it
 * is unset (or no longer exists on disk, which the main process verifies), the
 * dialog falls back to the system Downloads folder instead of letting the OS
 * choose -- on Windows that could be the application install directory.
 */

export type SftpDownloadDialogDirectoryOptions = {
  preferredDirectory?: string;
  fallbackDirectory: "downloads";
};

/** Trim a stored directory value; blank / non-string values mean "unset". */
export const normalizeSftpDefaultDownloadDirectory = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim();
};

/** Build the dialog directory hints from the stored setting. */
export const buildSftpDownloadDialogDirectoryOptions = (
  storedDirectory: unknown,
): SftpDownloadDialogDirectoryOptions => {
  const preferredDirectory = normalizeSftpDefaultDownloadDirectory(storedDirectory);
  return preferredDirectory
    ? { preferredDirectory, fallbackDirectory: "downloads" }
    : { fallbackDirectory: "downloads" };
};
