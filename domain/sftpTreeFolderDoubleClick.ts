export const SFTP_TREE_FOLDER_DOUBLE_CLICK_BEHAVIORS = ["navigate", "expand"] as const;

export type SftpTreeFolderDoubleClickBehavior =
  (typeof SFTP_TREE_FOLDER_DOUBLE_CLICK_BEHAVIORS)[number];

export const DEFAULT_SFTP_TREE_FOLDER_DOUBLE_CLICK_BEHAVIOR: SftpTreeFolderDoubleClickBehavior =
  "navigate";

export function isSftpTreeFolderDoubleClickBehavior(
  value: unknown,
): value is SftpTreeFolderDoubleClickBehavior {
  return value === "navigate" || value === "expand";
}

export function parseSftpTreeFolderDoubleClickBehavior(
  value: unknown,
): SftpTreeFolderDoubleClickBehavior {
  return isSftpTreeFolderDoubleClickBehavior(value)
    ? value
    : DEFAULT_SFTP_TREE_FOLDER_DOUBLE_CLICK_BEHAVIOR;
}
