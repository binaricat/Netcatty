import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { joinPath } from "./utils";

interface UseSftpTransfersParams {
  getActivePane: (side: "left" | "right") => SftpPane | null;
  refresh: (side: "left" | "right") => Promise<void>;
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
      onTransferComplete?: (result: TransferResult) => void | Promise<void>;
    },
  ) => Promise<TransferResult[]>;
  addExternalUpload: (task: TransferTask) => void;
  updateExternalUpload: (taskId: string, updates: Partial<TransferTask>) => void;
  cancelTransfer: (transferId: string) => Promise<void>;
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
  refresh,
  sftpSessionsRef,
  listLocalFiles,
  listRemoteFiles,
  handleSessionError,
}: UseSftpTransfersParams): UseSftpTransfersResult => {
  const [transfers, setTransfers] = useState<TransferTask[]>([]);
  const [conflicts, setConflicts] = useState<FileConflict[]>([]);

  const progressIntervalsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  // Track cancelled task IDs for checking during async operations
  const cancelledTasksRef = useRef<Set<string>>(new Set());
  const completionHandlersRef = useRef<Map<string, (result: TransferResult) => void | Promise<void>>>(new Map());

  useEffect(() => {
    const intervalsRef = progressIntervalsRef.current;
    return () => {
      intervalsRef.forEach((interval) => {
        clearInterval(interval);
      });
      intervalsRef.clear();
    };
  }, []);

  const startProgressSimulation = useCallback(
    (taskId: string, estimatedBytes: number) => {
      const existing = progressIntervalsRef.current.get(taskId);
      if (existing) clearInterval(existing);

      const baseSpeed = Math.max(50000, Math.min(500000, estimatedBytes / 10));
      const variability = 0.3;

      let transferred = 0;
      const interval = setInterval(() => {
        const speedFactor = 1 + (Math.random() - 0.5) * variability;
        const chunkSize = Math.floor(baseSpeed * speedFactor * 0.1);
        transferred = Math.min(transferred + chunkSize, estimatedBytes);

        setTransfers((prev) =>
          prev.map((t) => {
            if (t.id !== taskId || t.status !== "transferring") return t;
            return {
              ...t,
              transferredBytes: transferred,
              totalBytes: estimatedBytes,
              speed: chunkSize * 10,
            };
          }),
        );

        if (transferred >= estimatedBytes * 0.95) {
          clearInterval(interval);
          progressIntervalsRef.current.delete(taskId);
        }
      }, 100);

      progressIntervalsRef.current.set(taskId, interval);
    },
    [],
  );

  const stopProgressSimulation = useCallback((taskId: string) => {
    const interval = progressIntervalsRef.current.get(taskId);
    if (interval) {
      clearInterval(interval);
      progressIntervalsRef.current.delete(taskId);
    }
  }, []);

  const transferFile = async (
    task: TransferTask,
    sourceSftpId: string | null,
    targetSftpId: string | null,
    sourceIsLocal: boolean,
    targetIsLocal: boolean,
    sourceEncoding: SftpFilenameEncoding,
    targetEncoding: SftpFilenameEncoding,
    rootTaskId: string, // The original top-level task ID for cancellation checking
  ): Promise<void> => {
    // Check if task or root task was cancelled before starting
    if (cancelledTasksRef.current.has(task.id) || cancelledTasksRef.current.has(rootTaskId)) {
      throw new Error("Transfer cancelled");
    }

    if (netcattyBridge.get()?.startStreamTransfer) {
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

        const onProgress = (
          transferred: number,
          total: number,
          speed: number,
        ) => {
          setTransfers((prev) =>
            prev.map((t) => {
              if (t.id !== task.id) return t;
              if (t.status === "cancelled") return t;
              return {
                ...t,
                transferredBytes: transferred,
                totalBytes: total || t.totalBytes,
                speed,
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
    }

    let content: ArrayBuffer | string;

    if (sourceIsLocal) {
      content =
        (await netcattyBridge.get()?.readLocalFile?.(task.sourcePath)) ||
        new ArrayBuffer(0);
    } else if (sourceSftpId) {
      if (netcattyBridge.get()?.readSftpBinary) {
        content = await netcattyBridge.get()!.readSftpBinary!(
          sourceSftpId,
          task.sourcePath,
          sourceEncoding,
        );
      } else {
        content =
          (await netcattyBridge.get()?.readSftp(sourceSftpId, task.sourcePath, sourceEncoding)) || "";
      }
    } else {
      throw new Error("No source connection");
    }

    if (targetIsLocal) {
      if (content instanceof ArrayBuffer) {
        await netcattyBridge.get()?.writeLocalFile?.(task.targetPath, content);
      } else {
        const encoder = new TextEncoder();
        await netcattyBridge.get()?.writeLocalFile?.(
          task.targetPath,
          encoder.encode(content).buffer,
        );
      }
    } else if (targetSftpId) {
      if (content instanceof ArrayBuffer && netcattyBridge.get()?.writeSftpBinary) {
        await netcattyBridge.get()!.writeSftpBinary!(
          targetSftpId,
          task.targetPath,
          content,
          targetEncoding,
        );
      } else {
        const text =
          content instanceof ArrayBuffer
            ? new TextDecoder().decode(content)
            : content;
        await netcattyBridge.get()?.writeSftp(targetSftpId, task.targetPath, text, targetEncoding);
      }
    } else {
      throw new Error("No target connection");
    }
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

    for (const file of files) {
      if (file.name === "..") continue;

      // Check if root task was cancelled during iteration
      if (cancelledTasksRef.current.has(task.id) || cancelledTasksRef.current.has(rootTaskId)) {
        throw new Error("Transfer cancelled");
      }

      const childTask: TransferTask = {
        ...task,
        id: crypto.randomUUID(),
        fileName: file.name,
        originalFileName: file.name,
        sourcePath: joinPath(task.sourcePath, file.name),
        targetPath: joinPath(task.targetPath, file.name),
        isDirectory: file.type === "directory",
        parentTaskId: task.id,
      };

      if (file.type === "directory") {
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
      } else {
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

    let actualFileSize = task.totalBytes;
    if (!task.isDirectory && actualFileSize === 0) {
      try {
        const sourceSftpId = sourcePane.connection?.isLocal
          ? null
          : sftpSessionsRef.current.get(sourcePane.connection!.id);

        if (sourcePane.connection?.isLocal) {
          const stat = await netcattyBridge.get()?.statLocal?.(task.sourcePath);
          if (stat) actualFileSize = stat.size;
        } else if (sourceSftpId) {
          const stat = await netcattyBridge.get()?.statSftp?.(
            sourceSftpId,
            task.sourcePath,
            sourceEncoding,
          );
          if (stat) actualFileSize = stat.size;
        }
      } catch {
        // Ignore stat errors
      }
    }

    const estimatedSize =
      actualFileSize > 0
        ? actualFileSize
        : task.isDirectory
          ? 1024 * 1024
          : 256 * 1024;

    const hasStreamingTransfer = !!netcattyBridge.get()?.startStreamTransfer;

    updateTask({
      status: "transferring",
      totalBytes: estimatedSize,
      transferredBytes: 0,
      startTime: Date.now(),
    });

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

    let useSimulatedProgress = false;
    if (!hasStreamingTransfer || task.isDirectory) {
      useSimulatedProgress = true;
      startProgressSimulation(task.id, estimatedSize);
    }

    try {
      if (!task.skipConflictCheck && !task.isDirectory && targetPane.connection) {
        let targetExists = false;
        let existingStat: { size: number; mtime: number } | null = null;
        let sourceStat: { size: number; mtime: number } | null = null;

        try {
          if (sourcePane.connection.isLocal) {
            const stat = await netcattyBridge.get()?.statLocal?.(task.sourcePath);
            if (stat) {
              sourceStat = {
                size: stat.size,
                mtime: stat.lastModified || Date.now(),
              };
            }
          } else if (sourceSftpId) {
            const stat = await netcattyBridge.get()?.statSftp?.(
              sourceSftpId,
              task.sourcePath,
              sourceEncoding,
            );
            if (stat) {
              sourceStat = {
                size: stat.size,
                mtime: stat.lastModified || Date.now(),
              };
            }
          }
        } catch {
          // ignore
        }

        try {
          if (targetPane.connection.isLocal) {
            const stat = await netcattyBridge.get()?.statLocal?.(task.targetPath);
            if (stat) {
              targetExists = true;
              existingStat = {
                size: stat.size,
                mtime: stat.lastModified || Date.now(),
              };
            }
          } else if (targetSftpId) {
            const stat = await netcattyBridge.get()?.statSftp?.(
              targetSftpId,
              task.targetPath,
              targetEncoding,
            );
            if (stat) {
              targetExists = true;
              existingStat = {
                size: stat.size,
                mtime: stat.lastModified || Date.now(),
              };
            }
          }
        } catch {
          // ignore
        }

        if (targetExists && existingStat) {
          stopProgressSimulation(task.id);

          const newConflict: FileConflict = {
            transferId: task.id,
            fileName: task.fileName,
            sourcePath: task.sourcePath,
            targetPath: task.targetPath,
            existingSize: existingStat.size,
            newSize: sourceStat?.size || estimatedSize,
            existingModified: existingStat.mtime,
            newModified: sourceStat?.mtime || Date.now(),
          };
          setConflicts((prev) => [...prev, newConflict]);
          updateTask({
            status: "pending",
            totalBytes: sourceStat?.size || estimatedSize,
          });
          return "pending";
        }
      }

      if (task.isDirectory) {
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

      if (useSimulatedProgress) {
        stopProgressSimulation(task.id);
      }

      setTransfers((prev) =>
        prev.map((t) => {
          if (t.id !== task.id) return t;
          return {
            ...t,
            status: "completed" as TransferStatus,
            endTime: Date.now(),
            transferredBytes: t.totalBytes,
            speed: 0,
          };
        }),
      );

      await refresh(targetSide);
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
      if (useSimulatedProgress) {
        stopProgressSimulation(task.id);
      }

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
      onTransferComplete?: (result: TransferResult) => void | Promise<void>;
    },
  ) => {
      const sourcePane = options?.sourcePane ?? getActivePane(sourceSide);
      const targetPane = getActivePane(targetSide);

      if (!sourcePane?.connection || !targetPane?.connection) return [];

      const sourceEncoding: SftpFilenameEncoding = sourcePane.connection.isLocal
        ? "auto"
        : sourcePane.filenameEncoding || "auto";

      const sourcePath = options?.sourcePath ?? sourcePane.connection.currentPath;
      const targetPath = targetPane.connection.currentPath;
      const sourceConnectionId = options?.sourceConnectionId ?? sourcePane.connection.id;

      const sourceSftpId = sourcePane.connection.isLocal
        ? null
        : sftpSessionsRef.current.get(sourceConnectionId);

      const newTasks: TransferTask[] = [];

      for (const file of sourceFiles) {
        const direction: TransferDirection =
          sourcePane.connection!.isLocal && !targetPane.connection!.isLocal
            ? "upload"
            : !sourcePane.connection!.isLocal && targetPane.connection!.isLocal
              ? "download"
              : "remote-to-remote";

        let fileSize = 0;
        if (!file.isDirectory) {
          try {
            const fullPath = joinPath(sourcePath, file.name);
            if (sourcePane.connection!.isLocal) {
              const stat = await netcattyBridge.get()?.statLocal?.(fullPath);
              if (stat) fileSize = stat.size;
            } else if (sourceSftpId) {
            const stat = await netcattyBridge.get()?.statSftp?.(
              sourceSftpId,
              fullPath,
              sourceEncoding,
            );
              if (stat) fileSize = stat.size;
            }
          } catch {
            // ignore
          }
        }

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
    [getActivePane, sftpSessionsRef],
  );

  const cancelTransfer = useCallback(
    async (transferId: string) => {
      // Add to cancelled set so async operations can check
      cancelledTasksRef.current.add(transferId);

      stopProgressSimulation(transferId);

      setTransfers((prev) =>
        prev.map((t) =>
          t.id === transferId
            ? {
              ...t,
              status: "cancelled" as TransferStatus,
              endTime: Date.now(),
            }
            : t,
        ),
      );

      setConflicts((prev) => prev.filter((c) => c.transferId !== transferId));

      if (netcattyBridge.get()?.cancelTransfer) {
        try {
          await netcattyBridge.get()!.cancelTransfer!(transferId);
        } catch (err) {
          logger.warn("Failed to cancel transfer at backend:", err);
        }
      }

      // Clean up cancelled task ID after a delay to ensure all async ops see it
      setTimeout(() => {
        cancelledTasksRef.current.delete(transferId);
      }, 5000);
    },
    [stopProgressSimulation],
  );

  const retryTransfer = useCallback(
    async (transferId: string) => {
      const task = transfers.find((t) => t.id === transferId);
      if (!task) return;

      const sourceSide = task.sourceConnectionId.startsWith("left") ? "left" : "right";
      const targetSide = task.targetConnectionId.startsWith("left") ? "left" : "right";
      const sourcePane = getActivePane(sourceSide as "left" | "right");
      const targetPane = getActivePane(targetSide as "left" | "right");

      if (sourcePane?.connection && targetPane?.connection) {
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === transferId
              ? { ...t, status: "pending" as TransferStatus, error: undefined }
              : t,
          ),
        );
        await processTransfer(task, sourcePane, targetPane, targetSide);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- processTransfer is defined inline
    [transfers, getActivePane],
  );

  const clearCompletedTransfers = useCallback(() => {
    setTransfers((prev) =>
      prev.filter((t) => t.status !== "completed" && t.status !== "cancelled"),
    );
  }, []);

  const dismissTransfer = useCallback((transferId: string) => {
    setTransfers((prev) => prev.filter((t) => t.id !== transferId));
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
      prev.map((t) => (t.id === taskId ? { ...t, ...updates } : t)),
    );
  }, []);

  const resolveConflict = useCallback(
    async (conflictId: string, action: "replace" | "skip" | "duplicate") => {
      const conflict = conflicts.find((c) => c.transferId === conflictId);
      if (!conflict) return;

      setConflicts((prev) => prev.filter((c) => c.transferId !== conflictId));

      const task = transfers.find((t) => t.id === conflictId);
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

      const sourceSide = updatedTask.sourceConnectionId.startsWith("left") ? "left" : "right";
      const targetSide = updatedTask.targetConnectionId.startsWith("left") ? "left" : "right";
      const sourcePane = getActivePane(sourceSide as "left" | "right");
      const targetPane = getActivePane(targetSide as "left" | "right");

      if (sourcePane?.connection && targetPane?.connection) {
        setTimeout(async () => {
          await processTransfer(updatedTask, sourcePane, targetPane, targetSide);
        }, 100);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- processTransfer is defined inline
    [conflicts, transfers, getActivePane],
  );

  const activeTransfersCount = useMemo(() => transfers.filter(
    (t) => t.status === "pending" || t.status === "transferring",
  ).length, [transfers]);

  return {
    transfers,
    conflicts,
    activeTransfersCount,
    startTransfer,
    addExternalUpload,
    updateExternalUpload,
    cancelTransfer,
    retryTransfer,
    clearCompletedTransfers,
    dismissTransfer,
    resolveConflict,
  };
};
