import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { useSftpBackend } from "../application/state/useSftpBackend";
import { useSftpFileAssociations } from "../application/state/useSftpFileAssociations";
import { useSettingsState } from "../application/state/useSettingsState";
import { useSftpModalTransfers } from "./sftp-modal/hooks/useSftpModalTransfers";
import { Host, RemoteFile, SftpFilenameEncoding } from "../types";
import { filterHiddenFiles } from "./sftp";
import { DropEntry } from "../lib/sftpFileUtils";
import FileOpenerDialog from "./FileOpenerDialog";
import TextEditorModal from "./TextEditorModal";
import { SftpModalFileList } from "./sftp-modal/SftpModalFileList";
import { SftpModalDialogs } from "./sftp-modal/SftpModalDialogs";
import { SftpModalFooter } from "./sftp-modal/SftpModalFooter";
import { SftpModalHeader } from "./sftp-modal/SftpModalHeader";
import { SftpModalUploadTasks } from "./sftp-modal/SftpModalUploadTasks";
import { formatBytes, formatDate } from "./sftp-modal/utils";
import { useSftpModalSorting } from "./sftp-modal/hooks/useSftpModalSorting";
import { useSftpModalVirtualList } from "./sftp-modal/hooks/useSftpModalVirtualList";
import { useSftpModalPath } from "./sftp-modal/hooks/useSftpModalPath";
import { useSftpModalSelection } from "./sftp-modal/hooks/useSftpModalSelection";
import { useSftpModalSession } from "./sftp-modal/hooks/useSftpModalSession";
import { useSftpModalFileActions } from "./sftp-modal/hooks/useSftpModalFileActions";
import { useSftpModalKeyboardShortcuts } from "./sftp-modal/hooks/useSftpModalKeyboardShortcuts";
import { joinPath, isRootPath, getParentPath } from "./sftp-modal/pathUtils";
import { toast } from "./ui/toast";
import { Dialog, DialogContent } from "./ui/dialog";

interface SFTPModalProps {
  host: Host;
  credentials: {
    username?: string;
    hostname: string;
    port?: number;
    password?: string;
    privateKey?: string;
    certificate?: string;
    passphrase?: string;
    publicKey?: string;
    keyId?: string;
    keySource?: 'generated' | 'imported';
    proxy?: NetcattyProxyConfig;
    jumpHosts?: NetcattyJumpHost[];
    sftpSudo?: boolean;
  };
  open: boolean;
  onClose: () => void;
  /** Initial path to open in SFTP. If not accessible, falls back to home directory. */
  initialPath?: string;
  /** Initial entries to upload when SFTP modal opens. Used for drag-and-drop to terminal. */
  initialEntriesToUpload?: DropEntry[];
}

