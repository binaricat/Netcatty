import { useCallback, useRef, useMemo, useState } from "react";
import { FileConflict, FileConflictAction, TransferStatus, SftpFilenameEncoding } from "../../../domain/models";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { logger } from "../../../lib/logger";
import { notify } from "../../notification";
import { joinPath } from "./utils";
import { createUploadTaskCallbacks } from "./uploadTaskCallbacks";
import {
  UploadController,
  uploadFromDataTransfer,
  uploadFromFileList,
  uploadEntriesDirect,
  UploadBridge,
  UploadCallbacks,
  UploadResult,
  startUploadScanningTask,
} from "../../../lib/uploadService";
import type { DropEntry } from "../../../lib/sftpFileUtils";

// Re-export UploadResult for external usage
export type { UploadResult };

import type { UseSftpExternalOperationsParams, SftpExternalOperationsResult } from "./useSftpExternalOperations.types";

export const useSftpExternalOperations = (
  params: UseSftpExternalOperationsParams
): SftpExternalOperationsResult => {
  const {
    getActivePane,
    getPaneByConnectionId,
    refresh,
    sftpSessionsRef,
    connectionCacheKeyMapRef,
    clearDirCacheEntry,
    useCompressedUpload = false,
    addExternalUpload,
    updateExternalUpload,
    isTransferCancelled,
    dismissExternalUpload,
  } = params;

  // Upload controller for cancellation support
  const uploadControllerRef = useRef<UploadController | null>(null);

  // Track active file watches so the side panel can block host-switching.
  // Reset to 0 when the SFTP session disconnects (handled in SftpSidePanel).
  const activeFileWatchCountRef = useRef(0);
  const [uploadConflicts, setUploadConflicts] = useState<FileConflict[]>([]);
  const uploadConflictResolversRef = useRef(new Map<string, {
    resolve: (action: FileConflictAction) => void;
    setDefault: (action: FileConflictAction) => void;
  }>());

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

  const writeTextFileByConnection = useCallback(
    async (
      connectionId: string,
      expectedHostId: string,
      filePath: string,
      content: string,
      filenameEncoding?: SftpFilenameEncoding,
    ): Promise<void> => {
      const pane = getPaneByConnectionId(connectionId);
      if (!pane?.connection) {
        throw new Error("SFTP connection is no longer available");
      }
      if (pane.connection.hostId !== expectedHostId) {
        throw new Error("SFTP connection changed while editing — file not saved to prevent writing to wrong host");
      }

      if (pane.connection.isLocal) {
        const bridge = netcattyBridge.get();
        if (!bridge?.writeLocalFile) throw new Error("Local file writing not supported");
        const data = new TextEncoder().encode(content);
        await bridge.writeLocalFile(filePath, data.buffer);
        return;
      }

      const sftpId = sftpSessionsRef.current.get(pane.connection.id);
      if (!sftpId) throw new Error("SFTP session not found");

      const bridge = netcattyBridge.get();
      if (!bridge) throw new Error("Bridge not available");

      await bridge.writeSftp(sftpId, filePath, content, filenameEncoding ?? pane.filenameEncoding);
    },
    [getPaneByConnectionId, sftpSessionsRef],
  );

  const downloadToTemp = useCallback(
    async (
      side: "left" | "right",
      remotePath: string,
      fileName: string,
    ): Promise<{ localTempPath: string; sftpId: string; externalTransferId?: string }> => {
      const pane = getActivePane(side);
      if (!pane?.connection) {
        throw new Error("No connection available");
      }

      const bridge = netcattyBridge.get();
      if (!bridge?.downloadSftpToTemp) {
        throw new Error("SFTP temp download not supported");
      }

      if (pane.connection.isLocal) {
        throw new Error("Temp download is only available for remote files");
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
          return { localTempPath: "", sftpId, externalTransferId };
        }

        if (isLocalTempDownloadCancelled()) {
          await cleanupTempDownload(localTempPath);
          return { localTempPath: "", sftpId, externalTransferId };
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
        return { localTempPath: "", sftpId, externalTransferId };
      }

      if (bridge.registerTempFile) {
        try {
          await bridge.registerTempFile(sftpId, localTempPath);
        } catch (err) {
          console.warn("[SFTP] Failed to register temp file for cleanup:", err);
        }
      }

      return { localTempPath, sftpId, externalTransferId };
    },
    [getActivePane, sftpSessionsRef, addExternalUpload, updateExternalUpload, isTransferCancelled],
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
      if (!bridge?.openWithApplication) {
        throw new Error("System app opening not supported");
      }

      if (pane.connection.isLocal) {
        await bridge.openWithApplication(remotePath, appPath);
        return { localTempPath: remotePath };
      }

      const { localTempPath, sftpId, externalTransferId } = await downloadToTemp(side, remotePath, fileName);
      if (!localTempPath) {
        return { localTempPath: "" };
      }

      try {
        await bridge.openWithApplication(localTempPath, appPath);
      } catch (err) {
        if (externalTransferId) {
          updateExternalUpload?.(externalTransferId, {
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
          activeFileWatchCountRef.current += 1;
        } catch (err) {
          console.warn("[SFTP] Failed to start file watch:", err);
        }
      }

      return { localTempPath, watchId };
    },
    [downloadToTemp, getActivePane, updateExternalUpload],
  );

  const openWithSystemDefault = useCallback(
    async (
      side: "left" | "right",
      remotePath: string,
      fileName: string,
      options?: { enableWatch?: boolean }
    ): Promise<void> => {
      try {
        const pane = getActivePane(side);
        if (!pane?.connection) {
          throw new Error("No connection available");
        }

        const bridge = netcattyBridge.get();
        if (!bridge?.openWithSystemDefault) {
          throw new Error("System default opening not supported");
        }

        const bridgeMethods = bridge;

        const { localTempPath, sftpId, externalTransferId } = pane.connection.isLocal
          ? { localTempPath: remotePath, sftpId: "", externalTransferId: undefined }
          : await downloadToTemp(side, remotePath, fileName);

        if (!localTempPath) return;

        const result = await bridgeMethods.openWithSystemDefault(localTempPath);
        if (!result.success) {
          if (externalTransferId) {
            updateExternalUpload?.(externalTransferId, {
              status: "failed" as TransferStatus,
              endTime: Date.now(),
              error: result.error || "Failed to open file",
              speed: 0,
            });
          }
          throw new Error(result.error || "Failed to open file");
        }

        // Start file watch for remote SFTP auto-sync (mirrors downloadToTempAndOpen behavior)
        if (options?.enableWatch && !pane.connection.isLocal && bridgeMethods.startFileWatch) {
          try {
            await bridgeMethods.startFileWatch(
              localTempPath,
              remotePath,
              sftpId,
              pane.filenameEncoding,
            );
            activeFileWatchCountRef.current += 1;
          } catch (err) {
            console.warn("[SFTP] Failed to start file watch for default app open:", err);
          }
        }
      } catch (err) {
        notify.error(err instanceof Error ? err.message : String(err), "SFTP");
      }
    },
    [downloadToTemp, getActivePane, updateExternalUpload],
  );

  // Create upload callbacks that translate to TransferTask updates
  const createUploadCallbacks = useCallback((
    connectionId: string,
    targetPath: string,
    targetHostId?: string,
    targetConnectionKey?: string,
  ): UploadCallbacks => createUploadTaskCallbacks({
    connectionId,
    targetPath,
    targetHostId,
    targetConnectionKey,
    addExternalUpload,
    updateExternalUpload,
    dismissExternalUpload,
  }), [addExternalUpload, updateExternalUpload, dismissExternalUpload]);

  const resolveUploadConflict = useCallback((conflictId: string, action: FileConflictAction, applyToAll = false) => {
    const conflict = uploadConflicts.find((item) => item.transferId === conflictId);
    setUploadConflicts((prev) => prev.filter((item) => item.transferId !== conflictId));
    const resolver = uploadConflictResolversRef.current.get(conflictId);
    if (!resolver) return;
    uploadConflictResolversRef.current.delete(conflictId);
    if (conflict && applyToAll) {
      resolver.setDefault(action);
    }
    resolver.resolve(action);
  }, [uploadConflicts]);

  const cancelPendingUploadConflicts = useCallback(() => {
    const resolvers = Array.from(uploadConflictResolversRef.current.values());
    if (resolvers.length === 0) return;

    uploadConflictResolversRef.current.clear();
    setUploadConflicts([]);
    for (const resolver of resolvers) {
      resolver.resolve("stop");
    }
  }, []);

  const createUploadConflictResolver = useCallback(() => {
    const conflictDefaults = new Map<string, FileConflictAction>();

    return async (conflict: {
      fileName: string;
      targetPath: string;
      isDirectory: boolean;
      existingType?: 'file' | 'directory' | 'symlink';
      existingSize: number;
      newSize: number;
      existingModified: number;
      newModified: number;
      applyToAllCount: number;
    }): Promise<FileConflictAction> => {
      const conflictType = conflict.isDirectory ? "directory" : "file";
      const defaultAction = conflictDefaults.get(conflictType);
      if (defaultAction) return defaultAction;

      const conflictId = `upload-conflict-${crypto.randomUUID()}`;
      const fileConflict: FileConflict = {
        transferId: conflictId,
        fileName: conflict.fileName,
        sourcePath: "local",
        targetPath: conflict.targetPath,
        isDirectory: conflict.isDirectory,
        existingType: conflict.existingType,
        applyToAllCount: conflict.applyToAllCount,
        existingSize: conflict.existingSize,
        newSize: conflict.newSize,
        existingModified: conflict.existingModified,
        newModified: conflict.newModified,
      };

      setUploadConflicts((prev) => [...prev, fileConflict]);
      return new Promise<FileConflictAction>((resolve) => {
        uploadConflictResolversRef.current.set(conflictId, {
          resolve,
          setDefault: (action) => {
            conflictDefaults.set(conflictType, action);
          },
        });
      });
    };
  }, []);

  // Create upload bridge that wraps netcattyBridge
  const createUploadBridge = useMemo((): UploadBridge => {
    const bridge = netcattyBridge.get();
    return {
      writeLocalFile: bridge?.writeLocalFile,
      mkdirLocal: bridge?.mkdirLocal,
      statLocal: bridge?.statLocal,
      deleteLocalFile: bridge?.deleteLocalFile,
      mkdirSftp: async (sftpId: string, path: string) => {
        const b = netcattyBridge.get();
        if (b?.mkdirSftp) {
          await b.mkdirSftp(sftpId, path);
        }
      },
      statSftp: async (sftpId: string, path: string) => {
        const b = netcattyBridge.get();
        if (!b?.statSftp) return null;
        return b.statSftp(sftpId, path);
      },
      deleteSftp: async (sftpId: string, path: string) => {
        const b = netcattyBridge.get();
        if (b?.deleteSftp) {
          await b.deleteSftp(sftpId, path);
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
    async (side: "left" | "right", dataTransfer: DataTransfer, targetPath?: string): Promise<UploadResult[]> => {
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

      const uploadPaneId = pane.id;
      const uploadTargetPath = targetPath || pane.connection.currentPath;
      // Create a new upload controller for this upload
      const controller = new UploadController();
      uploadControllerRef.current = controller;

      const callbacks = createUploadCallbacks(
        pane.connection.id,
        uploadTargetPath,
        pane.connection.isLocal ? undefined : pane.connection.hostId,
        pane.connection.isLocal ? undefined : connectionCacheKeyMapRef.current.get(pane.connection.id),
      );

      try {
        const results = await uploadFromDataTransfer(
          dataTransfer,
          {
            targetPath: uploadTargetPath,
            sftpId,
            isLocal: pane.connection.isLocal,
            bridge: createUploadBridge,
            joinPath,
            callbacks,
            useCompressedUpload,
            resolveConflict: createUploadConflictResolver(),
          },
          controller
        );

        // Invalidate cache for the upload target so returning to that path
        // triggers a fresh listing.
        if (clearDirCacheEntry && targetPath) {
          clearDirCacheEntry(pane.connection.id, uploadTargetPath);
        }
        if (uploadTargetPath === pane.connection.currentPath) {
          await refresh(side, { tabId: uploadPaneId });
        }
        return results;
      } catch (error) {
        logger.error("[SFTP] Upload failed:", error);
        throw error;
      } finally {
        uploadControllerRef.current = null;
      }
    },
    [
      clearDirCacheEntry,
      connectionCacheKeyMapRef,
      getActivePane,
      refresh,
      sftpSessionsRef,
      createUploadCallbacks,
      createUploadBridge,
      createUploadConflictResolver,
      useCompressedUpload,
    ],
  );

  // Upload from a FileList. This keeps the original File objects from the file
  // picker so Electron can resolve local file paths for stream uploads.
  const uploadExternalFileList = useCallback(
    async (
      side: "left" | "right",
      fileList: FileList | File[],
      targetPath?: string,
    ): Promise<UploadResult[]> => {
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

      const uploadPaneId = pane.id;
      const uploadTargetPath = targetPath || pane.connection.currentPath;
      const controller = new UploadController();
      uploadControllerRef.current = controller;

      const callbacks = createUploadCallbacks(
        pane.connection.id,
        uploadTargetPath,
        pane.connection.isLocal ? undefined : pane.connection.hostId,
        pane.connection.isLocal ? undefined : connectionCacheKeyMapRef.current.get(pane.connection.id),
      );

      try {
        const results = await uploadFromFileList(
          fileList,
          {
            targetPath: uploadTargetPath,
            sftpId,
            isLocal: pane.connection.isLocal,
            bridge: createUploadBridge,
            joinPath,
            callbacks,
            useCompressedUpload,
            resolveConflict: createUploadConflictResolver(),
          },
          controller,
        );

        if (clearDirCacheEntry && targetPath) {
          clearDirCacheEntry(pane.connection.id, uploadTargetPath);
        }
        if (uploadTargetPath === pane.connection.currentPath) {
          await refresh(side, { tabId: uploadPaneId });
        }
        return results;
      } catch (error) {
        logger.error("[SFTP] File picker upload failed:", error);
        throw error;
      } finally {
        uploadControllerRef.current = null;
      }
    },
    [
      clearDirCacheEntry,
      connectionCacheKeyMapRef,
      getActivePane,
      refresh,
      sftpSessionsRef,
      createUploadCallbacks,
      createUploadBridge,
      createUploadConflictResolver,
      useCompressedUpload,
    ],
  );

  const uploadExternalFolderPath = useCallback(
    async (
      side: "left" | "right",
      folderPath: string,
      targetPath?: string,
    ): Promise<UploadResult[]> => {
      const pane = getActivePane(side);
      if (!pane?.connection) {
        throw new Error("No active connection");
      }

      const bridge = netcattyBridge.get();
      if (!bridge) {
        throw new Error("Bridge not available");
      }
      if (!bridge.listLocalTree) {
        throw new Error("Folder upload not supported");
      }

      const sftpId = pane.connection.isLocal
        ? null
        : sftpSessionsRef.current.get(pane.connection.id) || null;

      if (!pane.connection.isLocal && !sftpId) {
        throw new Error("SFTP session not found");
      }

      const uploadPaneId = pane.id;
      const uploadTargetPath = targetPath || pane.connection.currentPath;
      const controller = new UploadController();
      uploadControllerRef.current = controller;

      const callbacks = createUploadCallbacks(
        pane.connection.id,
        uploadTargetPath,
        pane.connection.isLocal ? undefined : pane.connection.hostId,
        pane.connection.isLocal ? undefined : connectionCacheKeyMapRef.current.get(pane.connection.id),
      );

      const scanningTask = startUploadScanningTask(callbacks);

      try {
        const localEntries = await bridge.listLocalTree(folderPath);
        if (controller.isCancelled()) {
          scanningTask.cancel();
          return [{ fileName: "", success: false, cancelled: true }];
        }
        scanningTask.complete();

        const entries: DropEntry[] = localEntries.map((entry) => {
          if (entry.type === "directory") {
            return {
              file: null,
              relativePath: entry.relativePath,
              isDirectory: true,
            };
          }

          const file = {
            name: entry.relativePath.split("/").pop() || entry.relativePath,
            size: entry.size,
            lastModified: entry.lastModified,
            type: "",
            path: entry.localPath,
            arrayBuffer: async () => {
              const currentBridge = netcattyBridge.get();
              if (!currentBridge?.readLocalFile) {
                throw new Error("Local file reading not supported");
              }
              return currentBridge.readLocalFile(entry.localPath);
            },
          } as File & { path?: string };

          return {
            file,
            relativePath: entry.relativePath,
            isDirectory: false,
          };
        });

        const results = await uploadEntriesDirect(
          entries,
          {
            targetPath: uploadTargetPath,
            sftpId,
            isLocal: pane.connection.isLocal,
            bridge: createUploadBridge,
            joinPath,
            callbacks,
            useCompressedUpload,
            resolveConflict: createUploadConflictResolver(),
          },
          controller,
        );

        if (clearDirCacheEntry) {
          clearDirCacheEntry(pane.connection.id, uploadTargetPath);
        }
        if (uploadTargetPath === pane.connection.currentPath) {
          await refresh(side, { tabId: uploadPaneId });
        }
        return results;
      } catch (error) {
        if (controller.isCancelled()) {
          scanningTask.cancel();
          return [{ fileName: "", success: false, cancelled: true }];
        }
        if (scanningTask.isOpen()) {
          scanningTask.fail(error);
        }
        logger.error("[SFTP] Folder picker upload failed:", error);
        throw error;
      } finally {
        uploadControllerRef.current = null;
      }
    },
    [
      clearDirCacheEntry,
      connectionCacheKeyMapRef,
      createUploadCallbacks,
      createUploadBridge,
      createUploadConflictResolver,
      getActivePane,
      refresh,
      sftpSessionsRef,
      useCompressedUpload,
    ],
  );

  const uploadExternalEntries = useCallback(
    async (
      side: "left" | "right",
      entries: DropEntry[],
      options?: { targetPath?: string },
    ): Promise<UploadResult[]> => {
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

      // Capture the pane ID now so we can refresh the correct tab after
      // upload, even if focus switches during the transfer.
      const uploadPaneId = pane.id;
      const controller = new UploadController();
      uploadControllerRef.current = controller;
      const uploadTargetPath = options?.targetPath || pane.connection.currentPath;

      const callbacks = createUploadCallbacks(
        pane.connection.id,
        uploadTargetPath,
        pane.connection.isLocal ? undefined : pane.connection.hostId,
        pane.connection.isLocal ? undefined : connectionCacheKeyMapRef.current.get(pane.connection.id),
      );
      const directUploadBridge: UploadBridge = {
        ...createUploadBridge,
      };

      try {
        const results = await uploadEntriesDirect(
          entries,
          {
            targetPath: uploadTargetPath,
            sftpId,
            isLocal: pane.connection.isLocal,
            bridge: directUploadBridge,
            joinPath,
            callbacks,
            useCompressedUpload,
            resolveConflict: createUploadConflictResolver(),
          },
          controller,
        );

        // Refresh the specific tab that initiated the upload (not whichever
        // tab is active now — focus may have switched during the transfer).
        // Also invalidate the upload target's cache entry so returning to
        // that path triggers a fresh listing.
        if (clearDirCacheEntry) {
          clearDirCacheEntry(pane.connection.id, uploadTargetPath);
        }
        if (uploadTargetPath === pane.connection.currentPath) {
          await refresh(side, { tabId: uploadPaneId });
        }
        return results;
      } catch (error) {
        logger.error("[SFTP] Upload failed:", error);
        throw error;
      } finally {
        uploadControllerRef.current = null;
      }
    },
    [
      clearDirCacheEntry,
      connectionCacheKeyMapRef,
      createUploadCallbacks,
      createUploadBridge,
      createUploadConflictResolver,
      getActivePane,
      refresh,
      sftpSessionsRef,
      useCompressedUpload,
    ],
  );

  const cancelExternalUpload = useCallback(async () => {
    const controller = uploadControllerRef.current;
    let cancelPromise: Promise<void> | undefined;
    if (controller) {
      logger.info("[SFTP] Cancelling external upload");
      cancelPromise = controller.cancel();
    }
    cancelPendingUploadConflicts();
    await cancelPromise;
  }, [cancelPendingUploadConflicts]);

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
    writeTextFileByConnection,
    downloadToTempAndOpen,
    openWithSystemDefault,
    uploadExternalFiles,
    uploadExternalFileList,
    uploadExternalFolderPath,
    uploadExternalEntries,
    cancelExternalUpload,
    selectApplication,
    activeFileWatchCountRef,
    uploadConflicts,
    resolveUploadConflict,
  };
};
