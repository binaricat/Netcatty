import type { TransferTask } from "../../domain/models";

export const SFTP_TRANSFER_HISTORY_RETENTION_MS = 10 * 60 * 1000;

/** Terminal side-panel transfer owner id for a workspace/session tab. */
export function terminalSftpTransferOwnerId(tabId: string): string {
  return `terminal:${tabId}`;
}

/**
 * Tasks that must keep the hidden SFTP owner mounted (orchestration lives in
 * useSftpState / useSftpTransfers). Matches activeTransfersCount semantics:
 * everything except completed/cancelled top-level rows.
 */
export function isTransferRetainingSftpOwner(
  task: Pick<TransferTask, "status" | "parentTaskId">,
): boolean {
  if (task.parentTaskId) return false;
  return task.status !== "completed" && task.status !== "cancelled";
}

export function countTransfersRetainingSftpOwner(
  tasks: readonly Pick<TransferTask, "status" | "parentTaskId" | "ownerId">[],
  ownerId: string,
): number {
  return tasks.filter(
    (task) => (task.ownerId ?? "") === ownerId && isTransferRetainingSftpOwner(task),
  ).length;
}

/**
 * Prefer the live panel report, but never under-count unfinished work already
 * published to the global transfer center (avoids close-before-layout-effect races).
 */
export function resolveSftpActiveTransfersCount(params: {
  reportedCount: number;
  storeTasks: readonly Pick<TransferTask, "status" | "parentTaskId" | "ownerId">[];
  ownerId: string;
}): number {
  const reported = Math.max(0, params.reportedCount);
  const fromStore = countTransfersRetainingSftpOwner(params.storeTasks, params.ownerId);
  return Math.max(reported, fromStore);
}

/** Tab ids whose terminal:* owner still has unfinished work in the store. */
export function listTerminalTabIdsWithRetainingTransfers(
  tasks: readonly Pick<TransferTask, "status" | "parentTaskId" | "ownerId">[],
): string[] {
  const tabIds = new Set<string>();
  for (const task of tasks) {
    if (!isTransferRetainingSftpOwner(task)) continue;
    const ownerId = task.ownerId ?? "";
    if (!ownerId.startsWith("terminal:")) continue;
    tabIds.add(ownerId.slice("terminal:".length));
  }
  return [...tabIds];
}

export function shouldKeepSftpMountedAfterClose(params: {
  activeTransfersCount: number;
  /** External-editor temps still need the browse session (closeSftp deletes them). */
  activeExternalEditCount?: number;
}): boolean {
  return params.activeTransfersCount > 0
    || (params.activeExternalEditCount ?? 0) > 0;
}

export function shouldCloseSftpSidePanel(params: {
  shouldKeepOpen: boolean;
  isOpen: boolean;
  isSameEndpoint: boolean;
  paneCount: number;
}): boolean {
  return !params.shouldKeepOpen
    && params.isOpen
    && params.isSameEndpoint
    && params.paneCount <= 1;
}

export function shouldClearSftpPanelAfterTransferChange(params: {
  activeTransfersCount: number;
  activeExternalEditCount?: number;
  panelOpen: boolean;
  retainedAfterClose: boolean;
}): boolean {
  return params.activeTransfersCount <= 0
    && (params.activeExternalEditCount ?? 0) <= 0
    && !params.panelOpen
    && !params.retainedAfterClose;
}

export function shouldScheduleSftpRetainedPanelCleanup(params: {
  activeTransfersCount: number;
  activeExternalEditCount?: number;
  retainedAfterClose: boolean;
}): boolean {
  return params.activeTransfersCount <= 0
    && (params.activeExternalEditCount ?? 0) <= 0
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
  const activeTransferTabIds = new Set(params.activeTransferTabIds);
  const trackedTabIds = new Set([
    ...params.mountedTabIds,
    ...activeTransferTabIds,
    ...params.retainedTabIds,
    ...params.openingTabIds,
    ...params.cleanupTimerTabIds,
  ]);
  return [...trackedTabIds].filter((tabId) => (
    !params.validTabIds.has(tabId) && !activeTransferTabIds.has(tabId)
  ));
}
