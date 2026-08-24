import { useCallback, useRef, useState } from "react";
import type { SftpFileEntry } from "../../../types";
import type { TransferStatus } from "../../../domain/models";
import { getParentPath, joinPath as joinFsPath } from "../../../application/state/sftp/utils";
import {
  DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY,
  runBoundedConcurrency,
} from "../../../application/state/sftp/transferConcurrency";
import { logger } from "../../../lib/logger";
import { toast } from "../../ui/toast";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { getFileExtension, getLanguageId, FileOpenerType, SystemAppInfo } from "../../../lib/sftpFileUtils";
import { isNavigableDirectory } from "../utils";
import { reportSftpUploadResults } from "../reportSftpUploadResults";
import { editorTabStore } from "../../../application/state/editorTabStore";
import { toEditorTabId, activeTabStore } from "../../../application/state/activeTabStore";
import type { TextEditorModalSnapshot } from "../../TextEditorModal";
import type { UseSftpViewFileOpsParams, UseSftpViewFileOpsResult } from "./useSftpViewFileOps.types";
import { assertSftpFileFitsBuiltinEditor } from "../sftpEditorFileLimits";

/** Local multi-select blob downloads read whole files into ArrayBuffers. */
const LOCAL_BLOB_DOWNLOAD_CONCURRENCY = 1;
/**
 * Multi-select roots each start their own interleaved folder walk / session
 * work. Bound them so many selected directories cannot stampede the scheduler.
 */
const MULTI_SELECT_ROOT_DOWNLOAD_CONCURRENCY = DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY;

