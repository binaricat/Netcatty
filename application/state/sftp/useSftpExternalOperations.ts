import { useCallback, useEffect, useRef, useState } from "react";
import { FileConflict, FileConflictAction, Host, TransferStatus, SftpFilenameEncoding } from "../../../domain/models";
import { getSftpConflictTypeKey } from "../../../domain/sftpConflict";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { logger } from "../../../lib/logger";
import { notify } from "../../notification";
import { joinPath } from "./utils";
import { createUploadTaskCallbacks } from "./uploadTaskCallbacks";
import {
  UploadController,
  uploadFromFileList,
  uploadEntriesDirect,
  UploadBridge,
  UploadCallbacks,
  UploadResult,
  startUploadScanningTask,
} from "../../../lib/uploadService";
import { extractDropEntries, type DropEntry } from "../../../lib/sftpFileUtils";

// Re-export UploadResult for external usage
export type { UploadResult };

import type { UseSftpExternalOperationsParams, SftpExternalOperationsResult } from "./useSftpExternalOperations.types";
import { getSftpTransferResourceKeys, globalSftpTransferScheduler } from "./globalTransferScheduler";
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";
import { STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY } from "../../../infrastructure/config/storageKeys";
import { sftpTransferCenterStore } from "../sftpTransferCenterStore";
import { editorTabStore } from "../editorTabStore";
import {
  resolveUploadStreamTargetSftpId,
} from "../../../domain/sftpDedicatedStreamPolicy";
import { isSessionError } from "./errors";
import { runWithCompressedUploadSession } from "./compressedUploadSession";
import {
  assertUploadEndpointUnchanged,
  captureUploadEndpoint,
  resolveUploadTargetPane,
  type UploadEndpointPin,
} from "./uploadTargetPin";
import {
  cleanupFailedExternalOpenTemp,
  useExternalFileWatchLifecycle,
} from "./externalFileWatchLifecycle";
import { createExternalEditTempRetention } from "./externalEditTempRetention";
import {
  cancelExternalUploadRuntime,
  getExternalUploadController,
  registerExternalUploadController,
  unregisterExternalUploadController,
} from "./externalUploadRuntime";

type UploadConflictResolver = {
  resolve: (action: FileConflictAction) => void;
  setDefault: (action: FileConflictAction) => void;
};

export function drainUploadConflictResolvers(
  resolvers: Map<string, UploadConflictResolver>,
  owners: Map<string, UploadController>,
  controller?: UploadController,
): string[] {
  const canceledIds: string[] = [];
  for (const [conflictId, resolver] of [...resolvers]) {
    if (controller && owners.get(conflictId) !== controller) continue;
    canceledIds.push(conflictId);
    resolvers.delete(conflictId);
    owners.delete(conflictId);
    resolver.resolve("stop");
  }
  return canceledIds;
}

