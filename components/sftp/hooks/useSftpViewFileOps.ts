import React, { useCallback, useState } from "react";
import type { MutableRefObject } from "react";
import type { RemoteFile, SftpFileEntry, SftpFilenameEncoding } from "../../../types";
import { joinPath as joinFsPath } from "../../../application/state/sftp/utils";
import type { SftpStateApi } from "../../../application/state/useSftpState";
import { logger } from "../../../lib/logger";
import { toast } from "../../ui/toast";
import { getFileExtension, FileOpenerType, SystemAppInfo } from "../../../lib/sftpFileUtils";
import { isNavigableDirectory } from "../index";

interface UseSftpViewFileOpsParams {
  sftpRef: MutableRefObject<SftpStateApi>;
  behaviorRef: MutableRefObject<string>;
  autoSyncRef: MutableRefObject<boolean>;
  getOpenerForFileRef: MutableRefObject<
    (fileName: string) => { openerType?: FileOpenerType; systemApp?: SystemAppInfo } | null
  >;
  setOpenerForExtension: (
    extension: string,
    openerType: FileOpenerType,
    systemApp?: SystemAppInfo,
  ) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  listSftp?: (sftpId: string, path: string, encoding?: SftpFilenameEncoding) => Promise<RemoteFile[]>;
  mkdirLocal?: (path: string) => Promise<unknown>;
  deleteLocalFile?: (path: string) => Promise<unknown>;
  showSaveDialog?: (defaultPath: string, filters?: Array<{ name: string; extensions: string[] }>) => Promise<string | null>;
  selectDirectory?: (title?: string, defaultPath?: string) => Promise<string | null>;
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
      sourceEncoding?: SftpFilenameEncoding;
      targetEncoding?: SftpFilenameEncoding;
    },
    onProgress?: (transferred: number, total: number, speed: number) => void,
    onComplete?: () => void,
    onError?: (error: string) => void
  ) => Promise<{ transferId: string; totalBytes?: number; error?: string }>;
  getSftpIdForConnection?: (connectionId: string) => string | undefined;
}

interface UseSftpViewFileOpsResult {
  permissionsState: { file: SftpFileEntry; side: "left" | "right" } | null;
  setPermissionsState: React.Dispatch<
    React.SetStateAction<{ file: SftpFileEntry; side: "left" | "right" } | null>
  >;
  showTextEditor: boolean;
  setShowTextEditor: React.Dispatch<React.SetStateAction<boolean>>;
  textEditorTarget: {
    file: SftpFileEntry;
    side: "left" | "right";
    fullPath: string;
  } | null;
  setTextEditorTarget: React.Dispatch<
    React.SetStateAction<{
      file: SftpFileEntry;
      side: "left" | "right";
      fullPath: string;
    } | null>
  >;
  textEditorContent: string;
  setTextEditorContent: React.Dispatch<React.SetStateAction<string>>;
  loadingTextContent: boolean;
  showFileOpenerDialog: boolean;
  setShowFileOpenerDialog: React.Dispatch<React.SetStateAction<boolean>>;
  fileOpenerTarget: {
    file: SftpFileEntry;
    side: "left" | "right";
    fullPath: string;
  } | null;
  setFileOpenerTarget: React.Dispatch<
    React.SetStateAction<{
      file: SftpFileEntry;
      side: "left" | "right";
      fullPath: string;
    } | null>
  >;
  handleSaveTextFile: (content: string) => Promise<void>;
  handleFileOpenerSelect: (
    openerType: FileOpenerType,
    setAsDefault: boolean,
    systemApp?: SystemAppInfo,
  ) => Promise<void>;
  handleSelectSystemApp: () => Promise<SystemAppInfo | null>;
  onEditPermissionsLeft: (file: SftpFileEntry) => void;
  onEditPermissionsRight: (file: SftpFileEntry) => void;
  onOpenEntryLeft: (entry: SftpFileEntry) => void;
  onOpenEntryRight: (entry: SftpFileEntry) => void;
  onEditFileLeft: (file: SftpFileEntry) => void;
  onEditFileRight: (file: SftpFileEntry) => void;
  onOpenFileLeft: (file: SftpFileEntry) => void;
  onOpenFileRight: (file: SftpFileEntry) => void;
  onOpenFileWithLeft: (file: SftpFileEntry) => void;
  onOpenFileWithRight: (file: SftpFileEntry) => void;
  onDownloadFileLeft: (file: SftpFileEntry) => void;
  onDownloadFileRight: (file: SftpFileEntry) => void;
  onUploadExternalFilesLeft: (dataTransfer: DataTransfer) => void;
  onUploadExternalFilesRight: (dataTransfer: DataTransfer) => void;
}

