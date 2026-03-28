import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  FileConflict,
  SftpFileEntry,
  SftpFilenameEncoding,
  TransferDirection,
  TransferStatus,
  TransferTask,
} from "../../../domain/models";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { logger } from "../../../lib/logger";
import { SftpPane } from "./types";
import { getParentPath, joinPath } from "./utils";

interface UseSftpTransfersParams {
  getActivePane: (side: "left" | "right") => SftpPane | null;
  getPaneByConnectionId: (connectionId: string) => SftpPane | null;
  getTabByConnectionId: (connectionId: string) => { side: "left" | "right"; tabId: string; pane: SftpPane } | null;
  updateTab: (side: "left" | "right", tabId: string, updater: (pane: SftpPane) => SftpPane) => void;
  refresh: (side: "left" | "right", options?: { tabId?: string }) => Promise<void>;
  clearCacheForConnection: (connectionId: string) => void;
  sftpSessionsRef: React.MutableRefObject<Map<string, string>>;
  listLocalFiles: (path: string) => Promise<SftpFileEntry[]>;
  listRemoteFiles: (sftpId: string, path: string, encoding?: SftpFilenameEncoding) => Promise<SftpFileEntry[]>;
  handleSessionError: (side: "left" | "right", error: Error) => void;
}

interface UseSftpTransfersResult {
  transfers: TransferTask[];
  conflicts: FileConflict[];
  activeTransfersCount: number;
  startTransfer: (
    sourceFiles: { name: string; isDirectory: boolean }[],
    sourceSide: "left" | "right",
    targetSide: "left" | "right",
    options?: {
      sourcePane?: SftpPane;
      sourcePath?: string;
      sourceConnectionId?: string;
      targetPath?: string;
      onTransferComplete?: (result: TransferResult) => void | Promise<void>;
    },
  ) => Promise<TransferResult[]>;
  addExternalUpload: (task: TransferTask) => void;
  updateExternalUpload: (taskId: string, updates: Partial<TransferTask>) => void;
  cancelTransfer: (transferId: string) => Promise<void>;
  isTransferCancelled: (transferId: string) => boolean;
  retryTransfer: (transferId: string) => Promise<void>;
  clearCompletedTransfers: () => void;
  dismissTransfer: (transferId: string) => void;
  resolveConflict: (conflictId: string, action: "replace" | "skip" | "duplicate") => Promise<void>;
}

interface TransferResult {
  id: string;
  fileName: string;
  originalFileName?: string;
  status: TransferStatus;
}

