/**
 * Shared Upload Service
 *
 * Provides core upload logic for both SftpView and SftpModal components.
 * Handles bundled folder uploads with aggregate progress tracking,
 * cancellation support, and works for both local and remote (SFTP) uploads.
 */

import { extractDropEntries, DropEntry, getPathForFile } from "./sftpFileUtils";

// ============================================================================
// Types
// ============================================================================

export interface UploadProgress {
  transferred: number;
  total: number;
  speed: number;
  /** Percentage (0-100) */
  percent: number;
}

export interface UploadTaskInfo {
  id: string;
  fileName: string;
  /** Display name for bundled tasks (e.g., "folder (5 files)") */
  displayName: string;
  isDirectory: boolean;
  totalBytes: number;
  transferredBytes: number;
  speed: number;
  fileCount: number;
  completedCount: number;
}

export interface UploadResult {
  fileName: string;
  success: boolean;
  error?: string;
  cancelled?: boolean;
}

export interface UploadCallbacks {
  /** Called when a new task is created (for bundled folders or standalone files) */
  onTaskCreated?: (task: UploadTaskInfo) => void;
  /** Called when task progress is updated */
  onTaskProgress?: (taskId: string, progress: UploadProgress) => void;
  /** Called when a task is completed */
  onTaskCompleted?: (taskId: string, totalBytes: number) => void;
  /** Called when a task fails */
  onTaskFailed?: (taskId: string, error: string) => void;
  /** Called when a task is cancelled */
  onTaskCancelled?: (taskId: string) => void;
  /** Called when scanning starts (for showing placeholder) */
  onScanningStart?: (taskId: string) => void;
  /** Called when scanning ends */
  onScanningEnd?: (taskId: string) => void;
  /** Called when task name needs to be updated (for phase changes) */
  onTaskNameUpdate?: (taskId: string, newName: string) => void;
}

export interface UploadBridge {
  writeLocalFile?: (path: string, data: ArrayBuffer) => Promise<void>;
  mkdirLocal?: (path: string) => Promise<void>;
  mkdirSftp: (sftpId: string, path: string) => Promise<void>;
  writeSftpBinary?: (sftpId: string, path: string, data: ArrayBuffer) => Promise<void>;
  writeSftpBinaryWithProgress?: (
    sftpId: string,
    path: string,
    data: ArrayBuffer,
    taskId: string,
    onProgress: (transferred: number, total: number, speed: number) => void,
    onComplete?: () => void,
    onError?: (error: string) => void
  ) => Promise<{ success: boolean; cancelled?: boolean } | undefined>;
  cancelSftpUpload?: (taskId: string) => Promise<unknown>;
  /** Stream transfer using local file path (avoids loading file into memory) */
  startStreamTransfer?: (
    options: {
      transferId: string;
      sourcePath: string;
      targetPath: string;
      sourceType: 'local' | 'sftp';
      targetType: 'local' | 'sftp';
      sourceSftpId?: string;
      targetSftpId?: string;
      totalBytes?: number;
    },
    onProgress?: (transferred: number, total: number, speed: number) => void,
    onComplete?: () => void,
    onError?: (error: string) => void
  ) => Promise<{ transferId: string; totalBytes?: number; error?: string; cancelled?: boolean }>;
  cancelTransfer?: (transferId: string) => Promise<void>;
}

export interface UploadConfig {
  /** Target directory path */
  targetPath: string;
  /** SFTP session ID (null for local) */
  sftpId: string | null;
  /** Is this a local file system upload? */
  isLocal: boolean;
  /** The bridge for file operations */
  bridge: UploadBridge;
  /** Path joining function */
  joinPath: (base: string, name: string) => string;
  /** Callbacks for progress updates */
  callbacks?: UploadCallbacks;
  /** Use compressed upload for folders (requires tar on both local and remote) */
  useCompressedUpload?: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

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
export class UploadController {
  private cancelled = false;
  private activeFileTransferIds = new Set<string>();
  private activeCompressionIds = new Set<string>();
  private currentTransferId = "";
  private bridge: UploadBridge | null = null;

