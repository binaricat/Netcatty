/**
 * Shared Upload Service
 *
 * Provides core upload logic for both SftpView and SftpModal components.
 * Handles bundled folder uploads with aggregate progress tracking,
 * cancellation support, and works for both local and remote (SFTP) uploads.
 */

import { extractDropEntries, DropEntry, getDropEntryLocalPath, getPathForFile } from "./sftpFileUtils";
import { logger } from "./logger";
import { uploadFoldersCompressed } from "./uploadCompressed";
import {
  canReplaceSftpConflict,
  describeSftpExistingKind,
  describeSftpIncomingKind,
  getSftpConflictTypeKey,
} from "../domain/sftpConflict";
import { isMissingStatError } from "../domain/sftpStatError";

// ============================================================================
// Types
// ============================================================================

export type {
  UploadBridge,
  UploadCallbacks,
  UploadConfig,
  UploadProgress,
  UploadResult,
  UploadTaskInfo,
} from "./uploadService.types";
import type { UploadBridge, UploadCallbacks, UploadConfig, UploadResult } from "./uploadService.types";

// ============================================================================
// Helper Functions
// ============================================================================

const formatUploadError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const getDropEntrySize = (entry: DropEntry): number => (
  entry.isDirectory ? 0 : entry.file?.size ?? entry.size ?? 0
);
const getRootDropLocalPath = (rootName: string, entries: DropEntry[]): string | undefined => {
  const entry = entries.find((candidate) => getDropEntryLocalPath(candidate));
  const localPath = entry ? getDropEntryLocalPath(entry) : undefined;
  if (!entry || !localPath) return undefined;
  const normalizedLocal = localPath.replace(/\\/g, "/");
  const normalizedRelative = entry.relativePath.replace(/\\/g, "/");
  if (!normalizedLocal.endsWith(normalizedRelative)) return localPath;
  return `${normalizedLocal.slice(0, -normalizedRelative.length)}${rootName}`;
};
const isUploadableFileEntry = (entry: DropEntry): boolean =>
  !entry.isDirectory && (!!entry.file || !!getDropEntryLocalPath(entry));

export interface UploadScanningTask {
  taskId: string;
  complete: () => void;
  fail: (error: unknown) => void;
  cancel: () => void;
  isOpen: () => boolean;
}

export function startUploadScanningTask(
  callbacks?: UploadCallbacks,
  taskId = crypto.randomUUID(),
  info?: { label?: string },
): UploadScanningTask {
  let open = true;
  callbacks?.onScanningStart?.(taskId, info);

  const close = (settle: () => void) => {
    if (!open) return;
    open = false;
    settle();
  };

  return {
    taskId,
    complete: () => close(() => callbacks?.onScanningEnd?.(taskId)),
    fail: (error) => close(() => callbacks?.onTaskFailed?.(taskId, formatUploadError(error))),
    cancel: () => close(() => callbacks?.onTaskCancelled?.(taskId)),
    isOpen: () => open,
  };
}

/**
 * Detect root folders from drop entries for bundled task creation
 */
export function detectRootFolders(entries: DropEntry[]): Map<string, DropEntry[]> {
  const rootFolders = new Map<string, DropEntry[]>();

  for (const entry of entries) {
    const parts = entry.relativePath.split('/');
    const rootName = parts[0];

    // Group if there's more than one part (from a folder) or the entry is a directory
    if (parts.length > 1 || entry.isDirectory) {
      if (!rootFolders.has(rootName)) {
        rootFolders.set(rootName, []);
      }
      rootFolders.get(rootName)!.push(entry);
    } else {
      // Standalone file - use its name as key with special prefix
      const key = `__file__${entry.relativePath}`;
      rootFolders.set(key, [entry]);
    }
  }

  return rootFolders;
}

/**
 * Sort entries: directories first, then by path depth
 */
export function sortEntries(entries: DropEntry[]): DropEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    const aDepth = a.relativePath.split('/').length;
    const bDepth = b.relativePath.split('/').length;
    return aDepth - bDepth;
  });
}

// ============================================================================
// Upload Controller
// ============================================================================

/**
 * Controller for managing upload operations with cancellation support
 */
export { UploadController } from "./uploadController";
import { UploadController } from "./uploadController";

// ============================================================================
// Core Upload Function
// ============================================================================

/**
 * Upload files from a DataTransfer object with bundled folder support
 *
 * @param dataTransfer - The DataTransfer object from a drop event
 * @param config - Upload configuration
 * @param controller - Optional upload controller for cancellation
 * @returns Array of upload results
 */
