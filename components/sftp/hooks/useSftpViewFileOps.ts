import React, { useCallback, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { SftpFileEntry, SftpFilenameEncoding } from "../../../types";
import { getParentPath, joinPath as joinFsPath } from "../../../application/state/sftp/utils";
import type { SftpStateApi } from "../../../application/state/useSftpState";
import { logger } from "../../../lib/logger";
import { toast } from "../../ui/toast";
import { getFileExtension, getLanguageId, FileOpenerType, SystemAppInfo } from "../../../lib/sftpFileUtils";
import { isNavigableDirectory } from "../index";
import { editorTabStore } from "../../../application/state/editorTabStore";
import { toEditorTabId, activeTabStore } from "../../../application/state/activeTabStore";
import type { TextEditorModalSnapshot } from "../../TextEditorModal";

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
  permissionsState: { file: SftpFileEntry; side: "left" | "right"; fullPath: string } | null;
  setPermissionsState: React.Dispatch<
    React.SetStateAction<{ file: SftpFileEntry; side: "left" | "right"; fullPath: string } | null>
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
  onPromoteToTab: (snapshot: TextEditorModalSnapshot) => void;
  handleFileOpenerSelect: (
    openerType: FileOpenerType,
    setAsDefault: boolean,
    systemApp?: SystemAppInfo,
  ) => Promise<void>;
  handleSelectSystemApp: () => Promise<SystemAppInfo | null>;
  onEditPermissionsLeft: (file: SftpFileEntry, fullPath?: string) => void;
  onEditPermissionsRight: (file: SftpFileEntry, fullPath?: string) => void;
  onOpenEntryLeft: (entry: SftpFileEntry, fullPath?: string) => void;
  onOpenEntryRight: (entry: SftpFileEntry, fullPath?: string) => void;
  onEditFileLeft: (file: SftpFileEntry, fullPath?: string) => void;
  onEditFileRight: (file: SftpFileEntry, fullPath?: string) => void;
  onOpenFileLeft: (file: SftpFileEntry, fullPath?: string) => void;
  onOpenFileRight: (file: SftpFileEntry, fullPath?: string) => void;
  onOpenFileWithLeft: (file: SftpFileEntry, fullPath?: string) => void;
  onOpenFileWithRight: (file: SftpFileEntry, fullPath?: string) => void;
  onDownloadFileLeft: (file: SftpFileEntry, fullPath?: string) => void;
  onDownloadFileRight: (file: SftpFileEntry, fullPath?: string) => void;
  onUploadExternalFilesLeft: (dataTransfer: DataTransfer, targetPath?: string) => void;
  onUploadExternalFilesRight: (dataTransfer: DataTransfer, targetPath?: string) => void;
}

