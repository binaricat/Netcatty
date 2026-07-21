export function shouldKeepSftpMountedAfterClose(activeTransfersCount: number): boolean {
  return activeTransfersCount > 0;
}
