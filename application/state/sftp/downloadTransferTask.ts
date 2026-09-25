import type { LocalDownloadTargetExpectation, TransferStatus, TransferTask } from "../../../domain/models";

export interface DirectDownloadTransferTaskInput {
  id: string;
  fileName: string;
  sourcePath: string;
  targetPath: string;
  expectedLocalTarget?: LocalDownloadTargetExpectation;
  /** Connect-time route key (proxy/jump) that identified the browsed source. */
  expectedSourceEndpointKey?: string;
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
    // A remembered target is safe only when the exact connect-time route that
    // identified the source can be re-established, so a task that was
    // validated against a session-only proxy/jump route must never be
    // hard-reconnected from the vault host alone: the replacement bytes could
    // come from a different server's identical path (Codex P1 on PR #3516).
    requireOriginalSourceForResume:
      !!input.expectedLocalTarget || !!input.expectedSourceEndpointKey,
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
