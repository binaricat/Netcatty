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

  // UNC roots come back without a trailing separator, so re-insert one before
  // joining the segments; without it \\server\share\docs would collapse to
  // \\server\sharedocs and collide with an unrelated share's path.
  if (root) {
    return root.endsWith(separator)
      ? root + parts.join(separator)
      : root + separator + parts.join(separator);
  }
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
 *
 * Lexical canonicalization alone cannot see through symlinks: when the
 * destination reaches the copied directory through an alias (e.g.
 * `/a/link -> /a/docs/sub`), a purely string-level comparison would allow the
 * paste and the recursive transfer would rediscover its own output. When
 * `resolvePath` is provided (SFTP realpath for remote connections, the local
 * realpath bridge for local panes), both sides are resolved through the
 * filesystem before comparing. If that resolution fails, the guard fails
 * closed and blocks the paste rather than risking a runaway transfer.
 */
export const resolveSamePanePasteAction = async (params: {
  operation: "copy" | "cut";
  sourcePath: string;
  targetPath: string;
  files: readonly SamePanePasteFile[];
  /** Optional filesystem resolver (e.g. realpath). Throws → unresolvable. */
  resolvePath?: (path: string) => Promise<string>;
}): Promise<SamePanePasteAction> => {
  const { resolvePath } = params;

  // Canonicalize first so equivalent spellings of the same directory (dot
  // segments, repeated separators) are still caught by the guards below, then
  // resolve through the filesystem when a resolver is available so symlink
  // aliases compare equal to their real targets. Returns null when resolution
  // fails, which callers treat as fail-closed.
  const canonicalizeForComparison = async (path: string): Promise<string | null> => {
    const lexical = canonicalizeSftpPath(path);
    if (!resolvePath) return lexical;
    try {
      return canonicalizeSftpPath(await resolvePath(path));
    } catch {
      return null;
    }
  };

  const [targetPath, sourcePath] = await Promise.all([
    canonicalizeForComparison(params.targetPath),
    canonicalizeForComparison(params.sourcePath),
  ]);
  // A files-only copy has no nesting hazard, so an unresolvable path only
  // blocks pastes that could actually recurse (directory items, or a cut).
  const failClosed = !targetPath || !sourcePath;
  if (failClosed && (params.operation === "cut" || params.files.some((file) => file.isDirectory))) {
    return "block-into-source";
  }
  if (failClosed) return "allow";

  if (params.operation === "cut" && isSameSftpPath(targetPath, sourcePath)) {
    return "block-same-folder";
  }
  for (const file of params.files) {
    if (!file.isDirectory) continue;
    const itemPath = await canonicalizeForComparison(joinPath(params.sourcePath, file.name));
    if (!itemPath) return "block-into-source";
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
