export type SftpConflictExistingType = "file" | "directory" | "symlink";

export const getSftpConflictTypeKey = (
  isDirectory: boolean,
  existingType?: SftpConflictExistingType,
): string => `${isDirectory ? "directory" : "file"}:${existingType ?? "unknown"}`;

export const canReplaceSftpConflict = (
  isDirectory: boolean,
  existingType?: SftpConflictExistingType,
): boolean => {
  if (!existingType) return true;
  return (existingType === "directory") === isDirectory;
};

export const describeSftpIncomingKind = (isDirectory: boolean): string =>
  isDirectory ? "directory" : "file";

export const describeSftpExistingKind = (existingType?: SftpConflictExistingType): string =>
  existingType === "directory" ? "directory" : "file";
