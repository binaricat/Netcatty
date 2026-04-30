import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  FileConflict,
  FileConflictAction,
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
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";
import { STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY } from "../../../infrastructure/config/storageKeys";

interface UseSftpTransfersParams {
  getActivePane: (side: "left" | "right") => SftpPane | null;
  getPaneByConnectionId: (connectionId: string) => SftpPane | null;
  getTabByConnectionId: (connectionId: string) => { side: "left" | "right"; tabId: string; pane: SftpPane } | null;
  updateTab: (side: "left" | "right", tabId: string, updater: (pane: SftpPane) => SftpPane) => void;
  refresh: (side: "left" | "right", options?: { tabId?: string }) => Promise<void>;
  clearCacheForConnection: (connectionId: string) => void;
  sftpSessionsRef: React.MutableRefObject<Map<string, string>>;
  connectionCacheKeyMapRef: React.MutableRefObject<Map<string, string>>;
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
  downloadToLocal: (params: {
    fileName: string;
    sourcePath: string;
    targetPath: string;
    sftpId: string;
    connectionId: string;
    sourceEncoding?: SftpFilenameEncoding;
    isDirectory: boolean;
    totalBytes?: number;
  }) => Promise<TransferStatus>;
  addExternalUpload: (task: TransferTask) => void;
  updateExternalUpload: (taskId: string, updates: Partial<TransferTask>) => void;
  cancelTransfer: (transferId: string) => Promise<void>;
  isTransferCancelled: (transferId: string) => boolean;
  retryTransfer: (transferId: string) => Promise<void>;
  clearCompletedTransfers: () => void;
  dismissTransfer: (transferId: string) => void;
  resolveConflict: (conflictId: string, action: FileConflictAction, applyToAll?: boolean) => Promise<void>;
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
  connectionCacheKeyMapRef,
  listLocalFiles,
  listRemoteFiles,
  handleSessionError,
}: UseSftpTransfersParams): UseSftpTransfersResult => {
  const [transfers, setTransfers] = useState<TransferTask[]>([]);
  const [conflicts, setConflicts] = useState<FileConflict[]>([]);

  // Track cancelled task IDs for checking during async operations
  const cancelledTasksRef = useRef<Set<string>>(new Set());
  // Track active child transfer IDs per parent (outside React state for immediate visibility)
  const activeChildIdsRef = useRef<Map<string, Set<string>>>(new Map());
  const transfersRef = useRef(transfers);
  transfersRef.current = transfers;
  const conflictsRef = useRef(conflicts);
  conflictsRef.current = conflicts;
  const completionHandlersRef = useRef<Map<string, (result: TransferResult) => void | Promise<void>>>(new Map());
  const conflictDefaultsRef = useRef<Map<string, FileConflictAction>>(new Map());

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

  const conflictDefaultKey = useCallback(
    (batchId: string | undefined, isDirectory: boolean) =>
      `${batchId ?? "global"}:${isDirectory ? "directory" : "file"}`,
    [],
  );

  const splitNameForDuplicate = useCallback((fileName: string, isDirectory: boolean) => {
    if (isDirectory) return { baseName: fileName, ext: "" };
    const lastDot = fileName.lastIndexOf(".");
    if (lastDot <= 0) return { baseName: fileName, ext: "" };
    return {
      baseName: fileName.slice(0, lastDot),
      ext: fileName.slice(lastDot),
    };
  }, []);

  const statTargetPath = useCallback(
    async (
      targetPane: SftpPane,
      targetSftpId: string | null,
      targetPath: string,
      targetEncoding: SftpFilenameEncoding,
    ): Promise<{ type?: "file" | "directory" | "symlink"; size: number; mtime: number } | null> => {
      if (!targetPane.connection) return null;

      if (targetPane.connection.isLocal) {
        const stat = await netcattyBridge.get()?.statLocal?.(targetPath);
        if (!stat) return null;
        return {
          type: stat.type as "file" | "directory" | "symlink" | undefined,
          size: stat.size,
          mtime: stat.lastModified || Date.now(),
        };
      }

      if (!targetSftpId) return null;
      const stat = await netcattyBridge.get()?.statSftp?.(
        targetSftpId,
        targetPath,
        targetEncoding,
      );
      if (!stat) return null;
      return {
        type: stat.type as "file" | "directory" | "symlink" | undefined,
        size: stat.size,
        mtime: stat.lastModified || Date.now(),
      };
    },
    [],
  );

  const getDuplicateTarget = useCallback(
    async (
      task: TransferTask,
      targetPane: SftpPane,
      targetSftpId: string | null,
      targetEncoding: SftpFilenameEncoding,
    ) => {
      const parentPath = getParentPath(task.targetPath);
      const { baseName, ext } = splitNameForDuplicate(task.fileName, task.isDirectory);

      for (let index = 1; index < 1000; index++) {
        const suffix = index === 1 ? " (copy)" : ` (copy ${index})`;
        const fileName = `${baseName}${suffix}${ext}`;
        const targetPath = joinPath(parentPath, fileName);
        try {
          const existing = await statTargetPath(targetPane, targetSftpId, targetPath, targetEncoding);
          if (!existing) return { fileName, targetPath };
        } catch {
          return { fileName, targetPath };
        }
      }

      const fallbackName = `${baseName} (copy ${Date.now()})${ext}`;
      return { fileName: fallbackName, targetPath: joinPath(parentPath, fallbackName) };
    },
    [splitNameForDuplicate, statTargetPath],
  );

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
    [],
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
  }, []);

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
    [cancelBackendTransfers, completeCancelledTask],
  );

  const deleteTargetPath = useCallback(
    async (
      task: TransferTask,
      targetPane: SftpPane,
      targetSftpId: string | null,
      targetEncoding: SftpFilenameEncoding,
    ) => {
      if (!targetPane.connection) return;
      if (targetPane.connection.isLocal) {
        const deleteLocalFile = netcattyBridge.get()?.deleteLocalFile;
        if (!deleteLocalFile) throw new Error("Local delete unavailable");
        await deleteLocalFile(task.targetPath);
        return;
      }
      if (!targetSftpId) throw new Error("Target SFTP session not found");
      const deleteSftp = netcattyBridge.get()?.deleteSftp;
      if (!deleteSftp) throw new Error("SFTP delete unavailable");
      await deleteSftp(targetSftpId, task.targetPath, targetEncoding);
    },
    [],
  );

  const getEntrySize = useCallback((entry: SftpFileEntry): number => {
    if (typeof entry.size === "string") {
      const parsed = parseInt(entry.size, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }
    return typeof entry.size === "number" && entry.size > 0 ? entry.size : 0;
  }, []);

  const MAX_SYMLINK_DEPTH = 32;

  const estimateDirectoryBytes = useCallback(
    async (
      sourcePath: string,
      sourceSftpId: string | null,
      sourceIsLocal: boolean,
      sourceEncoding: SftpFilenameEncoding,
      rootTaskId: string,
      symlinkDepth = 0,
      followSymlinks = false,
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
      const subdirs: { entry: SftpFileEntry; nextDepth: number }[] = [];

      for (const file of files) {
        if (file.name === ".." || file.name === ".") continue;

        if (file.type === "directory") {
          subdirs.push({ entry: file, nextDepth: symlinkDepth });
        } else if (followSymlinks && file.type === "symlink" && file.linkTarget === "directory") {
          if (symlinkDepth < MAX_SYMLINK_DEPTH) {
            subdirs.push({ entry: file, nextDepth: symlinkDepth + 1 });
          }
          // Skip at max depth — consistent with transferDirectory
        } else {
          totalBytes += getEntrySize(file);
        }
      }

      if (subdirs.length > 0) {
        if (cancelledTasksRef.current.has(rootTaskId)) {
          throw new Error("Transfer cancelled");
        }

        const subResults = await Promise.all(
          subdirs.map(({ entry: subdir, nextDepth }) =>
            estimateDirectoryBytes(
              joinPath(sourcePath, subdir.name),
              sourceSftpId,
              sourceIsLocal,
              sourceEncoding,
              rootTaskId,
              nextDepth,
              followSymlinks,
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
    sameHost?: boolean,
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
        sameHost: sameHost || undefined,
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

  const getTransferConcurrency = () => {
    const stored = localStorageAdapter.readNumber(STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY);
    return stored != null && stored >= 1 && stored <= 16 ? stored : 4;
  };

  /** Recursively count all files under a directory (for progress display). */
  const countDirectoryFiles = async (
    sourcePath: string,
    sourceSftpId: string | null,
    sourceIsLocal: boolean,
    sourceEncoding: SftpFilenameEncoding,
    rootTaskId: string,
    symlinkDepth = 0,
    followSymlinks = false,
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
      if (file.name === ".." || file.name === ".") continue;
      if (file.type === "directory") {
        subdirPromises.push(
          countDirectoryFiles(joinPath(sourcePath, file.name), sourceSftpId, sourceIsLocal, sourceEncoding, rootTaskId, symlinkDepth, followSymlinks),
        );
      } else if (followSymlinks && file.type === "symlink" && file.linkTarget === "directory") {
        // Only recurse if within depth limit; skip entirely at max depth
        // (consistent with transferDirectory which also skips these)
        if (symlinkDepth < MAX_SYMLINK_DEPTH) {
          subdirPromises.push(
            countDirectoryFiles(joinPath(sourcePath, file.name), sourceSftpId, sourceIsLocal, sourceEncoding, rootTaskId, symlinkDepth + 1, followSymlinks),
          );
        }
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

  /** Returns number of failed child file transfers */
  const transferDirectory = async (
    task: TransferTask,
    sourceSftpId: string | null,
    targetSftpId: string | null,
    sourceIsLocal: boolean,
    targetIsLocal: boolean,
    sourceEncoding: SftpFilenameEncoding,
    targetEncoding: SftpFilenameEncoding,
    rootTaskId: string, // The original top-level task ID for cancellation checking
    sameHost?: boolean,
    symlinkDepth = 0,
    followSymlinks = false, // Only true for downloadToLocal — uploads/copies treat symlinks as files
  ) => {
    // Check if task or root task was cancelled before starting
    if (cancelledTasksRef.current.has(task.id) || cancelledTasksRef.current.has(rootTaskId)) {
      throw new Error("Transfer cancelled");
    }

    let totalErrors = 0;

    if (targetIsLocal) {
      try {
        await netcattyBridge.get()?.mkdirLocal?.(task.targetPath);
      } catch (mkdirErr: unknown) {
        const isEEXIST = mkdirErr instanceof Error && mkdirErr.message.includes("EEXIST");
        if (!isEEXIST) throw mkdirErr;
        // EEXIST: verify the existing path is actually a directory, not a file
        const stat = await netcattyBridge.get()?.statLocal?.(task.targetPath);
        if (stat && stat.type !== 'directory') {
          throw new Error(`Target path exists as a file: ${task.targetPath}`);
        }
      }
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

    // Filter both "." and ".." — some SFTP servers include "." in readdir
    const filtered = files.filter((f) => f.name !== ".." && f.name !== ".");
    // Separate directories from files.
    // Symlink directories are only followed when followSymlinks is true
    // (downloadToLocal). Uploads/copies treat symlinks as regular entries
    // to preserve existing behavior and avoid expanding symlinked trees.
    const dirs: SftpFileEntry[] = [];
    const regularFiles: SftpFileEntry[] = [];
    for (const f of filtered) {
      if (f.type === "directory") {
        dirs.push(f);
      } else if (followSymlinks && f.type === "symlink" && f.linkTarget === "directory") {
        if (symlinkDepth < MAX_SYMLINK_DEPTH) {
          dirs.push(f);
        } else {
          // Count as an error so the parent task is marked failed
          totalErrors++;
          logger.warn(`[SFTP] Skipping symlink directory at max depth: ${joinPath(task.sourcePath, f.name)}`);
        }
      } else {
        regularFiles.push(f);
      }
    }

    // Process subdirectories sequentially to avoid unbounded concurrent SFTP
    // requests from nested Promise.all + worker pools across the tree.
    // File-level concurrency within each directory is still governed by
    // getTransferConcurrency().
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

      const isSymlink = dir.type === "symlink";
      const subdirErrors = await transferDirectory(
        childTask,
        sourceSftpId,
        targetSftpId,
        sourceIsLocal,
        targetIsLocal,
        sourceEncoding,
        targetEncoding,
        rootTaskId,
        sameHost,
        isSymlink ? symlinkDepth + 1 : symlinkDepth,
        followSymlinks,
      );
      totalErrors += subdirErrors;
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

          // Track child ID outside React state for immediate cancellation visibility
          if (!activeChildIdsRef.current.has(rootTaskId)) {
            activeChildIdsRef.current.set(rootTaskId, new Set());
          }
          activeChildIdsRef.current.get(rootTaskId)!.add(fileId);

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
            // Inherit retryable from parent — downloadToLocal sets retryable: false
            // because "local" targetConnectionId can't be resolved by retryTransfer
            retryable: task.retryable,
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
              sameHost,
            );

            activeChildIdsRef.current.get(rootTaskId)?.delete(fileId);
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
            activeChildIdsRef.current.get(rootTaskId)?.delete(fileId);
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

      const concurrency = getTransferConcurrency();
      const workers = Array.from(
        { length: Math.min(concurrency, regularFiles.length) },
        () => worker(),
      );
      await Promise.all(workers);

      totalErrors += errors.length;
      if (errors.length > 0) {
        logger.debug?.("[SFTP] Some files in directory transfer failed", errors);
      }
    }

    return totalErrors;
  };

  const processTransfer = async (
    task: TransferTask,
    sourcePane: SftpPane,
    targetPane: SftpPane,
    targetSide: "left" | "right",
  ): Promise<TransferStatus> => {
    if (cancelledTasksRef.current.has(task.id)) {
      return "cancelled";
    }

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

    // Detect same-host: both sides connected to the same remote endpoint.
    // Use per-connection cache keys (hostname+port+protocol+sudo+username) instead of
    // just hostId, because the same hostId can have different session-time overrides.
    const sourceCacheKey = sourcePane.connection?.id
      ? connectionCacheKeyMapRef.current.get(sourcePane.connection.id)
      : undefined;
    const targetCacheKey = targetPane.connection?.id
      ? connectionCacheKeyMapRef.current.get(targetPane.connection.id)
      : undefined;
    const sameHost = !!(
      sourceSftpId && targetSftpId &&
      !sourcePane.connection?.isLocal && !targetPane.connection?.isLocal &&
      sourceCacheKey && targetCacheKey &&
      sourceCacheKey === targetCacheKey
    );

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
        if (task.skipConflictCheck || !targetPane.connection) return null;

        const sourceStat: { size: number; mtime: number } | null =
          (task.totalBytes > 0 || task.sourceLastModified)
            ? { size: task.totalBytes, mtime: task.sourceLastModified || Date.now() }
            : null;

        try {
          const existingStat = await statTargetPath(targetPane, targetSftpId, task.targetPath, targetEncoding);

          if (existingStat) {
            return {
              transferId: task.id,
              batchId: task.batchId,
              fileName: task.fileName,
              sourcePath: task.sourcePath,
              targetPath: task.targetPath,
              isDirectory: task.isDirectory,
              existingType: existingStat.type,
              applyToAllCount: task.batchId
                ? transfersRef.current.filter((candidate) =>
                    candidate.batchId === task.batchId &&
                    candidate.isDirectory === task.isDirectory &&
                    !candidate.parentTaskId &&
                    candidate.status !== "completed" &&
                    candidate.status !== "cancelled",
                  ).length
                : 1,
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
        const defaultAction = conflictDefaultsRef.current.get(conflictDefaultKey(task.batchId, task.isDirectory));
        if (defaultAction) {
          if (defaultAction === "stop") {
            await markBatchStopped(task);
            return "cancelled";
          }

          if (defaultAction === "skip") {
            cancelledTasksRef.current.add(task.id);
            updateTask({ status: "cancelled", endTime: Date.now() });
            await completeCancelledTask(task);
            return "cancelled";
          }

          const duplicateTarget = defaultAction === "duplicate"
            ? await getDuplicateTarget(task, targetPane, targetSftpId, targetEncoding)
            : null;
          const updatedTask: TransferTask = {
            ...task,
            ...(duplicateTarget
              ? {
                  fileName: duplicateTarget.fileName,
                  targetPath: duplicateTarget.targetPath,
                }
              : null),
            skipConflictCheck: true,
            replaceExistingTarget: defaultAction === "replace",
          };
          setTransfers((prev) =>
            prev.map((t) =>
              t.id === task.id
                ? { ...updatedTask, status: "pending" as TransferStatus }
                : t,
            ),
          );
          return processTransfer(updatedTask, sourcePane, targetPane, targetSide);
        }

        setConflicts((prev) => [...prev, conflict]);
        updateTask({
          status: "pending",
          totalBytes: conflict.newSize || task.totalBytes || 0,
        });
        return "pending";
      }

      logger.debug(`[SFTP:perf] starting actual transfer — file=${task.fileName} isDir=${task.isDirectory} — ${(performance.now() - t0).toFixed(0)}ms since start`);

      let dirPartialFailure = false;

      if (task.replaceExistingTarget) {
        await deleteTargetPath(task, targetPane, targetSftpId, targetEncoding);
      }

      // Same-host exec-based paths are only safe for UTF-8 compatible encodings.
      // "auto" is allowed here — the backend resolves it to the actual encoding
      // and skips exec if it resolved to non-UTF-8 (e.g. gb18030).
      const encodingSafeForExec =
        (!sourceEncoding || sourceEncoding === "utf-8" || sourceEncoding === "auto") &&
        (!targetEncoding || targetEncoding === "utf-8" || targetEncoding === "auto");

      // Try same-host directory optimization first; falls back to recursive transfer
      // if remote cp is unavailable (e.g. Windows SSH servers).
      let dirHandledBySameHost = false;
      if (task.isDirectory && sameHost && encodingSafeForExec && sourceSftpId) {
        if (cancelledTasksRef.current.has(task.id)) {
          throw new Error("Transfer cancelled");
        }
        const result = await netcattyBridge.require().sameHostCopyDirectory!(
          sourceSftpId,
          task.sourcePath,
          task.targetPath,
          sourceEncoding,
          task.id,
        );
        if (cancelledTasksRef.current.has(task.id)) {
          throw new Error("Transfer cancelled");
        }
        dirHandledBySameHost = result.success;
      }

      if (task.isDirectory && !dirHandledBySameHost) {
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

        const dirErrors = await transferDirectory(
          task,
          sourceSftpId,
          targetSftpId,
          sourcePane.connection!.isLocal,
          targetPane.connection!.isLocal,
          sourceEncoding,
          targetEncoding,
          task.id, // rootTaskId - this is the top-level task
          sameHost,
        );

        if (dirErrors > 0) {
          dirPartialFailure = true;
        }
      } else if (!task.isDirectory) {
        await transferFile(
          task,
          sourceSftpId,
          targetSftpId,
          sourcePane.connection!.isLocal,
          targetPane.connection!.isLocal,
          sourceEncoding,
          targetEncoding,
          task.id, // rootTaskId - this is the top-level task
          sameHost,
        );
      }

      if (cancelledTasksRef.current.has(task.id)) {
        throw new Error("Transfer cancelled");
      }

      const finalStatus: TransferStatus = dirPartialFailure ? "failed" : "completed";
      setTransfers((prev) => {
        return prev.map((t) => {
          if (t.id !== task.id) return t;
          return {
            ...t,
            status: finalStatus,
            error: dirPartialFailure ? "Some files failed to transfer" : undefined,
            // Disable retry for partial failures — retrying replays the entire
            // directory without conflict checks, overwriting already-copied files
            retryable: dirPartialFailure ? false : t.retryable,
            endTime: Date.now(),
            transferredBytes: dirPartialFailure ? t.transferredBytes : t.totalBytes,
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
      // Clean up tracked child IDs for this transfer
      activeChildIdsRef.current.delete(task.id);

      const completionHandler = completionHandlersRef.current.get(task.id);
      if (completionHandler) {
        try {
          await completionHandler({
            id: task.id,
            fileName: task.fileName,
            originalFileName: task.originalFileName ?? task.fileName,
            status: finalStatus,
          });
        } finally {
          completionHandlersRef.current.delete(task.id);
        }
      }
      return finalStatus;
    } catch (err) {
      activeChildIdsRef.current.delete(task.id);
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
      const batchId = crypto.randomUUID();

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
          batchId,
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

      await cancelBackendTransfers([transferId]);

    },
    [cancelBackendTransfers],
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
    async (conflictId: string, action: FileConflictAction, applyToAll = false) => {
      const conflict = conflictsRef.current.find((c) => c.transferId === conflictId);
      if (!conflict) return;

      const task = transfersRef.current.find((t) => t.id === conflictId);
      if (!task) {
        setConflicts((prev) => prev.filter((c) => c.transferId !== conflictId));
        return;
      }

      const selectedConflictKey = conflictDefaultKey(task.batchId, task.isDirectory);
      const affectedConflicts = applyToAll
        ? conflictsRef.current.filter((candidate) =>
            conflictDefaultKey(candidate.batchId, candidate.isDirectory) === selectedConflictKey,
          )
        : [conflict];
      const affectedConflictIds = new Set(affectedConflicts.map((candidate) => candidate.transferId));
      const affectedTasks = affectedConflicts
        .map((candidate) => transfersRef.current.find((transfer) => transfer.id === candidate.transferId))
        .filter((candidate): candidate is TransferTask => Boolean(candidate));

      if (applyToAll) {
        conflictDefaultsRef.current.set(selectedConflictKey, action);
      }

      setConflicts((prev) => prev.filter((c) => !affectedConflictIds.has(c.transferId)));

      if (affectedTasks.length === 0) {
        return;
      }

      if (action === "stop") {
        await markBatchStopped(task);
        return;
      }

      if (action === "skip") {
        for (const affectedTask of affectedTasks) {
          cancelledTasksRef.current.add(affectedTask.id);
        }
        setTransfers((prev) =>
          prev.map((t) => affectedConflictIds.has(t.id)
              ? { ...t, status: "cancelled" as TransferStatus, endTime: Date.now() }
              : t,
          ),
        );
        for (const affectedTask of affectedTasks) {
          await completeCancelledTask(affectedTask);
        }
        return;
      }

      const updatedTasks: TransferTask[] = [];

      for (const affectedTask of affectedTasks) {
        let updatedTask = { ...affectedTask };

        if (action === "duplicate") {
          const endpoints = resolveTaskEndpoints(affectedTask);
          if (!endpoints) continue;
          const targetSftpId = endpoints.targetPane.connection?.isLocal
            ? null
            : sftpSessionsRef.current.get(endpoints.targetPane.connection!.id) ?? null;
          const targetEncoding = endpoints.targetPane.connection?.isLocal
            ? "auto"
            : endpoints.targetPane.filenameEncoding || "auto";
          const duplicateTarget = await getDuplicateTarget(affectedTask, endpoints.targetPane, targetSftpId, targetEncoding);
          updatedTask = {
            ...affectedTask,
            fileName: duplicateTarget.fileName,
            targetPath: duplicateTarget.targetPath,
            skipConflictCheck: true,
          };
        } else if (action === "replace") {
          updatedTask = {
            ...affectedTask,
            skipConflictCheck: true,
            replaceExistingTarget: true,
          };
        } else if (action === "merge") {
          updatedTask = {
            ...affectedTask,
            skipConflictCheck: true,
            replaceExistingTarget: false,
          };
        }

        updatedTasks.push(updatedTask);
      }

      const updatedTaskMap = new Map(updatedTasks.map((updatedTask) => [updatedTask.id, updatedTask]));
      setTransfers((prev) =>
        prev.map((t) => {
          const updatedTask = updatedTaskMap.get(t.id);
          return updatedTask
            ? { ...updatedTask, status: "pending" as TransferStatus }
            : t;
        }),
      );

      for (const updatedTask of updatedTasks) {
        setTimeout(async () => {
          const endpoints = resolveTaskEndpoints(updatedTask);
          if (!endpoints) return;
          await processTransfer(updatedTask, endpoints.sourcePane, endpoints.targetPane, endpoints.targetSide);
        }, 100);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- processTransfer is defined inline; transfers/conflicts accessed via refs
    [
      completeCancelledTask,
      conflictDefaultKey,
      getDuplicateTarget,
      markBatchStopped,
      resolveTaskEndpoints,
      sftpSessionsRef,
    ],
  );

  const activeTransfersCount = useMemo(() => transfers.filter(
    (t) => (t.status === "pending" || t.status === "transferring") && !t.parentTaskId,
  ).length, [transfers]);

  const downloadToLocal = useCallback(
    async (params: {
      fileName: string;
      sourcePath: string;
      targetPath: string;
      sftpId: string;
      connectionId: string;
      sourceEncoding?: SftpFilenameEncoding;
      isDirectory: boolean;
      totalBytes?: number;
    }): Promise<TransferStatus> => {
      const task: TransferTask = {
        id: crypto.randomUUID(),
        fileName: params.fileName,
        originalFileName: params.fileName,
        sourcePath: params.sourcePath,
        targetPath: params.targetPath,
        sourceConnectionId: params.connectionId,
        targetConnectionId: "local",
        direction: "download",
        status: "transferring",
        totalBytes: params.totalBytes ?? 0,
        transferredBytes: 0,
        speed: 0,
        startTime: Date.now(),
        isDirectory: params.isDirectory,
        progressMode: params.isDirectory ? "files" : "bytes",
        retryable: false,
      };

      setTransfers((prev) => [...prev, task]);

      const sourceEncoding = params.sourceEncoding ?? "auto";
      // Mutable counter to track child failures outside React state,
      // so the final status check doesn't depend on render timing.
      let childFailureCount = 0;

      try {
        if (params.isDirectory) {
          // Count files for progress display
          void countDirectoryFiles(
            params.sourcePath,
            params.sftpId,
            false,
            sourceEncoding,
            task.id,
            0,     // symlinkDepth
            true,  // followSymlinks
          ).then((fileCount) => {
            if (!cancelledTasksRef.current.has(task.id)) {
              setTransfers((prev) =>
                prev.map((t) => (t.id === task.id ? { ...t, totalBytes: fileCount } : t)),
              );
            }
          }).catch(() => {});

          childFailureCount = await transferDirectory(
            task,
            params.sftpId,
            null,       // targetSftpId = null (local)
            false,       // sourceIsLocal = false
            true,        // targetIsLocal = true
            sourceEncoding,
            "auto",      // targetEncoding
            task.id,
            false,       // sameHost
            0,           // symlinkDepth
            true,        // followSymlinks — download should expand symlink dirs
          );
        } else {
          await transferFile(
            task,
            params.sftpId,
            null,
            false,
            true,
            sourceEncoding,
            "auto",
            task.id,
          );
        }

        // Use childFailureCount (tracked outside React state) to determine
        // final status reliably, regardless of render timing.
        const hasFailures = childFailureCount > 0;
        const finalStatus: TransferStatus = hasFailures ? "failed" : "completed";
        setTransfers((prev) => {
          const completedCount = prev.filter(
            (t) => t.parentTaskId === task.id && t.status === "completed",
          ).length;
          return prev.map((t) => {
            if (t.id !== task.id) return t;
            const finalTotal = t.totalBytes > 0 ? t.totalBytes : completedCount;
            return {
              ...t,
              status: finalStatus,
              error: hasFailures ? "Some files failed to transfer" : undefined,
              endTime: Date.now(),
              totalBytes: finalTotal,
              transferredBytes: hasFailures ? completedCount : finalTotal,
            };
          });
        });
        activeChildIdsRef.current.delete(task.id);
        return finalStatus;
      } catch (err) {
        activeChildIdsRef.current.delete(task.id);
        const isCancelled = cancelledTasksRef.current.has(task.id);
        // Clean up cancelled task tracking to prevent memory leak
        if (isCancelled) cancelledTasksRef.current.delete(task.id);
        const errMsg = err instanceof Error ? err.message : String(err);
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === task.id
              ? {
                  ...t,
                  status: isCancelled ? ("cancelled" as TransferStatus) : ("failed" as TransferStatus),
                  error: isCancelled ? undefined : errMsg,
                  endTime: Date.now(),
                }
              : t,
          ),
        );
        return isCancelled ? "cancelled" : "failed";
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sftpSessionsRef],
  );

  return {
    transfers,
    conflicts,
    activeTransfersCount,
    startTransfer,
    downloadToLocal,
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
