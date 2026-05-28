import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { FileConflict, TransferStatus, TransferTask } from "../../../domain/models";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { logger } from "../../../lib/logger";
import type { TransferResult } from "./useSftpTransfers.types";

interface UseSftpTransferTaskOpsParams {
  cancelledTasksRef: MutableRefObject<Set<string>>;
  activeChildIdsRef: MutableRefObject<Map<string, Set<string>>>;
  transfersRef: MutableRefObject<TransferTask[]>;
  completionHandlersRef: MutableRefObject<Map<string, (result: TransferResult) => void | Promise<void>>>;
  setConflicts: Dispatch<SetStateAction<FileConflict[]>>;
  setTransfers: Dispatch<SetStateAction<TransferTask[]>>;
}

export function useSftpTransferTaskOps({
  cancelledTasksRef,
  activeChildIdsRef,
  transfersRef,
  completionHandlersRef,
  setConflicts,
  setTransfers,
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

    const cancelTransferAtBackend = netcattyBridge.get()?.cancelTransfer;
    if (!cancelTransferAtBackend) return;

    await Promise.all(
      Array.from(idsToCancel).map((id) =>
        cancelTransferAtBackend(id).catch((err) => {
          logger.warn("Failed to cancel transfer at backend:", err);
        }),
      ),
    );
  }, [activeChildIdsRef, cancelledTasksRef, transfersRef]);

  const markBatchStopped = useCallback(
    async (task: TransferTask) => {
      const batchId = task.batchId;
      const affected = transfersRef.current.filter((candidate) =>
        candidate.id === task.id ||
        (!!batchId && candidate.batchId === batchId && (candidate.status === "pending" || candidate.status === "transferring")),
      );

      affected.forEach((candidate) => cancelledTasksRef.current.add(candidate.id));
      const affectedIds = new Set(affected.map((candidate) => candidate.id));
      setConflicts((prev) => prev.filter((conflict) => conflict.transferId !== task.id && (!batchId || conflict.batchId !== batchId)));
      setTransfers((prev) => {
        for (const candidate of prev) {
          if (candidate.parentTaskId && affectedIds.has(candidate.parentTaskId)) {
            cancelledTasksRef.current.add(candidate.id);
          }
        }

        return prev
          .filter((candidate) => !(candidate.parentTaskId && affectedIds.has(candidate.parentTaskId)))
          .map((candidate) =>
            affectedIds.has(candidate.id)
              ? { ...candidate, status: "cancelled" as TransferStatus, endTime: Date.now() }
              : candidate,
          );
      });
      await cancelBackendTransfers(affected.map((candidate) => candidate.id));

      for (const candidate of affected) {
        await completeCancelledTask(candidate);
      }
    },
    [cancelBackendTransfers, cancelledTasksRef, completeCancelledTask, setConflicts, setTransfers, transfersRef],
  );


  return { completeCancelledTask, cancelBackendTransfers, markBatchStopped };
}