export const useSftpTransfers = ({
  getActivePane,
  getPaneByConnectionId,
  getTabByConnectionId,
  updateTab,
  refresh,
  clearCacheForConnection,
  sftpSessionsRef,
  listLocalFiles,
  listRemoteFiles,
  handleSessionError,
}: UseSftpTransfersParams): UseSftpTransfersResult => {
  const [transfers, setTransfers] = useState<TransferTask[]>([]);
  const [conflicts, setConflicts] = useState<FileConflict[]>([]);

  // Track cancelled task IDs for checking during async operations
  const cancelledTasksRef = useRef<Set<string>>(new Set());
  const transfersRef = useRef(transfers);
  transfersRef.current = transfers;
  const conflictsRef = useRef(conflicts);
  conflictsRef.current = conflicts;
  const completionHandlersRef = useRef<Map<string, (result: TransferResult) => void | Promise<void>>>(new Map());

  const clearCancelledTask = useCallback((taskId: string) => {
    cancelledTasksRef.current.delete(taskId);
  }, []);

  const resolveTaskEndpoints = useCallback((task: TransferTask) => {
    const sourceTab = getTabByConnectionId(task.sourceConnectionId);
    const targetTab = getTabByConnectionId(task.targetConnectionId);
    if (!sourceTab?.pane.connection || !targetTab?.pane.connection) {
      return null;
    }

    return {
      sourceSide: sourceTab.side,
      targetSide: targetTab.side,
      sourcePane: sourceTab.pane,
      targetPane: targetTab.pane,
    };
  }, [getTabByConnectionId]);

  const isTransferCancelledError = useCallback(
    (error: unknown): boolean =>
      error instanceof Error && error.message === "Transfer cancelled",
    [],
  );

  const getEntrySize = useCallback((entry: SftpFileEntry): number => {
    if (typeof entry.size === "string") {
      const parsed = parseInt(entry.size, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }
    return typeof entry.size === "number" && entry.size > 0 ? entry.size : 0;
  }, []);

  const estimateDirectoryBytes = useCallback(
    async (
      sourcePath: string,
      sourceSftpId: string | null,
      sourceIsLocal: boolean,
      sourceEncoding: SftpFilenameEncoding,
      rootTaskId: string,
    ): Promise<number> => {
      const estT0 = performance.now();
      if (cancelledTasksRef.current.has(rootTaskId)) {
        throw new Error("Transfer cancelled");
      }

      const files = sourceIsLocal
        ? await listLocalFiles(sourcePath)
        : sourceSftpId
          ? await listRemoteFiles(sourceSftpId, sourcePath, sourceEncoding)
          : null;

      if (!files) {
        throw new Error("No source connection");
      }

      let totalBytes = 0;
      const subdirs: SftpFileEntry[] = [];

      for (const file of files) {
        if (file.name === "..") continue;

        if (file.type === "directory") {
          subdirs.push(file);
        } else {
          totalBytes += getEntrySize(file);
        }
      }

      if (subdirs.length > 0) {
        if (cancelledTasksRef.current.has(rootTaskId)) {
          throw new Error("Transfer cancelled");
        }

        const subResults = await Promise.all(
          subdirs.map((subdir) =>
            estimateDirectoryBytes(
              joinPath(sourcePath, subdir.name),
              sourceSftpId,
              sourceIsLocal,
              sourceEncoding,
              rootTaskId,
            ),
          ),
        );
        totalBytes += subResults.reduce((sum, size) => sum + size, 0);
      }

      logger.debug(`[SFTP:perf] estimateDirectoryBytes ${sourcePath} = ${totalBytes} — ${(performance.now() - estT0).toFixed(0)}ms`);
      return totalBytes;
    },
    [getEntrySize, listLocalFiles, listRemoteFiles],
  );

  const transferFile = async (
    task: TransferTask,
    sourceSftpId: string | null,
    targetSftpId: string | null,
    sourceIsLocal: boolean,
    targetIsLocal: boolean,
    sourceEncoding: SftpFilenameEncoding,
    targetEncoding: SftpFilenameEncoding,
    rootTaskId: string, // The original top-level task ID for cancellation checking
    onStreamProgress?: (transferred: number, total: number, speed: number) => void,
  ): Promise<void> => {
    // Check if task or root task was cancelled before starting
    if (cancelledTasksRef.current.has(task.id) || cancelledTasksRef.current.has(rootTaskId)) {
      throw new Error("Transfer cancelled");
    }

    return new Promise((resolve, reject) => {
      const options = {
        transferId: task.id,
        sourcePath: task.sourcePath,
        targetPath: task.targetPath,
        sourceType: sourceIsLocal ? ("local" as const) : ("sftp" as const),
        targetType: targetIsLocal ? ("local" as const) : ("sftp" as const),
        sourceSftpId: sourceSftpId || undefined,
        targetSftpId: targetSftpId || undefined,
        totalBytes: task.totalBytes || undefined,
        sourceEncoding: sourceIsLocal ? undefined : sourceEncoding,
        targetEncoding: targetIsLocal ? undefined : targetEncoding,
      };

      let lastProgressUpdate = 0;
      const onProgress = (
        transferred: number,
        total: number,
        speed: number,
      ) => {
        // Bubble up streaming progress to parent (for directory transfers)
        onStreamProgress?.(transferred, total, speed);

        // Throttle state updates to at most once per 100ms
        const now = Date.now();
        if (now - lastProgressUpdate < 100 && transferred < total) return;
        lastProgressUpdate = now;

        setTransfers((prev) =>
          prev.map((t) => {
            if (t.id !== task.id) return t;
            if (t.status === "cancelled") return t;
            const normalizedTotal = total > 0 ? total : t.totalBytes;
            // Clamp to [previous, total] — the backend normalizes progress
            // but we guard against any non-monotonic edge cases.
            const normalizedTransferred = Math.max(
              t.transferredBytes,
              Math.min(transferred, normalizedTotal > 0 ? normalizedTotal : transferred),
            );
            return {
              ...t,
              transferredBytes: normalizedTransferred,
              totalBytes: normalizedTotal,
              speed: Number.isFinite(speed) && speed > 0 ? speed : 0,
            };
          }),
        );
      };

      const onComplete = () => {
        resolve();
      };

      const onError = (error: string) => {
        reject(new Error(error));
      };

      netcattyBridge.require().startStreamTransfer!(
        options,
        onProgress,
        onComplete,
        onError,
      ).catch(reject);
    });
  };

  const TRANSFER_CONCURRENCY = 4;

  /** Recursively count all files under a directory (for progress display). */
  const countDirectoryFiles = async (
    sourcePath: string,
    sourceSftpId: string | null,
    sourceIsLocal: boolean,
    sourceEncoding: SftpFilenameEncoding,
    rootTaskId: string,
  ): Promise<number> => {
    if (cancelledTasksRef.current.has(rootTaskId)) return 0;

    const files = sourceIsLocal
      ? await listLocalFiles(sourcePath)
      : sourceSftpId
        ? await listRemoteFiles(sourceSftpId, sourcePath, sourceEncoding)
        : null;
    if (!files) return 0;

    let count = 0;
    const subdirPromises: Promise<number>[] = [];
    for (const file of files) {
      if (file.name === "..") continue;
      if (file.type === "directory") {
        subdirPromises.push(
          countDirectoryFiles(joinPath(sourcePath, file.name), sourceSftpId, sourceIsLocal, sourceEncoding, rootTaskId),
        );
      } else {
        count++;
      }
    }
    if (subdirPromises.length > 0) {
      const subCounts = await Promise.all(subdirPromises);
      count += subCounts.reduce((a, b) => a + b, 0);
    }
    return count;
  };

  const transferDirectory = async (
    task: TransferTask,
    sourceSftpId: string | null,
    targetSftpId: string | null,
    sourceIsLocal: boolean,
    targetIsLocal: boolean,
    sourceEncoding: SftpFilenameEncoding,
    targetEncoding: SftpFilenameEncoding,
    rootTaskId: string, // The original top-level task ID for cancellation checking
  ) => {
    // Check if task or root task was cancelled before starting
    if (cancelledTasksRef.current.has(task.id) || cancelledTasksRef.current.has(rootTaskId)) {
      throw new Error("Transfer cancelled");
    }

    if (targetIsLocal) {
      await netcattyBridge.get()?.mkdirLocal?.(task.targetPath);
    } else if (targetSftpId) {
      await netcattyBridge.get()?.mkdirSftp(targetSftpId, task.targetPath, targetEncoding);
    }

    let files: SftpFileEntry[];
    if (sourceIsLocal) {
      files = await listLocalFiles(task.sourcePath);
    } else if (sourceSftpId) {
      files = await listRemoteFiles(sourceSftpId, task.sourcePath, sourceEncoding);
    } else {
      throw new Error("No source connection");
    }

    const filtered = files.filter((f) => f.name !== "..");
    const dirs = filtered.filter((f) => f.type === "directory");
    const regularFiles = filtered.filter((f) => f.type !== "directory");

    // Process subdirectories first
    for (const dir of dirs) {
      if (cancelledTasksRef.current.has(task.id) || cancelledTasksRef.current.has(rootTaskId)) {
        throw new Error("Transfer cancelled");
      }

      const childTask: TransferTask = {
        ...task,
        id: crypto.randomUUID(),
        fileName: dir.name,
        originalFileName: dir.name,
        sourcePath: joinPath(task.sourcePath, dir.name),
        targetPath: joinPath(task.targetPath, dir.name),
        isDirectory: true,
        progressMode: "files",
        parentTaskId: task.id,
      };

      await transferDirectory(
        childTask,
        sourceSftpId,
        targetSftpId,
        sourceIsLocal,
        targetIsLocal,
        sourceEncoding,
        targetEncoding,
        rootTaskId,
      );
    }

    // Transfer files in parallel with concurrency limit
    if (regularFiles.length > 0) {
      let fileIndex = 0;
      const errors: Error[] = [];

      const worker = async () => {
        while (fileIndex < regularFiles.length) {
          if (cancelledTasksRef.current.has(task.id) || cancelledTasksRef.current.has(rootTaskId)) {
            throw new Error("Transfer cancelled");
          }

          const idx = fileIndex++;
          const file = regularFiles[idx];
          const fileId = crypto.randomUUID();
          const fileSize = getEntrySize(file);

          const childTask: TransferTask = {
            ...task,
            id: fileId,
            fileName: file.name,
            originalFileName: file.name,
            sourcePath: joinPath(task.sourcePath, file.name),
            targetPath: joinPath(task.targetPath, file.name),
            isDirectory: false,
            progressMode: "bytes",
            parentTaskId: rootTaskId,
            totalBytes: fileSize,
          };

          // Register child in transfers array so UI can render it
          setTransfers((prev) => [...prev, {
            ...childTask,
            status: "transferring" as TransferStatus,
            transferredBytes: 0,
            speed: 0,
            startTime: Date.now(),
          }]);

          try {
            await transferFile(
              childTask,
              sourceSftpId,
              targetSftpId,
              sourceIsLocal,
              targetIsLocal,
              sourceEncoding,
              targetEncoding,
              rootTaskId,
            );

            // Mark child as completed & update parent file count
            setTransfers((prev) => {
              const updated = prev.map((t) => {
                if (t.id === fileId) {
                  return { ...t, status: "completed" as TransferStatus, endTime: Date.now(), transferredBytes: t.totalBytes };
                }
                if (t.id === rootTaskId) {
                  return { ...t, transferredBytes: t.transferredBytes + 1 };
                }
                return t;
              });
              return updated;
            });
          } catch (err) {
            // Mark child as failed
            setTransfers((prev) =>
              prev.map((t) =>
                t.id === fileId
                  ? { ...t, status: "failed" as TransferStatus, error: err instanceof Error ? err.message : String(err) }
                  : t,
              ),
            );
            if (err instanceof Error && err.message === "Transfer cancelled") throw err;
            errors.push(err instanceof Error ? err : new Error(String(err)));
          }
        }
      };

      const workers = Array.from(
        { length: Math.min(TRANSFER_CONCURRENCY, regularFiles.length) },
        () => worker(),
      );
      await Promise.all(workers);

      if (errors.length > 0) {
        logger.debug?.("[SFTP] Some files in directory transfer failed", errors);
      }
    }
  };

  const processTransfer = async (
    task: TransferTask,
    sourcePane: SftpPane,
    targetPane: SftpPane,
    targetSide: "left" | "right",
  ): Promise<TransferStatus> => {
    const updateTask = (updates: Partial<TransferTask>) => {
      setTransfers((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, ...updates } : t)),
      );
    };

    // Initialize encoding early to avoid temporal dead zone issues
    const sourceEncoding: SftpFilenameEncoding = sourcePane.connection?.isLocal
      ? "auto"
      : sourcePane.filenameEncoding || "auto";
    const targetEncoding: SftpFilenameEncoding = targetPane.connection?.isLocal
      ? "auto"
      : targetPane.filenameEncoding || "auto";

    const sourceSftpId = sourcePane.connection?.isLocal
      ? null
      : sftpSessionsRef.current.get(sourcePane.connection!.id);
    const targetSftpId = targetPane.connection?.isLocal
      ? null
      : sftpSessionsRef.current.get(targetPane.connection!.id);

    if (!sourcePane.connection?.isLocal && !sourceSftpId) {
      const sourceSide = targetSide === "left" ? "right" : "left";
      handleSessionError(sourceSide, new Error("Source SFTP session lost"));
      throw new Error("Source SFTP session not found");
    }

    if (!targetPane.connection?.isLocal && !targetSftpId) {
      handleSessionError(targetSide, new Error("Target SFTP session lost"));
      throw new Error("Target SFTP session not found");
    }

    const discoverTransferSize = async () => {
      try {
        if (task.isDirectory) {
          const discoveredSize = await estimateDirectoryBytes(
            task.sourcePath,
            sourceSftpId,
            sourcePane.connection!.isLocal,
            sourceEncoding,
            task.id,
          );
          if (cancelledTasksRef.current.has(task.id)) return;
          updateTask({
            totalBytes: Math.max(discoveredSize, 0),
          });
          return;
        }

        if (task.totalBytes > 0 || !!task.sourceLastModified) return;

        if (sourcePane.connection?.isLocal) {
          const stat = await netcattyBridge.get()?.statLocal?.(task.sourcePath);
          if (stat) {
            if (!task.sourceLastModified && stat.lastModified) {
              task.sourceLastModified = stat.lastModified;
            }
            if (!cancelledTasksRef.current.has(task.id)) {
              updateTask({
                totalBytes: stat.size,
              });
            }
          }
          return;
        }

        if (sourceSftpId) {
          const stat = await netcattyBridge.get()?.statSftp?.(
            sourceSftpId,
            task.sourcePath,
            sourceEncoding,
          );
          if (stat) {
            if (!task.sourceLastModified && stat.lastModified) {
              task.sourceLastModified = stat.lastModified;
            }
            if (!cancelledTasksRef.current.has(task.id)) {
              updateTask({
                totalBytes: stat.size,
              });
            }
          }
        }
      } catch (err) {
        if (!isTransferCancelledError(err)) {
          logger.debug?.("[SFTP] Deferred transfer size discovery failed", err);
        }
      }
    };

    try {
      const t0 = performance.now();
      logger.debug(`[SFTP:perf] processTransfer START — file=${task.fileName} isDir=${task.isDirectory}`);

      updateTask({
        status: "transferring",
        totalBytes: Math.max(task.totalBytes, 0),
        transferredBytes: 0,
        startTime: Date.now(),
      });

      // Run size discovery and conflict check in parallel
      const conflictCheckPromise = (async (): Promise<FileConflict | null> => {
        if (task.skipConflictCheck || task.isDirectory || !targetPane.connection) return null;

        const sourceStat: { size: number; mtime: number } | null =
          (task.totalBytes > 0 || task.sourceLastModified)
            ? { size: task.totalBytes, mtime: task.sourceLastModified || Date.now() }
            : null;

        try {
          let existingStat: { size: number; mtime: number } | null = null;

          if (targetPane.connection.isLocal) {
            const stat = await netcattyBridge.get()?.statLocal?.(task.targetPath);
            if (stat) {
              existingStat = { size: stat.size, mtime: stat.lastModified || Date.now() };
            }
          } else if (targetSftpId) {
            const stat = await netcattyBridge.get()?.statSftp?.(
              targetSftpId,
              task.targetPath,
              targetEncoding,
            );
            if (stat) {
              existingStat = { size: stat.size, mtime: stat.lastModified || Date.now() };
            }
          }

          if (existingStat) {
            return {
              transferId: task.id,
              fileName: task.fileName,
              sourcePath: task.sourcePath,
              targetPath: task.targetPath,
              existingSize: existingStat.size,
              newSize: sourceStat?.size || task.totalBytes || 0,
              existingModified: existingStat.mtime,
              newModified: sourceStat?.mtime || Date.now(),
            };
          }
        } catch {
          // ignore
        }
        return null;
      })();

      // For single files: fire-and-forget size discovery
      if (!task.isDirectory) {
        void discoverTransferSize();
      }

      // Only await conflict check (fast single stat call)
      const conflict = await conflictCheckPromise;

      if (conflict) {
        setConflicts((prev) => [...prev, conflict]);
        updateTask({
          status: "pending",
          totalBytes: conflict.newSize || task.totalBytes || 0,
        });
        return "pending";
      }

      logger.debug(`[SFTP:perf] starting actual transfer — file=${task.fileName} isDir=${task.isDirectory} — ${(performance.now() - t0).toFixed(0)}ms since start`);

      if (task.isDirectory) {
        // For directory transfers, parent task uses:
        //   totalBytes = total file count (discovered async)
        //   transferredBytes = completed file count (incremented by child completions)
        // Child file tasks are registered in transfers array with their own byte progress.

        // Fire-and-forget: count total files for parent progress display
        void countDirectoryFiles(
          task.sourcePath,
          sourceSftpId,
          sourcePane.connection!.isLocal,
          sourceEncoding,
          task.id,
        ).then((fileCount) => {
          if (!cancelledTasksRef.current.has(task.id)) {
            updateTask({ totalBytes: fileCount });
          }
        }).catch(() => {});

        await transferDirectory(
          task,
          sourceSftpId,
          targetSftpId,
          sourcePane.connection!.isLocal,
          targetPane.connection!.isLocal,
          sourceEncoding,
          targetEncoding,
          task.id, // rootTaskId - this is the top-level task
        );
      } else {
        await transferFile(
          task,
          sourceSftpId,
          targetSftpId,
          sourcePane.connection!.isLocal,
          targetPane.connection!.isLocal,
          sourceEncoding,
          targetEncoding,
          task.id, // rootTaskId - this is the top-level task
        );
      }

      setTransfers((prev) => {
        return prev.map((t) => {
          if (t.id !== task.id) return t;
          return {
            ...t,
            status: "completed" as TransferStatus,
            endTime: Date.now(),
            transferredBytes: t.totalBytes,
            speed: 0,
          };
        });
      });

      // Target contents may have been cached before this transfer started,
      // especially when dropping into a subdirectory like "/tmp" from its parent.
      // Clear the target connection cache so the next navigation reloads fresh data.
      clearCacheForConnection(task.targetConnectionId);

      const targetTab = getTabByConnectionId(task.targetConnectionId);
      if (targetTab) {
        updateTab(targetTab.side, targetTab.tabId, (prev) => ({
          ...prev,
          transferMutationToken: prev.transferMutationToken + 1,
        }));
      }

      // Refresh the specific target tab, not whichever tab happens to be
      // active now — focus may have switched during the transfer.
      if (getParentPath(task.targetPath) === targetPane.connection!.currentPath) {
        await refresh(targetSide, { tabId: targetPane.id });
      }
      const completionHandler = completionHandlersRef.current.get(task.id);
      if (completionHandler) {
        try {
          await completionHandler({
            id: task.id,
            fileName: task.fileName,
            originalFileName: task.originalFileName ?? task.fileName,
            status: "completed",
          });
        } finally {
          completionHandlersRef.current.delete(task.id);
        }
      }
      return "completed";
    } catch (err) {
      // Check if this was a cancellation
      const isCancelled = cancelledTasksRef.current.has(task.id) ||
        (err instanceof Error && err.message === "Transfer cancelled");

      if (isCancelled) {
        // Don't update status - cancelTransfer already set it to cancelled
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
        clearCancelledTask(task.id);
        return "cancelled";
      }

      updateTask({
        status: "failed",
        error: err instanceof Error ? err.message : "Transfer failed",
        endTime: Date.now(),
        speed: 0,
      });
      const completionHandler = completionHandlersRef.current.get(task.id);
      if (completionHandler) {
        try {
          await completionHandler({
            id: task.id,
            fileName: task.fileName,
            originalFileName: task.originalFileName ?? task.fileName,
            status: "failed",
          });
        } finally {
          completionHandlersRef.current.delete(task.id);
        }
      }
      return "failed";
    }
  };

  const startTransfer = useCallback(
    async (
      sourceFiles: { name: string; isDirectory: boolean }[],
      sourceSide: "left" | "right",
      targetSide: "left" | "right",
      options?: {
        sourcePane?: SftpPane;
        sourcePath?: string;
        sourceConnectionId?: string;
        targetPath?: string;
        onTransferComplete?: (result: TransferResult) => void | Promise<void>;
      },
    ) => {
      const sourcePane = options?.sourcePane
        ?? (options?.sourceConnectionId ? getPaneByConnectionId(options.sourceConnectionId) : null)
        ?? getActivePane(sourceSide);
      const targetPane = getActivePane(targetSide);

      if (!sourcePane?.connection || !targetPane?.connection) return [];

      const sourcePath = options?.sourcePath ?? sourcePane.connection.currentPath;
      const targetPath = options?.targetPath ?? targetPane.connection.currentPath;
      const sourceConnectionId = options?.sourceConnectionId ?? sourcePane.connection.id;

      const newTasks: TransferTask[] = [];

      const canReusePaneMetadata = sourcePath === sourcePane.connection.currentPath;
      const fileEntryMap = canReusePaneMetadata
        ? new Map(sourcePane.files.map(f => [f.name, f]))
        : null;

      for (const file of sourceFiles) {
        const direction: TransferDirection =
          sourcePane.connection!.isLocal && !targetPane.connection!.isLocal
            ? "upload"
            : !sourcePane.connection!.isLocal && targetPane.connection!.isLocal
              ? "download"
              : "remote-to-remote";

        // Use cached metadata from the source pane's file list to avoid
        // redundant stat calls over the network, but only when the transfer
        // source matches the pane's currently listed directory.
        const fileEntry = fileEntryMap?.get(file.name);
        const fileSize = file.isDirectory ? 0 : (fileEntry?.size ?? 0);
        const sourceLastModified = fileEntry?.lastModified ?? 0;

        newTasks.push({
          id: crypto.randomUUID(),
          fileName: file.name,
          originalFileName: file.name,
          sourcePath: joinPath(sourcePath, file.name),
          targetPath: joinPath(targetPath, file.name),
          sourceConnectionId,
          targetConnectionId: targetPane.connection!.id,
          direction,
          status: "pending" as TransferStatus,
          totalBytes: fileSize,
          transferredBytes: 0,
          speed: 0,
          startTime: Date.now(),
          isDirectory: file.isDirectory,
          progressMode: file.isDirectory ? "files" : "bytes",
          sourceLastModified,
        });
      }

      setTransfers((prev) => [...prev, ...newTasks]);

      if (options?.onTransferComplete) {
        for (const task of newTasks) {
          completionHandlersRef.current.set(task.id, options.onTransferComplete);
        }
      }

      const results: TransferResult[] = [];

      for (const task of newTasks) {
        const status = await processTransfer(task, sourcePane, targetPane, targetSide);
        results.push({
          id: task.id,
          fileName: task.fileName,
          originalFileName: task.originalFileName ?? task.fileName,
          status,
        });
      }

      return results;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getActivePane, getPaneByConnectionId, getTabByConnectionId, sftpSessionsRef, updateTab],
  );

  const cancelTransfer = useCallback(
    async (transferId: string) => {
      // Add to cancelled set so async operations can check
      cancelledTasksRef.current.add(transferId);

      // Cancel parent + remove child tasks
      setTransfers((prev) => {
        // Find child task IDs to cancel at backend too
        const childIds = prev.filter((t) => t.parentTaskId === transferId && (t.status === "transferring" || t.status === "pending")).map((t) => t.id);
        for (const cid of childIds) {
          cancelledTasksRef.current.add(cid);
        }
        return prev
          .filter((t) => t.parentTaskId !== transferId)
          .map((t) =>
            t.id === transferId
              ? { ...t, status: "cancelled" as TransferStatus, endTime: Date.now() }
              : t,
          );
      });

      setConflicts((prev) => prev.filter((c) => c.transferId !== transferId));

      if (netcattyBridge.get()?.cancelTransfer) {
        try {
          await netcattyBridge.get()!.cancelTransfer!(transferId);
        } catch (err) {
          logger.warn("Failed to cancel transfer at backend:", err);
        }
      }

    },
    [],
  );

  const retryTransfer = useCallback(
    async (transferId: string) => {
      const task = transfersRef.current.find((t) => t.id === transferId);
      if (!task || task.retryable === false) return;

      const retriedTask: TransferTask = {
        ...task,
        id: crypto.randomUUID(),
        status: "pending" as TransferStatus,
        error: undefined,
        transferredBytes: 0,
        speed: 0,
        startTime: Date.now(),
        endTime: undefined,
      };

      const endpoints = resolveTaskEndpoints(task);
      if (!endpoints) return;
      const { targetSide, sourcePane, targetPane } = endpoints;

      const completionHandler = completionHandlersRef.current.get(transferId);
      if (completionHandler) {
        completionHandlersRef.current.set(retriedTask.id, completionHandler);
        completionHandlersRef.current.delete(transferId);
      }

      setTransfers((prev) =>
        prev.map((t) =>
          t.id === transferId
            ? retriedTask
            : t,
        ),
      );
      await processTransfer(retriedTask, sourcePane, targetPane, targetSide);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- processTransfer is defined inline
    [resolveTaskEndpoints],
  );

  const clearCompletedTransfers = useCallback(() => {
    setTransfers((prev) =>
      prev.filter((t) => t.status !== "completed" && t.status !== "cancelled"),
    );
  }, []);

  const dismissTransfer = useCallback((transferId: string) => {
    setTransfers((prev) => prev.filter((t) => t.id !== transferId && t.parentTaskId !== transferId));
  }, []);

  const isTransferCancelled = useCallback((transferId: string) => {
    return cancelledTasksRef.current.has(transferId);
  }, []);

  const addExternalUpload = useCallback((task: TransferTask) => {
    // Filter out any pending scanning tasks before adding the new task.
    // This ensures that even if dismissExternalUpload's state update hasn't been applied yet
    // (due to React state batching), the scanning placeholder will still be removed.
    setTransfers((prev) => [
      ...prev.filter(t => !(t.status === "pending" && t.fileName === "Scanning files...")),
      task
    ]);
  }, []);

  const updateExternalUpload = useCallback((taskId: string, updates: Partial<TransferTask>) => {
    setTransfers((prev) =>
      prev.map((t) => {
        if (t.id !== taskId) return t;

        const merged: TransferTask = { ...t, ...updates };

        // Keep progress monotonic and bounded for stable progress UI.
        if (typeof merged.totalBytes === "number" && merged.totalBytes > 0) {
          merged.transferredBytes = Math.max(
            t.transferredBytes,
            Math.min(merged.transferredBytes, merged.totalBytes),
          );
        } else {
          merged.transferredBytes = Math.max(t.transferredBytes, merged.transferredBytes);
        }

        if (!Number.isFinite(merged.speed) || merged.speed < 0) {
          merged.speed = 0;
        }

        return merged;
      }),
    );
  }, []);

  const resolveConflict = useCallback(
    async (conflictId: string, action: "replace" | "skip" | "duplicate") => {
      const conflict = conflictsRef.current.find((c) => c.transferId === conflictId);
      if (!conflict) return;

      setConflicts((prev) => prev.filter((c) => c.transferId !== conflictId));

      const task = transfersRef.current.find((t) => t.id === conflictId);
      if (!task) return;

      if (action === "skip") {
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === conflictId
              ? { ...t, status: "cancelled" as TransferStatus }
              : t,
          ),
        );
        const completionHandler = completionHandlersRef.current.get(conflictId);
        if (completionHandler) {
          try {
            await completionHandler({
              id: task.id,
              fileName: task.fileName,
              originalFileName: task.originalFileName ?? task.fileName,
              status: "cancelled",
            });
          } finally {
            completionHandlersRef.current.delete(conflictId);
          }
        }
        return;
      }

      let updatedTask = { ...task };

      if (action === "duplicate") {
        const ext = task.fileName.includes(".")
          ? "." + task.fileName.split(".").pop()
          : "";
        const baseName = task.fileName.includes(".")
          ? task.fileName.slice(0, task.fileName.lastIndexOf("."))
          : task.fileName;
        const newName = `${baseName} (copy)${ext}`;
        const newTargetPath = task.targetPath.replace(task.fileName, newName);
        updatedTask = {
          ...task,
          fileName: newName,
          targetPath: newTargetPath,
          skipConflictCheck: true,
        };
      } else if (action === "replace") {
        updatedTask = {
          ...task,
          skipConflictCheck: true,
        };
      }

      setTransfers((prev) =>
        prev.map((t) =>
          t.id === conflictId
            ? { ...updatedTask, status: "pending" as TransferStatus }
            : t,
        ),
      );

      setTimeout(async () => {
        const endpoints = resolveTaskEndpoints(updatedTask);
        if (!endpoints) return;
        await processTransfer(updatedTask, endpoints.sourcePane, endpoints.targetPane, endpoints.targetSide);
      }, 100);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- processTransfer is defined inline; transfers/conflicts accessed via refs
    [resolveTaskEndpoints],
  );

  const activeTransfersCount = useMemo(() => transfers.filter(
    (t) => (t.status === "pending" || t.status === "transferring") && !t.parentTaskId,
  ).length, [transfers]);

  return {
    transfers,
    conflicts,
    activeTransfersCount,
    startTransfer,
    addExternalUpload,
    updateExternalUpload,
    cancelTransfer,
    isTransferCancelled,
    retryTransfer,
    clearCompletedTransfers,
    dismissTransfer,
    resolveConflict,
  };
};
