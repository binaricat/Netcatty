export type SftpPaneSide = "left" | "right";

import { isSameSftpPath, isSftpDescendantPath } from "../../application/state/sftp/utils";

export type SamePanePasteAction = "allow" | "block-same-folder" | "block-into-source";

/**
 * Decide whether an internal SFTP paste that targets the same connection as the
 * clipboard source can proceed. Copying within the same pane is always allowed
 * (the conflict dialog handles same-name collisions). Cutting is only blocked
 * when the paste target would be destroyed by the post-move source delete:
 * pasting into the source folder itself, or into one of its descendants.
 */
export const resolveSamePanePasteAction = (params: {
  operation: "copy" | "cut";
  sourcePath: string;
  targetPath: string;
}): SamePanePasteAction => {
  if (params.operation !== "cut") return "allow";
  if (isSameSftpPath(params.targetPath, params.sourcePath)) return "block-same-folder";
  if (isSftpDescendantPath(params.targetPath, params.sourcePath)) return "block-into-source";
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
