import type { TransferTask } from "./models";

export function getGlobalTransferBatchEligibility(tasks: readonly TransferTask[]) {
  const topLevel = tasks.filter((task) => !task.parentTaskId);
  return {
    cancellableCount: listGloballyCancellableTransferIds(tasks).length,
    pausableCount: topLevel.filter((task) => (
      ["pending", "queued", "transferring"].includes(task.status)
      && task.resumable !== false
      && !(task.ownerId === "dedicated-resume" && task.reconnectRequired)
    )).length,
    resumableCount: topLevel.filter((task) => (
      !task.conflict
      && task.resumable !== false
      && (
        ["pausing", "paused", "interrupted", "attention"].includes(task.status)
        || (task.status === "failed" && (task.checkpointBytes ?? 0) > 0)
      )
    )).length,
  };
}

export function listGloballyCancellableTransferIds(tasks: readonly TransferTask[]): string[] {
  return tasks.filter((task) => (
    !task.parentTaskId
    && ["pending", "queued", "transferring", "pausing", "paused", "interrupted", "attention"].includes(task.status)
  )).map((task) => task.id);
}

export function listGloballyPausableTransferIds(tasks: readonly TransferTask[]): string[] {
  return tasks.filter((task) => (
    !task.parentTaskId
    && !(task.ownerId === "dedicated-resume" && task.reconnectRequired)
    && ["pending", "queued", "transferring", "pausing"].includes(task.status)
    && task.resumable !== false
  )).map((task) => task.id);
}

export function listGloballyResumableTransferIds(tasks: readonly TransferTask[]): string[] {
  return tasks.filter((task) => (
    !task.parentTaskId
    && !task.conflict
    && task.resumable !== false
    && (
      ["paused", "pausing", "interrupted", "attention"].includes(task.status)
      || (task.status === "failed" && (task.checkpointBytes ?? 0) > 0)
    )
  )).map((task) => task.id);
}
