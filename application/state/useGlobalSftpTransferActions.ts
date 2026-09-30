import { useCallback, useMemo, useRef, useState } from "react";

import type { TransferTask } from "../../domain/models";
import {
  getGlobalTransferBatchEligibility,
  listGloballyCancellableTransferIds,
  listGloballyPausableTransferIds,
  listGloballyResumableTransferIds,
} from "../../domain/sftpTransferActions";
import { sftpTransferCenterStore } from "./sftpTransferCenterStore";
import { globalSftpTransferScheduler } from "./sftp/globalTransferScheduler";
import { clearTransferCancelledTree, markTransferCancelledTree } from "./sftp/transferCancelLatch";
import { transferRuntime } from "./sftp/transferRuntime";

export function useGlobalSftpTransferActions(tasks: readonly TransferTask[]) {
  const cancellingRef = useRef(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const batchEligibility = useMemo(
    () => getGlobalTransferBatchEligibility(tasks),
    [tasks],
  );
  const pauseAll = useCallback(() => {
    for (const taskId of listGloballyPausableTransferIds(tasks)) {
      void sftpTransferCenterStore.pause(taskId);
    }
  }, [tasks]);
  const resumeAll = useCallback(() => {
    for (const taskId of listGloballyResumableTransferIds(tasks)) {
      void sftpTransferCenterStore.resume(taskId);
    }
  }, [tasks]);

  const cancelAll = useCallback(async () => {
    if (cancellingRef.current) return;
    cancellingRef.current = true;
    setIsCancelling(true);
    const currentTasks = transferRuntime.getSnapshot().tasks;
    const ids = listGloballyCancellableTransferIds(currentTasks);
    try {
      // Stop queued work before yielding to IPC, including children of folder
      // transfers. Otherwise later batches could start while earlier ones stop.
      const selected = new Set(ids);
      const children = new Map<string, string[]>();
      for (const task of currentTasks) {
        if (!task.parentTaskId || !selected.has(task.parentTaskId)
          || ["completed", "failed", "cancelled"].includes(task.status)) continue;
        const idsForParent = children.get(task.parentTaskId) ?? [];
        idsForParent.push(task.id);
        children.set(task.parentTaskId, idsForParent);
        globalSftpTransferScheduler.cancel(task.id);
      }
      for (const id of ids) {
        markTransferCancelledTree(id, children.get(id));
        globalSftpTransferScheduler.cancel(id);
      }
      // Bound IPC work for large queues while active transfers stop promptly.
      for (let offset = 0; offset < ids.length; offset += 32) {
        await Promise.all(ids.slice(offset, offset + 32).map(async (taskId) => {
          const current = transferRuntime.getTask(taskId);
          // "failed" is terminal here just like the initial eligibility filter:
          // a queued task can fail naturally while its cancel batch awaits IPC,
          // and cancel's owner/orphan recovery paths would repaint the row as
          // cancelled, hiding the real failure and its diagnostic.
          if (!current || ["completed", "failed", "cancelled"].includes(current.status)) return;
          try {
            await transferRuntime.cancel(taskId);
          } catch {
            // The row is kept in attention for recovery, so the pre-installed
            // cancellation latch must be dropped or a later Resume is rejected
            // outright by admitTaskRun's cancelled-root check.
            clearTransferCancelledTree(taskId, children.get(taskId));
            sftpTransferCenterStore.patchTask(taskId, {
              status: "attention",
              error: "Could not cancel transfer. Please try again.",
            });
          }
        }));
      }
    } finally {
      cancellingRef.current = false;
      setIsCancelling(false);
    }
  }, []);

  return { batchEligibility, pauseAll, resumeAll, cancelAll, isCancelling };
}
