import type { LocalDownloadTargetExpectation, TransferStatus, TransferTask } from "../../../domain/models";

export interface DirectDownloadTransferTaskInput {
  id: string;
  fileName: string;
  sourcePath: string;
  targetPath: string;
  expectedLocalTarget?: LocalDownloadTargetExpectation;
  sourceConnectionId: string;
  sourceHostId: string;
  sourceHostLabel: string;
  totalBytes: number;
  isDirectory: boolean;
}

export function createDirectDownloadTransferTask(
  input: DirectDownloadTransferTaskInput,
): TransferTask {
  return {
    id: input.id,
    fileName: input.fileName,
    originalFileName: input.fileName,
    sourcePath: input.sourcePath,
    targetPath: input.targetPath,
    expectedLocalTarget: input.expectedLocalTarget,
    sourceConnectionId: input.sourceConnectionId,
    targetConnectionId: "local",
    sourceHostId: input.sourceHostId,
    sourceHostLabel: input.sourceHostLabel,
    targetHostLabel: "Local",
    direction: "download",
    status: "queued",
    totalBytes: input.totalBytes,
    transferredBytes: 0,
    speed: 0,
    startTime: Date.now(),
    isDirectory: input.isDirectory,
    progressMode: input.isDirectory ? "files" : "bytes",
    retryable: true,
    origin: "manual",
    resumable: true,
  };
}

/**
 * Final parent status after downloadToLocal finishes a directory tree.
 * Cancel must win over child error counts — cancelled children are counted as
 * errors by transferDirectory, but the parent was cancelled by the user.
 */
export function resolveDirectDirectoryDownloadFinalStatus(input: {
  parentCancelled: boolean;
  childFailureCount: number;
}): { status: TransferStatus; error?: string } {
  if (input.parentCancelled) {
    return { status: "cancelled" };
  }
  if (input.childFailureCount > 0) {
    return { status: "failed", error: "Some files failed to transfer" };
  }
  return { status: "completed" };
}
