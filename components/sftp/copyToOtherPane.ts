export type SftpPaneSide = "left" | "right";

type CopyTargetState = {
  getActivePane: (side: SftpPaneSide) => { connection?: unknown } | null | undefined;
};

export const canCopyToOtherPane = (
  state: CopyTargetState,
  targetSide: SftpPaneSide,
): boolean => Boolean(state.getActivePane(targetSide)?.connection);

export const requireCopyToOtherPaneTarget = (
  state: CopyTargetState,
  targetSide: SftpPaneSide,
  onUnavailable: () => void,
): boolean => {
  if (canCopyToOtherPane(state, targetSide)) return true;
  onUnavailable();
  return false;
};
