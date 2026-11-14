/**
 * Windows archive-window drags (WinRAR / 7-Zip / Explorer zip) hand the app
 * "virtual" items: Chromium forwards the shell FILEDESCRIPTOR/FILECONTENTS
 * data without a real disk path, so Electron's path resolution returns
 * nothing. A folder dragged out of an archive arrives in the renderer as a
 * single path-less, extension-less, empty pseudo-file — its contents cannot
 * be enumerated, so it can neither be merged nor safely replaced, and
 * streaming it only fabricates an empty file before failing with a confusing
 * path error (#3057). Those items are rejected before the conflict dialog
 * with an actionable message pointing the user to extract the archive first.
 */

export interface VirtualFolderDropCandidate {
  relativePath: string;
  isDirectory: boolean;
  localPath?: string;
  size?: number;
  /** Renderer pseudo-file handle; null for directory entries. */
  file?: { size?: number } | null;
}

/**
 * Sentinel stored in `UploadResult.error`. The toast reporting layer replaces
 * this with a localized message before it is presented to the user, so the
 * sentinel must never be shown as raw text.
 */
export const SFTP_VIRTUAL_FOLDER_UPLOAD_ERROR = "netcatty:virtual-folder-upload";

export const isSftpVirtualFolderUploadError = (error: string | undefined): boolean =>
  error === SFTP_VIRTUAL_FOLDER_UPLOAD_ERROR;

export const isVirtualFolderPseudoFileDrop = (
  entry: VirtualFolderDropCandidate,
): boolean => {
  // Real directory entries keep the normal folder flow (merge/replace dialog).
  if (entry.isDirectory) return false;
  // Normal Explorer/Finder drags always expose a real local path in Electron.
  if (entry.localPath) return false;
  // Only standalone roots matter. Enumerated children keep slash-nested
  // relative paths and upload as real (streamed) files.
  const relativePath = entry.relativePath || "";
  if (!relativePath || relativePath.includes("/")) return false;
  // Folder names can contain dots; only extension-less names are unambiguous
  // enough to reject automatically.
  if (relativePath.includes(".")) return false;
  // Virtual folder descriptors carry no streamable content.
  const size = entry.file?.size ?? entry.size;
  return size === undefined || size === 0;
};