export const useSftpExternalOperations = (
  params: UseSftpExternalOperationsParams
): SftpExternalOperationsResult => {
  const {
    ownerId,
    getActivePane,
    getPaneByConnectionId,
    getPaneByTabId,
    getTabByConnectionId,
    getSideByTabId,
    refresh,
    sftpSessionsRef,
    connectionCacheKeyMapRef,
    ensureRemoteSftpId,
    resolveConnectedHost,
    acquireTransferSession,
    clearDirCacheEntry,
    useCompressedUpload = false,
    isTransferCancelled,
  } = params;

  /** Connect-time Host for a tab (session overrides), when available. */
  const resolveUploadConnectHost = useCallback(
    (tabId: string, isLocal: boolean): Host | undefined => {
      if (isLocal || !resolveConnectedHost) return undefined;
      const host = resolveConnectedHost(tabId);
      if (!host || host === "local") return undefined;
      return host;
    },
    [resolveConnectedHost],
  );

  /**
   * Resolve an SFTP id for upload prep (mkdir/stat/conflict checks).
   * File bytes use dedicated pool connections inside startStreamTransfer
   * so concurrent files can multiplex up to 2 sessions per host.
   */
  const resolveRemoteSftpId = useCallback(async (
    side: "left" | "right",
    options?: { forceReconnect?: boolean; connectionId?: string; tabId?: string },
  ): Promise<{ sftpId: string | null; release: () => void }> => {
    const pane = resolveUploadTargetPane({
      side,
      tabId: options?.tabId,
      connectionId: options?.connectionId,
      getActivePane,
      getPaneByTabId,
      getPaneByConnectionId,
    });
    if (pane.connection.isLocal) return { sftpId: null, release: () => {} };

    const connectionId = pane.connection.id;
    const pinTabId = options?.tabId ?? pane.id;
    // Tab may have moved sides while probing/reconnecting — follow live side.
    const reconnectSide = getSideByTabId?.(pinTabId) ?? side;
    if (ensureRemoteSftpId) {
      const sftpId = await ensureRemoteSftpId(reconnectSide, {
        forceReconnect: options?.forceReconnect,
        connectionId,
        tabId: pinTabId,
      });
      return { sftpId, release: () => {} };
    }
    const sftpId = sftpSessionsRef.current.get(connectionId);
    if (!sftpId) throw new Error("SFTP session not found");
    return { sftpId, release: () => {} };
  }, [ensureRemoteSftpId, getActivePane, getPaneByConnectionId, getPaneByTabId, getSideByTabId, sftpSessionsRef]);

  const registerUploadController = useCallback((taskId: string, controller: UploadController) => {
    registerExternalUploadController(taskId, controller);
  }, []);

  const unregisterUploadController = useCallback((controller: UploadController) => {
    unregisterExternalUploadController(controller);
  }, []);

  const bindUploadControllerCallbacks = useCallback((
    controller: UploadController,
    callbacks: UploadCallbacks,
  ): UploadCallbacks => ({
    ...callbacks,
    onScanningStart: (taskId) => {
      registerUploadController(taskId, controller);
      callbacks.onScanningStart?.(taskId);
    },
    onTaskCreated: (task) => {
      registerUploadController(task.id, controller);
      if (task.parentTaskId) {
        registerUploadController(task.parentTaskId, controller);
      }
      callbacks.onTaskCreated?.(task);
    },
  }), [registerUploadController]);

  // Temp files downloaded for external editors (even without auto-sync watches).
  // Parking / disconnect / reconnect call closeSftp, which deletes these paths —
  // forget matching retainers so hasActiveWork does not stick after cleanup.
  const externalEditTempsRef = useRef(createExternalEditTempRetention());
  const [activeExternalEditCount, setActiveExternalEditCount] = useState(0);
  const rememberExternalEditTemp = useCallback((sftpId: string, localPath: string) => {
    if (!externalEditTempsRef.current.remember(sftpId, localPath)) return;
    setActiveExternalEditCount(externalEditTempsRef.current.size);
  }, []);
  const forgetExternalEditTemp = useCallback((localPath: string) => {
    if (!externalEditTempsRef.current.forgetPath(localPath)) return;
    setActiveExternalEditCount(externalEditTempsRef.current.size);
  }, []);
  const forgetExternalEditTempsForSftp = useCallback((sftpId: string) => {
    if (!externalEditTempsRef.current.forgetSftp(sftpId)) return;
    setActiveExternalEditCount(externalEditTempsRef.current.size);
  }, []);

  // Track every renderer-owned watch id so duplicate opens stay deduplicated
  // and panel/window teardown releases the worker-side polling resources.
  const stopExternalFileWatch = useCallback(async (watchId: string, cleanupTempFile: boolean) => {
    await netcattyBridge.get()?.stopFileWatch?.(watchId, cleanupTempFile);
  }, []);
  const subscribeExternalFileWatchStopped = useCallback((
    callback: (payload: { watchId: string; localPath?: string }) => void,
  ) => netcattyBridge.get()?.onFileWatchStopped?.(callback), []);
  const {
    activeCountRef: activeFileWatchCountRef,
    captureGeneration: captureExternalFileWatchGeneration,
    remember: rememberExternalFileWatch,
    releaseAll: releaseExternalFileWatchesBase,
  } = useExternalFileWatchLifecycle(
    stopExternalFileWatch,
    subscribeExternalFileWatchStopped,
    // Force-stop (temp deleted / session cleanup) includes localPath — drop retainer.
    forgetExternalEditTemp,
  );
  const releaseExternalFileWatches = useCallback(async (cleanupTempFiles = false) => {
    await releaseExternalFileWatchesBase(cleanupTempFiles);
    if (externalEditTempsRef.current.clear()) {
      setActiveExternalEditCount(0);
    }
  }, [releaseExternalFileWatchesBase]);
  const [uploadConflicts, setUploadConflicts] = useState<FileConflict[]>([]);
  const uploadConflictResolversRef = useRef<Map<string, UploadConflictResolver>>(new Map());
  /** Maps conflict id → owning UploadController so cancel A never stops B's prompts. */
  const uploadConflictOwnersRef = useRef<Map<string, UploadController>>(new Map());

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
      sftpTabId?: string,
    ): Promise<string> => {
      let tabRef = getTabByConnectionId?.(connectionId) ?? null;
      let pane = tabRef?.pane ?? getPaneByConnectionId(connectionId);

      if (!pane?.connection && sftpTabId) {
        const pinned = getPaneByTabId(sftpTabId);
        if (pinned?.connection) {
          pane = pinned;
          const side = getSideByTabId?.(sftpTabId);
          if (side) tabRef = { side, tabId: sftpTabId, pane: pinned };
        }
      }

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
        return pane.connection.id;
      }

      const tabId = tabRef?.tabId ?? pane.id;
      const side = tabRef?.side ?? getSideByTabId?.(tabId) ?? null;

      let sftpId = sftpSessionsRef.current.get(pane.connection.id);
      if (!sftpId && ensureRemoteSftpId && side) {
        sftpId = await ensureRemoteSftpId(side, {
          connectionId: pane.connection.id,
          tabId,
        });
      }

      // Reconnect replaces the pane's connection id — resolve again before write/return.
      const refreshedPane = (() => {
        if (sftpTabId) {
          const pinned = getPaneByTabId(sftpTabId);
          if (pinned?.connection) return pinned;
        }
        return getTabByConnectionId?.(connectionId)?.pane
          ?? getPaneByConnectionId(connectionId)
          ?? pane;
      })();

      if (!refreshedPane?.connection) {
        throw new Error("SFTP connection is no longer available");
      }
      if (refreshedPane.connection.hostId !== expectedHostId) {
        throw new Error("SFTP connection changed while editing — file not saved to prevent writing to wrong host");
      }

      const liveConnectionId = refreshedPane.connection.id;
      if (!sftpId) {
        sftpId = sftpSessionsRef.current.get(liveConnectionId);
      }
      if (!sftpId) throw new Error("SFTP session not found");

      if (liveConnectionId !== connectionId) {
        editorTabStore.remapSessionId(connectionId, liveConnectionId);
      }

      const bridge = netcattyBridge.get();
      if (!bridge) throw new Error("Bridge not available");

      await bridge.writeSftp(
        sftpId,
        filePath,
        content,
        filenameEncoding ?? refreshedPane.filenameEncoding,
      );
      return liveConnectionId;
    },
    [
      ensureRemoteSftpId,
      getPaneByConnectionId,
      getPaneByTabId,
      getSideByTabId,
      getTabByConnectionId,
      sftpSessionsRef,
    ],
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
      if (!bridge?.downloadSftpToTempWithProgress) {
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

      externalTransferId = `download-temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      sftpTransferCenterStore.upsertTasks([{
        id: externalTransferId,
        ownerId,
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
        origin: "editor-sync",
        background: true,
        resumable: true,
        phase: "transferring",
      }]);

      try {
        const result = await bridge.downloadSftpToTempWithProgress(
          sftpId,
          remotePath,
          fileName,
          pane.filenameEncoding,
          externalTransferId,
        );
        wasCancelled = result.cancelled;
        localTempPath = result.localPath;
      } catch (err) {
        sftpTransferCenterStore.patchTask(externalTransferId, {
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

      sftpTransferCenterStore.patchTask(externalTransferId, {
        status: "completed" as TransferStatus,
        endTime: Date.now(),
        speed: 0,
      });

      if (isLocalTempDownloadCancelled()) {
        await cleanupTempDownload(localTempPath);
        return { localTempPath: "", sftpId, externalTransferId };
      }

      if (bridge.registerTempFile) {
        try {
          await bridge.registerTempFile(sftpId, localTempPath);
          rememberExternalEditTemp(sftpId, localTempPath);
        } catch (err) {
          console.warn("[SFTP] Failed to register temp file for cleanup:", err);
        }
      }

      return { localTempPath, sftpId, externalTransferId };
    },
    [getActivePane, isTransferCancelled, ownerId, rememberExternalEditTemp, sftpSessionsRef],
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
        await cleanupFailedExternalOpenTemp(bridge, sftpId, localTempPath).catch(() => {});
        forgetExternalEditTemp(localTempPath);
        if (externalTransferId) {
          sftpTransferCenterStore.patchTask(externalTransferId, {
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
        const watchGeneration = captureExternalFileWatchGeneration();
        try {
          const result = await bridge.startFileWatch(
            localTempPath,
            remotePath,
            sftpId,
            pane.filenameEncoding,
          );
          watchId = result.watchId;
          rememberExternalFileWatch(watchId, watchGeneration);
        } catch (err) {
          console.warn("[SFTP] Failed to start file watch:", err);
        }
      }

      return { localTempPath, watchId };
    },
    [
      captureExternalFileWatchGeneration,
      downloadToTemp,
      forgetExternalEditTemp,
      getActivePane,
      rememberExternalFileWatch,
    ],
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

        let result;
        try {
          result = await bridgeMethods.openWithSystemDefault(localTempPath);
        } catch (error) {
          if (!pane.connection.isLocal) {
            await cleanupFailedExternalOpenTemp(bridgeMethods, sftpId, localTempPath).catch(() => {});
            forgetExternalEditTemp(localTempPath);
          }
          throw error;
        }
        if (!result.success) {
          if (!pane.connection.isLocal) {
            await cleanupFailedExternalOpenTemp(bridgeMethods, sftpId, localTempPath).catch(() => {});
            forgetExternalEditTemp(localTempPath);
          }
          if (externalTransferId) {
            sftpTransferCenterStore.patchTask(externalTransferId, {
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
          const watchGeneration = captureExternalFileWatchGeneration();
          try {
            const result = await bridgeMethods.startFileWatch(
              localTempPath,
              remotePath,
              sftpId,
              pane.filenameEncoding,
            );
            rememberExternalFileWatch(result.watchId, watchGeneration);
          } catch (err) {
            console.warn("[SFTP] Failed to start file watch for default app open:", err);
          }
        }
      } catch (err) {
        notify.error(err instanceof Error ? err.message : String(err), "SFTP");
      }
    },
    [
      captureExternalFileWatchGeneration,
      downloadToTemp,
      forgetExternalEditTemp,
      getActivePane,
      rememberExternalFileWatch,
    ],
  );

  // Create upload callbacks that translate to TransferTask updates
  const createUploadCallbacks = useCallback((
    connectionId: string,
    targetPath: string,
    targetHostId?: string,
    targetConnectionKey?: string,
    targetHostLabel?: string,
  ): UploadCallbacks => createUploadTaskCallbacks({
    ownerId,
    connectionId,
    targetPath,
    targetHostId,
    targetHostLabel,
    targetConnectionKey,
  }), [ownerId]);

  const resolveUploadConflict = useCallback((conflictId: string, action: FileConflictAction, applyToAll = false) => {
    const conflict = uploadConflicts.find((item) => item.transferId === conflictId);
    setUploadConflicts((prev) => prev.filter((item) => item.transferId !== conflictId));
    const resolver = uploadConflictResolversRef.current.get(conflictId);
    if (!resolver) return;
    uploadConflictResolversRef.current.delete(conflictId);
    uploadConflictOwnersRef.current.delete(conflictId);
    if (conflict && applyToAll) {
      resolver.setDefault(action);
    }
    resolver.resolve(action);
  }, [uploadConflicts]);

  const cancelPendingUploadConflicts = useCallback((controller?: UploadController) => {
    if (uploadConflictResolversRef.current.size === 0) return;
    const canceledIds = drainUploadConflictResolvers(
      uploadConflictResolversRef.current,
      uploadConflictOwnersRef.current,
      controller,
    );
    if (canceledIds.length === 0) return;
    setUploadConflicts((prev) => prev.filter((item) => !canceledIds.includes(item.transferId)));
  }, []);

  useEffect(() => () => {
    drainUploadConflictResolvers(
      uploadConflictResolversRef.current,
      uploadConflictOwnersRef.current,
    );
    // Upload controllers are process-level. Their upload finally blocks remove
    // them from externalUploadRuntime; panel unmount must not cancel them.
  }, []);

  const createUploadConflictResolver = useCallback((controller: UploadController) => {
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
      const conflictType = getSftpConflictTypeKey(conflict.isDirectory, conflict.existingType);
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
        uploadConflictOwnersRef.current.set(conflictId, controller);
        uploadConflictResolversRef.current.set(conflictId, {
          resolve,
          setDefault: (action) => {
            conflictDefaults.set(conflictType, action);
          },
        });
      });
    };
  }, []);

  // Create upload bridge that wraps netcattyBridge.
  // Pass connect-time Host so pooled stream uploads open the pinned endpoint
  // (session hostname/port/user overrides), not the vault entry by hostId alone.
  const createUploadBridge = useCallback((connectHost?: Host): UploadBridge => {
    const bridge = netcattyBridge.get();
    return {
      managesTransferLifecycle: Boolean(
        bridge?.startStreamTransfer,
      ),
      writeLocalFile: bridge?.writeLocalFile,
      mkdirLocal: bridge?.mkdirLocal,
      statLocal: bridge?.statLocal,
      deleteLocalFile: bridge?.deleteLocalFile,
      stageUploadFile: bridge?.stageUploadFile,
      cancelStagedUploadFile: bridge?.cancelStagedUploadFile,
      deleteTempFile: bridge?.deleteTempFile,
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
      // Stream transfer for large files (avoids loading into memory).
      // FileZilla-style: each concurrent file acquires a dedicated transfer
      // session (max 2/host) so the browse connection stays free.
      startStreamTransfer: bridge?.startStreamTransfer
        ? async (options) => {
            const b = netcattyBridge.get();
            if (!b?.startStreamTransfer) {
              return { transferId: options.transferId, error: 'Stream transfer not available' };
            }

            const wantPool =
              !!acquireTransferSession
              && options.targetType === "sftp"
              && !!options.targetHostId;

            // Acquire pool lease *inside* admission so queued uploads do not
            // pin dedicated connections while waiting for a scheduler slot.
            try {
              return await globalSftpTransferScheduler.run(
                ownerId,
                options.transferId,
                getSftpTransferResourceKeys(options),
                () => localStorageAdapter.readNumber(STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY),
                async () => {
                  let lease: { sftpId: string; release: () => void; discard: () => void } | null = null;
                  try {
                    if (wantPool && acquireTransferSession && options.targetHostId) {
                      // Never fall back to the browse/prep session for bulk
                      // streams — that path dies when the SFTP/terminal tab closes.
                      // Pass connectHost so session-time hostname/port/user
                      // overrides open the pinned endpoint, not vault-only hostId.
                      lease = await acquireTransferSession(
                        options.targetHostId,
                        options.transferId,
                        connectHost,
                      );
                    }

                    const resolvedTarget = resolveUploadStreamTargetSftpId({
                      requirePool: wantPool,
                      poolSftpId: lease?.sftpId,
                      prepSftpId: options.targetSftpId,
                    });
                    if (resolvedTarget.error) {
                      throw new Error(resolvedTarget.error);
                    }

                    const transferOptions = {
                      ...options,
                      targetSftpId: resolvedTarget.sftpId,
                      // Already admitted by globalSftpTransferScheduler.
                      skipAdmission: true as const,
                    };

                    const result = await b.startStreamTransfer!(transferOptions);

                    // Dead session → drop from pool so the next file opens fresh.
                    if (result?.error && isSessionError(new Error(result.error))) {
                      lease?.discard();
                      lease = null;
                    }
                    return result;
                  } catch (error) {
                    if (isSessionError(error)) {
                      lease?.discard();
                      lease = null;
                    }
                    throw error;
                  } finally {
                    lease?.release();
                  }
                },
              );
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
  }, [acquireTransferSession, ownerId]);

  const uploadExternalFiles = useCallback(
    async (side: "left" | "right", dataTransfer: DataTransfer, targetPath?: string): Promise<UploadResult[]> => {
      // DataTransfer is only valid during the drop event. Capture entries BEFORE
      // any await (session reconnect can take seconds while a transfer is busy).
      // Otherwise extractDropEntries returns [] and the UI toasts "Uploaded files: 0".
      let capturedEntries: DropEntry[];
      try {
        capturedEntries = await extractDropEntries(dataTransfer);
      } catch (error) {
        logger.error("[SFTP] Failed to read dropped files:", error);
        throw error;
      }
      if (capturedEntries.length === 0) {
        return [];
      }

      const run = async (forceReconnect = false): Promise<UploadResult[]> => {
        const pane = getActivePane(side);
        if (!pane?.connection) {
          throw new Error("No active connection");
        }

        const bridge = netcattyBridge.get();
        if (!bridge) {
          throw new Error("Bridge not available");
        }

        const { sftpId, release } = await resolveRemoteSftpId(side, { forceReconnect });
        const livePane = getActivePane(side) ?? pane;
        if (!livePane.connection) throw new Error("No active connection");

        const uploadPaneId = livePane.id;
        const uploadTargetPath = targetPath || livePane.connection.currentPath;
        const controller = new UploadController();
        const callbacks = bindUploadControllerCallbacks(
          controller,
          createUploadCallbacks(
            livePane.connection.id,
            uploadTargetPath,
            livePane.connection.isLocal ? undefined : livePane.connection.hostId,
            livePane.connection.isLocal ? undefined : connectionCacheKeyMapRef.current.get(livePane.connection.id),
            livePane.connection.isLocal ? undefined : livePane.connection.hostLabel,
          ),
        );
        const connectHost = resolveUploadConnectHost(uploadPaneId, livePane.connection.isLocal);
        const uploadBridge = createUploadBridge(connectHost);

        try {
          const hasDirectory = capturedEntries.some((entry) => (
            entry.isDirectory || entry.relativePath.replace(/\\/g, "/").includes("/")
          ));
          const results = await runWithCompressedUploadSession({
            enabled: useCompressedUpload,
            hasDirectory,
            isLocal: livePane.connection.isLocal,
            hostId: livePane.connection.isLocal ? undefined : livePane.connection.hostId,
            jobId: `compressed-upload-${crypto.randomUUID()}`,
            prepSftpId: sftpId,
            acquire: acquireTransferSession
              ? (hostId, jobId) => acquireTransferSession(hostId, jobId, connectHost)
              : undefined,
            shouldDiscard: isSessionError,
            run: async (uploadSftpId) => uploadEntriesDirect(
              capturedEntries,
              {
                targetPath: uploadTargetPath,
                sftpId: uploadSftpId,
                targetHostId: livePane.connection!.isLocal ? undefined : livePane.connection!.hostId,
                isLocal: livePane.connection!.isLocal,
                bridge: uploadBridge,
                joinPath,
                callbacks,
                useCompressedUpload,
                resolveConflict: createUploadConflictResolver(controller),
              },
              controller,
            ),
          });

          if (clearDirCacheEntry && targetPath) {
            clearDirCacheEntry(livePane.connection.id, uploadTargetPath);
          }
          if (uploadTargetPath === livePane.connection.currentPath) {
            await refresh(side, { tabId: uploadPaneId });
          }
          return results;
        } finally {
          release();
          unregisterUploadController(controller);
        }
      };

      try {
        return await run(false);
      } catch (error) {
        if (isSessionError(error) && ensureRemoteSftpId) {
          logger.warn("[SFTP] Upload session lost; reconnecting and retrying once", error);
          return await run(true);
        }
        logger.error("[SFTP] Upload failed:", error);
        throw error;
      }
    },
    [
      acquireTransferSession,
      clearDirCacheEntry,
      connectionCacheKeyMapRef,
      createUploadBridge,
      createUploadCallbacks,
      bindUploadControllerCallbacks,
      unregisterUploadController,
      createUploadConflictResolver,
      ensureRemoteSftpId,
      getActivePane,
      refresh,
      resolveRemoteSftpId,
      resolveUploadConnectHost,
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
      const run = async (forceReconnect = false): Promise<UploadResult[]> => {
        const pane = getActivePane(side);
        if (!pane?.connection) throw new Error("No active connection");
        if (!netcattyBridge.get()) throw new Error("Bridge not available");

        const { sftpId, release } = await resolveRemoteSftpId(side, { forceReconnect });
        const livePane = getActivePane(side) ?? pane;
        if (!livePane.connection) throw new Error("No active connection");

        const uploadPaneId = livePane.id;
        const uploadTargetPath = targetPath || livePane.connection.currentPath;
        const controller = new UploadController();

        const callbacks = bindUploadControllerCallbacks(
          controller,
          createUploadCallbacks(
            livePane.connection.id,
            uploadTargetPath,
            livePane.connection.isLocal ? undefined : livePane.connection.hostId,
            livePane.connection.isLocal ? undefined : connectionCacheKeyMapRef.current.get(livePane.connection.id),
            livePane.connection.isLocal ? undefined : livePane.connection.hostLabel,
          ),
        );
        const connectHost = resolveUploadConnectHost(uploadPaneId, livePane.connection.isLocal);
        const uploadBridge = createUploadBridge(connectHost);

        try {
          const files = Array.from(fileList);
          const hasDirectory = files.some((file) => (
            !!file.webkitRelativePath && file.webkitRelativePath.replace(/\\/g, "/").includes("/")
          ));
          const results = await runWithCompressedUploadSession({
            enabled: useCompressedUpload,
            hasDirectory,
            isLocal: livePane.connection.isLocal,
            hostId: livePane.connection.isLocal ? undefined : livePane.connection.hostId,
            jobId: `compressed-upload-${crypto.randomUUID()}`,
            prepSftpId: sftpId,
            acquire: acquireTransferSession
              ? (hostId, jobId) => acquireTransferSession(hostId, jobId, connectHost)
              : undefined,
            shouldDiscard: isSessionError,
            run: async (uploadSftpId) => uploadFromFileList(
              fileList,
              {
                targetPath: uploadTargetPath,
                sftpId: uploadSftpId,
                targetHostId: livePane.connection!.isLocal ? undefined : livePane.connection!.hostId,
                isLocal: livePane.connection!.isLocal,
                bridge: uploadBridge,
                joinPath,
                callbacks,
                useCompressedUpload,
                resolveConflict: createUploadConflictResolver(controller),
              },
              controller,
            ),
          });

          if (clearDirCacheEntry && targetPath) {
            clearDirCacheEntry(livePane.connection.id, uploadTargetPath);
          }
          if (uploadTargetPath === livePane.connection.currentPath) {
            await refresh(side, { tabId: uploadPaneId });
          }
          return results;
        } finally {
          release();
          unregisterUploadController(controller);
        }
      };

      try {
        return await run(false);
      } catch (error) {
        if (isSessionError(error) && ensureRemoteSftpId) {
          logger.warn("[SFTP] File picker upload session lost; reconnecting and retrying once", error);
          return await run(true);
        }
        logger.error("[SFTP] File picker upload failed:", error);
        throw error;
      }
    },
    [
      acquireTransferSession,
      clearDirCacheEntry,
      connectionCacheKeyMapRef,
      createUploadBridge,
      createUploadCallbacks,
      bindUploadControllerCallbacks,
      unregisterUploadController,
      createUploadConflictResolver,
      ensureRemoteSftpId,
      getActivePane,
      refresh,
      resolveRemoteSftpId,
      resolveUploadConnectHost,
      useCompressedUpload,
    ],
  );

  const uploadExternalFolderPath = useCallback(
    async (
      side: "left" | "right",
      folderPath: string,
      targetPath?: string,
      options?: { connectionId?: string; tabId?: string; endpointPin?: UploadEndpointPin },
    ): Promise<UploadResult[]> => {
      // Pin before any await so tab switches cannot retarget multi-folder pastes.
      const originatingPane = resolveUploadTargetPane({
        side,
        tabId: options?.tabId,
        connectionId: options?.connectionId,
        getActivePane,
        getPaneByTabId,
        getPaneByConnectionId,
      });
      const originatingTabId = originatingPane.id;
      // Prefer the pin captured when the paste dialog opened so multi-folder
      // uploads keep the original endpoint even if later calls re-resolve a
      // retargeted tab.
      const originatingEndpoint = options?.endpointPin ?? captureUploadEndpoint(
        originatingPane.connection,
        connectionCacheKeyMapRef.current,
      );
      assertUploadEndpointUnchanged(
        originatingPane.connection,
        originatingEndpoint,
        connectionCacheKeyMapRef.current,
      );

      const run = async (forceReconnect = false): Promise<UploadResult[]> => {
        const pane = resolveUploadTargetPane({
          side,
          tabId: originatingTabId,
          getActivePane,
          getPaneByTabId,
          getPaneByConnectionId,
        });
        assertUploadEndpointUnchanged(
          pane.connection,
          originatingEndpoint,
          connectionCacheKeyMapRef.current,
        );
        const bridge = netcattyBridge.get();
        if (!bridge) throw new Error("Bridge not available");
        if (!bridge.listLocalTree) throw new Error("Folder upload not supported");

        const { sftpId, release } = await resolveRemoteSftpId(side, {
          forceReconnect,
          connectionId: pane.connection.id,
          tabId: originatingTabId,
        });
        // Never re-resolve via getActivePane after awaits — focus may have moved.
        const livePane = resolveUploadTargetPane({
          side,
          tabId: originatingTabId,
          getActivePane,
          getPaneByTabId,
          getPaneByConnectionId,
        });
        assertUploadEndpointUnchanged(
          livePane.connection,
          originatingEndpoint,
          connectionCacheKeyMapRef.current,
        );

        const uploadPaneId = livePane.id;
        const uploadTargetPath = targetPath || livePane.connection.currentPath;
        const controller = new UploadController();

        const callbacks = bindUploadControllerCallbacks(
          controller,
          createUploadCallbacks(
            livePane.connection.id,
            uploadTargetPath,
            livePane.connection.isLocal ? undefined : livePane.connection.hostId,
            livePane.connection.isLocal ? undefined : connectionCacheKeyMapRef.current.get(livePane.connection.id),
            livePane.connection.isLocal ? undefined : livePane.connection.hostLabel,
          ),
        );
        // Pin connect-time Host before listLocalTree: a slow folder scan can
        // outlive a same-hostId tab rebind, and resolveUploadConnectHost would
        // otherwise open the pooled stream bridge on the newly selected endpoint.
        const uploadConnectHost = resolveUploadConnectHost(
          uploadPaneId,
          livePane.connection.isLocal,
        );
        const uploadBridge = createUploadBridge(uploadConnectHost);

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

          const results = await runWithCompressedUploadSession({
            enabled: useCompressedUpload,
            hasDirectory: true,
            isLocal: livePane.connection.isLocal,
            hostId: livePane.connection.isLocal ? undefined : livePane.connection.hostId,
            jobId: `compressed-upload-${crypto.randomUUID()}`,
            prepSftpId: sftpId,
            acquire: acquireTransferSession
              ? (hostId, jobId) => acquireTransferSession(hostId, jobId, uploadConnectHost)
              : undefined,
            shouldDiscard: isSessionError,
            run: async (uploadSftpId) => uploadEntriesDirect(
              entries,
              {
                targetPath: uploadTargetPath,
                sftpId: uploadSftpId,
                targetHostId: livePane.connection!.isLocal ? undefined : livePane.connection!.hostId,
                isLocal: livePane.connection!.isLocal,
                bridge: uploadBridge,
                joinPath,
                callbacks,
                useCompressedUpload,
                resolveConflict: createUploadConflictResolver(controller),
              },
              controller,
            ),
          });

          if (clearDirCacheEntry) {
            clearDirCacheEntry(livePane.connection.id, uploadTargetPath);
          }
          if (uploadTargetPath === livePane.connection.currentPath) {
            const refreshSide = getSideByTabId?.(uploadPaneId) ?? side;
            await refresh(refreshSide, { tabId: uploadPaneId });
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
          throw error;
        } finally {
          release();
          unregisterUploadController(controller);
        }
      };

      try {
        return await run(false);
      } catch (error) {
        if (isSessionError(error) && ensureRemoteSftpId) {
          logger.warn("[SFTP] Folder upload session lost; reconnecting and retrying once", error);
          return await run(true);
        }
        logger.error("[SFTP] Folder picker upload failed:", error);
        throw error;
      }
    },
    [
      acquireTransferSession,
      clearDirCacheEntry,
      connectionCacheKeyMapRef,
      createUploadBridge,
      createUploadCallbacks,
      bindUploadControllerCallbacks,
      unregisterUploadController,
      createUploadConflictResolver,
      ensureRemoteSftpId,
      getActivePane,
      getPaneByConnectionId,
      getPaneByTabId,
      getSideByTabId,
      refresh,
      resolveRemoteSftpId,
      resolveUploadConnectHost,
      useCompressedUpload,
    ],
  );

  const uploadExternalEntries = useCallback(
    async (
      side: "left" | "right",
      entries: DropEntry[],
      options?: {
        targetPath?: string;
        connectionId?: string;
        tabId?: string;
        endpointPin?: UploadEndpointPin;
      },
    ): Promise<UploadResult[]> => {
      // Pin before any await so tab switches cannot retarget the upload.
      const originatingPane = resolveUploadTargetPane({
        side,
        tabId: options?.tabId,
        connectionId: options?.connectionId,
        getActivePane,
        getPaneByTabId,
        getPaneByConnectionId,
      });
      const originatingTabId = originatingPane.id;
      const originatingEndpoint = options?.endpointPin ?? captureUploadEndpoint(
        originatingPane.connection,
        connectionCacheKeyMapRef.current,
      );
      assertUploadEndpointUnchanged(
        originatingPane.connection,
        originatingEndpoint,
        connectionCacheKeyMapRef.current,
      );

      const run = async (forceReconnect = false): Promise<UploadResult[]> => {
        const pane = resolveUploadTargetPane({
          side,
          tabId: originatingTabId,
          getActivePane,
          getPaneByTabId,
          getPaneByConnectionId,
        });
        assertUploadEndpointUnchanged(
          pane.connection,
          originatingEndpoint,
          connectionCacheKeyMapRef.current,
        );
        if (!netcattyBridge.get()) throw new Error("Bridge not available");

        const { sftpId, release } = await resolveRemoteSftpId(side, {
          forceReconnect,
          connectionId: pane.connection.id,
          tabId: originatingTabId,
        });
        // Never re-resolve via getActivePane after awaits — focus may have moved.
        const livePane = resolveUploadTargetPane({
          side,
          tabId: originatingTabId,
          getActivePane,
          getPaneByTabId,
          getPaneByConnectionId,
        });
        assertUploadEndpointUnchanged(
          livePane.connection,
          originatingEndpoint,
          connectionCacheKeyMapRef.current,
        );

        // Capture the pane ID now so we can refresh the correct tab after
        // upload, even if focus switches during the transfer.
        const uploadPaneId = livePane.id;
        const controller = new UploadController();
        const uploadTargetPath = options?.targetPath || livePane.connection.currentPath;

        const callbacks = bindUploadControllerCallbacks(
          controller,
          createUploadCallbacks(
            livePane.connection.id,
            uploadTargetPath,
            livePane.connection.isLocal ? undefined : livePane.connection.hostId,
            livePane.connection.isLocal ? undefined : connectionCacheKeyMapRef.current.get(livePane.connection.id),
            livePane.connection.isLocal ? undefined : livePane.connection.hostLabel,
          ),
        );
        const connectHost = resolveUploadConnectHost(uploadPaneId, livePane.connection.isLocal);
        const directUploadBridge = createUploadBridge(connectHost);

        try {
          const hasDirectory = entries.some((entry) => (
            entry.isDirectory || entry.relativePath.replace(/\\/g, "/").includes("/")
          ));
          const results = await runWithCompressedUploadSession({
            enabled: useCompressedUpload,
            hasDirectory,
            isLocal: livePane.connection.isLocal,
            hostId: livePane.connection.isLocal ? undefined : livePane.connection.hostId,
            jobId: `compressed-upload-${crypto.randomUUID()}`,
            prepSftpId: sftpId,
            acquire: acquireTransferSession
              ? (hostId, jobId) => acquireTransferSession(hostId, jobId, connectHost)
              : undefined,
            shouldDiscard: isSessionError,
            run: async (uploadSftpId) => uploadEntriesDirect(
              entries,
              {
                targetPath: uploadTargetPath,
                sftpId: uploadSftpId,
                targetHostId: livePane.connection!.isLocal ? undefined : livePane.connection!.hostId,
                isLocal: livePane.connection!.isLocal,
                bridge: directUploadBridge,
                joinPath,
                callbacks,
                useCompressedUpload,
                resolveConflict: createUploadConflictResolver(controller),
              },
              controller,
            ),
          });

          // Refresh the specific tab that initiated the upload (not whichever
          // tab is active now — focus may have switched during the transfer).
          // Also invalidate the upload target's cache entry so returning to
          // that path triggers a fresh listing.
          if (clearDirCacheEntry) {
            clearDirCacheEntry(livePane.connection.id, uploadTargetPath);
          }
          if (uploadTargetPath === livePane.connection.currentPath) {
            const refreshSide = getSideByTabId?.(uploadPaneId) ?? side;
            await refresh(refreshSide, { tabId: uploadPaneId });
          }
          return results;
        } finally {
          release();
          unregisterUploadController(controller);
        }
      };

      try {
        return await run(false);
      } catch (error) {
        if (isSessionError(error) && ensureRemoteSftpId) {
          logger.warn("[SFTP] Entry upload session lost; reconnecting and retrying once", error);
          return await run(true);
        }
        logger.error("[SFTP] Upload failed:", error);
        throw error;
      }
    },
    [
      acquireTransferSession,
      clearDirCacheEntry,
      connectionCacheKeyMapRef,
      createUploadBridge,
      createUploadCallbacks,
      bindUploadControllerCallbacks,
      unregisterUploadController,
      createUploadConflictResolver,
      ensureRemoteSftpId,
      getActivePane,
      getPaneByConnectionId,
      getPaneByTabId,
      getSideByTabId,
      refresh,
      resolveRemoteSftpId,
      resolveUploadConnectHost,
      useCompressedUpload,
    ],
  );

  const cancelExternalUpload = useCallback(async (taskId?: string) => {
    if (taskId) {
      const controller = getExternalUploadController(taskId);
      if (controller) {
        logger.info("[SFTP] Cancelling external upload", { taskId });
        cancelPendingUploadConflicts(controller);
      }
    } else {
      logger.info("[SFTP] Cancelling all external uploads");
      cancelPendingUploadConflicts();
    }
    await cancelExternalUploadRuntime(taskId);
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
    activeExternalEditCount,
    forgetExternalEditTempsForSftp,
    releaseExternalFileWatches,
    uploadConflicts,
    resolveUploadConflict,
  };
};
