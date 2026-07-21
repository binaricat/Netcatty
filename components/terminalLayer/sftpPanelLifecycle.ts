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
  retainedAfterClose: boolean;
}): boolean {
  return params.activeTransfersCount <= 0
    && params.retainedAfterClose;
}

export function listInvalidSftpPanelTabIds(params: {
  mountedTabIds: Iterable<string>;
  activeTransferTabIds: Iterable<string>;
  retainedTabIds: Iterable<string>;
  openingTabIds: Iterable<string>;
  cleanupTimerTabIds: Iterable<string>;
  validTabIds: ReadonlySet<string>;
}): string[] {
  const trackedTabIds = new Set([
    ...params.mountedTabIds,
    ...params.activeTransferTabIds,
    ...params.retainedTabIds,
    ...params.openingTabIds,
    ...params.cleanupTimerTabIds,
  ]);
  return [...trackedTabIds].filter((tabId) => !params.validTabIds.has(tabId));
}
