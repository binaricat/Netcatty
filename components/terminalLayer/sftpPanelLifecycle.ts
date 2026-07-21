export const SFTP_TRANSFER_HISTORY_RETENTION_MS = 10 * 60 * 1000;

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

export function shouldScheduleSftpRetainedPanelCleanup(params: {
  activeTransfersCount: number;
  panelOpen: boolean;
  retainedAfterClose: boolean;
}): boolean {
  return params.activeTransfersCount <= 0
    && !params.panelOpen
    && params.retainedAfterClose;
}
