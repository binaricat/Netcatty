import React, { useCallback, useRef, useMemo } from "react";
import { TransferTask, TransferStatus } from "../../../domain/models";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { logger } from "../../../lib/logger";
import { SftpPane } from "./types";
import { joinPath } from "./utils";
import {
  UploadController,
  uploadFromDataTransfer,
  UploadBridge,
  UploadCallbacks,
  UploadResult,
  UploadTaskInfo,
} from "../../../lib/uploadService";

// Re-export UploadResult for external usage
export type { UploadResult };

interface UseSftpExternalOperationsParams {
  getActivePane: (side: "left" | "right") => SftpPane | null;
  refresh: (side: "left" | "right") => Promise<void>;
  sftpSessionsRef: React.MutableRefObject<Map<string, string>>;
  useCompressedUpload?: boolean;
  addExternalUpload?: (task: TransferTask) => void;
  updateExternalUpload?: (taskId: string, updates: Partial<TransferTask>) => void;
  isTransferCancelled?: (taskId: string) => boolean;
  dismissExternalUpload?: (taskId: string) => void;
}

interface SftpExternalOperationsResult {
  readTextFile: (side: "left" | "right", filePath: string) => Promise<string>;
  readBinaryFile: (side: "left" | "right", filePath: string) => Promise<ArrayBuffer>;
  writeTextFile: (side: "left" | "right", filePath: string, content: string) => Promise<void>;
  downloadToTempAndOpen: (
    side: "left" | "right",
    remotePath: string,
    fileName: string,
    appPath: string,
    options?: { enableWatch?: boolean }
  ) => Promise<{ localTempPath: string; watchId?: string }>;
  uploadExternalFiles: (
    side: "left" | "right",
    dataTransfer: DataTransfer
  ) => Promise<UploadResult[]>;
  cancelExternalUpload: () => Promise<void>;
  selectApplication: () => Promise<{ path: string; name: string } | null>;
}