  /**
   * Cancel all active uploads
   */
  async cancel(): Promise<void> {
    this.cancelled = true;

    // Cancel all active compressed uploads
    const activeCompressionIds = Array.from(this.activeCompressionIds);
    for (const compressionId of activeCompressionIds) {
      try {
        // Import and call cancelCompressedUpload
        const { cancelCompressedUpload } = await import('../infrastructure/services/compressUploadService');
        await cancelCompressedUpload(compressionId);
      } catch {
        // Ignore cancel errors
      }
    }

    // Cancel all active file uploads
    const activeIds = Array.from(this.activeFileTransferIds);
    for (const transferId of activeIds) {
      try {
        // Try cancelTransfer first (for stream transfers)
        if (this.bridge?.cancelTransfer) {
          await this.bridge.cancelTransfer(transferId);
        }
        // Also try cancelSftpUpload (for legacy uploads)
        if (this.bridge?.cancelSftpUpload) {
          await this.bridge.cancelSftpUpload(transferId);
        }
      } catch {
        // Ignore cancel errors
      }
    }

    // Also cancel current one if not in the set
    if (this.currentTransferId && !activeIds.includes(this.currentTransferId)) {
      try {
        if (this.bridge?.cancelTransfer) {
          await this.bridge.cancelTransfer(this.currentTransferId);
        }
        if (this.bridge?.cancelSftpUpload) {
          await this.bridge.cancelSftpUpload(this.currentTransferId);
        }
      } catch {
        // Ignore cancel errors
      }
    }
  }

  /**
   * Check if upload was cancelled
   */
  isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * Get all active transfer IDs
   */
  getActiveTransferIds(): string[] {
    const ids = Array.from(this.activeFileTransferIds);
    if (this.currentTransferId && !ids.includes(this.currentTransferId)) {
      ids.push(this.currentTransferId);
    }
    // Also include compression IDs
    const compressionIds = Array.from(this.activeCompressionIds);
    return [...ids, ...compressionIds];
  }

  /**
   * Reset controller state for new upload
   */
  reset(): void {
    this.cancelled = false;
    this.activeFileTransferIds.clear();
    this.activeCompressionIds.clear();
    this.currentTransferId = "";
  }

  /**
   * Set the bridge for cancellation
   */
  setBridge(bridge: UploadBridge): void {
    this.bridge = bridge;
  }

  /**
   * Track a file transfer ID
   */
  addActiveTransfer(id: string): void {
    this.activeFileTransferIds.add(id);
    this.currentTransferId = id;
  }

  /**
   * Remove a tracked file transfer ID
   */
  removeActiveTransfer(id: string): void {
    this.activeFileTransferIds.delete(id);
    if (this.currentTransferId === id) {
      this.currentTransferId = "";
    }
  }

  /**
   * Clear current transfer ID
   */
  clearCurrentTransfer(): void {
    this.currentTransferId = "";
  }

  /**
   * Track a compression ID
   */
  addActiveCompression(id: string): void {
    this.activeCompressionIds.add(id);
  }

  /**
   * Remove a tracked compression ID
   */
  removeActiveCompression(id: string): void {
    this.activeCompressionIds.delete(id);
  }
}

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
  const { targetPath, sftpId, isLocal, bridge, joinPath, callbacks, useCompressedUpload } = config;

  // Reset controller if provided
  if (controller) {
    controller.reset();
    controller.setBridge(bridge);
  }

  // Create scanning placeholder
  const scanningTaskId = crypto.randomUUID();
  callbacks?.onScanningStart?.(scanningTaskId);

  let entries: DropEntry[];
  try {
    entries = await extractDropEntries(dataTransfer);
  } finally {
    callbacks?.onScanningEnd?.(scanningTaskId);
  }

  if (entries.length === 0) {
    return [];
  }