export const useSftpViewFileOps = ({
  sftpRef,
  behaviorRef,
  autoSyncRef,
  getOpenerForFileRef,
  setOpenerForExtension,
  t,
  listSftp,
  mkdirLocal,
  deleteLocalFile,
  showSaveDialog,
  selectDirectory,
  startStreamTransfer,
  getSftpIdForConnection,
}: UseSftpViewFileOpsParams): UseSftpViewFileOpsResult => {
  const [permissionsState, setPermissionsState] = useState<{
    file: SftpFileEntry;
    side: "left" | "right";
  } | null>(null);

  const [showTextEditor, setShowTextEditor] = useState(false);
  const [textEditorTarget, setTextEditorTarget] = useState<{
    file: SftpFileEntry;
    side: "left" | "right";
    fullPath: string;
    /** Host ID at the time the file was opened, to prevent saving to wrong host.
     * Uses hostId (not connectionId) because auto-reconnect after a transient
     * disconnect generates a fresh connectionId for the same endpoint. */
    hostId?: string;
  } | null>(null);
  const [textEditorContent, setTextEditorContent] = useState("");
  const [loadingTextContent, setLoadingTextContent] = useState(false);

  const [showFileOpenerDialog, setShowFileOpenerDialog] = useState(false);
  const [fileOpenerTarget, setFileOpenerTarget] = useState<{
    file: SftpFileEntry;
    side: "left" | "right";
    fullPath: string;
  } | null>(null);

  const onEditPermissionsLeft = useCallback(
    (file: SftpFileEntry) => setPermissionsState({ file, side: "left" }),
    [],
  );
  const onEditPermissionsRight = useCallback(
    (file: SftpFileEntry) => setPermissionsState({ file, side: "right" }),
    [],
  );

  const handleEditFileForSide = useCallback(
    async (side: "left" | "right", file: SftpFileEntry) => {
      const pane = side === "left" ? sftpRef.current.leftPane : sftpRef.current.rightPane;
      if (!pane.connection) return;

      const fullPath = sftpRef.current.joinPath(pane.connection.currentPath, file.name);

      try {
        setLoadingTextContent(true);
        setTextEditorTarget({ file, side, fullPath, hostId: pane.connection.hostId });

        const content = await sftpRef.current.readTextFile(side, fullPath);

        setTextEditorContent(content);
        setShowTextEditor(true);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to load file", "SFTP");
        setTextEditorTarget(null);
      } finally {
        setLoadingTextContent(false);
      }
    },
    [sftpRef],
  );

  const handleOpenFileForSide = useCallback(
    async (side: "left" | "right", file: SftpFileEntry) => {
      const pane = side === "left" ? sftpRef.current.leftPane : sftpRef.current.rightPane;
      if (!pane.connection) return;

      const fullPath = sftpRef.current.joinPath(pane.connection.currentPath, file.name);
      const savedOpener = getOpenerForFileRef.current(file.name);

      if (savedOpener && savedOpener.openerType) {
        if (savedOpener.openerType === "builtin-editor") {
          handleEditFileForSide(side, file);
          return;
        } else if (savedOpener.openerType === "system-app" && savedOpener.systemApp) {
          try {
            await sftpRef.current.downloadToTempAndOpen(
              side,
              fullPath,
              file.name,
              savedOpener.systemApp.path,
              { enableWatch: autoSyncRef.current },
            );
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed to open file", "SFTP");
          }
          return;
        }
      }

      setFileOpenerTarget({ file, side, fullPath });
      setShowFileOpenerDialog(true);
    },
    [sftpRef, handleEditFileForSide, getOpenerForFileRef, autoSyncRef],
  );

  const handleFileOpenerSelect = useCallback(
    async (openerType: FileOpenerType, setAsDefault: boolean, systemApp?: SystemAppInfo) => {
      if (!fileOpenerTarget) return;

      if (setAsDefault) {
        const ext = getFileExtension(fileOpenerTarget.file.name);
        setOpenerForExtension(ext, openerType, systemApp);
      }

      setShowFileOpenerDialog(false);

      if (openerType === "builtin-editor") {
        handleEditFileForSide(fileOpenerTarget.side, fileOpenerTarget.file);
      } else if (openerType === "system-app" && systemApp) {
        try {
          await sftpRef.current.downloadToTempAndOpen(
            fileOpenerTarget.side,
            fileOpenerTarget.fullPath,
            fileOpenerTarget.file.name,
            systemApp.path,
            { enableWatch: autoSyncRef.current },
          );
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Failed to open file", "SFTP");
        }
      }

      setFileOpenerTarget(null);
    },
    [fileOpenerTarget, setOpenerForExtension, handleEditFileForSide, autoSyncRef, sftpRef],
  );

  const handleSelectSystemApp = useCallback(async (): Promise<SystemAppInfo | null> => {
    const result = await sftpRef.current.selectApplication();
    if (result) {
      return { path: result.path, name: result.name };
    }
    return null;
  }, [sftpRef]);

  const handleSaveTextFile = useCallback(
    async (content: string) => {
      if (!textEditorTarget) return;

      // Verify the SFTP connection hasn't switched to a different host.
      // We check hostId (not connectionId) because auto-reconnect after a
      // transient disconnect generates a fresh connectionId for the same
      // endpoint.  The auto-connect effect in SftpSidePanel blocks
      // host-switching while the editor is open, so a hostId mismatch here
      // reliably indicates a genuinely different endpoint.
      const currentPane = textEditorTarget.side === "left"
        ? sftpRef.current.leftPane
        : sftpRef.current.rightPane;
      if (textEditorTarget.hostId && currentPane.connection?.hostId !== textEditorTarget.hostId) {
        throw new Error("SFTP connection changed while editing — file not saved to prevent writing to wrong host");
      }

      await sftpRef.current.writeTextFile(
        textEditorTarget.side,
        textEditorTarget.fullPath,
        content,
      );
    },
    [textEditorTarget, sftpRef],
  );

  const onEditFileLeft = useCallback(
    (file: SftpFileEntry) => handleEditFileForSide("left", file),
    [handleEditFileForSide],
  );
  const onEditFileRight = useCallback(
    (file: SftpFileEntry) => handleEditFileForSide("right", file),
    [handleEditFileForSide],
  );
  const onOpenFileLeft = useCallback(
    (file: SftpFileEntry) => handleOpenFileForSide("left", file),
    [handleOpenFileForSide],
  );
  const onOpenFileRight = useCallback(
    (file: SftpFileEntry) => handleOpenFileForSide("right", file),
    [handleOpenFileForSide],
  );

  const handleOpenFileWithForSide = useCallback(
    (side: "left" | "right", file: SftpFileEntry) => {
      const pane = side === "left" ? sftpRef.current.leftPane : sftpRef.current.rightPane;
      if (!pane.connection) return;

      const fullPath = sftpRef.current.joinPath(pane.connection.currentPath, file.name);
      setFileOpenerTarget({ file, side, fullPath });
      setShowFileOpenerDialog(true);
    },
    [sftpRef],
  );

  const onOpenFileWithLeft = useCallback(
    (file: SftpFileEntry) => handleOpenFileWithForSide("left", file),
    [handleOpenFileWithForSide],
  );
  const onOpenFileWithRight = useCallback(
    (file: SftpFileEntry) => handleOpenFileWithForSide("right", file),
    [handleOpenFileWithForSide],
  );

  const handleUploadExternalFilesForSide = useCallback(
    async (side: "left" | "right", dataTransfer: DataTransfer) => {
      try {
        const results = await sftpRef.current.uploadExternalFiles(side, dataTransfer);

        // Check if upload was cancelled
        if (results.some((r) => r.cancelled)) {
          toast.info(t("sftp.upload.cancelled"), "SFTP");
          return;
        }

        const failCount = results.filter((r) => !r.success && !r.cancelled).length;
        const successCount = results.filter((r) => r.success).length;

        if (failCount === 0) {
          const message =
            successCount === 1
              ? `${t("sftp.upload")}: ${results[0].fileName}`
              : `${t("sftp.uploadFiles")}: ${successCount}`;
          toast.success(message, "SFTP");
        } else {
          const failedFiles = results.filter((r) => !r.success && !r.cancelled);
          failedFiles.forEach((failed) => {
            const errorMsg = failed.error ? ` - ${failed.error}` : "";
            toast.error(
              `${t("sftp.error.uploadFailed")}: ${failed.fileName}${errorMsg}`,
              "SFTP",
            );
          });
        }
      } catch (error) {
        logger.error("[SftpView] Failed to upload external files:", error);
        toast.error(
          error instanceof Error ? error.message : t("sftp.error.uploadFailed"),
          "SFTP",
        );
      }
    },
    [sftpRef, t],
  );

  const onUploadExternalFilesLeft = useCallback(
    (dataTransfer: DataTransfer) => handleUploadExternalFilesForSide("left", dataTransfer),
    [handleUploadExternalFilesForSide],
  );

  const onUploadExternalFilesRight = useCallback(
    (dataTransfer: DataTransfer) => handleUploadExternalFilesForSide("right", dataTransfer),
    [handleUploadExternalFilesForSide],
  );

  const handleDownloadFileForSide = useCallback(
    async (side: "left" | "right", file: SftpFileEntry) => {
      const pane = side === "left" ? sftpRef.current.leftPane : sftpRef.current.rightPane;
      if (!pane.connection) return;

      const fullPath = sftpRef.current.joinPath(pane.connection.currentPath, file.name);
      const isDirectory = isNavigableDirectory(file);

      try {
        // For local files, use blob download.
        if (pane.connection.isLocal) {
          if (isDirectory) {
            toast.error(t("sftp.error.downloadFailed"), "SFTP");
            return;
          }

          const content = await sftpRef.current.readBinaryFile(side, fullPath);

          const blob = new Blob([content], { type: "application/octet-stream" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = file.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);

          toast.success(`${t("sftp.context.download")}: ${file.name}`, "SFTP");
          return;
        }

        // For remote SFTP files/directories, use streaming download with save dialog.
        if (!showSaveDialog || !startStreamTransfer || !getSftpIdForConnection) {
          toast.error(t("sftp.error.downloadFailed"), "SFTP");
          return;
        }

        const sftpId = getSftpIdForConnection(pane.connection.id);
        if (!sftpId) {
          throw new Error("SFTP session not found");
        }

        if (isDirectory) {
          if (!listSftp || !mkdirLocal || !selectDirectory) {
            toast.error(t("sftp.error.downloadFailed"), "SFTP");
            return;
          }

          const selectedDirectory = await selectDirectory(t("sftp.context.download"));
          if (!selectedDirectory) return;

          const targetPath = joinFsPath(selectedDirectory, file.name);

          const transferId = `download-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          let completedBytes = 0;
          const MAX_SYMLINK_DEPTH = 32;
          const DIRECTORY_DOWNLOAD_MAX_CONCURRENCY = 10;
          const activeChildTransferIds = new Set<string>();
          const activeFileProgress = new Map<string, { transferred: number; speed: number }>();
          const activeFileSizes = new Map<string, number>();
          const visitedPaths = new Set<string>();
          const directoryTaskQueue: Array<{
            type: "directory";
            remotePath: string;
            localPath: string;
            symlinkDepth: number;
          }> = [];
          const fileTaskQueue: Array<{
            type: "file";
            remotePath: string;
            localPath: string;
            size: number;
          }> = [];
          let pendingDirectoryTasks = 0;
          let discoveredTotalBytes = 0;
          let estimatedTotalBytes = 0;
          let activeQueueTasks = 0;

          const isTaskCancelled = () =>
            sftpRef.current.transfers.some(
              (task) => task.id === transferId && task.status === "cancelled",
            );

          const updateAggregateProgress = () => {
            let activeTransferredBytes = 0;
            let activeSpeed = 0;

            for (const progress of activeFileProgress.values()) {
              activeTransferredBytes += progress.transferred;
              activeSpeed += progress.speed;
            }

            sftpRef.current.updateExternalUpload(transferId, {
              fileName: pendingDirectoryTasks > 0 ? `${file.name} (${t("sftp.upload.scanning")})` : file.name,
              transferredBytes: completedBytes + activeTransferredBytes,
              totalBytes: estimatedTotalBytes > 0 ? estimatedTotalBytes : 0,
              speed: activeSpeed,
            });
          };

          const cancelActiveChildTransfers = async () => {
            await Promise.all(
              Array.from(activeChildTransferIds).map((childTransferId) =>
                sftpRef.current.cancelTransfer(childTransferId).catch(() => undefined),
              ),
            );
          };

          const maybeFinalizeDiscovery = () => {
            if (pendingDirectoryTasks === 0) {
              estimatedTotalBytes = discoveredTotalBytes;
              updateAggregateProgress();
            }
          };

          const getDynamicConcurrencyLimit = () => {
            let largeFiles = 0;
            let mediumFiles = 0;

            for (const size of activeFileSizes.values()) {
              if (size >= 32 * 1024 * 1024) largeFiles += 1;
              else if (size >= 1 * 1024 * 1024) mediumFiles += 1;
            }

            if (largeFiles > 0) return 2;
            if (mediumFiles >= 2) return 4;
            if (mediumFiles === 1) return 5;
            return DIRECTORY_DOWNLOAD_MAX_CONCURRENCY;
          };

          const enqueueDirectoryTask = (task: {
            type: "directory";
            remotePath: string;
            localPath: string;
            symlinkDepth: number;
          }) => {
            directoryTaskQueue.push(task);
          };

          const enqueueFileTask = (task: {
            type: "file";
            remotePath: string;
            localPath: string;
            size: number;
          }) => {
            const insertIndex = fileTaskQueue.findIndex((queuedTask) => queuedTask.size > task.size);
            if (insertIndex === -1) {
              fileTaskQueue.push(task);
            } else {
              fileTaskQueue.splice(insertIndex, 0, task);
            }
          };

          const dequeueTask = () => {
            if (pendingDirectoryTasks > 0 && directoryTaskQueue.length > 0) {
              return directoryTaskQueue.shift() ?? null;
            }
            if (fileTaskQueue.length > 0) return fileTaskQueue.shift() ?? null;
            if (directoryTaskQueue.length > 0) return directoryTaskQueue.shift() ?? null;
            return null;
          };

          const processFileTask = async (task: {
            type: "file";
            remotePath: string;
            localPath: string;
            size: number;
          }) => {
            const childTransferId = `download-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            activeChildTransferIds.add(childTransferId);
            activeFileSizes.set(childTransferId, task.size);
            activeFileProgress.set(childTransferId, { transferred: 0, speed: 0 });
            updateAggregateProgress();

            try {
              await new Promise<void>((resolve, reject) => {
                startStreamTransfer(
                  {
                    transferId: childTransferId,
                    sourcePath: task.remotePath,
                    targetPath: task.localPath,
                    sourceType: "sftp",
                    targetType: "local",
                    sourceSftpId: sftpId,
                    totalBytes: task.size,
                    sourceEncoding: pane.filenameEncoding,
                  },
                  (transferred, _total, speed) => {
                    if (isTaskCancelled()) {
                      sftpRef.current.cancelTransfer(childTransferId).catch(() => undefined);
                      return;
                    }

                    activeFileProgress.set(childTransferId, {
                      transferred,
                      speed: Number.isFinite(speed) && speed > 0 ? speed : 0,
                    });
                    updateAggregateProgress();
                  },
                  () => {
                    completedBytes += task.size;
                    activeChildTransferIds.delete(childTransferId);
                    activeFileSizes.delete(childTransferId);
                    activeFileProgress.delete(childTransferId);
                    updateAggregateProgress();
                    resolve();
                  },
                  (error) => {
                    activeChildTransferIds.delete(childTransferId);
                    activeFileSizes.delete(childTransferId);
                    activeFileProgress.delete(childTransferId);
                    updateAggregateProgress();
                    reject(new Error(error));
                  },
                )
                  .then((result) => {
                    if (result === undefined) {
                      activeChildTransferIds.delete(childTransferId);
                      activeFileSizes.delete(childTransferId);
                      activeFileProgress.delete(childTransferId);
                      updateAggregateProgress();
                      reject(new Error("Stream transfer unavailable"));
                    } else if (result.error) {
                      activeChildTransferIds.delete(childTransferId);
                      activeFileSizes.delete(childTransferId);
                      activeFileProgress.delete(childTransferId);
                      updateAggregateProgress();
                      reject(new Error(result.error));
                    }
                  })
                  .catch(reject);
              });
            } finally {
              activeChildTransferIds.delete(childTransferId);
              activeFileSizes.delete(childTransferId);
              activeFileProgress.delete(childTransferId);
            }
          };

          const processDirectoryTask = async (task: {
            type: "directory";
            remotePath: string;
            localPath: string;
            symlinkDepth: number;
          }) => {
            if (visitedPaths.has(task.remotePath)) {
              pendingDirectoryTasks -= 1;
              maybeFinalizeDiscovery();
              return;
            }

            visitedPaths.add(task.remotePath);

            if (isTaskCancelled()) {
              throw new Error("Transfer cancelled");
            }

            const entries = await listSftp(sftpId, task.remotePath, pane.filenameEncoding);

            for (const entry of entries) {
              if (entry.name === ".." || entry.name === ".") continue;

              if (isTaskCancelled()) {
                await cancelActiveChildTransfers();
                throw new Error("Transfer cancelled");
              }

              const remoteEntryPath = sftpRef.current.joinPath(task.remotePath, entry.name);
              const localEntryPath = joinFsPath(task.localPath, entry.name);
              const isRealDir = entry.type === "directory";
              const isSymlinkDir =
                entry.type === "symlink" && entry.linkTarget === "directory";

              if (isRealDir || isSymlinkDir) {
                if (isSymlinkDir && task.symlinkDepth >= MAX_SYMLINK_DEPTH) {
                  throw new Error(
                    "Maximum symlink directory depth exceeded (possible symlink cycle)",
                  );
                }

                try {
                  await mkdirLocal(localEntryPath);
                } catch (mkdirErr: unknown) {
                  const isEEXIST =
                    mkdirErr instanceof Error && mkdirErr.message.includes("EEXIST");
                  if (!isEEXIST) throw mkdirErr;
                }

                pendingDirectoryTasks += 1;
                enqueueDirectoryTask({
                  type: "directory",
                  remotePath: remoteEntryPath,
                  localPath: localEntryPath,
                  symlinkDepth: isSymlinkDir ? task.symlinkDepth + 1 : task.symlinkDepth,
                });
                continue;
              }

              const entrySize =
                typeof entry.size === "string"
                  ? parseInt(String(entry.size), 10) || 0
                  : entry.size || 0;
              discoveredTotalBytes += entrySize;
              enqueueFileTask({
                type: "file",
                remotePath: remoteEntryPath,
                localPath: localEntryPath,
                size: entrySize,
              });
            }

            pendingDirectoryTasks -= 1;
            maybeFinalizeDiscovery();
          };

          const runQueue = async () =>
            new Promise<void>((resolve, reject) => {
              let settled = false;

              const pump = () => {
                if (settled) return;

                if (isTaskCancelled()) {
                  settled = true;
                  void cancelActiveChildTransfers().finally(() =>
                    reject(new Error("Transfer cancelled")),
                  );
                  return;
                }

                while (
                  activeQueueTasks < getDynamicConcurrencyLimit()
                ) {
                  const nextTask = dequeueTask();
                  if (!nextTask) break;

                  activeQueueTasks += 1;
                  Promise.resolve(
                    nextTask.type === "directory"
                      ? processDirectoryTask(nextTask)
                      : processFileTask(nextTask),
                  )
                    .then(() => {
                      activeQueueTasks -= 1;
                      if (
                        !settled &&
                        fileTaskQueue.length === 0 &&
                        directoryTaskQueue.length === 0 &&
                        activeQueueTasks === 0 &&
                        pendingDirectoryTasks === 0
                      ) {
                        settled = true;
                        resolve();
                        return;
                      }
                      pump();
                    })
                    .catch((error) => {
                      if (settled) return;
                      settled = true;
                      void cancelActiveChildTransfers().finally(() => reject(error));
                    });
                }

                if (
                  !settled &&
                  fileTaskQueue.length === 0 &&
                  directoryTaskQueue.length === 0 &&
                  activeQueueTasks === 0 &&
                  pendingDirectoryTasks === 0
                ) {
                  settled = true;
                  resolve();
                }
              };

              pump();
            });

          sftpRef.current.addExternalUpload({
            id: transferId,
            fileName: `${file.name} (${t("sftp.upload.scanning")})`,
            sourcePath: fullPath,
            targetPath,
            sourceConnectionId: pane.connection.id,
            targetConnectionId: "local",
            direction: "download",
            status: "transferring",
            totalBytes: 0,
            transferredBytes: 0,
            speed: 0,
            startTime: Date.now(),
            isDirectory: true,
            retryable: false,
          });

          try {
            try {
              await mkdirLocal(targetPath);
            } catch (mkdirErr: unknown) {
              const isEEXIST =
                mkdirErr instanceof Error && mkdirErr.message.includes("EEXIST");
              if (isEEXIST && deleteLocalFile) {
                await deleteLocalFile(targetPath);
                await mkdirLocal(targetPath);
              } else {
                throw mkdirErr;
              }
            }

            pendingDirectoryTasks = 1;
            enqueueDirectoryTask({
              type: "directory",
              remotePath: fullPath,
              localPath: targetPath,
              symlinkDepth: 0,
            });
            await runQueue();

            sftpRef.current.updateExternalUpload(transferId, {
              status: "completed",
              fileName: file.name,
              transferredBytes: completedBytes,
              totalBytes: estimatedTotalBytes > 0 ? estimatedTotalBytes : completedBytes,
              speed: 0,
              endTime: Date.now(),
            });
            toast.success(`${t("sftp.context.download")}: ${file.name}`, "SFTP");
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : t("sftp.error.downloadFailed");
            const isCancelled =
              errorMessage.includes("cancelled") || errorMessage.includes("canceled");

            sftpRef.current.updateExternalUpload(transferId, {
              status: isCancelled ? "cancelled" : "failed",
              error: isCancelled ? undefined : errorMessage,
              speed: 0,
              endTime: Date.now(),
            });

            if (!isCancelled) {
              toast.error(errorMessage, "SFTP");
            }
          }

          return;
        }

        // Show save dialog to get target path
        const targetPath = await showSaveDialog(file.name);
        if (!targetPath) {
          // User cancelled
          return;
        }

        const transferId = `download-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const fileSize = typeof file.size === 'string' ? parseInt(file.size, 10) || 0 : (file.size || 0);

        // Add download task to transfer queue for progress display
        sftpRef.current.addExternalUpload({
          id: transferId,
          fileName: file.name,
          sourcePath: fullPath,
          targetPath,
          sourceConnectionId: pane.connection.id,
          targetConnectionId: 'local',
          direction: 'download',
          status: 'transferring',
          totalBytes: fileSize,
          transferredBytes: 0,
          speed: 0,
          startTime: Date.now(),
          isDirectory: false,
        });

        // Track if error was already handled by callback
        let errorHandled = false;

        const result = await startStreamTransfer(
          {
            transferId,
            sourcePath: fullPath,
            targetPath,
            sourceType: 'sftp',
            targetType: 'local',
            sourceSftpId: sftpId,
            totalBytes: fileSize,
            sourceEncoding: pane.filenameEncoding,
          },
          (transferred, total, speed) => {
            // Update transfer progress in the queue
            sftpRef.current.updateExternalUpload(transferId, {
              transferredBytes: transferred,
              totalBytes: total,
              speed,
            });
          },
          () => {
            // Mark as completed
            sftpRef.current.updateExternalUpload(transferId, {
              status: 'completed',
              transferredBytes: fileSize,
              endTime: Date.now(),
            });
            toast.success(`${t("sftp.context.download")}: ${file.name}`, "SFTP");
          },
          (error) => {
            errorHandled = true;
            // Check if this is a cancellation - don't show error toast for cancellations
            const isCancelError = error.includes('cancelled') || error.includes('canceled');
            sftpRef.current.updateExternalUpload(transferId, {
              status: isCancelError ? 'cancelled' : 'failed',
              error: isCancelError ? undefined : error,
              endTime: Date.now(),
            });
            if (!isCancelError) {
              toast.error(error, "SFTP");
            }
          }
        );

        // Check if bridge doesn't support streaming (returns undefined)
        if (result === undefined) {
          sftpRef.current.updateExternalUpload(transferId, {
            status: 'failed',
            error: t("sftp.error.downloadFailed"),
            endTime: Date.now(),
          });
          toast.error(t("sftp.error.downloadFailed"), "SFTP");
          return;
        }

        // Handle error from result only if onError callback wasn't called
        if (result?.error && !errorHandled) {
          const isCancelError = result.error.includes('cancelled') || result.error.includes('canceled');
          sftpRef.current.updateExternalUpload(transferId, {
            status: isCancelError ? 'cancelled' : 'failed',
            error: isCancelError ? undefined : result.error,
            endTime: Date.now(),
          });
          if (!isCancelError) {
            toast.error(result.error, "SFTP");
          }
        }
      } catch (e) {
        logger.error("[SftpView] Failed to download file:", e);
        toast.error(
          e instanceof Error ? e.message : t("sftp.error.downloadFailed"),
          "SFTP",
        );
      }
    },
    [
      sftpRef,
      t,
      listSftp,
      mkdirLocal,
      deleteLocalFile,
      showSaveDialog,
      selectDirectory,
      startStreamTransfer,
      getSftpIdForConnection,
    ],
  );

  const onDownloadFileLeft = useCallback(
    (file: SftpFileEntry) => handleDownloadFileForSide("left", file),
    [handleDownloadFileForSide],
  );

  const onDownloadFileRight = useCallback(
    (file: SftpFileEntry) => handleDownloadFileForSide("right", file),
    [handleDownloadFileForSide],
  );

  const onOpenEntryLeft = useCallback(
    (entry: SftpFileEntry) => {
      const isDir = isNavigableDirectory(entry);

      if (entry.name === ".." || isDir) {
        sftpRef.current.openEntry("left", entry);
        return;
      }

      if (behaviorRef.current === "transfer") {
        const fileData = [{
          name: entry.name,
          isDirectory: isDir,
        }];
        sftpRef.current.startTransfer(fileData, "left", "right");
      } else {
        onOpenFileLeft(entry);
      }
    },
    [sftpRef, onOpenFileLeft, behaviorRef],
  );

  const onOpenEntryRight = useCallback(
    (entry: SftpFileEntry) => {
      const isDir = isNavigableDirectory(entry);

      if (entry.name === ".." || isDir) {
        sftpRef.current.openEntry("right", entry);
        return;
      }

      if (behaviorRef.current === "transfer") {
        const fileData = [{
          name: entry.name,
          isDirectory: isDir,
        }];
        sftpRef.current.startTransfer(fileData, "right", "left");
      } else {
        onOpenFileRight(entry);
      }
    },
    [sftpRef, onOpenFileRight, behaviorRef],
  );

  return {
    permissionsState,
    setPermissionsState,
    showTextEditor,
    setShowTextEditor,
    textEditorTarget,
    setTextEditorTarget,
    textEditorContent,
    setTextEditorContent,
    loadingTextContent,
    showFileOpenerDialog,
    setShowFileOpenerDialog,
    fileOpenerTarget,
    setFileOpenerTarget,
    handleSaveTextFile,
    handleFileOpenerSelect,
    handleSelectSystemApp,
    onEditPermissionsLeft,
    onEditPermissionsRight,
    onOpenEntryLeft,
    onOpenEntryRight,
    onEditFileLeft,
    onEditFileRight,
    onOpenFileLeft,
    onOpenFileRight,
    onOpenFileWithLeft,
    onOpenFileWithRight,
    onDownloadFileLeft,
    onDownloadFileRight,
    onUploadExternalFilesLeft,
    onUploadExternalFilesRight,
  };
};
