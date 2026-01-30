import React, { useCallback, useState } from "react";
import type { MutableRefObject } from "react";
import type { SftpFileEntry } from "../../../types";
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
  showSaveDialog?: (defaultPath: string, filters?: Array<{ name: string; extensions: string[] }>) => Promise<string | null>;
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
  showSaveDialog,
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
        setTextEditorTarget({ file, side, fullPath });

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

      try {
        // For local files, use blob download
        if (pane.connection.isLocal) {
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

        // For remote SFTP files, use streaming download with save dialog
        if (!showSaveDialog || !startStreamTransfer || !getSftpIdForConnection) {
          toast.error(t("sftp.error.downloadFailed"), "SFTP");
          return;
        }

        const sftpId = getSftpIdForConnection(pane.connection.id);
        if (!sftpId) {
          throw new Error("SFTP session not found");
        }

        // Show save dialog to get target path
        const targetPath = await showSaveDialog(file.name);
        if (!targetPath) {
          // User cancelled
          return;
        }

        const transferId = `download-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
          },
          undefined, // onProgress - SftpView uses its own transfer queue UI
          () => {
            toast.success(`${t("sftp.context.download")}: ${file.name}`, "SFTP");
          },
          (error) => {
            errorHandled = true;
            // Check if this is a cancellation - don't show error toast for cancellations
            if (!error.includes('cancelled') && !error.includes('canceled')) {
              toast.error(error, "SFTP");
            }
          }
        );

        // Check if bridge doesn't support streaming (returns undefined)
        if (result === undefined) {
          toast.error(t("sftp.error.downloadFailed"), "SFTP");
          return;
        }

        // Handle error from result only if onError callback wasn't called
        if (result?.error && !errorHandled) {
          const isCancelError = result.error.includes('cancelled') || result.error.includes('canceled');
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
    [sftpRef, t, showSaveDialog, startStreamTransfer, getSftpIdForConnection],
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
