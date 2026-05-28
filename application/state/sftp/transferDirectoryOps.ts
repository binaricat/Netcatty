import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { SftpFileEntry, SftpFilenameEncoding, TransferStatus, TransferTask } from "../../../domain/models";
import { STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY } from "../../../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { logger } from "../../../lib/logger";
import { joinPath } from "./utils";

interface UseSftpDirectoryTransferOpsParams {
  cancelledTasksRef: MutableRefObject<Set<string>>;
  activeChildIdsRef: MutableRefObject<Map<string, Set<string>>>;
  setTransfers: Dispatch<SetStateAction<TransferTask[]>>;
  listLocalFiles: (path: string) => Promise<SftpFileEntry[]>;
  listRemoteFiles: (sftpId: string, path: string, encoding?: SftpFilenameEncoding) => Promise<SftpFileEntry[]>;
}

export function useSftpDirectoryTransferOps({
  cancelledTasksRef,
  activeChildIdsRef,
  setTransfers,
  listLocalFiles,
  listRemoteFiles,
}: UseSftpDirectoryTransferOpsParams) {
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
    [cancelledTasksRef, getEntrySize, listLocalFiles, listRemoteFiles],
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


  return { estimateDirectoryBytes, transferFile, countDirectoryFiles, transferDirectory };
}
