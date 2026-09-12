export type SftpConflictExistingType = "file" | "directory" | "symlink";

export const getSftpConflictTypeKey = (
  isDirectory: boolean,
  existingType?: SftpConflictExistingType,
): string => `${isDirectory ? "directory" : "file"}:${existingType ?? "unknown"}`;

export const canReplaceSftpConflict = (
  isDirectory: boolean,
  existingType?: SftpConflictExistingType,
): boolean => {
  // Legacy persisted conflicts may not know the destination type. A file keeps
  // its historical behavior, but a folder must fail closed because the unknown
  // target may itself be a folder with destination-only data.
  if (!existingType) return !isDirectory;
  // Symlinks are neither files nor directories for conflict typing. Replace must
  // unlink the link itself (not follow it), so either incoming kind may replace.
  if (existingType === "symlink") return true;
  return (existingType === "directory") === isDirectory;
};

export const shouldUnlinkSftpConflictBeforeReplace = (
  existingType?: SftpConflictExistingType,
): boolean => existingType === "symlink";

export const describeSftpIncomingKind = (isDirectory: boolean): string =>
  isDirectory ? "directory" : "file";

export const describeSftpExistingKind = (existingType?: SftpConflictExistingType): string =>
  existingType === "directory" ? "directory" : "file";
