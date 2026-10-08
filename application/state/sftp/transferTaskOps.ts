import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { FileConflict, TransferStatus, TransferTask } from "../../../domain/models";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { logger } from "../../../lib/logger";
import { globalSftpTransferScheduler } from "./globalTransferScheduler";
import type { TransferResult } from "./useSftpTransfers.types";

interface UseSftpTransferTaskOpsParams {
  cancelledTasksRef: MutableRefObject<Set<string>>;
  activeChildIdsRef: MutableRefObject<Map<string, Set<string>>>;
  transfersRef: MutableRefObject<TransferTask[]>;
  completionHandlersRef: MutableRefObject<Map<string, (result: TransferResult) => void | Promise<void>>>;
  setConflicts: Dispatch<SetStateAction<FileConflict[]>>;
  setTransfers: Dispatch<SetStateAction<TransferTask[]>>;
  releasePausedTransfer?: (taskId: string) => void;
  cleanupTaskArtifacts?: (task: TransferTask) => void | Promise<void>;
}

export function useSftpTransferTaskOps({
  cancelledTasksRef,
  activeChildIdsRef,
  transfersRef,
  completionHandlersRef,
  setConflicts,
  setTransfers,
  releasePausedTransfer,
  cleanupTaskArtifacts,
}: UseSftpTransferTaskOpsParams) {
  const completeCancelledTask = useCallback(
    async (task: TransferTask) => {
      const completionHandler = completionHandlersRef.current.get(task.id);
      if (completionHandler) {
        try {
          await completionHandler({
            id: task.id,
            fileName: task.fileName,
            originalFileName: task.originalFileName ?? task.fileName,
            status: "cancelled",
          });
        } finally {
          completionHandlersRef.current.delete(task.id);
        }
      }
    },
    [completionHandlersRef],
  );

  const cancelBackendTransfers = useCallback(async (transferIds: string[]) => {
    const idsToCancel = new Set<string>();
    const currentTransfers = transfersRef.current;
    for (const transferId of transferIds) {
      idsToCancel.add(transferId);
      const trackedChildren = activeChildIdsRef.current.get(transferId);
      if (trackedChildren) {
        for (const childId of trackedChildren) {
          idsToCancel.add(childId);
          cancelledTasksRef.current.add(childId);
        }
      }
      for (const transfer of currentTransfers) {
        if (
          transfer.parentTaskId === transferId &&
          (transfer.status === "transferring" || transfer.status === "pending")
        ) {
          idsToCancel.add(transfer.id);
          cancelledTasksRef.current.add(transfer.id);
        }
      }
    }

    const bridge = netcattyBridge.get();
    const cancelTransferAtBackend = bridge?.cancelTransfer;
    const cancelCompressedUpload = bridge?.cancelCompressedUpload;
    if (!cancelTransferAtBackend && !cancelCompressedUpload) return [];

    const failed: string[] = [];
    const ids = [...idsToCancel];
    for (let offset = 0; offset < ids.length; offset += 32) {
      await Promise.all(ids.slice(offset, offset + 32).map(async (id) => {
        const candidate = currentTransfers.find((task) => task.id === id);
        const compressed = candidate?.controlKind === "compressed-upload";
        try {
          const result = await (compressed ? cancelCompressedUpload?.(id) : cancelTransferAtBackend?.(id));
          if (result && result.success === false) failed.push(id);
        } catch {
          failed.push(id);
        }
      }));
    }
    if (failed.length > 0) logger.warn("Failed to cancel one or more transfer backends");
    return failed;
  }, [activeChildIdsRef, cancelledTasksRef, transfersRef]);

  const markBatchStopped = useCallback(
    async (task: TransferTask) => {
      const batchId = task.batchId;
      // Stop the whole unfinished batch, including siblings already waiting on
      // conflict resolution (attention), not only pending/transferring rows.
      const isUnfinished = (status: TransferTask["status"]) =>
        !["completed", "cancelled", "failed"].includes(status);
      const affected = transfersRef.current.filter((candidate) =>
        candidate.id === task.id ||
        (!!batchId && candidate.batchId === batchId && isUnfinished(candidate.status)),
      );

      for (const candidate of affected) {
        cancelledTasksRef.current.add(candidate.id);
        globalSftpTransferScheduler.cancel(candidate.id);
        releasePausedTransfer?.(candidate.id);
      }
      const affectedIds = new Set(affected.map((candidate) => candidate.id));
      for (const candidate of transfersRef.current) {
        if (candidate.parentTaskId && affectedIds.has(candidate.parentTaskId)) {
          cancelledTasksRef.current.add(candidate.id);
          globalSftpTransferScheduler.cancel(candidate.id);
          releasePausedTransfer?.(candidate.id);
          affectedIds.add(candidate.id);
        }
      }
      const nextTransfers = transfersRef.current
        .filter((candidate) => !(candidate.parentTaskId && affectedIds.has(candidate.parentTaskId)))
        .map((candidate) =>
          affectedIds.has(candidate.id)
            ? { ...candidate, status: "cancelled" as TransferStatus, endTime: Date.now(), conflict: undefined }
            : candidate,
        );
      transfersRef.current = nextTransfers;
      setTransfers(nextTransfers);
      setConflicts((prev) => prev.filter((conflict) => !affectedIds.has(conflict.transferId) && (!batchId || conflict.batchId !== batchId)));
      await cancelBackendTransfers([...affectedIds]);

      for (const candidate of affected) {
        try {
          await cleanupTaskArtifacts?.(candidate);
        } catch {
          // best-effort
        }
        await completeCancelledTask(candidate);
      }
    },
    [
      cancelBackendTransfers,
      cancelledTasksRef,
      cleanupTaskArtifacts,
      completeCancelledTask,
      releasePausedTransfer,
      setConflicts,
      setTransfers,
      transfersRef,
    ],
  );


  return { completeCancelledTask, cancelBackendTransfers, markBatchStopped };
}