export const useSftpViewFileOps = ({
  sftpRef,
  behaviorRef,
  autoSyncRef,
  getOpenerForFileRef,
  setOpenerForExtension,
  t,
  showSaveDialog,
  selectDirectory,
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
        assertSftpFileFitsBuiltinEditor(file.size);
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
      sftpTabId: pane.id,
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

  const handleOpenFileWithSystemDefaultForSide = useCallback(
    (side: "left" | "right", file: SftpFileEntry, fullPath?: string) => {
      const pane = side === "left" ? sftpRef.current.leftPane : sftpRef.current.rightPane;
      if (!pane.connection) return;

      const resolvedFullPath = fullPath ?? sftpRef.current.joinPath(pane.connection.currentPath, file.name);
      void sftpRef.current.openWithSystemDefault(side, resolvedFullPath, file.name, { enableWatch: autoSyncRef.current });
    },
    [sftpRef, autoSyncRef],
  );

  const onOpenFileWithSystemDefaultLeft = useCallback(
    (file: SftpFileEntry, fullPath?: string) => handleOpenFileWithSystemDefaultForSide("left", file, fullPath),
    [handleOpenFileWithSystemDefaultForSide],
  );
  const onOpenFileWithSystemDefaultRight = useCallback(
    (file: SftpFileEntry, fullPath?: string) => handleOpenFileWithSystemDefaultForSide("right", file, fullPath),
    [handleOpenFileWithSystemDefaultForSide],
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
        reportSftpUploadResults({ results, t, toast });
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

  const handleUploadExternalFileListForSide = useCallback(
    async (side: "left" | "right", fileList: FileList, targetPath?: string) => {
      try {
        const results = await sftpRef.current.uploadExternalFileList(side, fileList, targetPath);
        reportSftpUploadResults({ results, t, toast });
      } catch (error) {
        logger.error("[SftpView] Failed to upload picked files:", error);
        toast.error(
          error instanceof Error ? error.message : t("sftp.error.uploadFailed"),
          "SFTP",
        );
      }
    },
    [sftpRef, t],
  );

  const onUploadExternalFileListLeft = useCallback(
    (fileList: FileList, targetPath?: string) => handleUploadExternalFileListForSide("left", fileList, targetPath),
    [handleUploadExternalFileListForSide],
  );

  const onUploadExternalFileListRight = useCallback(
    (fileList: FileList, targetPath?: string) => handleUploadExternalFileListForSide("right", fileList, targetPath),
    [handleUploadExternalFileListForSide],
  );

  const handleUploadExternalFolderForSide = useCallback(
    async (side: "left" | "right", targetPath?: string) => {
      if (!selectDirectory) {
        toast.error(t("sftp.error.uploadFailed"), "SFTP");
        return;
      }

      const selectedDirectory = await selectDirectory(t("sftp.context.uploadFolder"));
      if (!selectedDirectory) return;

      try {
        const results = await sftpRef.current.uploadExternalFolderPath(side, selectedDirectory, targetPath);
        const folderName = selectedDirectory.split(/[/\\]/).filter(Boolean).pop() || selectedDirectory;
        reportSftpUploadResults({
          results,
          t,
          toast,
          successMessage: `${t("sftp.uploadFolder")}: ${folderName}`,
        });
      } catch (error) {
        logger.error("[SftpView] Failed to upload picked folder:", error);
        toast.error(
          error instanceof Error ? error.message : t("sftp.error.uploadFailed"),
          "SFTP",
        );
      }
    },
    [selectDirectory, sftpRef, t],
  );

  const onUploadExternalFolderLeft = useCallback(
    (targetPath?: string) => handleUploadExternalFolderForSide("left", targetPath),
    [handleUploadExternalFolderForSide],
  );

  const onUploadExternalFolderRight = useCallback(
    (targetPath?: string) => handleUploadExternalFolderForSide("right", targetPath),
    [handleUploadExternalFolderForSide],
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

        // For remote SFTP files/directories, use transfer-center downloads
        // (dedicated pool sessions via downloadToLocal).
        if (!showSaveDialog || !getSftpIdForConnection) {
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
              sourceHostId: pane.connection.hostId,
              sourceHostLabel: pane.connection.hostLabel,
              sourceEncoding: pane.filenameEncoding,
              isDirectory: true,
            });
            if (status === "completed") {
              toast.success(`${t("sftp.context.download")}: ${file.name}`, "SFTP");
            } else if (status === "failed") {
              toast.error(`${t("sftp.error.downloadFailed")}: ${file.name}`, "SFTP");
            } else if (status === "attention") {
              toast.error(`${file.name}: another transfer for this path is already in progress`, "SFTP");
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

        const fileSize = typeof file.size === "string" ? parseInt(file.size, 10) || 0 : (file.size || 0);
        // Route through downloadToLocal so FileZilla-style transfer pool
        // sessions are used (browse session stays free for listing).
        const status = await sftpRef.current.downloadToLocal({
          fileName: file.name,
          sourcePath: resolvedFullPath,
          targetPath,
          sftpId,
          connectionId: pane.connection.id,
          sourceHostId: pane.connection.hostId,
          sourceHostLabel: pane.connection.hostLabel,
          sourceEncoding: pane.filenameEncoding,
          isDirectory: false,
          totalBytes: fileSize,
        });
        if (status === "completed") {
          toast.success(`${t("sftp.context.download")}: ${file.name}`, "SFTP");
        } else if (status === "failed") {
          toast.error(`${t("sftp.error.downloadFailed")}: ${file.name}`, "SFTP");
        } else if (status === "attention") {
          toast.error(`${file.name}: another transfer for this path is already in progress`, "SFTP");
        }
      } catch (e) {
        logger.error("[SftpView] Failed to download file:", e);
        const errorMessage = e instanceof Error ? e.message : String(e);
        const isCancelError = errorMessage.includes("cancelled") || errorMessage.includes("canceled");
        if (!isCancelError) toast.error(errorMessage || t("sftp.error.downloadFailed"), "SFTP");
      }
    },
    [
      sftpRef,
      t,
      showSaveDialog,
      selectDirectory,
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

  const handleExtractArchiveForSide = useCallback(
    async (side: "left" | "right", file: SftpFileEntry, fullPath?: string) => {
      const pane = side === "left" ? sftpRef.current.leftPane : sftpRef.current.rightPane;
      if (!pane.connection) return;

      const resolvedPath = fullPath ?? sftpRef.current.joinPath(pane.connection.currentPath, file.name);
      toast.info(t("sftp.extract.extracting", { fileName: file.name }), "SFTP");
      try {
        const bridge = netcattyBridge.get();
        if (pane.connection.isLocal) {
          if (!bridge?.extractLocalArchive) {
            throw new Error("Local extract unavailable");
          }
          await bridge.extractLocalArchive(resolvedPath);
        } else {
          const sftpId = getSftpIdForConnection?.(pane.connection.id);
          if (!sftpId || !bridge?.extractSftpArchive) {
            throw new Error("SFTP session not found");
          }
          await bridge.extractSftpArchive(sftpId, resolvedPath, pane.filenameEncoding);
        }
        await sftpRef.current.refresh(side);
        toast.success(t("sftp.extract.success", { fileName: file.name }), "SFTP");
      } catch (e) {
        logger.error("[SftpView] Failed to extract archive:", e);
        toast.error(
          t("sftp.extract.error", {
            fileName: file.name,
            error: e instanceof Error ? e.message : String(e),
          }),
          "SFTP",
        );
      }
    },
    [getSftpIdForConnection, sftpRef, t],
  );

  const onExtractArchiveLeft = useCallback(
    (file: SftpFileEntry, fullPath?: string) => handleExtractArchiveForSide("left", file, fullPath),
    [handleExtractArchiveForSide],
  );
  const onExtractArchiveRight = useCallback(
    (file: SftpFileEntry, fullPath?: string) => handleExtractArchiveForSide("right", file, fullPath),
    [handleExtractArchiveForSide],
  );

  // Multi-file download. For local panes, each file auto-downloads as a blob
  // (no prompt). For remote panes, prompts for a target directory once and
  // streams all selected entries into it — avoids the per-file save dialog
  // that would otherwise appear N times.
  const handleDownloadFilesForSide = useCallback(
    async (side: "left" | "right", files: SftpFileEntry[]) => {
      if (files.length === 0) return;
      if (files.length === 1) {
        await handleDownloadFileForSide(side, files[0]);
        return;
      }

      const pane = side === "left" ? sftpRef.current.leftPane : sftpRef.current.rightPane;
      if (!pane.connection) return;

      if (pane.connection.isLocal) {
        // Sequential: each local download materializes a full ArrayBuffer.
        await runBoundedConcurrency(
          files,
          LOCAL_BLOB_DOWNLOAD_CONCURRENCY,
          async (file) => {
            await handleDownloadFileForSide(side, file);
          },
        );
        return;
      }

      if (!selectDirectory || !getSftpIdForConnection) {
        toast.error(t("sftp.error.downloadFailed"), "SFTP");
        return;
      }

      const sftpId = getSftpIdForConnection(pane.connection.id);
      if (!sftpId) {
        toast.error(t("sftp.error.downloadFailed"), "SFTP");
        return;
      }

      const selectedDirectory = await selectDirectory(t("sftp.context.download"));
      if (!selectedDirectory) return;

      // Bound root jobs: each directory root walks and transfers independently,
      // so unbounded Promise.allSettled would multiply session / LIST pressure.
      const results: Array<PromiseSettledResult<{ file: SftpFileEntry; status: TransferStatus }>> = [];
      await runBoundedConcurrency(
        files,
        MULTI_SELECT_ROOT_DOWNLOAD_CONCURRENCY,
        async (file, index) => {
          try {
            const sourcePath = sftpRef.current.joinPath(pane.connection.currentPath, file.name);
            const targetPath = joinFsPath(selectedDirectory, file.name);
            const isDirectory = isNavigableDirectory(file);
            const fileSize = typeof file.size === "string" ? parseInt(file.size, 10) || 0 : (file.size || 0);

            const status = await sftpRef.current.downloadToLocal({
              fileName: file.name,
              sourcePath,
              targetPath,
              sftpId,
              connectionId: pane.connection.id,
              sourceHostId: pane.connection.hostId,
              sourceHostLabel: pane.connection.hostLabel,
              sourceEncoding: pane.filenameEncoding,
              isDirectory,
              totalBytes: isDirectory ? undefined : fileSize,
            });
            results[index] = { status: "fulfilled", value: { file, status } };
          } catch (reason) {
            results[index] = { status: "rejected", reason };
          }
        },
      );

      for (const result of results) {
        if (!result) continue;
        if (result.status === "fulfilled") {
          const { file, status } = result.value;
          if (status === "completed") {
            toast.success(`${t("sftp.context.download")}: ${file.name}`, "SFTP");
          } else if (status === "failed") {
            toast.error(`${t("sftp.error.downloadFailed")}: ${file.name}`, "SFTP");
          } else if (status === "attention") {
            toast.error(`${file.name}: another transfer for this path is already in progress`, "SFTP");
          }
        } else {
          logger.error("[SftpView] Failed to download file:", result.reason);
          const errorMessage = result.reason instanceof Error ? result.reason.message : String(result.reason);
          const isCancelError = errorMessage.includes("cancelled") || errorMessage.includes("canceled");
          if (!isCancelError) toast.error(errorMessage || t("sftp.error.downloadFailed"), "SFTP");
        }
      }
    },
    [
      sftpRef,
      t,
      selectDirectory,
      getSftpIdForConnection,
      handleDownloadFileForSide,
    ],
  );

  const onDownloadFilesLeft = useCallback(
    (files: SftpFileEntry[]) => handleDownloadFilesForSide("left", files),
    [handleDownloadFilesForSide],
  );

  const onDownloadFilesRight = useCallback(
    (files: SftpFileEntry[]) => handleDownloadFilesForSide("right", files),
    [handleDownloadFilesForSide],
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
    onOpenFileWithSystemDefaultLeft,
    onOpenFileWithSystemDefaultRight,
    onOpenFileWithLeft,
    onOpenFileWithRight,
    onDownloadFileLeft,
    onDownloadFileRight,
    onExtractArchiveLeft,
    onExtractArchiveRight,
    onDownloadFilesLeft,
    onDownloadFilesRight,
    onUploadExternalFilesLeft,
    onUploadExternalFilesRight,
    onUploadExternalFileListLeft,
    onUploadExternalFileListRight,
    onUploadExternalFolderLeft,
    onUploadExternalFolderRight,
  };
};