export async function uploadFromDataTransfer(
  dataTransfer: DataTransfer,
  config: UploadConfig,
  controller?: UploadController
): Promise<UploadResult[]> {
  const { callbacks } = config;

  // Reset controller if provided
  if (controller) {
    controller.reset();
    controller.setBridge(config.bridge);
  }

  // Create scanning placeholder

  const scanT0 = performance.now();
  const scanningTask = startUploadScanningTask(callbacks);
  let entries: DropEntry[];
  try {
    entries = await extractDropEntries(dataTransfer, {
      onProgress: (progress) => {
        callbacks?.onScanningProgress?.(scanningTask.taskId, progress);
      },
      isCancelled: () => controller?.isCancelled() === true,
    });
  } catch (error) {
    if (controller?.isCancelled() || /cancel/i.test(error instanceof Error ? error.message : String(error))) {
      scanningTask.cancel();
    } else {
      scanningTask.fail(error);
    }
    throw error;
  }
  if (controller?.isCancelled()) {
    scanningTask.cancel();
    return [{ fileName: "", success: false, cancelled: true }];
  }
  scanningTask.complete();
  logger.debug(`[SFTP:perf] extractDropEntries — ${entries.length} entries — ${(performance.now() - scanT0).toFixed(0)}ms`);

  if (entries.length === 0) {
    return [];
  }

  return uploadEntriesWithOptionalCompression(entries, config, controller);
}

/**
 * Upload a FileList or File array with bundled folder support
 */
export async function uploadFromFileList(
  fileList: FileList | File[],
  config: UploadConfig,
  controller?: UploadController
): Promise<UploadResult[]> {
  if (controller) {
    controller.reset();
    controller.setBridge(config.bridge);
  }

  // Convert FileList to DropEntry array
  // Use webkitRelativePath for folder uploads, fallback to file.name for regular file uploads
  const entries: DropEntry[] = Array.from(fileList).map(file => {
    const localPath = getPathForFile(file);
    // Use webkitRelativePath if available (folder upload), otherwise use file.name (regular file upload)
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    return {
      file,
      localPath,
      relativePath,
      isDirectory: false,
    };
  });

  if (entries.length === 0) {
    return [];
  }

  return uploadEntriesWithOptionalCompression(entries, config, controller);
}

type UploadConflictAction = Awaited<ReturnType<NonNullable<UploadConfig["resolveConflict"]>>>;

const compressionFallbackError = "Compressed upload not supported - fallback needed";

const uploadConflictGroupKey = (fileName: string, isDirectory: boolean) => (
  `${isDirectory ? "directory" : "file"}:${fileName}`
);

/**
 * Resolve root conflicts once before selecting compressed vs regular transfer.
 * New folders and directory merges can use the atomic compressed path. Replace,
 * duplicate, and invalid merge cases stay on the regular path so their existing
 * semantics are preserved exactly and the user is never prompted twice.
 */
