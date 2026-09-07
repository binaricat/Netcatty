export type SftpPaneSide = "left" | "right";

import {
  isSameSftpPath,
  isSftpDescendantPath,
  joinPath,
} from "../../application/state/sftp/utils";

export type SamePanePasteAction = "allow" | "block-same-folder" | "block-into-source";

export interface SamePanePasteFile {
  name: string;
  isDirectory: boolean;
}

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
  if (
    params.operation === "cut"
    && isSameSftpPath(params.targetPath, params.sourcePath)
  ) {
    return "block-same-folder";
  }
  for (const file of params.files) {
    if (!file.isDirectory) continue;
    const itemPath = joinPath(params.sourcePath, file.name);
    if (
      isSameSftpPath(params.targetPath, itemPath)
      || isSftpDescendantPath(params.targetPath, itemPath)
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
