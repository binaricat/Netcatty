export type SftpPaneSide = "left" | "right";

type CopyTargetState = {
  getActivePane: (side: SftpPaneSide) => {
    connection?: { status?: "connecting" | "connected" | "disconnected" | "error" } | null;
  } | null | undefined;
};

export const canCopyToOtherPane = (
  state: CopyTargetState,
  targetSide: SftpPaneSide,
): boolean => state.getActivePane(targetSide)?.connection?.status === "connected";

export const requireCopyToOtherPaneTarget = (
  state: CopyTargetState,
  targetSide: SftpPaneSide,
  onUnavailable: () => void,
): boolean => {
  if (canCopyToOtherPane(state, targetSide)) return true;
  onUnavailable();
  return false;
};
