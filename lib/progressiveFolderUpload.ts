/**
 * Progressive local-folder upload: stream discovery batches from listLocalTree
 * and upload files as they arrive (edge-scan / edge-transfer).
 */

import type { DropEntry } from "./sftpFileUtils";
import { localTreeToDropEntries, type LocalTreeListEntry } from "./sftpFileUtils";
import type { UploadBridge, UploadCallbacks, UploadResult } from "./uploadService.types";
import type { UploadController } from "./uploadController";
import {
  canReplaceSftpConflict,
  describeSftpExistingKind,
  describeSftpIncomingKind,
  getSftpConflictTypeKey,
} from "../domain/sftpConflict";
import {
  DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY,
  resolveSftpTransferConcurrency,
} from "../domain/sftpTransferConcurrency";
import { isMissingStatError } from "../domain/sftpStatError";

const formatUploadError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Keep progressive worker admission aligned with the user-visible transfer limit. */
export const DEFAULT_PROGRESSIVE_FOLDER_UPLOAD_CONCURRENCY = DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY;

export const resolveProgressiveFolderUploadConcurrency = (
  savedValue: number | null | undefined,
): number => resolveSftpTransferConcurrency(() => savedValue);
/** Pause discovery when the upload queue grows this large (memory backpressure). */
const QUEUE_HIGH_WATER = 2_000;
/** Resume discovery once the queue drains to this size. */
const QUEUE_LOW_WATER = 500;

export type ProgressiveLocalRoot = {
  name: string;
  localPath: string;
};

export type ListLocalTreeStreaming = (
  path: string,
  options: {
    onProgress?: (progress: { fileCount: number; directoryCount: number; entryCount: number }) => void;
    onEntries?: (entries: LocalTreeListEntry[]) => void;
    abortSignal?: AbortSignal;
  },
) => Promise<LocalTreeListEntry[]>;

export type ProgressiveConflictAction = "stop" | "skip" | "replace" | "duplicate" | "merge";

export type ProgressiveFolderUploadConfig = {
  targetPath: string;
  sftpId: string | null;
  targetHostId?: string;
  /** Maximum number of file transfers this upload may start at once. */
  fileTransferConcurrency?: number;
  isLocal: boolean;
  bridge: UploadBridge;
  joinPath: (base: string, name: string) => string;
  callbacks?: UploadCallbacks;
  listLocalTree: ListLocalTreeStreaming;
  /** Optional pre-created parent task ids (e.g. scanning task id for single root). */
  parentTaskIds?: Map<string, string>;
  abortSignal?: AbortSignal;
  /**
   * Soft-pause gate (process-global latch). Must resolve only after the parent
   * folder is resumed. Used before discovery enqueue and before creating child
   * UI rows so Pause does not keep filling the transfer queue.
   */
  waitWhilePaused?: (parentTaskId: string) => Promise<void>;
  /** Sync probe so multi-root queues can skip latched parents (no HOL block). */
  isPaused?: (parentTaskId: string) => boolean;
  /**
   * Root-level conflict dialog (same contract as uploadEntries). Progressive
   * path must not overwrite existing remote folders without confirmation.
   */
  resolveConflict?: (conflict: {
    fileName: string;
    targetPath: string;
    isDirectory: boolean;
    existingType?: "file" | "directory" | "symlink";
    existingSize: number;
    newSize: number;
    existingModified: number;
    newModified: number;
    applyToAllCount: number;
  }) => Promise<ProgressiveConflictAction>;
};

function entryToDrop(entry: LocalTreeListEntry): DropEntry {
  return localTreeToDropEntries([entry])[0];
}

/**
 * Walk each local root with streaming batches and upload files concurrently
 * while discovery continues.
 */