export const useSftpExternalOperations = (
  params: UseSftpExternalOperationsParams
): SftpExternalOperationsResult => {
  const {
    getActivePane,
    refresh,
    sftpSessionsRef,
    useCompressedUpload = false,
    addExternalUpload,
    updateExternalUpload,
    isTransferCancelled,
    dismissExternalUpload,
  } = params;

  // Upload controller for cancellation support
  const uploadControllerRef = useRef<UploadController | null>(null);

  const readTextFile = useCallback(
    async (side: "left" | "right", filePath: string): Promise<string> => {
      const pane = getActivePane(side);
      if (!pane?.connection) {
        throw new Error("No connection available");
      }

      if (pane.connection.isLocal) {
        const bridge = netcattyBridge.get();
        if (bridge?.readLocalFile) {
          const buffer = await bridge.readLocalFile(filePath);
          return new TextDecoder().decode(buffer);
        }
        throw new Error("Local file reading not supported");
      }

      const sftpId = sftpSessionsRef.current.get(pane.connection.id);
      if (!sftpId) {
        throw new Error("SFTP session not found");
      }

      const bridge = netcattyBridge.get();
      if (!bridge) {
        throw new Error("Bridge not available");
      }

      return await bridge.readSftp(sftpId, filePath, pane.filenameEncoding);
    },
    [getActivePane, sftpSessionsRef],
  );

  const readBinaryFile = useCallback(
    async (side: "left" | "right", filePath: string): Promise<ArrayBuffer> => {
      const pane = getActivePane(side);
      if (!pane?.connection) {
        throw new Error("No connection available");
      }

      if (pane.connection.isLocal) {
        const bridge = netcattyBridge.get();
        if (bridge?.readLocalFile) {
          return await bridge.readLocalFile(filePath);
        }
        throw new Error("Local file reading not supported");
      }

      const sftpId = sftpSessionsRef.current.get(pane.connection.id);
      if (!sftpId) {
        throw new Error("SFTP session not found");
      }

      const bridge = netcattyBridge.get();
      if (!bridge?.readSftpBinary) {
        throw new Error("Binary file reading not supported");
      }

      return await bridge.readSftpBinary(sftpId, filePath, pane.filenameEncoding);
    },
    [getActivePane, sftpSessionsRef],
  );

  const writeTextFile = useCallback(
    async (side: "left" | "right", filePath: string, content: string): Promise<void> => {
      const pane = getActivePane(side);
      if (!pane?.connection) {
        throw new Error("No connection available");
      }

      if (pane.connection.isLocal) {
        const bridge = netcattyBridge.get();
        if (bridge?.writeLocalFile) {
          const data = new TextEncoder().encode(content);
          await bridge.writeLocalFile(filePath, data.buffer);
          return;
        }
        throw new Error("Local file writing not supported");
      }

      const sftpId = sftpSessionsRef.current.get(pane.connection.id);
      if (!sftpId) {
        throw new Error("SFTP session not found");
      }

      const bridge = netcattyBridge.get();
      if (!bridge) {
        throw new Error("Bridge not available");
      }

      await bridge.writeSftp(sftpId, filePath, content, pane.filenameEncoding);
    },
    [getActivePane, sftpSessionsRef],
  );

  const downloadToTempAndOpen = useCallback(
    async (
      side: "left" | "right",
      remotePath: string,
      fileName: string,
      appPath: string,
      options?: { enableWatch?: boolean }
    ): Promise<{ localTempPath: string; watchId?: string }> => {
      const pane = getActivePane(side);
      if (!pane?.connection) {
        throw new Error("No connection available");
      }

      const bridge = netcattyBridge.get();
      if (!bridge?.downloadSftpToTemp || !bridge?.openWithApplication) {
        throw new Error("System app opening not supported");
      }

      if (pane.connection.isLocal) {
        await bridge.openWithApplication(remotePath, appPath);
        return { localTempPath: remotePath };
      }

      const sftpId = sftpSessionsRef.current.get(pane.connection.id);
      if (!sftpId) {
        throw new Error("SFTP session not found");
      }

      let localTempPath: string;
      let wasCancelled = false;
      let externalTransferId: string | undefined;
      const isLocalTempDownloadCancelled = () =>
        !!externalTransferId && !!isTransferCancelled?.(externalTransferId);
      const cleanupTempDownload = async (filePath: string) => {
        if (!bridge.deleteTempFile) return;
        try {
          await bridge.deleteTempFile(filePath);
        } catch (err) {
          console.warn("[SFTP] Failed to delete cancelled temp download:", err);
        }
      };

      if (bridge.downloadSftpToTempWithProgress && addExternalUpload && updateExternalUpload) {
        externalTransferId = `download-temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        addExternalUpload({
          id: externalTransferId,
          fileName,
          sourcePath: remotePath,
          targetPath: "(temp)",
          sourceConnectionId: pane.connection.id,
          targetConnectionId: "local",
          direction: "download",
          status: "transferring" as TransferStatus,
          totalBytes: 0,
          transferredBytes: 0,
          speed: 0,
          startTime: Date.now(),
          isDirectory: false,
          retryable: false,
        });

        try {
          const result = await bridge.downloadSftpToTempWithProgress(
            sftpId,
            remotePath,
            fileName,
            pane.filenameEncoding,
            externalTransferId,
            (transferred, total, speed) => {
              updateExternalUpload(externalTransferId, {
                transferredBytes: transferred,
                totalBytes: total,
                speed,
              });
            },
            undefined,
            (error) => {
              updateExternalUpload(externalTransferId, {
                status: "failed" as TransferStatus,
                endTime: Date.now(),
                error,
                speed: 0,
              });
            },
            () => {
              updateExternalUpload(externalTransferId, {
                status: "cancelled" as TransferStatus,
                endTime: Date.now(),
                speed: 0,
              });
            },
          );
          wasCancelled = result.cancelled;
          localTempPath = result.localPath;
        } catch (err) {
          updateExternalUpload(externalTransferId, {
            status: "failed" as TransferStatus,
            endTime: Date.now(),
            error: err instanceof Error ? err.message : String(err),
            speed: 0,
          });
          throw err;
        }

        if (wasCancelled) {
          if (localTempPath && bridge.deleteTempFile) {
            bridge.deleteTempFile(localTempPath).catch(() => {});
          }
          return { localTempPath: "" };
        }

        if (isLocalTempDownloadCancelled()) {
          await cleanupTempDownload(localTempPath);
          return { localTempPath: "" };
        }

        updateExternalUpload(externalTransferId, {
          status: "completed" as TransferStatus,
          endTime: Date.now(),
          speed: 0,
        });
      } else {
        localTempPath = await bridge.downloadSftpToTemp(
          sftpId,
          remotePath,
          fileName,
          pane.filenameEncoding,
        );
      }

      if (isLocalTempDownloadCancelled()) {
        await cleanupTempDownload(localTempPath);
        return { localTempPath: "" };
      }

      if (bridge.registerTempFile) {
        try {
          await bridge.registerTempFile(sftpId, localTempPath);
        } catch (err) {
          console.warn("[SFTP] Failed to register temp file for cleanup:", err);
        }
      }

      try {
        await bridge.openWithApplication(localTempPath, appPath);
      } catch (err) {
        if (externalTransferId) {
          updateExternalUpload(externalTransferId, {
            status: "failed" as TransferStatus,
            endTime: Date.now(),
            error: err instanceof Error ? err.message : String(err),
            speed: 0,
          });
        }
        throw err;
      }

      let watchId: string | undefined;
      if (options?.enableWatch && bridge.startFileWatch) {
        try {
          const result = await bridge.startFileWatch(
            localTempPath,
            remotePath,
            sftpId,
            pane.filenameEncoding,
          );
          watchId = result.watchId;
        } catch (err) {
          console.warn("[SFTP] Failed to start file watch:", err);
        }
      }

      return { localTempPath, watchId };
    },
    [getActivePane, sftpSessionsRef, addExternalUpload, updateExternalUpload, isTransferCancelled],
  );

  // Create upload callbacks that translate to TransferTask updates
  const createUploadCallbacks = useCallback((
    connectionId: string,
    targetPath: string
  ): UploadCallbacks => {
    return {
      onScanningStart: (taskId: string) => {
        if (addExternalUpload) {
          const scanningTask: TransferTask = {
            id: taskId,
            fileName: "Scanning files...",
            sourcePath: "local",
            targetPath,
            sourceConnectionId: "external",
            targetConnectionId: connectionId,
            direction: "upload",
            status: "pending" as TransferStatus,
            totalBytes: 0,
            transferredBytes: 0,
            speed: 0,
            startTime: Date.now(),
            isDirectory: true,
          };
          addExternalUpload(scanningTask);
        }
      },
      onScanningEnd: (taskId: string) => {
        if (dismissExternalUpload) {
          dismissExternalUpload(taskId);
        }
      },
      onTaskCreated: (task: UploadTaskInfo) => {
        if (addExternalUpload) {
          const transferTask: TransferTask = {
            id: task.id,
            fileName: task.displayName,
            sourcePath: "local",
            targetPath: joinPath(targetPath, task.fileName),
            sourceConnectionId: "external",
            targetConnectionId: connectionId,
            direction: "upload",
            status: "transferring" as TransferStatus,
            totalBytes: task.totalBytes,
            transferredBytes: 0,
            speed: 0,
            startTime: Date.now(),
            isDirectory: task.isDirectory,
          };
          addExternalUpload(transferTask);
        }
      },
      onTaskProgress: (taskId: string, progress) => {
        if (updateExternalUpload) {
          updateExternalUpload(taskId, {
            transferredBytes: progress.transferred,
            speed: progress.speed,
          });
        }
      },
      onTaskCompleted: (taskId: string, totalBytes: number) => {
        if (updateExternalUpload) {
          updateExternalUpload(taskId, {
            status: "completed" as TransferStatus,
            endTime: Date.now(),
            transferredBytes: totalBytes,
            speed: 0,
          });
        }
      },
      onTaskFailed: (taskId: string, error: string) => {
        if (updateExternalUpload) {
          updateExternalUpload(taskId, {
            status: "failed" as TransferStatus,
            endTime: Date.now(),
            error,
            speed: 0,
          });
        }
      },
      onTaskCancelled: (taskId: string) => {
        if (updateExternalUpload) {
          updateExternalUpload(taskId, {
            status: "cancelled" as TransferStatus,
            endTime: Date.now(),
            speed: 0,
          });
        }
      },
    };
  }, [addExternalUpload, updateExternalUpload, dismissExternalUpload]);

  // Create upload bridge that wraps netcattyBridge
  const createUploadBridge = useMemo((): UploadBridge => {
    const bridge = netcattyBridge.get();
    return {
      writeLocalFile: bridge?.writeLocalFile,
      mkdirLocal: bridge?.mkdirLocal,
      mkdirSftp: async (sftpId: string, path: string) => {
        const b = netcattyBridge.get();
        if (b?.mkdirSftp) {
          await b.mkdirSftp(sftpId, path);
        }
      },
      writeSftpBinary: bridge?.writeSftpBinary,
      // Wrap writeSftpBinaryWithProgress to adapt UploadBridge interface to NetcattyBridge interface
      // UploadBridge: (sftpId, path, data, taskId, onProgress, onComplete, onError)
      // NetcattyBridge: (sftpId, path, content, transferId, encoding, onProgress, onComplete, onError)
      writeSftpBinaryWithProgress: bridge?.writeSftpBinaryWithProgress
        ? async (sftpId, path, data, taskId, onProgress, onComplete, onError) => {
            const b = netcattyBridge.get();
            if (!b?.writeSftpBinaryWithProgress) return undefined;
            // Pass undefined for encoding to use session default, and forward callbacks
            return b.writeSftpBinaryWithProgress(
              sftpId,
              path,
              data,
              taskId,
              undefined, // encoding - use session default
              onProgress,
              onComplete,
              onError
            );
          }
        : undefined,
      cancelSftpUpload: bridge?.cancelSftpUpload,
      // Stream transfer for large files (avoids loading into memory)
      startStreamTransfer: bridge?.startStreamTransfer
        ? async (options, onProgress, onComplete, onError) => {
            const b = netcattyBridge.get();
            if (!b?.startStreamTransfer) {
              return { transferId: options.transferId, error: 'Stream transfer not available' };
            }
            try {
              const result = await b.startStreamTransfer(options, onProgress, onComplete, onError);
              return result;
            } catch (error) {
              return {
                transferId: options.transferId,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }
        : undefined,
      cancelTransfer: bridge?.cancelTransfer,
    };
  }, []);

  const uploadExternalFiles = useCallback(
    async (side: "left" | "right", dataTransfer: DataTransfer): Promise<UploadResult[]> => {
      const pane = getActivePane(side);
      if (!pane?.connection) {
        throw new Error("No active connection");
      }

      const bridge = netcattyBridge.get();
      if (!bridge) {
        throw new Error("Bridge not available");
      }

      const sftpId = pane.connection.isLocal
        ? null
        : sftpSessionsRef.current.get(pane.connection.id) || null;

      if (!pane.connection.isLocal && !sftpId) {
        throw new Error("SFTP session not found");
      }

      // Create a new upload controller for this upload
      const controller = new UploadController();
      uploadControllerRef.current = controller;

      const callbacks = createUploadCallbacks(pane.connection.id, pane.connection.currentPath);

      try {
        const results = await uploadFromDataTransfer(
          dataTransfer,
          {
            targetPath: pane.connection.currentPath,
            sftpId,
            isLocal: pane.connection.isLocal,
            bridge: createUploadBridge,
            joinPath,
            callbacks,
            useCompressedUpload,
          },
          controller
        );

        await refresh(side);
        return results;
      } catch (error) {
        logger.error("[SFTP] Upload failed:", error);
        throw error;
      } finally {
        uploadControllerRef.current = null;
      }
    },
    [
      getActivePane,
      refresh,
      sftpSessionsRef,
      createUploadCallbacks,
      createUploadBridge,
      useCompressedUpload,
    ],
  );

  const cancelExternalUpload = useCallback(async () => {
    const controller = uploadControllerRef.current;
    if (controller) {
      logger.info("[SFTP] Cancelling external upload");
      await controller.cancel();
    }
  }, []);

  const selectApplication = useCallback(
    async (): Promise<{ path: string; name: string } | null> => {
      const bridge = netcattyBridge.get();
      if (!bridge?.selectApplication) {
        return null;
      }
      return await bridge.selectApplication();
    },
    [],
  );

  return {
    readTextFile,
    readBinaryFile,
    writeTextFile,
    downloadToTempAndOpen,
    uploadExternalFiles,
    cancelExternalUpload,
    selectApplication,
  };
};
