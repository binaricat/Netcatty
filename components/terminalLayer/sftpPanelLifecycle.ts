export function shouldKeepSftpMountedAfterClose(activeTransfersCount: number): boolean {
  return activeTransfersCount > 0;
}

export function shouldClearSftpPanelAfterTransferChange(params: {
  activeTransfersCount: number;
  panelOpen: boolean;
  retainedAfterClose: boolean;
}): boolean {
  return params.activeTransfersCount <= 0
    && !params.panelOpen
    && !params.retainedAfterClose;
}
