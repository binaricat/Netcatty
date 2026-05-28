import type { TransferTask, TransferStatus } from "../../../domain/models";
import type { UploadCallbacks, UploadTaskInfo } from "../../../lib/uploadService";
import { joinPath } from "./utils";

interface UploadTaskCallbacksParams {
  connectionId: string;
  targetPath: string;
  targetHostId?: string;
  targetConnectionKey?: string;
  addExternalUpload?: (task: TransferTask) => void;
  updateExternalUpload?: (taskId: string, updates: Partial<TransferTask>) => void;
  dismissExternalUpload?: (taskId: string) => void;
}

export const createUploadTaskCallbacks = ({
  connectionId,
  targetPath,
  targetHostId,
  targetConnectionKey,
  addExternalUpload,
  updateExternalUpload,
  dismissExternalUpload,
}: UploadTaskCallbacksParams): UploadCallbacks => ({
  onScanningStart: (taskId: string) => {
    if (!addExternalUpload) return;
    addExternalUpload({
      id: taskId,
      fileName: "Scanning files...",
      sourcePath: "local",
      targetPath,
      sourceConnectionId: "external",
      targetConnectionId: connectionId,
      targetHostId,
      targetConnectionKey,
      direction: "upload",
      status: "pending" as TransferStatus,
      totalBytes: 0,
      transferredBytes: 0,
      speed: 0,
      startTime: Date.now(),
      isDirectory: true,
      progressMode: "bytes",
    });
  },
  onScanningEnd: (taskId: string) => {
    dismissExternalUpload?.(taskId);
  },
  onTaskCreated: (task: UploadTaskInfo) => {
    if (!addExternalUpload) return;
    addExternalUpload({
      id: task.id,
      fileName: task.displayName,
      sourcePath: "local",
      targetPath: joinPath(targetPath, task.fileName),
      sourceConnectionId: "external",
      targetConnectionId: connectionId,
      targetHostId,
      targetConnectionKey,
      direction: "upload",
      status: "transferring" as TransferStatus,
      totalBytes: task.totalBytes,
      transferredBytes: 0,
      speed: 0,
      startTime: Date.now(),
      isDirectory: task.isDirectory,
      progressMode: task.progressMode ?? "bytes",
      parentTaskId: task.parentTaskId,
    });
  },
  onTaskProgress: (taskId: string, progress) => {
    updateExternalUpload?.(taskId, {
      transferredBytes: progress.transferred,
      speed: progress.speed,
    });
  },
  onTaskCompleted: (taskId: string, totalBytes: number) => {
    updateExternalUpload?.(taskId, {
      status: "completed" as TransferStatus,
      endTime: Date.now(),
      transferredBytes: totalBytes,
      speed: 0,
    });
  },
  onTaskFailed: (taskId: string, error: string) => {
    updateExternalUpload?.(taskId, {
      status: "failed" as TransferStatus,
      endTime: Date.now(),
      error,
      speed: 0,
    });
  },
  onTaskCancelled: (taskId: string) => {
    updateExternalUpload?.(taskId, {
      status: "cancelled" as TransferStatus,
      endTime: Date.now(),
      speed: 0,
    });
  },
});