async function uploadEntriesWithOptionalCompression(
  entries: DropEntry[],
  config: UploadConfig,
  controller?: UploadController,
): Promise<UploadResult[]> {
  const {
    targetPath,
    sftpId,
    isLocal,
    bridge,
    joinPath,
    callbacks,
    useCompressedUpload,
    resolveConflict,
  } = config;

  if (!useCompressedUpload || isLocal || !sftpId) {
    return uploadEntries(
      entries,
      targetPath,
      sftpId,
      isLocal,
      bridge,
      joinPath,
      callbacks,
      controller,
      resolveConflict,
      config.targetHostId,
    );
  }

  const rootGroups = Array.from(detectRootFolders(entries).entries());
  if (!rootGroups.some(([key]) => !key.startsWith("__file__"))) {
    return uploadEntries(
      entries,
      targetPath,
      sftpId,
      isLocal,
      bridge,
      joinPath,
      callbacks,
      controller,
      resolveConflict,
      config.targetHostId,
    );
  }

  const statTarget = async (path: string) => {
    try {
      // Prefer no-follow lstat so Replace can unlink a symlink instead of
      // writing through it. Followed statSftp stays for source sizing / resume.
      return await (bridge.lstatSftp ?? bridge.statSftp)?.(sftpId, path) ?? null;
    } catch (error) {
      if (isMissingStatError(error)) return null;
      // e.g. LSTAT ENOTSUP: unknown target type — fail closed, do not upload.
      throw error;
    }
  };
  const groupInfos = await Promise.all(rootGroups.map(async ([key, groupEntries]) => {
    const isStandaloneFile = key.startsWith("__file__");
    const rootName = isStandaloneFile ? key.slice("__file__".length) : key;
    const isDirectory = !isStandaloneFile;
    const rootTargetPath = joinPath(targetPath, rootName);
    return {
      groupEntries,
      rootName,
      isDirectory,
      rootTargetPath,
      existing: resolveConflict ? await statTarget(rootTargetPath) : null,
    };
  }));

  const conflictCounts = new Map<string, number>();
  for (const info of groupInfos) {
    if (!info.existing) continue;
    const key = getSftpConflictTypeKey(info.isDirectory, info.existing.type);
    conflictCounts.set(key, (conflictCounts.get(key) ?? 0) + 1);
  }

  const compressedGroups: Array<[string, DropEntry[]]> = [];
  const regularEntries: DropEntry[] = [];
  const resolvedResults: UploadResult[] = [];
  const selectedActions = new Map<string, UploadConflictAction>();

  for (const info of groupInfos) {
    if (controller?.isCancelled()) break;
    if (!info.existing || !resolveConflict) {
      if (info.isDirectory) compressedGroups.push([info.rootName, info.groupEntries]);
      else regularEntries.push(...info.groupEntries);
      continue;
    }

    const conflictKey = getSftpConflictTypeKey(info.isDirectory, info.existing.type);
    const action = await resolveConflict({
      fileName: info.rootName,
      targetPath: info.rootTargetPath,
      isDirectory: info.isDirectory,
      existingType: info.existing.type,
      existingSize: info.existing.size,
      newSize: info.groupEntries.reduce((sum, entry) => sum + getDropEntrySize(entry), 0),
      existingModified: info.existing.lastModified,
      newModified: Date.now(),
      applyToAllCount: conflictCounts.get(conflictKey) ?? 1,
    });

    if (action === "stop") {
      await controller?.cancel();
      return [{ fileName: info.rootName, success: false, cancelled: true }];
    }
    if (action === "skip") {
      resolvedResults.push({ fileName: info.rootName, success: false, cancelled: true });
      continue;
    }

    selectedActions.set(uploadConflictGroupKey(info.rootName, info.isDirectory), action);
    if (info.isDirectory && action === "merge" && info.existing.type === "directory") {
      compressedGroups.push([info.rootName, info.groupEntries]);
    } else {
      regularEntries.push(...info.groupEntries);
    }
  }

  let compressedResults: UploadResult[] = [];
  if (compressedGroups.length > 0 && !controller?.isCancelled()) {
    try {
      compressedResults = await uploadFoldersCompressed(
        compressedGroups,
        targetPath,
        sftpId,
        callbacks,
        controller,
      );
    } catch {
      compressedResults = compressedGroups.map(([fileName]) => ({
        fileName,
        success: false,
        error: compressionFallbackError,
      }));
    }
  }

  const fallbackFolderNames = new Set(
    compressedResults
      .filter((result) => !result.success && result.error === compressionFallbackError)
      .map((result) => result.fileName),
  );
  for (const [fileName, groupEntries] of compressedGroups) {
    if (fallbackFolderNames.has(fileName)) regularEntries.push(...groupEntries);
  }

  const terminalCompressedResults = compressedResults.filter((result) => (
    result.success || result.error !== compressionFallbackError
  ));
  if (regularEntries.length === 0) {
    return [...resolvedResults, ...terminalCompressedResults];
  }

  const replayResolvedConflict: UploadConfig["resolveConflict"] = resolveConflict
    ? async (conflict) => (
        selectedActions.get(uploadConflictGroupKey(conflict.fileName, conflict.isDirectory))
        ?? resolveConflict(conflict)
      )
    : undefined;
  const regularResults = await uploadEntries(
    regularEntries,
    targetPath,
    sftpId,
    isLocal,
    bridge,
    joinPath,
    callbacks,
    controller,
    replayResolvedConflict,
    config.targetHostId,
  );
  return [...resolvedResults, ...terminalCompressedResults, ...regularResults];
}

/**
 * Core upload logic for entries
 */