  // Check if this is a folder upload and compressed upload is enabled
  if (useCompressedUpload && !isLocal && sftpId) {
    const rootFolders = detectRootFolders(entries);
    const folderEntries = Array.from(rootFolders.entries()).filter(([key]) => !key.startsWith("__file__"));
    const standaloneFileEntries = Array.from(rootFolders.entries()).filter(([key]) => key.startsWith("__file__"));

    if (folderEntries.length > 0) {
      try {
        const compressedResults = await uploadFoldersCompressed(folderEntries, targetPath, sftpId, callbacks, controller);

        // Check if any folders failed due to lack of compression support
        const failedFolders = compressedResults.filter(result =>
          !result.success && result.error === "Compressed upload not supported - fallback needed"
        );
        const successfulFolders = compressedResults.filter(result =>
          result.success || result.error !== "Compressed upload not supported - fallback needed"
        );

        let fallbackResults: UploadResult[] = [];
        if (failedFolders.length > 0) {
          // Get entries only for failed folders, not already successful ones
          const failedFolderNames = new Set(failedFolders.map(f => f.fileName));
          const failedFolderEntries = entries.filter(entry => {
            const topFolder = entry.relativePath.split('/')[0];
            return failedFolderNames.has(topFolder);
          });

          if (failedFolderEntries.length > 0) {
            fallbackResults = await uploadEntries(failedFolderEntries, targetPath, sftpId, isLocal, bridge, joinPath, callbacks, controller);
          }
        }

        // Upload standalone files using regular upload if any exist
        let standaloneResults: UploadResult[] = [];
        if (standaloneFileEntries.length > 0) {
          const standaloneEntries = standaloneFileEntries.flatMap(([, entries]) => entries);
          standaloneResults = await uploadEntries(standaloneEntries, targetPath, sftpId, isLocal, bridge, joinPath, callbacks, controller);
        }

        // Combine results: successful compressed + fallback results + standalone files
        return [...successfulFolders, ...fallbackResults, ...standaloneResults];
      } catch {
        // Fall back to regular upload
        return uploadEntries(entries, targetPath, sftpId, isLocal, bridge, joinPath, callbacks, controller);
      }
    }
  }

  return uploadEntries(entries, targetPath, sftpId, isLocal, bridge, joinPath, callbacks, controller);
}

/**
 * Upload a FileList or File array with bundled folder support
 */