const SFTPModal: React.FC<SFTPModalProps> = ({
  host,
  credentials,
  open,
  onClose,
  initialPath,
  initialEntriesToUpload,
}) => {
  const {
    openSftp,
    closeSftp: closeSftpBackend,
    listSftp,
    readSftp,
    writeSftpBinaryWithProgress,
    writeSftpBinary,
    writeSftp,
    deleteSftp,
    mkdirSftp,
    renameSftp,
    chmodSftp,
    statSftp,
    listLocalDir,
    readLocalFile,
    writeLocalFile,
    deleteLocalFile,
    mkdirLocal,
    getHomeDir,
    selectApplication,
    downloadSftpToTempAndOpen,
    cancelSftpUpload,
    startStreamTransfer,
    cancelTransfer,
    showSaveDialog,
  } = useSftpBackend();
  const { t } = useI18n();
  const { sftpAutoSync, sftpShowHiddenFiles, sftpUseCompressedUpload, hotkeyScheme, keyBindings } = useSettingsState();
  const isLocalSession = host.protocol === "local";
  const [filenameEncoding, setFilenameEncoding] = useState<SftpFilenameEncoding>(
    host.sftpEncoding ?? "auto"
  );
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const navigatingRef = useRef(false);
  const clearSelection = useCallback(() => setSelectedFiles(new Set()), []);

  // Update filenameEncoding when host changes
  useEffect(() => {
    setFilenameEncoding(host.sftpEncoding ?? "auto");
  }, [host.id, host.sftpEncoding]);

  const listSftpWithEncoding = useCallback(
    (sftpId: string, path: string) => listSftp(sftpId, path, filenameEncoding),
    [listSftp, filenameEncoding],
  );

  const readSftpWithEncoding = useCallback(
    (sftpId: string, path: string) => readSftp(sftpId, path, filenameEncoding),
    [readSftp, filenameEncoding],
  );

  const writeSftpWithEncoding = useCallback(
    (sftpId: string, path: string, data: string) =>
      writeSftp(sftpId, path, data, filenameEncoding),
    [writeSftp, filenameEncoding],
  );

  const writeSftpBinaryWithEncoding = useCallback(
    (sftpId: string, path: string, data: ArrayBuffer) =>
      writeSftpBinary(sftpId, path, data, filenameEncoding),
    [writeSftpBinary, filenameEncoding],
  );

  const writeSftpBinaryWithProgressWithEncoding = useCallback(
    (
      sftpId: string,
      path: string,
      data: ArrayBuffer,
      transferId: string,
      onProgress?: (transferred: number, total: number, speed: number) => void,
      onComplete?: () => void,
      onError?: (error: string) => void,
    ) =>
      writeSftpBinaryWithProgress(
        sftpId,
        path,
        data,
        transferId,
        filenameEncoding,
        onProgress,
        onComplete,
        onError,
      ),
    [writeSftpBinaryWithProgress, filenameEncoding],
  );

  const deleteSftpWithEncoding = useCallback(
    (sftpId: string, path: string) => deleteSftp(sftpId, path, filenameEncoding),
    [deleteSftp, filenameEncoding],
  );

  const mkdirSftpWithEncoding = useCallback(
    (sftpId: string, path: string) => mkdirSftp(sftpId, path, filenameEncoding),
    [mkdirSftp, filenameEncoding],
  );

  const renameSftpWithEncoding = useCallback(
    (sftpId: string, oldPath: string, newPath: string) =>
      renameSftp(sftpId, oldPath, newPath, filenameEncoding),
    [renameSftp, filenameEncoding],
  );

  const chmodSftpWithEncoding = useCallback(
    (sftpId: string, path: string, mode: string) =>
      chmodSftp(sftpId, path, mode, filenameEncoding),
    [chmodSftp, filenameEncoding],
  );

  const statSftpWithEncoding = useCallback(
    (sftpId: string, path: string) => statSftp(sftpId, path, filenameEncoding),
    [statSftp, filenameEncoding],
  );

  const downloadSftpToTempAndOpenWithEncoding = useCallback(
    (
      sftpId: string,
      remotePath: string,
      fileName: string,
      appPath: string,
      options?: { enableWatch?: boolean },
    ) =>
      downloadSftpToTempAndOpen(sftpId, remotePath, fileName, appPath, {
        ...options,
        encoding: filenameEncoding,
      }),
    [downloadSftpToTempAndOpen, filenameEncoding],
  );

  const {
    currentPath,
    setCurrentPath,
    files,
    loading,
    setLoading,
    reconnecting,
    ensureSftp,
    loadFiles,
    closeSftpSession,
    localHomeRef,
  } = useSftpModalSession({
    open,
    host,
    credentials,
    initialPath,
    isLocalSession,
    t,
    openSftp,
    closeSftp: closeSftpBackend,
    listSftp: listSftpWithEncoding,
    listLocalDir,
    getHomeDir,
    onClearSelection: clearSelection,
  });

  // Track previous encoding to detect changes
  const prevEncodingRef = useRef(filenameEncoding);

  // Force reload only when filenameEncoding changes (not on every path change)
  useEffect(() => {
    if (!open || isLocalSession) return;
    // Only force reload if encoding actually changed
    if (prevEncodingRef.current !== filenameEncoding) {
      prevEncodingRef.current = filenameEncoding;
      loadFiles(currentPath, { force: true });
    }
  }, [currentPath, filenameEncoding, isLocalSession, loadFiles, open]);

  const { getOpenerForFile, setOpenerForExtension } = useSftpFileAssociations();

  const { sortField, sortOrder, columnWidths, handleSort, handleResizeStart } =
    useSftpModalSorting();

  const joinPathForSession = useCallback(
    (base: string, name: string) => joinPath(base, name, isLocalSession),
    [isLocalSession],
  );
  const isRootPathForSession = useCallback(
    (path: string) => isRootPath(path, isLocalSession),
    [isLocalSession],
  );
  const getParentPathForSession = useCallback(
    (path: string) => getParentPath(path, isLocalSession),
    [isLocalSession],
  );

  const handleNavigate = useCallback((path: string) => {
    // Prevent double navigation (e.g., from double-click race condition)
    if (navigatingRef.current) return;
    navigatingRef.current = true;
    setCurrentPath(path);
    // Reset lock after a short delay
    setTimeout(() => {
      navigatingRef.current = false;
    }, 300);
  }, [navigatingRef, setCurrentPath]);

  const handleUp = () => {
    if (isRootPathForSession(currentPath)) return;
    setCurrentPath(getParentPathForSession(currentPath));
  };

  const {
    isEditingPath,
    editingPathValue,
    setEditingPathValue,
    pathInputRef,
    handlePathDoubleClick,
    handlePathSubmit,
    handlePathKeyDown,
    breadcrumbs,
    visibleBreadcrumbs,
    hiddenBreadcrumbs,
    needsBreadcrumbTruncation,
    breadcrumbPathAtForIndex,
    rootLabel,
    rootPath,
  } = useSftpModalPath({
    currentPath,
    isLocalSession,
    localHomePath: localHomeRef.current,
    onNavigate: handleNavigate,
  });

  const {
    handleDelete,
    handleCreateFolder,
    handleCreateFile,
    showRenameDialog,
    setShowRenameDialog,
    renameTarget,
    renameName,
    setRenameName,
    isRenaming,
    openRenameDialog,
    handleRename,
    showPermissionsDialog,
    setShowPermissionsDialog,
    permissionsTarget,
    permissions,
    isChangingPermissions,
    openPermissionsDialog,
    togglePermission,
    getOctalPermissions,
    getSymbolicPermissions,
    handleSavePermissions,
    showFileOpenerDialog,
    setShowFileOpenerDialog,
    fileOpenerTarget,
    setFileOpenerTarget,
    openFileOpenerDialog,
    handleFileOpenerSelect,
    handleSelectSystemApp,
    showTextEditor,
    setShowTextEditor,
    textEditorTarget,
    setTextEditorTarget,
    textEditorContent,
    setTextEditorContent,
    loadingTextContent,
    handleEditFile,
    handleSaveTextFile,
    handleOpenFile,
  } = useSftpModalFileActions({
    currentPath,
    isLocalSession,
    joinPath: joinPathForSession,
    ensureSftp,
    loadFiles,
    readLocalFile,
    readSftp: readSftpWithEncoding,
    writeLocalFile,
    writeSftp: writeSftpWithEncoding,
    writeSftpBinary: writeSftpBinaryWithEncoding,
    deleteLocalFile,
    deleteSftp: deleteSftpWithEncoding,
    mkdirLocal,
    mkdirSftp: mkdirSftpWithEncoding,
    renameSftp: renameSftpWithEncoding,
    chmodSftp: chmodSftpWithEncoding,
    statSftp: statSftpWithEncoding,
    t,
    sftpAutoSync,
    getOpenerForFile,
    setOpenerForExtension,
    downloadSftpToTempAndOpen: downloadSftpToTempAndOpenWithEncoding,
    selectApplication,
  });

  const {
    uploading,
    uploadTasks,
    dragActive,
    handleDownload,
    handleUploadEntries,
    handleFileSelect,
    handleFolderSelect,
    handleDrag,
    handleDrop,
    cancelUpload,
    cancelTask,
    dismissTask,
  } = useSftpModalTransfers({
    currentPath,
    isLocalSession,
    joinPath: joinPathForSession,
    ensureSftp,
    loadFiles,
    readLocalFile,
    readSftp: readSftpWithEncoding,
    writeLocalFile,
    writeSftpBinaryWithProgress: writeSftpBinaryWithProgressWithEncoding,
    writeSftpBinary: writeSftpBinaryWithEncoding,
    writeSftp: writeSftpWithEncoding,
    mkdirLocal,
    mkdirSftp: mkdirSftpWithEncoding,
    cancelSftpUpload,
    startStreamTransfer,
    cancelTransfer,
    showSaveDialog,
    setLoading,
    t,
    useCompressedUpload: sftpUseCompressedUpload,
  });

  const handleClose = async () => {
    await closeSftpSession();
    onClose();
  };

  // Handle initial entries to upload (from drag-and-drop to terminal)
  const initialUploadTriggeredRef = useRef(false);
  const prevLoadingRef = useRef(loading);
  const prevEntriesRef = useRef<DropEntry[] | undefined>(undefined);
  useEffect(() => {
    // Detect when loading transitions from true to false (initial load complete)
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;
    const justFinishedLoading = wasLoading && !loading;

    // Reset the flag when initialEntriesToUpload is cleared
    if (!initialEntriesToUpload || initialEntriesToUpload.length === 0) {
      initialUploadTriggeredRef.current = false;
      prevEntriesRef.current = undefined;
      return;
    }

    // Reset the flag when new entries arrive (different reference = new drop)
    if (initialEntriesToUpload !== prevEntriesRef.current) {
      initialUploadTriggeredRef.current = false;
      prevEntriesRef.current = initialEntriesToUpload;
    }

    // Prevent duplicate uploads
    if (initialUploadTriggeredRef.current) return;

    // Wait for SFTP connection to be established
    // Trigger when: modal is open AND loading just finished (works for empty directories too)
    if (!open || loading) return;
    if (!justFinishedLoading) return;

    initialUploadTriggeredRef.current = true;

    // Trigger upload with full DropEntry data (preserves directory structure)
    handleUploadEntries(initialEntriesToUpload);
  }, [initialEntriesToUpload, open, loading, handleUploadEntries]);

  // Display files with parent entry (like SftpView)
  const displayFiles = useMemo(() => {
    // Filter hidden files using utility function
    const visibleFiles = filterHiddenFiles(files, sftpShowHiddenFiles);

    // Check if we're at root
    const atRoot = isRootPathForSession(currentPath);
    if (atRoot) return visibleFiles;

    // Add ".." parent directory entry at the top (only if not at root)
    const parentEntry: RemoteFile = {
      name: "..",
      type: "directory",
      size: "--",
      lastModified: undefined,
    };
    return [parentEntry, ...visibleFiles.filter((f) => f.name !== "..")];
  }, [files, currentPath, isRootPathForSession, sftpShowHiddenFiles]);

  // Sorted files
  const sortedFiles = useMemo(() => {
    if (!displayFiles.length) return displayFiles;

    // Keep ".." at the top, sort the rest
    const parentEntry = displayFiles.find((f) => f.name === "..");
    const otherFiles = displayFiles.filter((f) => f.name !== "..");

    const sorted = [...otherFiles].sort((a, b) => {
      // Directories and symlinks pointing to directories come first
      const aIsDir = a.type === "directory" || (a.type === "symlink" && a.linkTarget === "directory");
      const bIsDir = b.type === "directory" || (b.type === "symlink" && b.linkTarget === "directory");
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;

      let cmp = 0;
      switch (sortField) {
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "size": {
          const sizeA =
            typeof a.size === "number"
              ? a.size
              : parseInt(String(a.size), 10) || 0;
          const sizeB =
            typeof b.size === "number"
              ? b.size
              : parseInt(String(b.size), 10) || 0;
          cmp = sizeA - sizeB;
          break;
        }
        case "modified": {
          const dateA = new Date(a.lastModified || 0).getTime();
          const dateB = new Date(b.lastModified || 0).getTime();
          cmp = dateA - dateB;
          break;
        }
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });

    return parentEntry ? [parentEntry, ...sorted] : sorted;
  }, [displayFiles, sortField, sortOrder]);
  const {
    fileListRef,
    handleFileListScroll,
    shouldVirtualize,
    totalHeight,
    visibleRows,
  } = useSftpModalVirtualList({ open, sortedFiles });


  const { handleFileClick, handleFileDoubleClick } = useSftpModalSelection({
    files,
    setSelectedFiles,
    currentPath,
    joinPath: joinPathForSession,
    onNavigate: handleNavigate,
    onOpenFile: handleOpenFile,
    onNavigateUp: handleUp,
  });

  // Keyboard shortcuts for modal
  const handleKeyboardRename = useCallback((file: RemoteFile) => {
    openRenameDialog(file);
  }, [openRenameDialog]);

  const handleKeyboardDelete = useCallback((fileNames: string[]) => {
    // Find the files to pass to confirm dialog
    if (fileNames.length === 0) return;
    if (!confirm(t("sftp.deleteConfirm.title", { count: fileNames.length }))) return;
    
    // Delete files
    (async () => {
      try {
        for (const fileName of fileNames) {
          const fullPath = joinPathForSession(currentPath, fileName);
          if (isLocalSession) {
            await deleteLocalFile(fullPath);
          } else {
            await deleteSftpWithEncoding(await ensureSftp(), fullPath);
          }
        }
        await loadFiles(currentPath, { force: true });
        setSelectedFiles(new Set());
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : t("sftp.error.deleteFailed"),
          "SFTP",
        );
      }
    })();
  }, [currentPath, isLocalSession, deleteLocalFile, deleteSftpWithEncoding, ensureSftp, loadFiles, setSelectedFiles, t, joinPathForSession]);

  const handleKeyboardNewFolder = useCallback(() => {
    handleCreateFolder();
  }, [handleCreateFolder]);

  useSftpModalKeyboardShortcuts({
    keyBindings,
    hotkeyScheme,
    open,
    files,
    visibleFiles: displayFiles,
    selectedFiles,
    setSelectedFiles,
    onRefresh: () => loadFiles(currentPath, { force: true }),
    onRename: handleKeyboardRename,
    onDelete: handleKeyboardDelete,
    onNewFolder: handleKeyboardNewFolder,
  });

  const handleDeleteSelected = async () => {
    if (selectedFiles.size === 0) return;
    const fileNames = Array.from(selectedFiles);
    if (!confirm(t("sftp.deleteConfirm.title", { count: fileNames.length }))) return;

    try {
      for (const fileName of fileNames) {
        const fullPath = joinPathForSession(currentPath, fileName);
        if (isLocalSession) {
          await deleteLocalFile(fullPath);
        } else {
          await deleteSftpWithEncoding(await ensureSftp(), fullPath);
        }
      }
      await loadFiles(currentPath, { force: true });
      setSelectedFiles(new Set());
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : t("sftp.error.deleteFailed"),
        "SFTP",
      );
    }
  };

  const handleDownloadSelected = async () => {
    if (selectedFiles.size === 0) return;
    for (const fileName of selectedFiles) {
      const file = files.find((f) => f.name === fileName);
      if (file && file.type === "file") {
        await handleDownload(file);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
      <DialogContent className="max-w-4xl h-[80vh] flex flex-col p-0 gap-0">
        <SftpModalHeader
          t={t}
          host={host}
          credentials={credentials}
          showEncoding={!isLocalSession}
          filenameEncoding={filenameEncoding}
          onFilenameEncodingChange={setFilenameEncoding}
          currentPath={currentPath}
          isEditingPath={isEditingPath}
          editingPathValue={editingPathValue}
          setEditingPathValue={setEditingPathValue}
          handlePathSubmit={handlePathSubmit}
          handlePathKeyDown={handlePathKeyDown}
          handlePathDoubleClick={handlePathDoubleClick}
          isAtRoot={isRootPathForSession(currentPath)}
          rootLabel={rootLabel}
          isRefreshing={loading || reconnecting}
          onUp={handleUp}
          onHome={() =>
            setCurrentPath((isLocalSession && localHomeRef.current) || rootPath)
          }
          onRefresh={() => loadFiles(currentPath, { force: true })}
          visibleBreadcrumbs={visibleBreadcrumbs}
          hiddenBreadcrumbs={hiddenBreadcrumbs}
          needsBreadcrumbTruncation={needsBreadcrumbTruncation}
          breadcrumbs={breadcrumbs}
          onBreadcrumbSelect={(index) => setCurrentPath(breadcrumbPathAtForIndex(index))}
          onRootSelect={() => setCurrentPath(rootPath)}
          inputRef={inputRef}
          folderInputRef={folderInputRef}
          pathInputRef={pathInputRef}
          uploading={uploading}
          onTriggerUpload={() => inputRef.current?.click()}
          onTriggerFolderUpload={() => folderInputRef.current?.click()}
          onCreateFolder={handleCreateFolder}
          onCreateFile={handleCreateFile}
          onFileSelect={handleFileSelect}
          onFolderSelect={handleFolderSelect}
        />

        <SftpModalFileList
          t={t}
          currentPath={currentPath}
          isLocalSession={isLocalSession}
          files={files}
          selectedFiles={selectedFiles}
          dragActive={dragActive}
          loading={loading}
          loadingTextContent={loadingTextContent}
          reconnecting={reconnecting}
          columnWidths={columnWidths}
          sortField={sortField}
          sortOrder={sortOrder}
          shouldVirtualize={shouldVirtualize}
          totalHeight={totalHeight}
          visibleRows={visibleRows}
          fileListRef={fileListRef}
          inputRef={inputRef}
          folderInputRef={folderInputRef}
          handleSort={handleSort}
          handleResizeStart={handleResizeStart}
          handleFileListScroll={handleFileListScroll}
          handleDrag={handleDrag}
          handleDrop={handleDrop}
          handleFileClick={handleFileClick}
          handleFileDoubleClick={handleFileDoubleClick}
          handleDownload={handleDownload}
          handleDelete={handleDelete}
          handleOpenFile={handleOpenFile}
          openFileOpenerDialog={openFileOpenerDialog}
          handleEditFile={handleEditFile}
          openRenameDialog={openRenameDialog}
          openPermissionsDialog={openPermissionsDialog}
          handleNavigate={handleNavigate}
          handleCreateFolder={handleCreateFolder}
          handleCreateFile={handleCreateFile}
          handleDownloadSelected={handleDownloadSelected}
          handleDeleteSelected={handleDeleteSelected}
          loadFiles={loadFiles}
          formatBytes={formatBytes}
          formatDate={formatDate}
        />

        <SftpModalUploadTasks tasks={uploadTasks} t={t} onCancel={cancelUpload} onCancelTask={cancelTask} onDismiss={dismissTask} />

        <SftpModalFooter
          t={t}
          files={files}
          selectedFiles={selectedFiles}
          loading={loading}
          uploading={uploading}
          onDownloadSelected={handleDownloadSelected}
          onDeleteSelected={handleDeleteSelected}
        />
      </DialogContent>

      <SftpModalDialogs
        t={t}
        showRenameDialog={showRenameDialog}
        setShowRenameDialog={setShowRenameDialog}
        renameTarget={renameTarget}
        renameName={renameName}
        setRenameName={setRenameName}
        handleRename={handleRename}
        isRenaming={isRenaming}
        showPermissionsDialog={showPermissionsDialog}
        setShowPermissionsDialog={setShowPermissionsDialog}
        permissionsTarget={permissionsTarget}
        permissions={permissions}
        togglePermission={togglePermission}
        getOctalPermissions={getOctalPermissions}
        getSymbolicPermissions={getSymbolicPermissions}
        handleSavePermissions={handleSavePermissions}
        isChangingPermissions={isChangingPermissions}
      />

      {/* File Opener Dialog */}
      <FileOpenerDialog
        open={showFileOpenerDialog}
        onClose={() => {
          setShowFileOpenerDialog(false);
          setFileOpenerTarget(null);
        }}
        fileName={fileOpenerTarget?.name || ""}
        onSelect={handleFileOpenerSelect}
        onSelectSystemApp={handleSelectSystemApp}
      />

      {/* Text Editor Modal */}
      <TextEditorModal
        open={showTextEditor}
        onClose={() => {
          setShowTextEditor(false);
          setTextEditorTarget(null);
          setTextEditorContent("");
        }}
        fileName={textEditorTarget?.name || ""}
        initialContent={textEditorContent}
        onSave={handleSaveTextFile}
      />
    </Dialog>
  );
};

export default SFTPModal;