async function uploadEntries(
  entries: DropEntry[],
  targetPath: string,
  sftpId: string | null,
  isLocal: boolean,
  bridge: UploadBridge,
  joinPath: (base: string, name: string) => string,
  callbacks?: UploadCallbacks,
  controller?: UploadController,
  resolveConflict?: UploadConfig["resolveConflict"],
  targetHostId?: string,
): Promise<UploadResult[]> {
  const results: UploadResult[] = [];
  const createdDirs = new Set<string>();
  const failedDirs = new Map<string, string>();
  const reportedDirectoryFailures = new Set<string>();
  let wasCancelled = false;

  if (controller?.isCancelled()) {
    return [{ fileName: "", success: false, cancelled: true }];
  }

  const statTarget = async (path: string) => {
    try {
      // Prefer no-follow lstat for destinations so Replace can unlink a
      // symlink instead of writing through it. Followed stat* stays for
      // source sizing / resume (link size must not become totalBytes).
      if (isLocal) return await (bridge.lstatLocal ?? bridge.statLocal)?.(path);
      if (sftpId) return await (bridge.lstatSftp ?? bridge.statSftp)?.(sftpId, path);
    } catch (error) {
      if (isMissingStatError(error)) return null;
      // e.g. LSTAT ENOTSUP: unknown target type — fail closed, do not upload.
      throw error;
    }
    return null;
  };

  const deleteTarget = async (
    path: string,
    expectedType?: "file" | "directory" | "symlink",
  ) => {
    if (isLocal) {
      await bridge.deleteLocalFile?.(path, expectedType);
    } else if (sftpId) {
      await bridge.deleteSftp?.(sftpId, path, expectedType);
    }
  };

  const splitNameForDuplicate = (name: string, isDirectory: boolean) => {
    if (isDirectory) return { baseName: name, ext: "" };
    const lastDot = name.lastIndexOf(".");
    if (lastDot <= 0) return { baseName: name, ext: "" };
    return { baseName: name.slice(0, lastDot), ext: name.slice(lastDot) };
  };

  const getDuplicateName = async (name: string, isDirectory: boolean) => {
    const { baseName, ext } = splitNameForDuplicate(name, isDirectory);
    for (let index = 1; index < 1000; index++) {
      const suffix = index === 1 ? " (copy)" : ` (copy ${index})`;
      const candidate = `${baseName}${suffix}${ext}`;
      const candidatePath = joinPath(targetPath, candidate);
      const existing = await statTarget(candidatePath);
      if (!existing) return candidate;
    }
    return `${baseName} (copy ${Date.now()})${ext}`;
  };

  const renameRoot = (entry: DropEntry, oldName: string, newName: string): DropEntry => {
    if (entry.relativePath === oldName) {
      return { ...entry, relativePath: newName };
    }
    if (entry.relativePath.startsWith(`${oldName}/`)) {
      return { ...entry, relativePath: `${newName}/${entry.relativePath.slice(oldName.length + 1)}` };
    }
    return entry;
  };

  const ensureDirectory = async (dirPath: string): Promise<string | null> => {
    if (createdDirs.has(dirPath)) return null;
    const previousFailure = failedDirs.get(dirPath);
    if (previousFailure) return previousFailure;

    try {
      if (isLocal) {
        if (bridge.mkdirLocal) {
          await bridge.mkdirLocal(dirPath);
        }
      } else if (sftpId) {
        await bridge.mkdirSftp(sftpId, dirPath);
      }
      createdDirs.add(dirPath);
      return null;
    } catch (error) {
      const errorMessage = formatUploadError(error);
      failedDirs.set(dirPath, errorMessage);
      return errorMessage;
    }
  };

  // Group entries by root folder
  const rootFolders = detectRootFolders(entries);
  let resolvedEntries = entries;

  if (resolveConflict) {
    const resolved: DropEntry[] = [];
    let stop = false;
    const groupInfos = await Promise.all(Array.from(rootFolders.entries()).map(async ([key, groupEntries]) => {
      const isStandaloneFile = key.startsWith("__file__");
      const rootName = isStandaloneFile ? key.slice("__file__".length) : key;
      const isDirectory = !isStandaloneFile;
      const rootTargetPath = joinPath(targetPath, rootName);
      const existing = await statTarget(rootTargetPath);
      return {
        groupEntries,
        rootName,
        isDirectory,
        rootTargetPath,
        existing,
      };
    }));

    const conflictCounts = new Map<string, number>();
    for (const info of groupInfos) {
      if (!info.existing) continue;
      const conflictKey = getSftpConflictTypeKey(info.isDirectory, info.existing.type);
      conflictCounts.set(conflictKey, (conflictCounts.get(conflictKey) ?? 0) + 1);
    }

    for (const { groupEntries, rootName, isDirectory, rootTargetPath, existing } of groupInfos) {
      if (stop || controller?.isCancelled()) break;

      if (!existing) {
        resolved.push(...groupEntries);
        continue;
      }

      const conflictKey = getSftpConflictTypeKey(isDirectory, existing.type);
      const newSize = groupEntries.reduce((sum, entry) => sum + getDropEntrySize(entry), 0);
      const action = await resolveConflict({
        fileName: rootName,
        targetPath: rootTargetPath,
        isDirectory,
        existingType: existing.type,
        existingSize: existing.size,
        newSize,
        existingModified: existing.lastModified,
        newModified: Date.now(),
        applyToAllCount: conflictCounts.get(conflictKey) ?? 1,
      });

      if (action === "stop") {
        stop = true;
        await controller?.cancel();
        resolved.length = 0;
        results.push({ fileName: rootName, success: false, cancelled: true });
        break;
      }

      if (action === "skip") {
        results.push({ fileName: rootName, success: false, cancelled: true });
        continue;
      }

      if (action === "replace") {
        if (!canReplaceSftpConflict(isDirectory, existing.type)) {
          results.push({
            fileName: rootName,
            success: false,
            error: `Cannot replace existing ${describeSftpExistingKind(existing.type)} with ${describeSftpIncomingKind(isDirectory)}: ${rootTargetPath}`,
          });
          continue;
        }
        // Preserve confirmed remote regular files so stage+rename can restore
        // mode bits (#2954). Local writes do not use that transaction, so
        // unlink local files first to avoid truncating every alias of a hard
        // linked inode. Directories and symlinks must always be cleared.
        if (isLocal || existing.type !== "file") {
          await deleteTarget(rootTargetPath, existing.type);
        }
        resolved.push(...groupEntries);
        continue;
      }

      if (action === "duplicate") {
        const duplicateName = await getDuplicateName(rootName, isDirectory);
        resolved.push(...groupEntries.map((entry) => renameRoot(entry, rootName, duplicateName)));
        continue;
      }

      if (action === "merge" && !(isDirectory && existing.type === "directory")) {
        results.push({
          fileName: rootName,
          success: false,
          error: `Cannot merge existing ${describeSftpExistingKind(existing.type)} with ${describeSftpIncomingKind(isDirectory)}: ${rootTargetPath}`,
        });
        continue;
      }

      resolved.push(...groupEntries);
    }

    resolvedEntries = resolved;
  }

  if (resolvedEntries.length === 0) {
    return results;
  }

  const resolvedRootFolders = detectRootFolders(resolvedEntries);
  const sortedEntries = sortEntries(resolvedEntries);
  const explicitDirectoryPaths = new Map<string, string>();

  // Pre-create all needed directories in batch before file transfers
  const uploadT0 = performance.now();
  logger.debug(`[SFTP:perf] uploadEntries START — ${sortedEntries.length} entries, ${sortedEntries.filter(e => !e.isDirectory).length} files`);
  const allDirPaths = new Set<string>();
  for (const entry of sortedEntries) {
    if (entry.isDirectory) {
      const dirPath = joinPath(targetPath, entry.relativePath);
      allDirPaths.add(dirPath);
      explicitDirectoryPaths.set(dirPath, entry.relativePath);
    } else {
      const pathParts = entry.relativePath.split('/');
      if (pathParts.length > 1) {
        let parentPath = targetPath;
        for (let i = 0; i < pathParts.length - 1; i++) {
          parentPath = joinPath(parentPath, pathParts[i]);
          allDirPaths.add(parentPath);
        }
      }
    }
  }
  // Create directories in sorted order (parents before children) with limited concurrency
  const sortedDirPaths = Array.from(allDirPaths).sort();
  // Group by depth and create each depth level in parallel
  const dirsByDepth = new Map<number, string[]>();
  for (const dirPath of sortedDirPaths) {
    const depth = dirPath.split('/').length;
    const group = dirsByDepth.get(depth) || [];
    group.push(dirPath);
    dirsByDepth.set(depth, group);
  }
  const sortedDepths = Array.from(dirsByDepth.keys()).sort((a, b) => a - b);
  for (const depth of sortedDepths) {
    const dirs = dirsByDepth.get(depth)!;
    const directoryResults = await Promise.all(dirs.map(async (dirPath) => ({
      dirPath,
      error: await ensureDirectory(dirPath),
    })));
    for (const { dirPath, error } of directoryResults) {
      if (!error) continue;
      const relativePath = explicitDirectoryPaths.get(dirPath);
      if (!relativePath || reportedDirectoryFailures.has(relativePath)) continue;
      reportedDirectoryFailures.add(relativePath);
      results.push({ fileName: relativePath, success: false, error });
    }
    if (controller?.isCancelled()) {
      wasCancelled = true;
      break;
    }
  }
  logger.debug(`[SFTP:perf] batch mkdir done — ${allDirPaths.size} dirs — ${(performance.now() - uploadT0).toFixed(0)}ms`);

  // Track bundled task progress
  const bundleProgress = new Map<string, {
    totalBytes: number;
    transferredBytes: number;
    fileCount: number;
    completedCount: number;
    failedCount: number;
    currentSpeed: number;
    completedFilesBytes: number;
  }>();
  const pendingTaskIds = new Set<string>();

  // Create bundled tasks for each root folder
  const bundleTaskIds = new Map<string, string>(); // rootName -> bundleTaskId

  for (const [rootName, rootEntries] of resolvedRootFolders) {
    const isStandaloneFile = rootName.startsWith("__file__");
    if (isStandaloneFile) continue;

    // Calculate total bytes for this folder (path-only entries from listLocalTree
    // carry size without a browser File handle).
    let totalBytes = 0;
    let fileCount = 0;
    for (const entry of rootEntries) {
      if (!isUploadableFileEntry(entry)) continue;
      totalBytes += getDropEntrySize(entry);
      fileCount++;
    }

    if (fileCount === 0) continue;

    const bundleTaskId = crypto.randomUUID();
    bundleTaskIds.set(rootName, bundleTaskId);
    bundleProgress.set(bundleTaskId, {
      totalBytes,
      transferredBytes: 0,
      fileCount,
      completedCount: 0,
      failedCount: 0,
      currentSpeed: 0,
      completedFilesBytes: 0,
    });

    // Notify task created
    if (callbacks?.onTaskCreated) {
      const displayName = rootName;
      callbacks.onTaskCreated({
        id: bundleTaskId,
        fileName: rootName,
        displayName,
        isDirectory: true,
        progressMode: 'files',
        totalBytes: fileCount,
        transferredBytes: 0,
        speed: 0,
        fileCount,
        completedCount: 0,
        sourcePath: getRootDropLocalPath(rootName, rootEntries),
      });
      pendingTaskIds.add(bundleTaskId);
    }
  }

  // Helper to get bundle task ID for an entry
  const getBundleTaskId = (entry: DropEntry): string | null => {
    const parts = entry.relativePath.split('/');
    const rootName = parts[0];
    if (parts.length > 1 || entry.isDirectory) {
      return bundleTaskIds.get(rootName) || null;
    }
    return null;
  };

  // Upload a single file entry — returns result and handles progress
  const uploadSingleFile = async (
    entry: DropEntry,
    entryTargetPath: string,
    standaloneTransferId: string,
    fileTotalBytes: number,
  ): Promise<{ cancelled?: boolean; error?: string }> => {
    let localFilePath = getDropEntryLocalPath(entry);
    let ownedTempPath: string | undefined;

    if (
      !localFilePath
      && !isLocal
      && entry.file
      && bridge.stageUploadFile
      && bridge.deleteTempFile
    ) {
      controller?.addActiveTransfer(standaloneTransferId);
      try {
        ownedTempPath = await bridge.stageUploadFile(entry.file, standaloneTransferId);
      } catch (error) {
        controller?.removeActiveTransfer(standaloneTransferId);
        if (controller?.isCancelled() || /cancel/i.test(error instanceof Error ? error.message : String(error))) {
          return { cancelled: true };
        }
        throw error;
      }
      localFilePath = ownedTempPath;
      if (controller?.isCancelled()) {
        await bridge.deleteTempFile(ownedTempPath).catch(() => {});
        return { cancelled: true };
      }
    }

    try {
      if (localFilePath && bridge.startStreamTransfer && (!isLocal ? !!sftpId : true)) {
        const fileTransferId = standaloneTransferId;
        controller?.addActiveTransfer(fileTransferId);

        let streamResult: { transferId: string; totalBytes?: number; error?: string; cancelled?: boolean } | undefined;
        try {
          streamResult = await bridge.startStreamTransfer({
              transferId: fileTransferId,
              sourcePath: localFilePath,
              targetPath: entryTargetPath,
              sourceType: 'local',
              targetType: isLocal ? 'local' : 'sftp',
              targetSftpId: isLocal ? undefined : sftpId,
              targetHostId: isLocal ? undefined : targetHostId,
              totalBytes: fileTotalBytes,
              resumable: true,
              checkpointBytes: 0,
            });
        } finally {
          controller?.removeActiveTransfer(fileTransferId);
        }

        if (streamResult?.cancelled || streamResult?.error?.includes('cancelled')) {
          return { cancelled: true };
        }
        if (streamResult?.error) {
          return { error: streamResult.error };
        }
      } else {
        if (!entry.file) {
          return { error: "No local file data available" };
        }
        if (isLocal) {
          const arrayBuffer = await entry.file.arrayBuffer();
          if (!bridge.writeLocalFile) throw new Error("writeLocalFile not available");
          await bridge.writeLocalFile(entryTargetPath, arrayBuffer);
        } else if (sftpId) {
          // Electron-backed files must expose a real local path so the unified
          // transfer runtime can stream them. Falling back to File.arrayBuffer()
          // duplicates the entire payload in renderer + IPC memory.
          return { error: "A local file path is required for streaming SFTP upload" };
        }
      }
      return {};
    } finally {
      if (ownedTempPath) {
        controller?.removeActiveTransfer(standaloneTransferId);
        await bridge.deleteTempFile?.(ownedTempPath).catch(() => {});
      }
    }
  };

  // Filter to only file entries (directories are pre-created above)
  const fileEntries = sortedEntries.filter(isUploadableFileEntry);

  // Create standalone task entries upfront so they're visible immediately.
  // Bundled child tasks are created lazily when upload actually starts, so
  // large folder uploads don't flood React state before work begins.
  const standaloneTaskIds = new Map<string, string>(); // relativePath -> taskId
  for (const entry of fileEntries) {
    const bundleTaskId = getBundleTaskId(entry);
    if (!bundleTaskId) {
      const taskId = crypto.randomUUID();
      standaloneTaskIds.set(entry.relativePath, taskId);
      if (callbacks?.onTaskCreated) {
        callbacks.onTaskCreated({
          id: taskId,
          fileName: entry.relativePath,
          displayName: entry.relativePath,
          isDirectory: false,
          progressMode: 'bytes',
          totalBytes: getDropEntrySize(entry),
          transferredBytes: 0,
          speed: 0,
          fileCount: 1,
          completedCount: 0,
          sourcePath: getDropEntryLocalPath(entry),
        });
        pendingTaskIds.add(taskId);
      }
    }
  }

  const createBundledChildTask = (entry: DropEntry, bundleTaskId: string): string => {
    const taskId = crypto.randomUUID();
    if (callbacks?.onTaskCreated) {
      callbacks.onTaskCreated({
        id: taskId,
        fileName: entry.relativePath,
        displayName: entry.relativePath,
        isDirectory: false,
        progressMode: 'bytes',
        parentTaskId: bundleTaskId,
        totalBytes: getDropEntrySize(entry),
        transferredBytes: 0,
        speed: 0,
        fileCount: 1,
        completedCount: 0,
        sourcePath: getDropEntryLocalPath(entry),
      });
      pendingTaskIds.add(taskId);
    }
    return taskId;
  };

  const settleTask = (
    taskId: string,
    settle: (taskId: string) => void,
  ) => {
    if (!taskId) return;
    if (!pendingTaskIds.delete(taskId)) return;
    settle(taskId);
  };

  const settleFileTask = (
    taskId: string,
    lifecycleManaged: boolean,
    settle: (taskId: string) => void,
  ) => {
    if (!taskId) return;
    if (lifecycleManaged) {
      pendingTaskIds.delete(taskId);
      return;
    }
    settleTask(taskId, settle);
  };

  // Keep external multi-file uploads conservative: each file may open an
  // isolated fastPut channel with its own in-flight WRITE fanout.
  const UPLOAD_CONCURRENCY = 2;

  try {
    let entryIndex = 0;

    const worker = async () => {
      while (entryIndex < fileEntries.length) {
        if (controller?.isCancelled() || wasCancelled) break;

        const idx = entryIndex++;
        const entry = fileEntries[idx];
        const entryTargetPath = joinPath(targetPath, entry.relativePath);
        const bundleTaskId = getBundleTaskId(entry);
        const bundledChildTaskId = bundleTaskId ? createBundledChildTask(entry, bundleTaskId) : "";
        const standaloneTransferId = standaloneTaskIds.get(entry.relativePath) || "";
        const fileTotalBytes = getDropEntrySize(entry);
        const localFilePath = getDropEntryLocalPath(entry);
        const lifecycleManaged = bridge.managesTransferLifecycle === true && Boolean(
          localFilePath && bridge.startStreamTransfer,
        );

        try {
          const uploadResult = await uploadSingleFile(
            entry,
            entryTargetPath,
            bundledChildTaskId || standaloneTransferId,
            fileTotalBytes,
          );

          if (uploadResult.cancelled) {
            wasCancelled = true;
            settleFileTask(bundledChildTaskId, lifecycleManaged, (taskId) => callbacks?.onTaskCancelled?.(taskId));
            settleTask(bundleTaskId ?? "", (taskId) => callbacks?.onTaskCancelled?.(taskId));
            settleFileTask(!bundleTaskId ? standaloneTransferId : "", lifecycleManaged, (taskId) => callbacks?.onTaskCancelled?.(taskId));
            break;
          }

          if (uploadResult.error) {
            throw new Error(uploadResult.error);
          }

          results.push({ fileName: entry.relativePath, success: true });

          // Update progress tracking
          if (bundleTaskId) {
            const progress = bundleProgress.get(bundleTaskId);
            if (bundledChildTaskId) {
              settleFileTask(bundledChildTaskId, lifecycleManaged, (taskId) => callbacks?.onTaskCompleted?.(taskId, fileTotalBytes));
            }
            if (progress) {
              progress.completedCount++;
              progress.completedFilesBytes += fileTotalBytes;
              progress.transferredBytes = progress.completedCount;

              if (progress.completedCount >= progress.fileCount) {
                callbacks?.onTaskProgress?.(bundleTaskId, {
                  transferred: progress.fileCount,
                  total: progress.fileCount,
                  speed: 0,
                  percent: 100,
                });
                settleTask(bundleTaskId, (taskId) => callbacks?.onTaskCompleted?.(taskId, progress.fileCount));
              } else {
                callbacks?.onTaskProgress?.(bundleTaskId, {
                  transferred: progress.completedCount,
                  total: progress.fileCount,
                  speed: 0,
                  percent: progress.fileCount > 0 ? (progress.completedCount / progress.fileCount) * 100 : 0,
                });
              }
            }
          } else if (standaloneTransferId) {
            settleFileTask(standaloneTransferId, lifecycleManaged, (taskId) => callbacks?.onTaskCompleted?.(taskId, fileTotalBytes));
          }
        } catch (error) {
          if (controller?.isCancelled()) {
            wasCancelled = true;
            settleFileTask(bundledChildTaskId, lifecycleManaged, (taskId) => callbacks?.onTaskCancelled?.(taskId));
            settleTask(bundleTaskId ?? "", (taskId) => callbacks?.onTaskCancelled?.(taskId));
            settleFileTask(!bundleTaskId ? standaloneTransferId : "", lifecycleManaged, (taskId) => callbacks?.onTaskCancelled?.(taskId));
            break;
          }

          const errorMessage = formatUploadError(error);
          results.push({ fileName: entry.relativePath, success: false, error: errorMessage });

          if (bundleTaskId) {
            const progress = bundleProgress.get(bundleTaskId);
            if (progress) {
              progress.failedCount++;
            }
          }

          settleFileTask(bundledChildTaskId, lifecycleManaged, (taskId) => callbacks?.onTaskFailed?.(taskId, errorMessage));
          settleFileTask(!bundleTaskId ? standaloneTransferId : "", lifecycleManaged, (taskId) => callbacks?.onTaskFailed?.(taskId, errorMessage));
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(UPLOAD_CONCURRENCY, fileEntries.length || 1) },
      () => worker(),
    );
    await Promise.all(workers);

    if (!wasCancelled) {
      for (const [bundleTaskId, progress] of bundleProgress) {
        if (progress.failedCount > 0) {
          settleTask(bundleTaskId, (taskId) => {
            callbacks?.onTaskFailed?.(
              taskId,
              progress.failedCount === progress.fileCount
                ? `All ${progress.fileCount} files failed`
                : `${progress.failedCount} of ${progress.fileCount} files failed`,
            );
          });
        }
      }
    }

    // Mark any remaining incomplete tasks as cancelled if upload was cancelled
    if (wasCancelled) {
      for (const pendingTaskId of Array.from(pendingTaskIds)) {
        settleTask(pendingTaskId, (taskId) => callbacks?.onTaskCancelled?.(taskId));
      }
    }
  } finally {
    controller?.clearCurrentTransfer();
  }

  if (wasCancelled) {
    results.push({ fileName: "", success: false, cancelled: true });
  }

  return results;
}

/**
 * Upload entries directly (used when entries are already extracted)
 */
export async function uploadEntriesDirect(
  entries: DropEntry[],
  config: UploadConfig,
  controller?: UploadController
): Promise<UploadResult[]> {
  if (controller?.isCancelled()) {
    return [{ fileName: "", success: false, cancelled: true }];
  }

  if (controller) {
    // Keep cancel latches/listeners from the external drop scan so the user
    // can still cancel while pre-task work (stat / conflict / mkdir) runs.
    controller.prepareForEntries();
    controller.setBridge(config.bridge);
  }

  if (entries.length === 0) {
    return [];
  }

  return uploadEntriesWithOptionalCompression(entries, config, controller);
}