export async function uploadFromFileList(
  fileList: FileList | File[],
  config: UploadConfig,
  controller?: UploadController
): Promise<UploadResult[]> {
  const { targetPath, sftpId, isLocal, bridge, joinPath, callbacks, useCompressedUpload } = config;

  if (controller) {
    controller.reset();
    controller.setBridge(bridge);
  }

  // Convert FileList to DropEntry array
  // Use webkitRelativePath for folder uploads, fallback to file.name for regular file uploads
  const entries: DropEntry[] = Array.from(fileList).map(file => {
    const localPath = getPathForFile(file);
    // Use webkitRelativePath if available (folder upload), otherwise use file.name (regular file upload)
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (localPath) {
      // Set the path property on the file for stream transfer
      (file as File & { path?: string }).path = localPath;
    }
    return {
      file,
      relativePath,
      isDirectory: false,
    };
  });

  if (entries.length === 0) {
    return [];
  }

  // Check if this is a folder upload and compressed upload is enabled
  if (useCompressedUpload && !isLocal && sftpId) {
    const rootFolders = detectRootFolders(entries);
    const folderEntries = Array.from(rootFolders.entries()).filter(([key]) => !key.startsWith("__file__"));
    const standaloneFileEntries = Array.from(rootFolders.entries()).filter(([key]) => key.startsWith("__file__"));

    if (folderEntries.length > 0) {
      try {
        const compressedResults = await uploadFoldersCompressed(folderEntries, targetPath, sftpId, callbacks, controller);

        // Check if any folders failed due to lack of compression support
        const failedFolders = compressedResults.filter(result =>
          !result.success && result.error === "Compressed upload not supported - fallback needed"
        );
        const successfulFolders = compressedResults.filter(result =>
          result.success || result.error !== "Compressed upload not supported - fallback needed"
        );

        let fallbackResults: UploadResult[] = [];
        if (failedFolders.length > 0) {
          // Get entries only for failed folders, not already successful ones
          const failedFolderNames = new Set(failedFolders.map(f => f.fileName));
          const failedFolderEntries = entries.filter(entry => {
            const topFolder = entry.relativePath.split('/')[0];
            return failedFolderNames.has(topFolder);
          });

          if (failedFolderEntries.length > 0) {
            fallbackResults = await uploadEntries(failedFolderEntries, targetPath, sftpId, isLocal, bridge, joinPath, callbacks, controller);
          }
        }

        // Upload standalone files using regular upload if any exist
        let standaloneResults: UploadResult[] = [];
        if (standaloneFileEntries.length > 0) {
          const standaloneEntries = standaloneFileEntries.flatMap(([, entries]) => entries);
          standaloneResults = await uploadEntries(standaloneEntries, targetPath, sftpId, isLocal, bridge, joinPath, callbacks, controller);
        }

        // Combine results: successful compressed + fallback results + standalone files
        return [...successfulFolders, ...fallbackResults, ...standaloneResults];
      } catch {
        // Fall back to regular upload
        return uploadEntries(entries, targetPath, sftpId, isLocal, bridge, joinPath, callbacks, controller);
      }
    }
  }

  return uploadEntries(entries, targetPath, sftpId, isLocal, bridge, joinPath, callbacks, controller);
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
  controller?: UploadController
): Promise<UploadResult[]> {
  const results: UploadResult[] = [];
  const createdDirs = new Set<string>();

  const ensureDirectory = async (dirPath: string) => {
    if (createdDirs.has(dirPath)) return;

    try {
      if (isLocal) {
        if (bridge.mkdirLocal) {
          await bridge.mkdirLocal(dirPath);
        }
      } else if (sftpId) {
        await bridge.mkdirSftp(sftpId, dirPath);
      }
      createdDirs.add(dirPath);
    } catch {
      createdDirs.add(dirPath);
    }
  };

  // Group entries by root folder
  const rootFolders = detectRootFolders(entries);
  const sortedEntries = sortEntries(entries);

  let wasCancelled = false;
  const yieldToMain = () => new Promise<void>(resolve => setTimeout(resolve, 0));

  // Track bundled task progress
  const bundleProgress = new Map<string, {
    totalBytes: number;
    transferredBytes: number;
    fileCount: number;
    completedCount: number;
    currentSpeed: number;
    completedFilesBytes: number;
  }>();

  // Create bundled tasks for each root folder
  const bundleTaskIds = new Map<string, string>(); // rootName -> bundleTaskId

  for (const [rootName, rootEntries] of rootFolders) {
    const isStandaloneFile = rootName.startsWith("__file__");
    if (isStandaloneFile) continue;

    // Calculate total bytes for this folder
    let totalBytes = 0;
    let fileCount = 0;
    for (const entry of rootEntries) {
      if (!entry.isDirectory && entry.file) {
        totalBytes += entry.file.size;
        fileCount++;
      }
    }

    if (fileCount === 0) continue;

    const bundleTaskId = crypto.randomUUID();
    bundleTaskIds.set(rootName, bundleTaskId);
    bundleProgress.set(bundleTaskId, {
      totalBytes,
      transferredBytes: 0,
      fileCount,
      completedCount: 0,
      currentSpeed: 0,
      completedFilesBytes: 0,
    });

    // Notify task created
    if (callbacks?.onTaskCreated) {
      const displayName = fileCount === 1 ? rootName : `${rootName} (${fileCount} files)`;
      callbacks.onTaskCreated({
        id: bundleTaskId,
        fileName: rootName,
        displayName,
        isDirectory: true,
        totalBytes,
        transferredBytes: 0,
        speed: 0,
        fileCount,
        completedCount: 0,
      });
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

  try {
    for (const entry of sortedEntries) {
      await yieldToMain();

      if (controller?.isCancelled()) {
        wasCancelled = true;
        // Mark all created tasks as cancelled before breaking
        for (const [, bundleTaskId] of bundleTaskIds) {
          const progress = bundleProgress.get(bundleTaskId);
          if (progress && progress.completedCount < progress.fileCount) {
            callbacks?.onTaskCancelled?.(bundleTaskId);
          }
        }
        break;
      }

      const entryTargetPath = joinPath(targetPath, entry.relativePath);
      const bundleTaskId = getBundleTaskId(entry);
      let standaloneTransferId = "";
      let fileTotalBytes = 0;

      try {
        if (entry.isDirectory) {
          await ensureDirectory(entryTargetPath);
        } else if (entry.file) {
          fileTotalBytes = entry.file.size;

          // For standalone files (not in a folder), create individual task
          if (!bundleTaskId) {
            standaloneTransferId = crypto.randomUUID();

            if (callbacks?.onTaskCreated) {
              callbacks.onTaskCreated({
                id: standaloneTransferId,
                fileName: entry.relativePath,
                displayName: entry.relativePath,
                isDirectory: false,
                totalBytes: fileTotalBytes,
                transferredBytes: 0,
                speed: 0,
                fileCount: 1,
                completedCount: 0,
              });
            }
          }

          // Ensure parent directories exist
          const pathParts = entry.relativePath.split('/');
          if (pathParts.length > 1) {
            let parentPath = targetPath;
            for (let i = 0; i < pathParts.length - 1; i++) {
              parentPath = joinPath(parentPath, pathParts[i]);
              await ensureDirectory(parentPath);
            }
          }

          // Check if file has a local path (Electron provides file.path for dropped files)
          const localFilePath = (entry.file as File & { path?: string }).path;

          // Use stream transfer if available and we have a local file path (avoids loading file into memory)
          if (localFilePath && bridge.startStreamTransfer && sftpId && !isLocal) {
            let pendingProgressUpdate: { transferred: number; total: number; speed: number } | null = null;
            let rafScheduled = false;

            const onProgress = (transferred: number, total: number, speed: number) => {
              if (controller?.isCancelled()) return;

              pendingProgressUpdate = { transferred, total, speed };

              if (!rafScheduled) {
                rafScheduled = true;
                requestAnimationFrame(() => {
                  rafScheduled = false;
                  const update = pendingProgressUpdate;
                  pendingProgressUpdate = null;

                  if (update && !controller?.isCancelled() && callbacks?.onTaskProgress) {
                    if (bundleTaskId) {
                      const progress = bundleProgress.get(bundleTaskId);
                      if (progress) {
                        // For bundled tasks, only update the current file's progress
                        // Don't add to completedFilesBytes until the file is fully completed
                        const newTransferred = progress.completedFilesBytes + update.transferred;
                        progress.transferredBytes = newTransferred;
                        progress.currentSpeed = update.speed;
                        const percent = progress.totalBytes > 0 ? (newTransferred / progress.totalBytes) * 100 : 0;
                        // Ensure progress doesn't exceed 99.9% until all files are completed
                        const displayPercent = progress.completedCount >= progress.fileCount ? percent : Math.min(percent, 99.9);
                        callbacks.onTaskProgress(bundleTaskId, {
                          transferred: newTransferred,
                          total: progress.totalBytes,
                          speed: update.speed,
                          percent: displayPercent,
                        });
                      }
                    } else if (standaloneTransferId) {
                      callbacks.onTaskProgress(standaloneTransferId, {
                        transferred: update.transferred,
                        total: update.total,
                        speed: update.speed,
                        percent: update.total > 0 ? (update.transferred / update.total) * 100 : 0,
                      });
                    }
                  }
                });
              }
            };

            const fileTransferId = crypto.randomUUID();
            controller?.addActiveTransfer(fileTransferId);

            let streamResult: { transferId: string; totalBytes?: number; error?: string; cancelled?: boolean } | undefined;
            try {
              streamResult = await bridge.startStreamTransfer(
                {
                  transferId: fileTransferId,
                  sourcePath: localFilePath,
                  targetPath: entryTargetPath,
                  sourceType: 'local',
                  targetType: 'sftp',
                  targetSftpId: sftpId,
                  totalBytes: fileTotalBytes,
                },
                onProgress,
                undefined,
                undefined
              );
            } finally {
              controller?.removeActiveTransfer(fileTransferId);
            }

            if (streamResult?.cancelled || streamResult?.error?.includes('cancelled')) {
              wasCancelled = true;
              const taskId = bundleTaskId || standaloneTransferId;
              if (taskId) {
                callbacks?.onTaskCancelled?.(taskId);
              }
              break;
            }

            if (streamResult?.error) {
              throw new Error(streamResult.error);
            }
          } else {
            // Fallback: load file into memory (for small files or when stream transfer is not available)
            const arrayBuffer = await entry.file.arrayBuffer();

            if (isLocal) {
              if (!bridge.writeLocalFile) {
                throw new Error("writeLocalFile not available");
              }
              await bridge.writeLocalFile(entryTargetPath, arrayBuffer);
            } else if (sftpId) {
              if (bridge.writeSftpBinaryWithProgress) {
                let pendingProgressUpdate: { transferred: number; total: number; speed: number } | null = null;
                let rafScheduled = false;

                const onProgress = (transferred: number, total: number, speed: number) => {
                  if (controller?.isCancelled()) return;

                  pendingProgressUpdate = { transferred, total, speed };

                  if (!rafScheduled) {
                    rafScheduled = true;
                    requestAnimationFrame(() => {
                      rafScheduled = false;
                      const update = pendingProgressUpdate;
                      pendingProgressUpdate = null;

                      if (update && !controller?.isCancelled() && callbacks?.onTaskProgress) {
                        if (bundleTaskId) {
                          const progress = bundleProgress.get(bundleTaskId);
                          if (progress) {
                            const newTransferred = progress.completedFilesBytes + update.transferred;
                            progress.transferredBytes = newTransferred;
                            progress.currentSpeed = update.speed;
                            const percent = progress.totalBytes > 0 ? (newTransferred / progress.totalBytes) * 100 : 0;
                            // Ensure progress doesn't show 100% until all files are completed
                            const displayPercent = progress.completedCount >= progress.fileCount ? percent : Math.min(percent, 99.9);
                            callbacks.onTaskProgress(bundleTaskId, {
                              transferred: newTransferred,
                              total: progress.totalBytes,
                              speed: update.speed,
                              percent: displayPercent,
                            });
                          }
                        } else if (standaloneTransferId) {
                          callbacks.onTaskProgress(standaloneTransferId, {
                            transferred: update.transferred,
                            total: update.total,
                            speed: update.speed,
                            percent: update.total > 0 ? (update.transferred / update.total) * 100 : 0,
                          });
                        }
                      }
                    });
                  }
                };

                // Use unique file transfer ID for backend cancellation tracking
                const fileTransferId = crypto.randomUUID();
                controller?.addActiveTransfer(fileTransferId);

                let result;
                try {
                  result = await bridge.writeSftpBinaryWithProgress(
                    sftpId,
                    entryTargetPath,
                    arrayBuffer,
                    fileTransferId,
                    onProgress,
                    () => {
                      // File upload completed successfully
                    },
                    (error) => {
                      // File upload failed - error is handled by the caller
                      void error;
                    }
                  );
                } finally {
                  controller?.removeActiveTransfer(fileTransferId);
                }

                if (result?.cancelled) {
                  wasCancelled = true;
                  const taskId = bundleTaskId || standaloneTransferId;
                  if (taskId) {
                    callbacks?.onTaskCancelled?.(taskId);
                  }
                  break;
                }

                if (!result || result.success === false) {
                  if (bridge.writeSftpBinary) {
                    await bridge.writeSftpBinary(sftpId, entryTargetPath, arrayBuffer);
                  } else {
                    throw new Error("Upload failed and no fallback method available");
                  }
                }
              } else if (bridge.writeSftpBinary) {
                await bridge.writeSftpBinary(sftpId, entryTargetPath, arrayBuffer);
              } else {
                throw new Error("No SFTP write method available");
              }
            }
          }

          // File processing completed (both stream transfer and fallback paths)
          controller?.clearCurrentTransfer();
          results.push({ fileName: entry.relativePath, success: true });

          // Update progress tracking
          if (bundleTaskId) {
            const progress = bundleProgress.get(bundleTaskId);
            if (progress) {
              progress.completedCount++;
              progress.completedFilesBytes += fileTotalBytes;
              // Set transferredBytes to completedFilesBytes to avoid double counting
              progress.transferredBytes = progress.completedFilesBytes;

              if (progress.completedCount >= progress.fileCount) {
                // All files completed - set final progress to 100% and mark as completed
                callbacks?.onTaskProgress?.(bundleTaskId, {
                  transferred: progress.totalBytes,
                  total: progress.totalBytes,
                  speed: 0,
                  percent: 100,
                });
                // Call completion callback synchronously
                callbacks?.onTaskCompleted?.(bundleTaskId, progress.totalBytes);
              } else if (callbacks?.onTaskProgress) {
                const percent = progress.totalBytes > 0 ? (progress.completedFilesBytes / progress.totalBytes) * 100 : 0;
                // Ensure progress doesn't exceed 99.9% until all files are completed
                const displayPercent = Math.min(percent, 99.9);
                callbacks.onTaskProgress(bundleTaskId, {
                  transferred: progress.completedFilesBytes,
                  total: progress.totalBytes,
                  speed: 0,
                  percent: displayPercent,
                });
              }
            }
          } else if (standaloneTransferId) {
            callbacks?.onTaskCompleted?.(standaloneTransferId, fileTotalBytes);
          }
        }
      } catch (error) {
        controller?.clearCurrentTransfer();

        // Check if this was a cancellation
        if (controller?.isCancelled()) {
          wasCancelled = true;
          const taskId = bundleTaskId || standaloneTransferId;
          if (taskId) {
            callbacks?.onTaskCancelled?.(taskId);
          }
          break;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);

        if (!entry.isDirectory) {
          results.push({
            fileName: entry.relativePath,
            success: false,
            error: errorMessage,
          });

          const taskId = bundleTaskId || standaloneTransferId;
          if (taskId) {
            callbacks?.onTaskFailed?.(taskId, errorMessage);
          }
        }

        // Any error stops the entire upload - fail fast approach
        // Note: We don't set wasCancelled here because this is an error, not a cancellation
        break;
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
  const { targetPath, sftpId, isLocal, bridge, joinPath, callbacks } = config;

  if (controller) {
    controller.reset();
    controller.setBridge(bridge);
  }

  return uploadEntries(entries, targetPath, sftpId, isLocal, bridge, joinPath, callbacks, controller);
}
/**
 * Upload folders using compression
 */
async function uploadFoldersCompressed(
  folderEntries: Array<[string, DropEntry[]]>,
  targetPath: string,
  sftpId: string,
  callbacks?: UploadCallbacks,
  controller?: UploadController
): Promise<UploadResult[]> {
  const results: UploadResult[] = [];
  
  // Import the compressed upload service
  const { startCompressedUpload, checkCompressedUploadSupport } = await import('../infrastructure/services/compressUploadService');
  
  for (const [folderName, entries] of folderEntries) {
    if (controller?.isCancelled()) {
      break;
    }

    // Get the local folder path from the first file in the folder
    const firstFile = entries.find(e => e.file);
    if (!firstFile?.file) {
      // Empty folder - mark for fallback to regular upload which will create the directory
      results.push({ fileName: folderName, success: false, error: "Compressed upload not supported - fallback needed" });
      continue;
    }
    
    const localFilePath = getPathForFile(firstFile.file);
    if (!localFilePath) {
      results.push({ fileName: folderName, success: false, error: "Could not get local file path" });
      continue;
    }

    // Extract folder path from the first file path
    // Use DropEntry.relativePath which works for both file input and drag-drop scenarios
    // For file input: webkitRelativePath is set (e.g., "folder/subdir/file.txt")
    // For drag-drop: DropEntry.relativePath contains the correct path from extractDropEntries
    const relativePath = firstFile.relativePath || (firstFile.file as File & { webkitRelativePath?: string }).webkitRelativePath || firstFile.file.name;
    
    // Normalize path separators for cross-platform compatibility
    const normalizePathSeparators = (path: string) => path.replace(/\\/g, '/');
    const normalizedLocalPath = normalizePathSeparators(localFilePath);
    const normalizedRelativePath = normalizePathSeparators(relativePath);
    
    // Calculate the root folder path by removing the full relativePath from localFilePath
    // For example: if localFilePath is "/Users/rice/Downloads/110-temp/insideServer/subdir/file.txt"
    // and relativePath is "insideServer/subdir/file.txt", we want "/Users/rice/Downloads/110-temp/insideServer"
    let folderPath = localFilePath;
    if (normalizedRelativePath && normalizedLocalPath.endsWith(normalizedRelativePath)) {
      // Remove the relativePath from the end to get the base directory
      const basePath = localFilePath.substring(0, localFilePath.length - relativePath.length);
      // Remove trailing slash/backslash if present
      const cleanBasePath = basePath.replace(/[/\\]$/, '');
      // Add the folder name to get the actual folder path
      folderPath = cleanBasePath + (cleanBasePath ? (localFilePath.includes('\\') ? '\\' : '/') : '') + folderName;
    } else {
      // Fallback: try to extract based on folder name with normalized separators
      const normalizedFolderPattern1 = '/' + folderName + '/';
      const normalizedFolderPattern2 = '\\' + folderName + '\\';
      const folderIndex1 = normalizedLocalPath.lastIndexOf(normalizedFolderPattern1);
      const folderIndex2 = localFilePath.lastIndexOf(normalizedFolderPattern2);
      const folderIndex = Math.max(folderIndex1, folderIndex2);
      
      if (folderIndex >= 0) {
        folderPath = localFilePath.substring(0, folderIndex + folderName.length + 1);
      } else {
        // Last resort: remove just the filename (original logic)
        const pathParts = normalizedRelativePath.split('/');
        if (pathParts.length > 1) {
          const fileName = pathParts[pathParts.length - 1];
          if (normalizedLocalPath.endsWith(fileName)) {
            folderPath = localFilePath.substring(0, localFilePath.length - fileName.length - 1);
          }
        } else {
          // Single file, get its parent directory
          const lastSlash = Math.max(localFilePath.lastIndexOf('/'), localFilePath.lastIndexOf('\\'));
          if (lastSlash > 0) {
            folderPath = localFilePath.substring(0, lastSlash);
          }
        }
      }
    }

    let taskId: string | null = null; // Declare taskId outside try block for error handling

    try {
      // Check if compressed upload is supported
      const support = await checkCompressedUploadSupport(sftpId);
      if (!support.supported) {
        // Fall back to regular upload for this folder
        results.push({
          fileName: folderName,
          success: false,
          error: "Compressed upload not supported - fallback needed"
        });
        continue;
      }
      
      const compressionId = crypto.randomUUID();
      
      // Check for cancellation before starting
      if (controller?.isCancelled()) {
        results.push({ fileName: folderName, success: false, cancelled: true });
        break;
      }
      
      // Register compression ID with controller for cancellation support
      controller?.addActiveCompression(compressionId);
      
      // Create a task for this folder compression
      const totalBytes = entries.reduce((sum, entry) => sum + (entry.file?.size || 0), 0);
      taskId = compressionId;
      
      if (callbacks?.onTaskCreated) {
        callbacks.onTaskCreated({
          id: taskId,
          fileName: folderName,
          displayName: `${folderName} (compressed)`,
          isDirectory: true,
          totalBytes,
          transferredBytes: 0,
          speed: 0,
          fileCount: entries.length,
          completedCount: 0,
        });
      }
      
      // Start compressed upload
      const result = await startCompressedUpload(
        {
          compressionId,
          folderPath,
          targetPath,
          sftpId,
          folderName,
        },
        (phase, transferred, total) => {
          // Check for cancellation during progress updates
          if (controller?.isCancelled()) {
            return;
          }

          if (callbacks?.onTaskProgress) {
            // Map compression progress to actual file bytes
            const progressPercent = total > 0 ? (transferred / total) * 100 : 0;
            const mappedTransferred = Math.floor((progressPercent / 100) * totalBytes);

            callbacks.onTaskProgress(taskId, {
              transferred: mappedTransferred,
              total: totalBytes,
              speed: 0, // Speed is handled by the compression service
              percent: progressPercent,
            });
          }

          // Update task name based on phase
          if (callbacks?.onTaskNameUpdate) {
            // Pass phase identifier for UI layer to handle i18n
            // Format: "folderName|phase" where phase is: compressing, extracting, uploading, or compressed
            const phaseKey = phase === 'compressing' ? 'compressing'
              : phase === 'extracting' ? 'extracting'
              : phase === 'uploading' ? 'uploading'
              : 'compressed';
            callbacks.onTaskNameUpdate(taskId, `${folderName}|${phaseKey}`);
          }
        },
        () => {
          // Remove compression ID from controller
          controller?.removeActiveCompression(compressionId);
          // Mark task as completed immediately
          if (callbacks?.onTaskCompleted) {
            callbacks.onTaskCompleted(taskId, totalBytes);
          }
        },
        (error) => {
          // Remove compression ID from controller on error
          controller?.removeActiveCompression(compressionId);
          if (callbacks?.onTaskFailed) {
            callbacks.onTaskFailed(taskId, error);
          }
        }
      );
      
      if (result.success) {
        results.push({ fileName: folderName, success: true });
      } else if (result.error?.includes('cancelled') || controller?.isCancelled()) {
        // Handle cancellation
        results.push({ fileName: folderName, success: false, cancelled: true });
        if (callbacks?.onTaskCancelled) {
          callbacks.onTaskCancelled(taskId);
        }
      } else {
        results.push({ fileName: folderName, success: false, error: result.error });
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Remove compression ID from controller on error
      if (taskId) {
        controller?.removeActiveCompression(taskId);
      }
      
      // Check if this was a cancellation
      if (controller?.isCancelled() || errorMessage.includes('cancelled')) {
        results.push({ fileName: folderName, success: false, cancelled: true });
        if (callbacks?.onTaskCancelled && taskId) {
          callbacks.onTaskCancelled(taskId);
        }
      } else {
        results.push({ fileName: folderName, success: false, error: errorMessage });
        // Only call onTaskFailed if we have a valid taskId (task was created) and it's not a cancellation
        if (callbacks?.onTaskFailed && taskId) {
          callbacks.onTaskFailed(taskId, errorMessage);
        }
      }
    }
  }
  
  return results;
}