export async function uploadLocalFoldersProgressively(
  roots: ProgressiveLocalRoot[],
  config: ProgressiveFolderUploadConfig,
  controller?: UploadController,
): Promise<UploadResult[]> {
  const {
    targetPath,
    sftpId,
    targetHostId,
    fileTransferConcurrency,
    isLocal,
    bridge,
    joinPath,
    callbacks,
    listLocalTree,
    parentTaskIds,
    abortSignal,
    waitWhilePaused,
    isPaused,
    resolveConflict,
  } = config;

  if (roots.length === 0) return [];
  if (!isLocal && !sftpId) {
    throw new Error("No SFTP session for progressive folder upload");
  }

  const isStopped = () => !!(controller?.isCancelled() || abortSignal?.aborted);

  /** Block while the folder soft-pause latch is held; re-check cancel after wake. */
  const awaitUnpaused = async (parentTaskId: string): Promise<boolean> => {
    if (!waitWhilePaused) return !isStopped();
    while (!isStopped()) {
      await waitWhilePaused(parentTaskId);
      // waitWhilePaused may resolve spuriously if the latch was already free;
      // always re-check stop intent after any await.
      if (isStopped()) return false;
      return true;
    }
    return false;
  };

  const results: UploadResult[] = [];
  const createdDirs = new Set<string>();
  const failedDirs = new Map<string, string>();
  const parentIds = new Map<string, string>();
  const parentStats = new Map<string, {
    discovered: number;
    completed: number;
    failed: number;
    dirFailures: number;
  }>();
  /** Source root name -> destination root segment after conflict resolution. */
  const destRootNameBySource = new Map<string, string>();

  const statTarget = async (path: string) => {
    try {
      // Prefer no-follow lstat so Replace cannot write through a symlink.
      if (isLocal) return await (bridge.lstatLocal ?? bridge.statLocal)?.(path) ?? null;
      if (sftpId) return await (bridge.lstatSftp ?? bridge.statSftp)?.(sftpId, path) ?? null;
    } catch (error) {
      if (isMissingStatError(error)) return null;
      // Unknown target state must fail closed rather than bypass conflict handling.
      throw error;
    }
    return null;
  };

  const deleteTarget = async (
    path: string,
    expectedType?: "file" | "directory" | "symlink",
  ) => {
    if (isLocal) await bridge.deleteLocalFile?.(path, expectedType);
    else if (sftpId) await bridge.deleteSftp?.(sftpId, path, expectedType);
  };

  const getDuplicateName = async (name: string) => {
    for (let index = 1; index < 1000; index++) {
      const suffix = index === 1 ? " (copy)" : ` (copy ${index})`;
      const candidate = `${name}${suffix}`;
      const existing = await statTarget(joinPath(targetPath, candidate));
      if (!existing) return candidate;
    }
    return `${name} (copy ${Date.now()})`;
  };

  // Root-level conflict preflight — match uploadEntries so progressive drops
  // cannot overwrite remote content without Skip/Replace/Duplicate/Merge.
  let activeRoots = [...roots];
  if (resolveConflict) {
    const existingByRoot = await Promise.all(activeRoots.map(async (root) => ({
      root,
      existing: await statTarget(joinPath(targetPath, root.name)),
    })));
    const conflictCounts = new Map<string, number>();
    for (const { existing } of existingByRoot) {
      if (!existing) continue;
      const key = getSftpConflictTypeKey(true, existing.type);
      conflictCounts.set(key, (conflictCounts.get(key) ?? 0) + 1);
    }

    const kept: ProgressiveLocalRoot[] = [];
    for (const { root, existing } of existingByRoot) {
      if (isStopped()) break;
      if (!existing) {
        destRootNameBySource.set(root.name, root.name);
        kept.push(root);
        continue;
      }
      const conflictKey = getSftpConflictTypeKey(true, existing.type);
      const action = await resolveConflict({
        fileName: root.name,
        targetPath: joinPath(targetPath, root.name),
        isDirectory: true,
        existingType: existing.type,
        existingSize: existing.size,
        // Progressive has not walked yet; byte total is unknown.
        newSize: 0,
        existingModified: existing.lastModified,
        newModified: Date.now(),
        applyToAllCount: conflictCounts.get(conflictKey) ?? 1,
      });

      if (action === "stop") {
        await controller?.cancel();
        return [{ fileName: root.name, success: false, cancelled: true }, ...results];
      }
      if (action === "skip") {
        results.push({ fileName: root.name, success: false, cancelled: true });
        const scanningId = parentTaskIds?.get(root.name);
        if (scanningId) callbacks?.onTaskCancelled?.(scanningId);
        continue;
      }
      if (action === "replace") {
        if (!canReplaceSftpConflict(true, existing.type)) {
          results.push({
            fileName: root.name,
            success: false,
            error: `Cannot replace existing ${describeSftpExistingKind(existing.type)} with ${describeSftpIncomingKind(true)}: ${joinPath(targetPath, root.name)}`,
          });
          const scanningId = parentTaskIds?.get(root.name);
          if (scanningId) {
            callbacks?.onTaskFailed?.(
              scanningId,
              `Cannot replace existing ${describeSftpExistingKind(existing.type)}`,
            );
          }
          continue;
        }
        await deleteTarget(joinPath(targetPath, root.name), existing.type);
        destRootNameBySource.set(root.name, root.name);
        kept.push(root);
        continue;
      }
      if (action === "duplicate") {
        const duplicateName = await getDuplicateName(root.name);
        destRootNameBySource.set(root.name, duplicateName);
        kept.push(root);
        continue;
      }
      if (action === "merge" && !(existing.type === "directory")) {
        results.push({
          fileName: root.name,
          success: false,
          error: `Cannot merge existing ${describeSftpExistingKind(existing.type)} with ${describeSftpIncomingKind(true)}: ${joinPath(targetPath, root.name)}`,
        });
        const scanningId = parentTaskIds?.get(root.name);
        if (scanningId) {
          callbacks?.onTaskFailed?.(scanningId, `Cannot merge existing ${describeSftpExistingKind(existing.type)}`);
        }
        continue;
      }
      destRootNameBySource.set(root.name, root.name);
      kept.push(root);
    }
    activeRoots = kept;
  } else {
    for (const root of activeRoots) destRootNameBySource.set(root.name, root.name);
  }

  if (activeRoots.length === 0) return results;

  for (const root of activeRoots) {
    const id = parentTaskIds?.get(root.name) ?? crypto.randomUUID();
    parentIds.set(root.name, id);
    parentStats.set(id, { discovered: 0, completed: 0, failed: 0, dirFailures: 0 });
    const destName = destRootNameBySource.get(root.name) ?? root.name;
    // Skip create if caller already opened a scanning row with this id.
    if (!parentTaskIds?.has(root.name)) {
      callbacks?.onTaskCreated?.({
        id,
        fileName: destName,
        displayName: destName,
        isDirectory: true,
        progressMode: "files",
        totalBytes: 0,
        transferredBytes: 0,
        speed: 0,
        fileCount: 0,
        completedCount: 0,
        sourcePath: root.localPath,
      });
    } else {
      // Promote scanning row into live file-count progress.
      callbacks?.onTaskProgress?.(id, {
        transferred: 0,
        total: 0,
        speed: 0,
        percent: 0,
        phase: "scanning",
      });
    }
  }

  const ensureDirectory = async (dirPath: string): Promise<void> => {
    if (createdDirs.has(dirPath)) return;
    if (failedDirs.has(dirPath)) {
      throw new Error(failedDirs.get(dirPath) || "Directory creation failed");
    }
    try {
      if (isLocal) {
        await bridge.mkdirLocal?.(dirPath);
      } else if (sftpId) {
        await bridge.mkdirSftp(sftpId, dirPath);
      }
      createdDirs.add(dirPath);
    } catch (error) {
      const message = formatUploadError(error);
      // Concurrent workers / merge into existing remote dirs race here.
      if (/exist|EEXIST|file exists|already/i.test(message)) {
        createdDirs.add(dirPath);
        return;
      }
      failedDirs.set(dirPath, message);
      throw error;
    }
  };

  const remapRelativePath = (sourceRootName: string, relativePath: string): string => {
    const dest = destRootNameBySource.get(sourceRootName) ?? sourceRootName;
    if (dest === sourceRootName) return relativePath;
    if (relativePath === sourceRootName) return dest;
    if (relativePath.startsWith(`${sourceRootName}/`)) {
      return `${dest}/${relativePath.slice(sourceRootName.length + 1)}`;
    }
    return relativePath;
  };

  const ensureParentsForFile = async (relativePath: string): Promise<void> => {
    const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length <= 1) return;
    let cursor = targetPath;
    for (let i = 0; i < parts.length - 1; i++) {
      cursor = joinPath(cursor, parts[i]);
      await ensureDirectory(cursor);
    }
  };

  type FileJob = { entry: DropEntry; parentId: string; rootName: string };
  const fileQueue: FileJob[] = [];
  let scanDone = false;
  /** In-flight onEntries handlers (may await soft-pause before queueing). */
  let pendingEnqueues = 0;
  let scanError: unknown;
  let wakeWaiters: Array<() => void> = [];
  const wake = () => {
    const waiters = wakeWaiters;
    wakeWaiters = [];
    for (const resolve of waiters) resolve();
  };
  const waitForWork = () => new Promise<void>((resolve) => {
    wakeWaiters.push(resolve);
  });
  const discoverySettled = () => scanDone && pendingEnqueues === 0;

  // Multiple enqueueBatch handlers can park on backpressure at once. A single
  // resolver would orphan older waiters and leave pendingEnqueues stuck forever.
  let pauseScanWaiters: Array<() => void> = [];
  const waitIfQueueHigh = async () => {
    while (fileQueue.length >= QUEUE_HIGH_WATER && !isStopped()) {
      await new Promise<void>((resolve) => {
        pauseScanWaiters.push(resolve);
      });
    }
  };
  const maybeResumeScan = () => {
    if (fileQueue.length > QUEUE_LOW_WATER || pauseScanWaiters.length === 0) return;
    const waiters = pauseScanWaiters;
    pauseScanWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const publishParentProgress = (parentId: string, phase?: "scanning" | "transferring") => {
    const stats = parentStats.get(parentId);
    if (!stats) return;
    const total = Math.max(stats.discovered, stats.completed);
    callbacks?.onTaskProgress?.(parentId, {
      transferred: stats.completed,
      total,
      speed: 0,
      percent: total > 0 ? (stats.completed / total) * 100 : 0,
      phase: phase ?? (stats.completed > 0 ? "transferring" : "scanning"),
    });
  };

  const enqueueBatch = async (rootName: string, batch: LocalTreeListEntry[]) => {
    pendingEnqueues += 1;
    try {
      if (isStopped()) {
        fileQueue.length = 0;
        return;
      }
      const parentId = parentIds.get(rootName);
      if (!parentId) return;
      const stats = parentStats.get(parentId);
      if (!stats) return;

      // Soft-pause: do not grow the work queue or create remote dirs until resume.
      // Otherwise Pause still looks "alive" as hundreds of pending children appear.
      if (!(await awaitUnpaused(parentId))) {
        fileQueue.length = 0;
        return;
      }

      for (const row of batch) {
        if (isStopped()) {
          fileQueue.length = 0;
          return;
        }
        // Re-check pause between entries so a mid-batch Pause freezes the rest.
        if (waitWhilePaused && !(await awaitUnpaused(parentId))) {
          fileQueue.length = 0;
          return;
        }
        const drop = entryToDrop(row);
        const remappedRelative = remapRelativePath(rootName, drop.relativePath);
        const remappedDrop = remappedRelative === drop.relativePath
          ? drop
          : { ...drop, relativePath: remappedRelative };
        if (remappedDrop.isDirectory) {
          // Create remote dirs early when we see them. Empty-directory failures
          // must not be silently ignored (no later file will retry the mkdir).
          try {
            await ensureDirectory(joinPath(targetPath, remappedDrop.relativePath));
          } catch (error) {
            stats.dirFailures += 1;
            results.push({
              fileName: remappedDrop.relativePath,
              success: false,
              error: formatUploadError(error),
            });
          }
          continue;
        }
        stats.discovered += 1;
        fileQueue.push({ entry: remappedDrop, parentId, rootName });
      }
      publishParentProgress(parentId);
      wake();
      maybeResumeScan();
      await waitIfQueueHigh();
    } finally {
      pendingEnqueues = Math.max(0, pendingEnqueues - 1);
      // Workers may have seen an empty queue while we were still paused inside
      // this handler — wake them once discovery work is actually settled.
      wake();
    }
  };

  const scanPromise = (async () => {
    try {
      for (const root of activeRoots) {
        if (isStopped()) break;
        await listLocalTree(root.localPath, {
          abortSignal,
          onProgress: () => {
            // Counts are derived from entry batches so UI stays consistent.
          },
          onEntries: (batch) => {
            void enqueueBatch(root.name, batch);
          },
        });
      }
    } catch (error) {
      scanError = error;
    } finally {
      scanDone = true;
      wake();
      if (pauseScanWaiters.length > 0) {
        const waiters = pauseScanWaiters;
        pauseScanWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  })();

  const uploadSingle = async (job: FileJob): Promise<void> => {
    if (isStopped()) return;
    const { entry, parentId } = job;
    const stats = parentStats.get(parentId);
    if (!stats) return;

    // Soft-pause and cancel both block before a child row is created. Creating
    // the UI task first made Pause look broken: new "pending" children kept
    // flooding the panel even though streams were soft-drained.
    if (!(await awaitUnpaused(parentId))) return;

    const entryTargetPath = joinPath(targetPath, entry.relativePath);
    const childId = crypto.randomUUID();
    const fileTotalBytes = entry.size ?? 0;

    callbacks?.onTaskCreated?.({
      id: childId,
      fileName: entry.relativePath,
      displayName: entry.relativePath,
      isDirectory: false,
      progressMode: "bytes",
      parentTaskId: parentId,
      totalBytes: fileTotalBytes,
      transferredBytes: 0,
      speed: 0,
      fileCount: 1,
      completedCount: 0,
      sourcePath: entry.localPath,
    });

    if (isStopped()) {
      callbacks?.onTaskCancelled?.(childId);
      return;
    }
    // Pause may have been hit between create and stream open — wait again so we
    // never start a new write under a paused parent.
    if (!(await awaitUnpaused(parentId))) {
      callbacks?.onTaskCancelled?.(childId);
      return;
    }

    try {
      await ensureParentsForFile(entry.relativePath);
      const localFilePath = entry.localPath;
      if (!localFilePath || !bridge.startStreamTransfer) {
        throw new Error("A local file path is required for streaming SFTP upload");
      }
      controller?.addActiveTransfer(childId);
      let streamResult: { error?: string; cancelled?: boolean } | undefined;
      try {
        streamResult = await bridge.startStreamTransfer({
          transferId: childId,
          sourcePath: localFilePath,
          targetPath: entryTargetPath,
          sourceType: "local",
          targetType: isLocal ? "local" : "sftp",
          targetSftpId: isLocal ? undefined : sftpId ?? undefined,
          targetHostId: isLocal ? undefined : targetHostId,
          totalBytes: fileTotalBytes,
          resumable: true,
          checkpointBytes: 0,
        });
      } finally {
        controller?.removeActiveTransfer(childId);
      }

      if (streamResult?.cancelled || streamResult?.error?.includes("cancelled")) {
        callbacks?.onTaskCancelled?.(childId);
        return;
      }
      if (streamResult?.error) {
        throw new Error(streamResult.error);
      }

      results.push({ fileName: entry.relativePath, success: true });
      stats.completed += 1;
      callbacks?.onTaskCompleted?.(childId, fileTotalBytes);
      publishParentProgress(parentId, "transferring");
    } catch (error) {
      if (controller?.isCancelled()) {
        callbacks?.onTaskCancelled?.(childId);
        return;
      }
      const message = formatUploadError(error);
      results.push({ fileName: entry.relativePath, success: false, error: message });
      stats.failed += 1;
      stats.completed += 1;
      callbacks?.onTaskFailed?.(childId, message);
      publishParentProgress(parentId, "transferring");
    } finally {
      maybeResumeScan();
      wake();
    }
  };

  const uploadConcurrency = resolveProgressiveFolderUploadConcurrency(fileTransferConcurrency);
  const workers = Array.from({ length: uploadConcurrency }, async () => {
    while (true) {
      if (isStopped()) {
        fileQueue.length = 0;
        return;
      }
      if (fileQueue.length === 0) {
        // onEntries handlers may still be awaiting soft-pause before pushing
        // jobs — do not treat scanDone alone as terminal.
        if (discoverySettled()) return;
        await waitForWork();
        continue;
      }
      // Soft-pause is per-parent. Prefer an unpaused job so pausing parent A
      // does not head-of-line block parent B on the shared FIFO.
      if (fileQueue.length === 0) continue;
      let pickIndex = 0;
      if (isPaused) {
        const freeIndex = fileQueue.findIndex((j) => !isPaused(j.parentId));
        if (freeIndex < 0) {
          // Every pending parent is latched. Race-wait on *all* of them so
          // resuming a non-head parent does not stall behind a still-paused head.
          const pausedParents = [...new Set(fileQueue.map((j) => j.parentId))];
          let anyReleased = false;
          await Promise.race(
            pausedParents.map(async (parentId) => {
              if (await awaitUnpaused(parentId)) anyReleased = true;
            }),
          );
          if (!anyReleased || isStopped()) {
            fileQueue.length = 0;
            return;
          }
          continue;
        }
        pickIndex = freeIndex;
      } else if (waitWhilePaused) {
        if (!(await awaitUnpaused(fileQueue[0].parentId))) {
          fileQueue.length = 0;
          return;
        }
      }
      if (isStopped()) {
        fileQueue.length = 0;
        return;
      }
      if (fileQueue.length === 0) continue;
      const [job] = fileQueue.splice(pickIndex, 1);
      if (!job) continue;
      maybeResumeScan();
      if (isStopped()) {
        fileQueue.length = 0;
        return;
      }
      await uploadSingle(job);
    }
  });

  await Promise.all([scanPromise, ...workers]);

  if (controller?.isCancelled()) {
    for (const parentId of parentIds.values()) {
      callbacks?.onTaskCancelled?.(parentId);
    }
    return [{ fileName: "", success: false, cancelled: true }, ...results];
  }

  if (scanError) {
    for (const parentId of parentIds.values()) {
      callbacks?.onTaskFailed?.(parentId, formatUploadError(scanError));
    }
    throw scanError;
  }

  for (const [parentId, stats] of parentStats) {
    if (stats.failed > 0 || stats.dirFailures > 0) {
      const parts: string[] = [];
      if (stats.failed > 0) {
        parts.push(
          stats.failed === stats.discovered && stats.discovered > 0
            ? `All ${stats.failed} files failed`
            : `${stats.failed} of ${stats.discovered} files failed`,
        );
      }
      if (stats.dirFailures > 0) {
        parts.push(
          stats.dirFailures === 1
            ? "1 directory could not be created"
            : `${stats.dirFailures} directories could not be created`,
        );
      }
      callbacks?.onTaskFailed?.(parentId, parts.join("; "));
    } else {
      callbacks?.onTaskCompleted?.(parentId, stats.discovered);
    }
  }

  return results;
}
