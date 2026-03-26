import React, { memo, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { logger } from "../../lib/logger";
import { useRenderTracker } from "../../lib/useRenderTracker";
import { cn } from "../../lib/utils";
import { SftpPaneDialogs } from "./SftpPaneDialogs";
import { SftpPaneEmptyState } from "./SftpPaneEmptyState";
import { SftpPaneFileList } from "./SftpPaneFileList";
import { SftpPaneToolbar } from "./SftpPaneToolbar";
import {
  useActiveTabId,
  useSftpDrag,
  useSftpHosts,
  useSftpPaneCallbacks,
  useSftpUpdateHosts,
} from "./index";
import type { SftpPane } from "../../application/state/sftp/types";
import type { Host } from "../../domain/models";
import { useSftpPaneDialogs } from "./hooks/useSftpPaneDialogs";
import { useSftpPaneDragAndSelect } from "./hooks/useSftpPaneDragAndSelect";
import { useSftpPaneFiles } from "./hooks/useSftpPaneFiles";
import { useSftpPanePath } from "./hooks/useSftpPanePath";
import { useSftpPaneSorting } from "./hooks/useSftpPaneSorting";
import { useSftpPaneVirtualList } from "./hooks/useSftpPaneVirtualList";
import { useSftpDialogActionHandler } from "./hooks/useSftpDialogAction";
import { useSftpBookmarks } from "./hooks/useSftpBookmarks";
import { useLocalSftpBookmarks } from "./hooks/useLocalSftpBookmarks";
import { useGlobalSftpBookmarks } from "./hooks/useGlobalSftpBookmarks";

interface SftpPaneWrapperProps {
  side: "left" | "right";
  paneId: string;
  isFirstPane: boolean;
  children: React.ReactNode;
}

const SftpPaneWrapper = memo<SftpPaneWrapperProps>(({ side, paneId, isFirstPane, children }) => {
  const activeTabId = useActiveTabId(side);
  const isActive = activeTabId ? paneId === activeTabId : isFirstPane;

  const containerStyle: React.CSSProperties = isActive
    ? {}
    : { visibility: "hidden", pointerEvents: "none" };

  return (
    <div
      className={cn("absolute inset-0", isActive ? "z-10" : "z-0")}
      style={containerStyle}
    >
      {children}
    </div>
  );
});
SftpPaneWrapper.displayName = "SftpPaneWrapper";

interface SftpPaneViewProps {
  side: "left" | "right";
  pane: SftpPane;
  showHeader?: boolean;
  showEmptyHeader?: boolean;
  onToggleShowHiddenFiles?: () => void;
  onGoToTerminalCwd?: () => void;
}

const SftpPaneViewInner: React.FC<SftpPaneViewProps> = ({
  side,
  pane,
  showHeader = true,
  showEmptyHeader = true,
  onToggleShowHiddenFiles,
  onGoToTerminalCwd,
}) => {
  const isActive = true;

  const callbacks = useSftpPaneCallbacks(side);
  const { draggedFiles, onDragStart, onDragEnd } = useSftpDrag();
  const hosts = useSftpHosts();

  const { t } = useI18n();
  const [, startTransition] = useTransition();
  const [showFilterBar, setShowFilterBar] = useState(false);
  const filterInputRef = useRef<HTMLInputElement>(null);

  useRenderTracker(`SftpPaneView[${side}]`, {
    side,
    paneId: pane.id,
    paneConnected: pane.connected,
    panePath: pane.currentPath,
    showHeader,
    draggedFilesCount: draggedFiles?.length ?? 0,
  });

  const { sortField, sortOrder, columnWidths, handleSort, handleResizeStart } = useSftpPaneSorting();

  // Bookmark support
  const updateHosts = useSftpUpdateHosts();
  const currentHost = useMemo(
    () => hosts.find((h) => h.id === pane.connection?.hostId),
    [hosts, pane.connection?.hostId],
  );
  const onUpdateHost = useCallback(
    (updated: Host) => updateHosts(hosts.map((h) => (h.id === updated.id ? updated : h))),
    [hosts, updateHosts],
  );
  const remoteBookmarks = useSftpBookmarks({
    host: currentHost,
    currentPath: pane.connection?.currentPath,
    onUpdateHost,
  });
  const localBookmarks = useLocalSftpBookmarks({
    currentPath: pane.connection?.currentPath,
  });
  const globalBookmarks = useGlobalSftpBookmarks({
    currentPath: pane.connection?.currentPath,
  });
  const hostBookmarks = pane.connection?.isLocal ? localBookmarks : remoteBookmarks;
  const mergedBookmarks = useMemo(
    () => [...globalBookmarks.bookmarks.map((b) => ({ ...b, global: true as const })), ...hostBookmarks.bookmarks],
    [hostBookmarks.bookmarks, globalBookmarks.bookmarks],
  );
  const isCurrentPathBookmarked = hostBookmarks.isCurrentPathBookmarked || globalBookmarks.isCurrentPathBookmarked;
  const toggleBookmark = useCallback(() => {
    if (globalBookmarks.isCurrentPathBookmarked && !hostBookmarks.isCurrentPathBookmarked) {
      const currentPath = pane.connection?.currentPath;
      if (currentPath) {
        const bm = globalBookmarks.bookmarks.find((b) => b.path === currentPath);
        if (bm) globalBookmarks.deleteBookmark(bm.id);
      }
    } else {
      hostBookmarks.toggleBookmark();
    }
  }, [hostBookmarks, globalBookmarks, pane.connection?.currentPath]);
  const deleteBookmark = useCallback(
    (id: string) => {
      if (id.startsWith("gbm-")) {
        globalBookmarks.deleteBookmark(id);
      } else {
        hostBookmarks.deleteBookmark(id);
      }
    },
    [hostBookmarks, globalBookmarks],
  );

  const { filteredFiles, sortedDisplayFiles } = useSftpPaneFiles({
    files: pane.files,
    filter: pane.filter,
    connection: pane.connection,
    showHiddenFiles: pane.showHiddenFiles,
    sortField,
    sortOrder,
  });
  const {
    isEditingPath,
    editingPathValue,
    showPathSuggestions,
    pathSuggestionIndex,
    pathInputRef,
    pathDropdownRef,
    pathSuggestions,
    setEditingPathValue,
    setShowPathSuggestions,
    setPathSuggestionIndex,
    handlePathBlur,
    handlePathKeyDown,
    handlePathDoubleClick,
    handlePathSubmit,
  } = useSftpPanePath({
    connection: pane.connection,
    filteredFiles,
    onNavigateTo: callbacks.onNavigateTo,
  });
  const {
    showHostPicker,
    hostSearch,
    showNewFolderDialog,
    newFolderName,
    showNewFileDialog,
    newFileName,
    fileNameError,
    showOverwriteConfirm,
    overwriteTarget,
    showRenameDialog,
    renameTarget: _renameTarget,
    renameName,
    showDeleteConfirm,
    deleteTargets,
    isCreating,
    isCreatingFile,
    isRenaming,
    isDeleting,
    setShowHostPicker,
    setHostSearch,
    setShowNewFolderDialog,
    setNewFolderName,
    setShowNewFileDialog,
    setNewFileName,
    setFileNameError,
    setShowOverwriteConfirm,
    setShowRenameDialog,
    setRenameName,
    setShowDeleteConfirm,
    handleCreateFolder,
    handleCreateFile,
    handleConfirmOverwrite,
    handleRename,
    handleDelete,
    openRenameDialog,
    openDeleteConfirm,
    getNextUntitledName,
  } = useSftpPaneDialogs({
    t,
    pane,
    onCreateDirectory: callbacks.onCreateDirectory,
    onCreateFile: callbacks.onCreateFile,
    onRenameFile: callbacks.onRenameFile,
    onDeleteFiles: callbacks.onDeleteFiles,
    onClearSelection: callbacks.onClearSelection,
  });
  const {
    dragOverEntry,
    isDragOverPane,
    paneContainerRef,
    handlePaneDragOver,
    handlePaneDragLeave,
    handlePaneDrop,
    handleFileDragStart,
    handleEntryDragOver,
    handleEntryDrop,
    handleRowDragLeave,
    handleRowSelect,
    handleRowOpen,
  } = useSftpPaneDragAndSelect({
    side,
    pane,
    sortedDisplayFiles,
    draggedFiles,
    onDragStart,
    onReceiveFromOtherPane: callbacks.onReceiveFromOtherPane,
    onUploadExternalFiles: callbacks.onUploadExternalFiles,
    onOpenEntry: callbacks.onOpenEntry,
    onRangeSelect: callbacks.onRangeSelect,
    onToggleSelection: callbacks.onToggleSelection,
  });
  const {
    fileListRef,
    rowHeight,
    handleFileListScroll,
    shouldVirtualize,
    totalHeight,
    visibleRows,
  } = useSftpPaneVirtualList({
    isActive,
    sortedDisplayFiles,
  });

  // Handle keyboard shortcut dialog actions
  const dialogActionHandlers = useMemo(
    () => ({
      onRename: (fileName: string) => openRenameDialog(fileName),
      onDelete: (fileNames: string[]) => openDeleteConfirm(fileNames),
      onNewFolder: () => {
        setNewFolderName("");
        setShowNewFolderDialog(true);
      },
      onNewFile: () => {
        const defaultName = getNextUntitledName(pane.files.map(f => f.name));
        setNewFileName(defaultName);
        setFileNameError(null);
        setShowNewFileDialog(true);
      },
    }),
    [
      getNextUntitledName,
      openDeleteConfirm,
      openRenameDialog,
      pane.files,
      setFileNameError,
      setNewFileName,
      setNewFolderName,
      setShowNewFileDialog,
      setShowNewFolderDialog,
    ],
  );

  useSftpDialogActionHandler(side, dialogActionHandlers);

  const handleSortWithTransition = (field: typeof sortField) => {
    startTransition(() => handleSort(field));
  };

  useEffect(() => {
    logger.debug("SftpPaneView active state", {
      side,
      paneId: pane.id,
      isActive,
    });
  }, [isActive, pane.id, side]);

  if (!pane.connection) {
    return (
      <SftpPaneEmptyState
        side={side}
        showEmptyHeader={showEmptyHeader}
        t={t}
        showHostPicker={showHostPicker}
        setShowHostPicker={setShowHostPicker}
        hostSearch={hostSearch}
        setHostSearch={setHostSearch}
        hosts={hosts}
        onConnect={callbacks.onConnect}
      />
    );
  }

  return (
    <div
      ref={paneContainerRef}
      className={cn(
        "absolute inset-0 flex flex-col transition-colors",
        isDragOverPane && "bg-primary/5",
      )}
      onDragOver={handlePaneDragOver}
      onDragLeave={handlePaneDragLeave}
      onDrop={handlePaneDrop}
    >
      <SftpPaneToolbar
        t={t}
        pane={pane}
        onNavigateTo={callbacks.onNavigateTo}
        onSetFilter={callbacks.onSetFilter}
        onSetFilenameEncoding={callbacks.onSetFilenameEncoding}
        onRefresh={callbacks.onRefresh}
        showFilterBar={showFilterBar}
        setShowFilterBar={setShowFilterBar}
        filterInputRef={filterInputRef}
        isEditingPath={isEditingPath}
        editingPathValue={editingPathValue}
        setEditingPathValue={setEditingPathValue}
        setShowPathSuggestions={setShowPathSuggestions}
        showPathSuggestions={showPathSuggestions}
        setPathSuggestionIndex={setPathSuggestionIndex}
        pathSuggestions={pathSuggestions}
        pathSuggestionIndex={pathSuggestionIndex}
        pathInputRef={pathInputRef}
        pathDropdownRef={pathDropdownRef}
        handlePathBlur={handlePathBlur}
        handlePathKeyDown={handlePathKeyDown}
        handlePathDoubleClick={handlePathDoubleClick}
        handlePathSubmit={handlePathSubmit}
        startTransition={startTransition}
        getNextUntitledName={getNextUntitledName}
        setNewFileName={setNewFileName}
        setFileNameError={setFileNameError}
        setShowNewFileDialog={setShowNewFileDialog}
        setShowNewFolderDialog={setShowNewFolderDialog}
        setNewFolderName={setNewFolderName}
        bookmarks={mergedBookmarks}
        isCurrentPathBookmarked={isCurrentPathBookmarked}
        onToggleBookmark={toggleBookmark}
        onAddGlobalBookmark={globalBookmarks.addBookmark}
        isCurrentPathGlobalBookmarked={globalBookmarks.isCurrentPathBookmarked}
        onNavigateToBookmark={callbacks.onNavigateTo}
        onDeleteBookmark={deleteBookmark}
        showHiddenFiles={pane.showHiddenFiles}
        onToggleShowHiddenFiles={onToggleShowHiddenFiles}
        onGoToTerminalCwd={onGoToTerminalCwd}
      />

      <SftpPaneFileList
        t={t}
        pane={pane}
        side={side}
        columnWidths={columnWidths}
        sortField={sortField}
        sortOrder={sortOrder}
        handleSort={handleSortWithTransition}
        handleResizeStart={handleResizeStart}
        fileListRef={fileListRef}
        handleFileListScroll={handleFileListScroll}
        shouldVirtualize={shouldVirtualize}
        totalHeight={totalHeight}
        sortedDisplayFiles={sortedDisplayFiles}
        isDragOverPane={isDragOverPane}
        draggedFiles={draggedFiles}
        onRefresh={callbacks.onRefresh}
        setShowNewFolderDialog={setShowNewFolderDialog}
        setShowNewFileDialog={setShowNewFileDialog}
        getNextUntitledName={getNextUntitledName}
        setNewFileName={setNewFileName}
        setFileNameError={setFileNameError}
        dragOverEntry={dragOverEntry}
        handleRowSelect={handleRowSelect}
        handleRowOpen={handleRowOpen}
        handleFileDragStart={handleFileDragStart}
        onDragEnd={onDragEnd}
        handleEntryDragOver={handleEntryDragOver}
        handleRowDragLeave={handleRowDragLeave}
        handleEntryDrop={handleEntryDrop}
        onCopyToOtherPane={callbacks.onCopyToOtherPane}
        onOpenFileWith={callbacks.onOpenFileWith}
        onEditFile={callbacks.onEditFile}
        onDownloadFile={callbacks.onDownloadFile}
        onEditPermissions={callbacks.onEditPermissions}
        openRenameDialog={openRenameDialog}
        openDeleteConfirm={openDeleteConfirm}
        rowHeight={rowHeight}
        visibleRows={visibleRows}
      />

      <SftpPaneDialogs
        t={t}
        showNewFolderDialog={showNewFolderDialog}
        setShowNewFolderDialog={setShowNewFolderDialog}
        newFolderName={newFolderName}
        setNewFolderName={setNewFolderName}
        handleCreateFolder={handleCreateFolder}
        isCreating={isCreating}
        showNewFileDialog={showNewFileDialog}
        setShowNewFileDialog={setShowNewFileDialog}
        newFileName={newFileName}
        setNewFileName={setNewFileName}
        fileNameError={fileNameError}
        setFileNameError={setFileNameError}
        handleCreateFile={handleCreateFile}
        isCreatingFile={isCreatingFile}
        showOverwriteConfirm={showOverwriteConfirm}
        setShowOverwriteConfirm={setShowOverwriteConfirm}
        overwriteTarget={overwriteTarget}
        handleOverwriteConfirm={handleConfirmOverwrite}
        showRenameDialog={showRenameDialog}
        setShowRenameDialog={setShowRenameDialog}
        renameName={renameName}
        setRenameName={setRenameName}
        handleRename={handleRename}
        isRenaming={isRenaming}
        showDeleteConfirm={showDeleteConfirm}
        setShowDeleteConfirm={setShowDeleteConfirm}
        deleteTargets={deleteTargets}
        handleDelete={handleDelete}
        isDeleting={isDeleting}
        showHostPicker={showHostPicker}
        setShowHostPicker={setShowHostPicker}
        hosts={hosts}
        side={side}
        hostSearch={hostSearch}
        setHostSearch={setHostSearch}
        onConnect={callbacks.onConnect}
        onDisconnect={callbacks.onDisconnect}
      />
    </div>
  );
};

const sftpPaneViewAreEqual = (
  prev: SftpPaneViewProps,
  next: SftpPaneViewProps,
): boolean => {
  if (prev.pane !== next.pane) return false;
  if (prev.side !== next.side) return false;
  if (prev.showHeader !== next.showHeader) return false;
  if (prev.showEmptyHeader !== next.showEmptyHeader) return false;

  return true;
};

const SftpPaneView = memo(SftpPaneViewInner, sftpPaneViewAreEqual);
SftpPaneView.displayName = "SftpPaneView";

export { SftpPaneView, SftpPaneWrapper };
