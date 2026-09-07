export type SftpPaneSide = "left" | "right";

import {
  getWindowsUncRoot,
  isSameSftpPath,
  isSftpDescendantPath,
  isWindowsPath,
  joinPath,
} from "../../application/state/sftp/utils";

export type SamePanePasteAction = "allow" | "block-same-folder" | "block-into-source";

export interface SamePanePasteFile {
  name: string;
  isDirectory: boolean;
}

/**
 * Lexically resolve "." / ".." segments and repeated separators so equivalent
 * spellings of the same directory (e.g. /home/user/., /home//user) compare
 * equal in the same-pane paste guards. Purely string-level: it never touches
 * the server, and it is only used to make the guards stricter, never to build
 * transfer paths.
 */
const canonicalizeSftpPath = (path: string): string => {
  const isWindows = isWindowsPath(path);
  const separator = isWindows ? "\\" : "/";
  const unified = isWindows ? path.replace(/\//g, "\\") : path;

  let root = "";
  let rest = unified;
  if (isWindows) {
    const uncRoot = getWindowsUncRoot(unified, { acceptForwardSlashUnc: true });
    const driveRoot = unified.match(/^[A-Za-z]:\\/)?.[0];
    if (uncRoot) {
      root = uncRoot;
      rest = unified.slice(uncRoot.length);
    } else if (driveRoot) {
      root = driveRoot;
      rest = unified.slice(driveRoot.length);
    }
  } else if (unified.startsWith("/")) {
    // Collapse a leading "//" to "/" for comparisons: on ordinary POSIX
    // filesystems "//home/user" names the same directory as "/home/user", and
    // treating it as a distinct root would let a same-pane cut reach the
    // replace/delete flow. This helper never builds transfer paths, so the
    // guards stay strict either way.
    root = "/";
    rest = unified.replace(/^\/+/, "");
  }

  const parts: string[] = [];
  for (const segment of rest.split(separator)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }

  if (root) return root + parts.join(separator);
  return parts.join(separator) || ".";
};

/**
 * Decide whether an internal SFTP paste that targets the same connection as the
 * clipboard source can proceed. Copying files into their own source folder is
 * allowed (the conflict dialog handles same-name collisions), but pasting a
 * clipboard directory into itself or one of its descendants is blocked for both
 * copy and cut: the transfer creates the destination before listing the source,
 * so the fresh copy would be rediscovered and nested until the traversal limit.
 * For cuts, pasting into the clipboard's source folder is also blocked because
 * the post-move source delete would remove the freshly moved items. Note that
 * `sourcePath` is the folder containing every clipboard item, so the per-item
 * checks must join it with each selected entry's name.
 */
export const resolveSamePanePasteAction = (params: {
  operation: "copy" | "cut";
  sourcePath: string;
  targetPath: string;
  files: readonly SamePanePasteFile[];
}): SamePanePasteAction => {
  // Canonicalize first so equivalent spellings of the same directory (dot
  // segments, repeated separators) are still caught by the guards below.
  const targetPath = canonicalizeSftpPath(params.targetPath);
  if (
    params.operation === "cut"
    && isSameSftpPath(targetPath, canonicalizeSftpPath(params.sourcePath))
  ) {
    return "block-same-folder";
  }
  for (const file of params.files) {
    if (!file.isDirectory) continue;
    const itemPath = canonicalizeSftpPath(joinPath(params.sourcePath, file.name));
    if (
      isSameSftpPath(targetPath, itemPath)
      || isSftpDescendantPath(targetPath, itemPath)
    ) {
      return "block-into-source";
    }
  }
  return "allow";
};

type CopyTargetState = {
  getActivePane: (side: SftpPaneSide) => {
    connection?: { status?: "connecting" | "connected" | "disconnected" | "error" } | null;
    reconnecting?: boolean;
  } | null | undefined;
};

export const canCopyToOtherPane = (
  state: CopyTargetState,
  targetSide: SftpPaneSide,
): boolean => {
  const targetPane = state.getActivePane(targetSide);
  return targetPane?.connection?.status === "connected" && targetPane.reconnecting !== true;
};

export const requireCopyToOtherPaneTarget = (
  state: CopyTargetState,
  targetSide: SftpPaneSide,
  onUnavailable: () => void,
): boolean => {
  if (canCopyToOtherPane(state, targetSide)) return true;
  onUnavailable();
  return false;
};
