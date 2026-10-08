import type { TransferTask } from "../../../domain/models";

/** Apply only after backend cancellation AND the old walk have settled. */
export function settleCancelledTransferTree(
  tasks: readonly TransferTask[],
  rootId: string,
  cancelledIds: ReadonlySet<string>,
  failedIds: ReadonlySet<string>,
  retainedTasks: readonly TransferTask[] = [],
): TransferTask[] {
  const existingIds = new Set(tasks.map((task) => task.id));
  // Cancellation callbacks may compact terminal child rows before settlement.
  // Recover their checkpoints too, so a large tree does not lose partial work.
  const settledTasks = failedIds.size > 0
    ? [...tasks, ...retainedTasks.filter((task) => !existingIds.has(task.id))]
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
