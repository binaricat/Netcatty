import type { TransferTask } from "../../../domain/models";
import { isValidDirectoryResumeCheckpoint } from "../../../domain/sftpDirectoryCheckpoint";

/** Apply only after backend cancellation AND the old walk have settled. */
export function settleCancelledTransferTree(
  tasks: readonly TransferTask[],
  rootId: string,
  cancelledIds: ReadonlySet<string>,
  failedIds: ReadonlySet<string>,
  retainedTasks: readonly TransferTask[] = [],
): TransferTask[] {
  const existingTasks = new Map(tasks.map((task) => [task.id, task]));
  // Use observed terminal outcomes rather than stale pre-cancel snapshots.
  // Missing completed children already covered by the parent stay compacted;
  // cancelled/failed exceptions still need their rows for the recovery walk.
  const settledTasks = failedIds.size > 0
    ? [...tasks, ...retainedTasks.filter((task) => {
      if (existingTasks.has(task.id)) return false;
      const checkpoint = task.parentTaskId
        ? existingTasks.get(task.parentTaskId)?.directoryResumeCheckpoint
        : undefined;
      return !(task.status === "completed"
        && isValidDirectoryResumeCheckpoint(checkpoint)
        && Number.isSafeInteger(task.directoryEntryIndex)
        && (task.directoryEntryIndex ?? -1) >= 0
        && task.directoryEntryIndex! < checkpoint.coveredEntries);
    })]
    : tasks;
  return settledTasks.map((task) => {
    // Natural completion/failure wins a race with Cancel. Rows cancelled by
    // this attempt can be re-admitted only when the whole tree needs recovery.
    if (!cancelledIds.has(task.id) || task.status === "completed" || task.status === "failed") return task;
    const failed = failedIds.has(task.id) || (task.id === rootId && failedIds.size > 0);
    const recoverable = failedIds.size > 0;
    return {
      ...task,
      status: failed ? "attention" : recoverable ? "interrupted" : "cancelled",
      error: failed ? "Could not cancel transfer. Please try again." : undefined,
      reconnectRequired: recoverable,
      endTime: recoverable ? undefined : Date.now(),
      speed: 0,
      phase: undefined,
      conflict: undefined,
    };
  });
}
