import { findActivePathConflict, pathConflictMessage } from "../../../domain/sftpTransferConflicts";
import { STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY, STORAGE_KEY_SFTP_USE_PACKED_DOWNLOAD } from "../../../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { sftpTransferCenterStore } from "../sftpTransferCenterStore";
import { createDirectDownloadTransferTask } from "./downloadTransferTask";
import { unwrapSftpIpcError } from "./errors";
import { globalSftpTransferScheduler, getSftpTransferResourceKeys } from "./globalTransferScheduler";
import { isTransferCancelledFlag } from "./transferCancelLatch";
import { transferRuntime } from "./transferRuntime";
import type { PackedDownloadRequest, PackedDownloadStatus } from "./useSftpTransfers.types";
import { joinPath, joinTransferTargetPath } from "./utils";

export async function runPackedDownload(ownerId: string, request: PackedDownloadRequest): Promise<PackedDownloadStatus> {
  const bridge = netcattyBridge.get();
  if (!bridge?.downloadPackedSftp || localStorageAdapter.readBoolean(STORAGE_KEY_SFTP_USE_PACKED_DOWNLOAD) === false) {
    return "regular";
  }
  if (!request.remoteDirectory.startsWith("/")) return "unsupported";

  const id = crypto.randomUUID();
  const targetPaths = request.names.map((name) => joinTransferTargetPath(request.localDirectory, name));
  const task = createDirectDownloadTransferTask({
    id, fileName: request.fileName,
    sourcePath: request.names.length === 1 ? joinPath(request.remoteDirectory, request.names[0]) : request.remoteDirectory,
    targetPath: targetPaths.length === 1 ? targetPaths[0] : request.localDirectory,
    sourceConnectionId: request.connectionId, sourceHostId: request.sourceHostId,
    sourceHostLabel: request.sourceHostLabel, isDirectory: true, totalBytes: 0,
  });
  const active = sftpTransferCenterStore.getSnapshot().tasks;
  for (const targetPath of targetPaths) {
    const conflict = findActivePathConflict(active, { ...task, targetPath });
    if (conflict) throw new Error(pathConflictMessage(conflict));
  }

  // Reserve all selected roots synchronously, before waiting for a slot or a channel.
  transferRuntime.enqueue([{ ...task, ownerId, packedTargetPaths: targetPaths,
    controlKind: "packed-download", progressMode: "bytes", resumable: false, retryable: false,
  }]);
  const packed = bridge.downloadPackedSftp;
  let outcome: PackedDownloadStatus = "cancelled";
  let received = 0;
  await transferRuntime.runWalk(id, async () => {
    let retained = false;
    try {
      // Use a separate exec channel on the exact browse connection (including terminal
      // host/user overrides). A transfer lease keeps it alive if the pane is closed.
      if (bridge.retainSftpTransferSession) {
        const lease = await bridge.retainSftpTransferSession(request.sftpId, id, { cancelOnOwnerGone: true });
        if (!lease.success) throw new Error(lease.reason || "SFTP session is no longer available");
        retained = true;
      }
      const result = await globalSftpTransferScheduler.run(ownerId, id,
        getSftpTransferResourceKeys({ sourceHostId: request.sourceHostId, sourceSftpId: request.sftpId }),
        () => localStorageAdapter.readNumber(STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY),
        async () => {
          if (isTransferCancelledFlag(id)) return { status: "cancelled" as const };
          transferRuntime.patchTask(id, { status: "transferring", phase: "transferring" });
          return packed({
            sftpId: request.sftpId, transferId: id, remoteDirectory: request.remoteDirectory,
            names: request.names, localDirectory: request.localDirectory, encoding: request.sourceEncoding,
          }, ({ phase, bytes }) => {
            if (isTransferCancelledFlag(id)) return;
            received = Math.max(received, bytes);
            transferRuntime.patchTask(id, {
              phase: phase === "extracting" ? "extracting" : "transferring",
              transferredBytes: received,
            });
          });
        });
      if (result.status === "completed") {
        outcome = "completed";
        transferRuntime.patchTask(id, { status: "completed", totalBytes: received, transferredBytes: received, endTime: Date.now() });
      } else if (result.status === "cancelled" || isTransferCancelledFlag(id)) {
        transferRuntime.patchTask(id, { status: "cancelled", endTime: Date.now() });
      } else {
        outcome = result.reason === "conflict" ? "conflict" : "unsupported";
        sftpTransferCenterStore.dismiss(id);
      }
    } catch (error) {
      if (isTransferCancelledFlag(id)) {
        transferRuntime.patchTask(id, { status: "cancelled", endTime: Date.now() });
      } else {
        const message = unwrapSftpIpcError(error);
        transferRuntime.patchTask(id, { status: "failed", error: message, endTime: Date.now() });
        throw new Error(message);
      }
    } finally {
      if (retained) await bridge.releaseSftpTransferSession?.(request.sftpId, id).catch(() => {});
    }
  });
  return outcome;
}