export const useSftpViewFileOps = ({
  sftpRef,
  behaviorRef,
  autoSyncRef,
  getOpenerForFileRef,
  setOpenerForExtension,
  t,
  showSaveDialog,
  selectDirectory,
  startStreamTransfer,
  getSftpIdForConnection,
}: UseSftpViewFileOpsParams): UseSftpViewFileOpsResult => {
  const [permissionsState, setPermissionsState] = useState<{
    file: SftpFileEntry;
    side: "left" | "right";
    fullPath: string;
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

  // Refs for frequently-changing state used inside stable callbacks
  const fileOpenerTargetRef = useRef(fileOpenerTarget);
  fileOpenerTargetRef.current = fileOpenerTarget;
  const textEditorTargetRef = useRef(textEditorTarget);
  textEditorTargetRef.current = textEditorTarget;

  const onEditPermissionsLeft = useCallback(
    (file: SftpFileEntry, fullPath?: string) => {
      const pane = sftpRef.current.leftPane;
      if (!pane.connection) return;
      setPermissionsState({
        file,
        side: "left",
        fullPath: fullPath ?? sftpRef.current.joinPath(pane.connection.currentPath, file.name),
      });
    },
    [sftpRef],
  );
  const onEditPermissionsRight = useCallback(
    (file: SftpFileEntry, fullPath?: string) => {
      const pane = sftpRef.current.rightPane;
      if (!pane.connection) return;
      setPermissionsState({
        file,
        side: "right",
        fullPath: fullPath ?? sftpRef.current.joinPath(pane.connection.currentPath, file.name),
      });
    },
    [sftpRef],
  );

  const handleEditFileForSide = useCallback(
    async (side: "left" | "right", file: SftpFileEntry, fullPath?: string) => {
      const pane = side === "left" ? sftpRef.current.leftPane : sftpRef.current.rightPane;
      if (!pane.connection) return;

      const resolvedFullPath = fullPath ?? sftpRef.current.joinPath(pane.connection.currentPath, file.name);

      try {
        setLoadingTextContent(true);
        setTextEditorTarget({ file, side, fullPath: resolvedFullPath, hostId: pane.connection.hostId });

        const content = await sftpRef.current.readTextFile(side, resolvedFullPath);

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
    async (side: "left" | "right", file: SftpFileEntry, fullPath?: string) => {
      const pane = side === "left" ? sftpRef.current.leftPane : sftpRef.current.rightPane;
      if (!pane.connection) return;

      const resolvedFullPath = fullPath ?? sftpRef.current.joinPath(pane.connection.currentPath, file.name);
      const savedOpener = getOpenerForFileRef.current(file.name);

      if (savedOpener && savedOpener.openerType) {
        if (savedOpener.openerType === "builtin-editor") {
          handleEditFileForSide(side, file, resolvedFullPath);
          return;
        } else if (savedOpener.openerType === "system-app" && savedOpener.systemApp) {
          try {
            await sftpRef.current.downloadToTempAndOpen(
              side,
              resolvedFullPath,
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

      setFileOpenerTarget({ file, side, fullPath: resolvedFullPath });
      setShowFileOpenerDialog(true);
    },
    [sftpRef, handleEditFileForSide, getOpenerForFileRef, autoSyncRef],
  );

  const handleFileOpenerSelect = useCallback(
    async (openerType: FileOpenerType, setAsDefault: boolean, systemApp?: SystemAppInfo) => {
      const target = fileOpenerTargetRef.current;
      if (!target) return;

      if (setAsDefault) {
        const ext = getFileExtension(target.file.name);
        setOpenerForExtension(ext, openerType, systemApp);
      }

      setShowFileOpenerDialog(false);

      if (openerType === "builtin-editor") {
        handleEditFileForSide(target.side, target.file, target.fullPath);
      } else if (openerType === "system-app" && systemApp) {
        try {
          await sftpRef.current.downloadToTempAndOpen(
            target.side,
            target.fullPath,
            target.file.name,
            systemApp.path,
            { enableWatch: autoSyncRef.current },
          );
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Failed to open file", "SFTP");
        }
      }

      setFileOpenerTarget(null);
    },
    [setOpenerForExtension, handleEditFileForSide, autoSyncRef, sftpRef],
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
      const target = textEditorTargetRef.current;
      if (!target) return;

      // Verify the SFTP connection hasn't switched to a different host.
      // We check hostId (not connectionId) because auto-reconnect after a
      // transient disconnect generates a fresh connectionId for the same
      // endpoint.  The auto-connect effect in SftpSidePanel blocks
      // host-switching while the editor is open, so a hostId mismatch here
      // reliably indicates a genuinely different endpoint.
      const currentPane = target.side === "left"
        ? sftpRef.current.leftPane
        : sftpRef.current.rightPane;
      if (target.hostId && currentPane.connection?.hostId !== target.hostId) {
        throw new Error("SFTP connection changed while editing — file not saved to prevent writing to wrong host");
      }

      await sftpRef.current.writeTextFile(
        target.side,
        target.fullPath,
        content,
      );
    },
    [sftpRef],
  );

  const handlePromoteToTab = useCallback((snapshot: TextEditorModalSnapshot) => {
    const target = textEditorTargetRef.current;
    if (!target) return;
    const pane = target.side === "left" ? sftpRef.current.leftPane : sftpRef.current.rightPane;
    const connection = pane.connection;
    if (!connection || !target.hostId) return;

    const editorId = editorTabStore.promoteFromModal({
      sessionId: connection.id,
      hostId: target.hostId,
      remotePath: target.fullPath,
      fileName: target.file.name,
      languageId: snapshot.languageId || getLanguageId(target.file.name),
      content: snapshot.content,
      baselineContent: snapshot.baselineContent,
      wordWrap: snapshot.wordWrap,
      viewState: snapshot.viewState,
    });
    activeTabStore.setActiveTabId(toEditorTabId(editorId));
    // Close the modal
    setShowTextEditor(false);
    setTextEditorTarget(null);
    setTextEditorContent("");
  }, [sftpRef]);

  const onEditFileLeft = useCallback(
    (file: SftpFileEntry, fullPath?: string) => handleEditFileForSide("left", file, fullPath),
    [handleEditFileForSide],
  );
  const onEditFileRight = useCallback(
    (file: SftpFileEntry, fullPath?: string) => handleEditFileForSide("right", file, fullPath),
    [handleEditFileForSide],
  );
  const onOpenFileLeft = useCallback(
    (file: SftpFileEntry, fullPath?: string) => handleOpenFileForSide("left", file, fullPath),
    [handleOpenFileForSide],
  );
  const onOpenFileRight = useCallback(
    (file: SftpFileEntry, fullPath?: string) => handleOpenFileForSide("right", file, fullPath),
    [handleOpenFileForSide],
  );

  const handleOpenFileWithForSide = useCallback(
    (side: "left" | "right", file: SftpFileEntry, fullPath?: string) => {
      const pane = side === "left" ? sftpRef.current.leftPane : sftpRef.current.rightPane;
      if (!pane.connection) return;

      const resolvedFullPath = fullPath ?? sftpRef.current.joinPath(pane.connection.currentPath, file.name);
      setFileOpenerTarget({ file, side, fullPath: resolvedFullPath });
      setShowFileOpenerDialog(true);
    },
    [sftpRef],
  );

  const onOpenFileWithLeft = useCallback(
    (file: SftpFileEntry, fullPath?: string) => handleOpenFileWithForSide("left", file, fullPath),
    [handleOpenFileWithForSide],
  );
  const onOpenFileWithRight = useCallback(
    (file: SftpFileEntry, fullPath?: string) => handleOpenFileWithForSide("right", file, fullPath),
    [handleOpenFileWithForSide],
  );

  const handleUploadExternalFilesForSide = useCallback(
    async (side: "left" | "right", dataTransfer: DataTransfer, targetPath?: string) => {
      try {
        const results = await sftpRef.current.uploadExternalFiles(side, dataTransfer, targetPath);

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
    (dataTransfer: DataTransfer, targetPath?: string) => handleUploadExternalFilesForSide("left", dataTransfer, targetPath),
    [handleUploadExternalFilesForSide],
  );

  const onUploadExternalFilesRight = useCallback(
    (dataTransfer: DataTransfer, targetPath?: string) => handleUploadExternalFilesForSide("right", dataTransfer, targetPath),
    [handleUploadExternalFilesForSide],
  );

  const handleDownloadFileForSide = useCallback(
    async (side: "left" | "right", file: SftpFileEntry, fullPath?: string) => {
      const pane = side === "left" ? sftpRef.current.leftPane : sftpRef.current.rightPane;
      if (!pane.connection) return;

      const resolvedFullPath = fullPath ?? sftpRef.current.joinPath(pane.connection.currentPath, file.name);
      const isDirectory = isNavigableDirectory(file);

      try {
        // For local files, use blob download.
        if (pane.connection.isLocal) {
          if (isDirectory) {
            toast.error(t("sftp.error.downloadFailed"), "SFTP");
            return;
          }

          const content = await sftpRef.current.readBinaryFile(side, resolvedFullPath);

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
          if (!selectDirectory) {
            toast.error(t("sftp.error.downloadFailed"), "SFTP");
            return;
          }

          const selectedDirectory = await selectDirectory(t("sftp.context.download"));
          if (!selectedDirectory) return;

          const targetPath = joinFsPath(selectedDirectory, file.name);

          try {
            const status = await sftpRef.current.downloadToLocal({
              fileName: file.name,
              sourcePath: resolvedFullPath,
              targetPath,
              sftpId,
              connectionId: pane.connection.id,
              sourceEncoding: pane.filenameEncoding,
              isDirectory: true,
            });
            if (status === "completed") {
              toast.success(`${t("sftp.context.download")}: ${file.name}`, "SFTP");
            } else if (status === "failed") {
              toast.error(`${t("sftp.error.downloadFailed")}: ${file.name}`, "SFTP");
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : t("sftp.error.downloadFailed");
            if (!errorMessage.includes("cancelled") && !errorMessage.includes("canceled")) {
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
          sourcePath: resolvedFullPath,
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
            sourcePath: resolvedFullPath,
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
      showSaveDialog,
      selectDirectory,
      startStreamTransfer,
      getSftpIdForConnection,
    ],
  );

  const onDownloadFileLeft = useCallback(
    (file: SftpFileEntry, fullPath?: string) => handleDownloadFileForSide("left", file, fullPath),
    [handleDownloadFileForSide],
  );

  const onDownloadFileRight = useCallback(
    (file: SftpFileEntry, fullPath?: string) => handleDownloadFileForSide("right", file, fullPath),
    [handleDownloadFileForSide],
  );

  const onOpenEntryLeft = useCallback(
    (entry: SftpFileEntry, fullPath?: string) => {
      const pane = sftpRef.current.leftPane;
      const isDir = isNavigableDirectory(entry);

      if (entry.name === ".." || isDir) {
        sftpRef.current.openEntry("left", entry);
        return;
      }

      if (behaviorRef.current === "transfer") {
        const sourcePath = fullPath ? getParentPath(fullPath) : pane.connection?.currentPath;
        const sourceConnectionId = pane.connection?.id;
        const fileData = [{
          name: entry.name,
          isDirectory: isDir,
          sourceConnectionId,
          sourcePath,
        }];
        sftpRef.current.startTransfer(fileData, "left", "right", {
          sourceConnectionId,
          sourcePath,
        });
      } else {
        onOpenFileLeft(entry, fullPath);
      }
    },
    [sftpRef, onOpenFileLeft, behaviorRef],
  );

  const onOpenEntryRight = useCallback(
    (entry: SftpFileEntry, fullPath?: string) => {
      const pane = sftpRef.current.rightPane;
      const isDir = isNavigableDirectory(entry);

      if (entry.name === ".." || isDir) {
        sftpRef.current.openEntry("right", entry);
        return;
      }

      if (behaviorRef.current === "transfer") {
        const sourcePath = fullPath ? getParentPath(fullPath) : pane.connection?.currentPath;
        const sourceConnectionId = pane.connection?.id;
        const fileData = [{
          name: entry.name,
          isDirectory: isDir,
          sourceConnectionId,
          sourcePath,
        }];
        sftpRef.current.startTransfer(fileData, "right", "left", {
          sourceConnectionId,
          sourcePath,
        });
      } else {
        onOpenFileRight(entry, fullPath);
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
    onPromoteToTab: handlePromoteToTab,
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
