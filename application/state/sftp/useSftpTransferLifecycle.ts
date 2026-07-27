import { useEffect, useLayoutEffect, useRef } from "react";

import { sftpTransferCenterStore } from "../sftpTransferCenterStore";

export function useWarmSftpTransferPool(params: {
  hostIds: readonly string[];
  activeHostId?: string;
  enabled?: boolean;
  warmTransferPoolForHost?: (hostId: string) => void | Promise<void>;
}) {
  const warmRef = useRef(params.warmTransferPoolForHost);
  warmRef.current = params.warmTransferPoolForHost;
  const hostIdsKey = getWarmSftpTransferPoolHostIds(params).join("\u0000");

  useEffect(() => {
    for (const hostId of hostIdsKey.split("\u0000").filter(Boolean)) {
      void warmRef.current?.(hostId);
    }
  }, [hostIdsKey]);
}

/**
 * Resolve the hosts that may be pre-warmed for transfer-pool usage.
 *
 * The default is intentionally off: opening a terminal SFTP browser should not
 * start a background SSH/SFTP authentication flow, because MFA-backed hosts can
 * show an unexpected secondary-password prompt before any transfer begins.
 */
export function getWarmSftpTransferPoolHostIds(params: {
  hostIds: readonly string[];
  activeHostId?: string;
  enabled?: boolean;
}): string[] {
  if (!params.enabled) return [];
  return [...new Set([
    ...params.hostIds,
    ...(params.activeHostId ? [params.activeHostId] : []),
  ])].sort();
}

export function useReportSftpTransferOwnerActivity(params: {
  ownerId: string;
  activeTransfersCount: number;
  onActiveTransfersChange?: (count: number) => void;
}) {
  const onChangeRef = useRef(params.onActiveTransfersChange);
  onChangeRef.current = params.onActiveTransfersChange;

  useLayoutEffect(() => {
    onChangeRef.current?.(params.activeTransfersCount);
  }, [params.activeTransfersCount]);

  useEffect(() => () => {
    const unfinished = sftpTransferCenterStore.getSnapshot().tasks.filter((task) => (
      task.ownerId === params.ownerId
      && !task.parentTaskId
      && task.status !== "completed"
      && task.status !== "cancelled"
    )).length;
    onChangeRef.current?.(unfinished);
  }, [params.ownerId]);
}
