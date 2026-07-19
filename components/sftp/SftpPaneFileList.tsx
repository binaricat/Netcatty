import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, ArrowDown, ArrowRight, ArrowUp, ChevronDown, ClipboardCopy, Copy, Download, Edit2, ExternalLink, FilePlus, Folder, FolderPlus, Loader2, Pencil, RefreshCw, Shield, Trash2, Unplug, Upload } from "lucide-react";
import { Button } from "../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { cn } from "../../lib/utils";
import { getParentPath, joinPath } from "../../application/state/sftp/utils";
import type { SftpFileEntry } from "../../types";
import type { SftpPane } from "../../application/state/sftp/types";
import type { SftpTransferSource } from "./SftpContext";
import { sftpListOrderStore } from "./hooks/useSftpListOrderStore";
import type { UseSftpPaneSortingResult } from "./hooks/useSftpPaneSorting";
import { buildSftpColumnTemplate, isNavigableDirectory, isSftpColumnMenuKey } from "./utils";
import { isKnownBinaryFile } from "../../lib/sftpFileUtils";
import { SftpFileRow } from "./SftpFileRow";
import { SftpColumnMenuItems } from "./SftpColumnMenuItems";
import { getSftpVirtualListScrollTop } from "../../domain/sftpVirtualList";
import {
  getSftpListUploadFilesTargetPath,
  getSftpUploadFilesLabelKey,
  getSftpUploadFolderLabelKey,
  shouldShowSftpUploadFolderMenu,
  shouldShowSftpUploadFilesMenu,
} from "./sftpUploadMenu";

interface SftpPaneFileListProps {
  t: (key: string, params?: Record<string, unknown>) => string;
  pane: SftpPane;
  side: "left" | "right";
  isPaneFocused: boolean;
  sorting: UseSftpPaneSortingResult;
  fileListRef: React.RefObject<HTMLDivElement>;
  handleFileListScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  shouldVirtualize: boolean;
  totalHeight: number;
  sortedDisplayFiles: SftpFileEntry[];
  isDragOverPane: boolean;
  draggedFiles: (SftpTransferSource & { side: "left" | "right" })[] | null;
  onRefresh: () => void;
  onNavigateTo: (path: string) => void;
  onClearSelection: () => void;
  setShowNewFolderDialog: (open: boolean) => void;
  setShowNewFileDialog: (open: boolean) => void;
  getNextUntitledName: (existingNames: string[]) => string;
  setNewFileName: (value: string) => void;
  setFileNameError: (value: string | null) => void;
  // Row rendering
  dragOverEntry: string | null;
  handleRowSelect: (entry: SftpFileEntry, index: number, e: React.MouseEvent) => void;
  handleRowOpen: (entry: SftpFileEntry) => void;
  handleFileDragStart: (entry: SftpFileEntry, e: React.DragEvent) => void;
  onDragEnd: () => void;
  handleEntryDragOver: (entry: SftpFileEntry, e: React.DragEvent) => void;
  handleRowDragLeave: () => void;
  handleEntryDrop: (entry: SftpFileEntry, e: React.DragEvent) => void;
  onCopyToOtherPane: (files: SftpTransferSource[]) => void;
  onMoveEntriesToPath: (sourcePaths: string[], targetPath: string) => Promise<void>;
  onOpenFileWithSystemDefault?: (entry: SftpFileEntry) => void;
  onOpenFileWith?: (entry: SftpFileEntry) => void;
  onEditFile?: (entry: SftpFileEntry) => void;
  onDownloadFile?: (entry: SftpFileEntry) => void;
  onDownloadFiles?: (entries: SftpFileEntry[]) => void;
  onEditPermissions?: (entry: SftpFileEntry) => void;
  onUploadExternalFileList?: (fileList: FileList, targetPath?: string) => Promise<void> | void;
  onUploadExternalFolder?: (targetPath?: string) => Promise<void> | void;
  // Whether this pane is rendering a local filesystem. Upload menu items only
  // make sense for remote (SFTP) panes, so they are suppressed when isLocal.
  isLocal?: boolean;
  openRenameDialog: (name: string) => void;
  openDeleteConfirm: (targets: string[]) => void;
  rowHeight: number;
  visibleRows: { entry: SftpFileEntry; index: number; top: number }[];
}

const SftpErrorWithLogs: React.FC<{
  error: string;
  connectionLogs: string[];
  onRetry: () => void;
  t: (key: string) => string;
}> = ({ error, connectionLogs, onRetry, t }) => {
  const [showLogs, setShowLogs] = useState(connectionLogs.length > 0);
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
      <Unplug size={28} className="text-destructive/70" />
      <span className="text-xs text-center px-6 max-w-xs leading-relaxed">{t(error)}</span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onRetry}>
          {t("sftp.retry")}
        </Button>
        {connectionLogs.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => setShowLogs(!showLogs)}
          >
            <ChevronDown size={14} className={`mr-1 transition-transform ${showLogs ? 'rotate-180' : ''}`} />
            {showLogs ? "Hide logs" : "Show logs"}
          </Button>
        )}
      </div>
      {showLogs && connectionLogs.length > 0 && (
        <div className="w-full max-w-sm mt-1 p-2 rounded-md bg-secondary/50 border border-border/60 space-y-0.5 max-h-40 overflow-y-auto">
          {connectionLogs.map((log, i) => (
            <div key={i} className="text-[11px] text-muted-foreground truncate font-mono">
              {log}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const SftpPaneFileList: React.FC<SftpPaneFileListProps> = React.memo(({
  t,
  pane,
  side,
  isPaneFocused,
  sorting,
  fileListRef,
  handleFileListScroll,
  shouldVirtualize,
  totalHeight,
  sortedDisplayFiles,
  isDragOverPane,
  draggedFiles,
  onRefresh,
  onNavigateTo,
  onClearSelection,
  setShowNewFolderDialog,
  setShowNewFileDialog,
  getNextUntitledName,
  setNewFileName,
  setFileNameError,
  dragOverEntry,
  handleRowSelect,
  handleRowOpen,
  handleFileDragStart,
  onDragEnd,
  handleEntryDragOver,
  handleRowDragLeave,
  handleEntryDrop,
  onCopyToOtherPane,
  onMoveEntriesToPath,
  onOpenFileWithSystemDefault,
  onOpenFileWith,
  onEditFile,
  onDownloadFile,
  onDownloadFiles,
  onEditPermissions,
  onUploadExternalFileList,
  onUploadExternalFolder,
  isLocal = false,
  openRenameDialog,
  openDeleteConfirm,
  rowHeight,
  visibleRows,
}) => {
  const {
    columnWidths,
    visibleColumns,
    directoriesFirst,
    sortField,
    sortOrder,
    handleSort,
    handleResizeStart,
    toggleColumnVisibility,
    toggleDirectoriesFirst,
  } = sorting;
  const filesByName = useMemo(() => {
    const map = new Map<string, SftpFileEntry>();
    sortedDisplayFiles.forEach((entry) => {
      map.set(entry.name, entry);
    });
    return map;
  }, [sortedDisplayFiles]);

  // Push sorted file names into the list order store for keyboard navigation
  useEffect(() => {
    const names = sortedDisplayFiles
      .filter((f) => f.name !== "..")
      .map((f) => f.name);
    sftpListOrderStore.setItems(pane.id, names);
    return () => sftpListOrderStore.clearPane(pane.id);
  }, [sortedDisplayFiles, pane.id]);

  useEffect(() => {
    if (pane.selectedFiles.size !== 1) return;
    const selectedName = Array.from(pane.selectedFiles)[0];
    if (!selectedName) return;

    const container = fileListRef.current;
    if (!container) return;

    const row = Array.from(container.querySelectorAll<HTMLElement>('[data-sftp-row="true"]'))
      .find((element) => element.dataset.entryName === selectedName);
    if (row) {
      row.scrollIntoView({ block: "nearest" });
      return;
    }

    if (!shouldVirtualize || rowHeight <= 0) return;
    const itemIndex = sortedDisplayFiles.findIndex((entry) => entry.name === selectedName);
    if (itemIndex < 0) return;
    container.scrollTop = getSftpVirtualListScrollTop({
      itemIndex,
      rowHeight,
      currentScrollTop: container.scrollTop,
      viewportHeight: container.clientHeight,
    });
  }, [fileListRef, pane.selectedFiles, rowHeight, shouldVirtualize, sortedDisplayFiles]);

  // Use refs for frequently-changing values in context-menu actions
  const selectedFilesRef = useRef(pane.selectedFiles);
  selectedFilesRef.current = pane.selectedFiles;

  const handleBackgroundClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-sftp-row="true"]')) return;
    if (pane.selectedFiles.size === 0) return;
    onClearSelection();
  }, [onClearSelection, pane.selectedFiles.size]);

  // Hidden file input backing the "Upload File(s)" context menu item. It sends
  // the original FileList through uploadFromFileList so Electron can still
  // resolve local paths for stream uploads.
  const uploadEnabled = shouldShowSftpUploadFilesMenu({
    isLocal,
    hasFileListUpload: !!onUploadExternalFileList,
  });
  const folderUploadEnabled = shouldShowSftpUploadFolderMenu({
    isLocal,
    hasFolderUpload: !!onUploadExternalFolder,
  });
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetPathRef = useRef<string | undefined>(undefined);

  const triggerUploadPicker = useCallback((targetPath?: string) => {
    if (isLocal || !onUploadExternalFileList) return;
    const input = uploadInputRef.current;
    if (!input) return;
    uploadTargetPathRef.current = targetPath;
    // Reset value so selecting the same files twice still fires onChange.
    input.value = "";
    input.click();
  }, [isLocal, onUploadExternalFileList]);

  const handleUploadInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) {
      uploadTargetPathRef.current = undefined;
      return;
    }
    if (!onUploadExternalFileList) {
      uploadTargetPathRef.current = undefined;
      return;
    }
    const targetPath = uploadTargetPathRef.current;
    uploadTargetPathRef.current = undefined;
    void onUploadExternalFileList(files, targetPath);
  }, [onUploadExternalFileList]);

  const renderRow = useCallback(
    (entry: SftpFileEntry, index: number) => (
      <ContextMenu>
        <ContextMenuTrigger>
          <SftpFileRow
            entry={entry}
            index={index}
            isSelected={pane.selectedFiles.has(entry.name)}
            showSelectionHighlight={isPaneFocused}
            isDragOver={dragOverEntry === entry.name}
            columnWidths={columnWidths}
            visibleColumns={visibleColumns}
            onSelect={handleRowSelect}
            onOpen={handleRowOpen}
            onDragStart={handleFileDragStart}
            onDragEnd={onDragEnd}
            onDragOver={handleEntryDragOver}
            onDragLeave={handleRowDragLeave}
            onDrop={handleEntryDrop}
          />
        </ContextMenuTrigger>
        {entry.name !== ".." && (
          <ContextMenuContent>
            <ContextMenuItem onClick={() => handleRowOpen(entry)}>
              {isNavigableDirectory(entry) ? (
                <>
                  <Folder size={14} className="mr-2" /> {t("sftp.context.open")}
                </>
              ) : (
                <>
                  <ExternalLink size={14} className="mr-2" />{" "}
                  {t("sftp.context.open")}
                </>
              )}
            </ContextMenuItem>
            {isNavigableDirectory(entry) && (
              <ContextMenuItem onClick={() => onNavigateTo(joinPath(pane.connection.currentPath, entry.name))}>
                <ArrowRight size={14} className="mr-2" /> {t("sftp.context.navigateTo")}
              </ContextMenuItem>
            )}
            {!isNavigableDirectory(entry) && onOpenFileWithSystemDefault && (
              <ContextMenuItem onClick={() => onOpenFileWithSystemDefault(entry)}>
                <AppWindow size={14} className="mr-2" />{" "}
                {t("sftp.context.openWithDefault")}
              </ContextMenuItem>
            )}
            {!isNavigableDirectory(entry) && onOpenFileWith && (
              <ContextMenuItem onClick={() => onOpenFileWith(entry)}>
                <ExternalLink size={14} className="mr-2" />{" "}
                {t("sftp.context.openWith")}
              </ContextMenuItem>
            )}
            {!isNavigableDirectory(entry) && !isKnownBinaryFile(entry.name) && onEditFile && (
              <ContextMenuItem onClick={() => onEditFile(entry)}>
                <Edit2 size={14} className="mr-2" />{" "}
                {t("sftp.context.edit")}
              </ContextMenuItem>
            )}
            {onDownloadFile &&
              (!isNavigableDirectory(entry) || !pane.connection?.isLocal) && (
              <ContextMenuItem
                onClick={() => {
                  const currentSelected = selectedFilesRef.current;
                  if (
                    onDownloadFiles &&
                    currentSelected.has(entry.name) &&
                    currentSelected.size > 1
                  ) {
                    const entries = Array.from(currentSelected)
                      .map((name) => filesByName.get(String(name)))
                      .filter((f): f is SftpFileEntry => !!f);
                    onDownloadFiles(entries);
                  } else {
                    onDownloadFile(entry);
                  }
                }}
              >
                <Download size={14} className="mr-2" />{" "}
                {t("sftp.context.download")}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() => {
                const currentSelected = selectedFilesRef.current;
                const files = currentSelected.has(entry.name)
                  ? Array.from(currentSelected)
                  : [entry.name];
                const fileData = files.map((name) => {
                  const fileName = String(name);
                  const file = filesByName.get(fileName);
                  return {
                    name: fileName,
                    isDirectory: file ? isNavigableDirectory(file) : false,
                    sourceConnectionId: pane.connection?.id,
                    sourcePath: pane.connection?.currentPath,
                  };
                });
                onCopyToOtherPane(fileData);
              }}
            >
              <Copy size={14} className="mr-2" />{" "}
              {t("sftp.context.copyToOtherPane")}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                navigator.clipboard.writeText(joinPath(pane.connection.currentPath, entry.name));
              }}
            >
              <ClipboardCopy size={14} className="mr-2" />{" "}
              {t("sftp.context.copyPath")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {(() => {
              const sourceParent = getParentPath(joinPath(pane.connection?.currentPath ?? "", entry.name));
              const targetParent = getParentPath(sourceParent);
              if (sourceParent === targetParent) return null;

              return (
                <ContextMenuItem
                  onClick={() => {
                    const currentSelected = selectedFilesRef.current;
                    const sourcePaths = currentSelected.has(entry.name)
                      ? Array.from(currentSelected as Set<string>).map((n) => joinPath(pane.connection?.currentPath ?? "", n))
                      : [joinPath(pane.connection?.currentPath ?? "", entry.name)];
                    void onMoveEntriesToPath(sourcePaths, targetParent);
                  }}
                >
                  <ArrowUp size={14} className="mr-2" />{" "}
                  {t("sftp.context.moveToParent")}
                </ContextMenuItem>
              );
            })()}
            <ContextMenuItem onClick={() => openRenameDialog(joinPath(pane.connection?.currentPath ?? "", entry.name))}>
              <Pencil size={14} className="mr-2" /> {t("common.rename")}
            </ContextMenuItem>
            {onEditPermissions && pane.connection && !pane.connection.isLocal && (
              <ContextMenuItem onClick={() => onEditPermissions(entry)}>
                <Shield size={14} className="mr-2" />{" "}
                {t("sftp.context.permissions")}
              </ContextMenuItem>
            )}
            <ContextMenuItem
              className="text-destructive"
              onClick={() => {
                const currentSelected = selectedFilesRef.current;
                const files = currentSelected.has(entry.name)
                  ? Array.from(currentSelected as Set<string>).map((n) => joinPath(pane.connection?.currentPath ?? "", n))
                  : [joinPath(pane.connection?.currentPath ?? "", entry.name)];
                openDeleteConfirm(files);
              }}
            >
              <Trash2 size={14} className="mr-2" /> {t("action.delete")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onRefresh}>
              <RefreshCw size={14} className="mr-2" /> {t("common.refresh")}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setShowNewFolderDialog(true)}>
              <FolderPlus size={14} className="mr-2" /> {t("sftp.newFolder")}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setShowNewFileDialog(true)}>
              <FilePlus size={14} className="mr-2" /> {t("sftp.newFile")}
            </ContextMenuItem>
            {uploadEnabled && onUploadExternalFileList && (
              <ContextMenuItem
                onClick={() => {
                  const target = getSftpListUploadFilesTargetPath(entry, pane.connection?.currentPath ?? "");
                  triggerUploadPicker(target);
                }}
              >
                <Upload size={14} className="mr-2" />{" "}
                {t(getSftpUploadFilesLabelKey(entry))}
              </ContextMenuItem>
            )}
            {folderUploadEnabled && onUploadExternalFolder && (
              <ContextMenuItem
                onClick={() => {
                  const target = getSftpListUploadFilesTargetPath(entry, pane.connection?.currentPath ?? "");
                  void onUploadExternalFolder(target);
                }}
              >
                <Upload size={14} className="mr-2" />{" "}
                {t(getSftpUploadFolderLabelKey(entry))}
              </ContextMenuItem>
            )}
          </ContextMenuContent>
        )}
      </ContextMenu>
    ),
    [
      columnWidths,
      visibleColumns,
      filesByName,
      handleEntryDragOver,
      handleEntryDrop,
      handleFileDragStart,
      handleRowDragLeave,
      handleRowOpen,
      handleRowSelect,
      dragOverEntry,
      isPaneFocused,
      onCopyToOtherPane,
      onMoveEntriesToPath,
      onDownloadFile,
      onDownloadFiles,
      onDragEnd,
      onEditFile,
      onEditPermissions,
      onNavigateTo,
      onOpenFileWithSystemDefault,
      onOpenFileWith,
      onRefresh,
      onUploadExternalFileList,
      onUploadExternalFolder,
      uploadEnabled,
      folderUploadEnabled,
      openDeleteConfirm,
      openRenameDialog,
      pane.connection,
      pane.selectedFiles,
      setShowNewFolderDialog,
      setShowNewFileDialog,
      t,
      triggerUploadPicker,
    ],
  );

  const fileRows = useMemo(
    () =>
      shouldVirtualize
        ? visibleRows.map(({ entry, index, top }) => (
          <div
            key={entry.name}
            className="absolute left-0 right-0 border-b border-border/30"
            style={{ top, height: rowHeight }}
          >
            {renderRow(entry, index)}
          </div>
        ))
        : sortedDisplayFiles.map((entry, index) => (
          <React.Fragment key={entry.name}>
            {renderRow(entry, index)}
          </React.Fragment>
        )),
    [
      renderRow,
      rowHeight,
      shouldVirtualize,
      sortedDisplayFiles,
      visibleRows,
    ],
  );

  return (
    <>
      {/* File list header */}
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="text-[11px] uppercase tracking-wide text-muted-foreground px-4 py-2 border-b border-border/40 bg-secondary/10 select-none"
          data-section="terminal-sftp-list-header"
          tabIndex={0}
          aria-label={t("sftp.columns.configure")}
          onKeyDown={(e) => {
            if (!isSftpColumnMenuKey(e.key, e.shiftKey)) return;
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            e.currentTarget.dispatchEvent(new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: rect.left + 16,
              clientY: rect.top + rect.height / 2,
            }));
          }}
          style={{
            display: "grid",
            gridTemplateColumns: buildSftpColumnTemplate(columnWidths, visibleColumns),
          }}
        >
          <div
            className="flex min-w-0 items-center gap-1 cursor-pointer hover:text-foreground relative pr-2 overflow-hidden"
            onClick={() => handleSort("name")}
          >
            <span className="truncate whitespace-nowrap">{t("sftp.columns.name")}</span>
            {sortField === "name" && (
              <span className="shrink-0 text-primary">
                {sortOrder === "asc" ? "↑" : "↓"}
              </span>
            )}
            <div
              className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
              onMouseDown={(e) => handleResizeStart("name", e)}
            />
          </div>
          {visibleColumns.modified && (
            <div
              className="flex min-w-0 items-center gap-1 cursor-pointer hover:text-foreground relative pr-2 overflow-hidden"
              onClick={() => handleSort("modified")}
            >
              <span className="truncate whitespace-nowrap">{t("sftp.columns.modified")}</span>
              {sortField === "modified" && (
                <span className="shrink-0 text-primary">
                  {sortOrder === "asc" ? "↑" : "↓"}
                </span>
              )}
              <div
                className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
                onMouseDown={(e) => handleResizeStart("modified", e)}
              />
            </div>
          )}
          {visibleColumns.size && (
            <div
              className="flex min-w-0 items-center gap-1 cursor-pointer hover:text-foreground relative pr-2 justify-end overflow-hidden"
              onClick={() => handleSort("size")}
            >
              {sortField === "size" && (
                <span className="shrink-0 text-primary">
                  {sortOrder === "asc" ? "↑" : "↓"}
                </span>
              )}
              <span className="truncate whitespace-nowrap">{t("sftp.columns.size")}</span>
              <div
                className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
                onMouseDown={(e) => handleResizeStart("size", e)}
              />
            </div>
          )}
          {visibleColumns.type && (
            <div
              className="flex min-w-0 items-center gap-1 cursor-pointer hover:text-foreground justify-end overflow-hidden"
              onClick={() => handleSort("type")}
            >
              {sortField === "type" && (
                <span className="shrink-0 text-primary">
                  {sortOrder === "asc" ? "↑" : "↓"}
                </span>
              )}
              <span className="truncate whitespace-nowrap">{t("sftp.columns.kind")}</span>
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <SftpColumnMenuItems
          visibleColumns={visibleColumns}
          directoriesFirst={directoriesFirst}
          toggleColumnVisibility={toggleColumnVisibility}
          toggleDirectoriesFirst={toggleDirectoriesFirst}
        />
      </ContextMenuContent>
    </ContextMenu>

    {/* File list with empty area context menu */}
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={fileListRef}
          data-section="terminal-sftp-list"
          className={cn(
            "flex-1 min-h-0 overflow-y-auto relative",
            isDragOverPane && "ring-2 ring-primary/30 ring-inset",
          )}
          onClick={handleBackgroundClick}
          onScroll={handleFileListScroll}
        >
          {pane.loading && sortedDisplayFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2">
              <Loader2 size={24} className="animate-spin text-muted-foreground" />
              {pane.connectionLogs.length > 0 && (
                <div className="w-full max-w-sm mt-2 space-y-0.5 px-4">
                  {pane.connectionLogs.map((log, i) => (
                    <div key={i} className="text-[11px] text-muted-foreground truncate">
                      {log}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : pane.error && !pane.reconnecting ? (
            <SftpErrorWithLogs
              error={pane.error}
              connectionLogs={pane.connectionLogs}
              onRetry={onRefresh}
              t={t}
            />
          ) : sortedDisplayFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <Folder size={32} className="mb-2 opacity-50" />
              <span className="text-sm">{t("sftp.emptyDirectory")}</span>
            </div>
          ) : (
            <div
              className={cn(
                shouldVirtualize ? "relative" : "divide-y divide-border/30",
              )}
              style={shouldVirtualize ? { height: totalHeight } : undefined}
            >
              {fileRows}
            </div>
          )}

          {/* Drop overlay */}
          {isDragOverPane && draggedFiles && draggedFiles[0]?.side !== side && (
            <div className="absolute inset-0 flex items-center justify-center bg-primary/5 pointer-events-none">
              <div className="flex flex-col items-center gap-2 text-primary">
                <ArrowDown size={32} />
                <span className="text-sm font-medium">{t("sftp.dropFilesHere")}</span>
              </div>
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onRefresh}>
          <RefreshCw size={14} className="mr-2" />{t("sftp.context.refresh")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => setShowNewFolderDialog(true)}>
          <FolderPlus size={14} className="mr-2" />{t("sftp.newFolder")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => {
          const defaultName = getNextUntitledName(pane.files.map(f => f.name));
          setNewFileName(defaultName);
          setFileNameError(null);
          setShowNewFileDialog(true);
        }}>
          <FilePlus size={14} className="mr-2" />{t("sftp.newFile")}
        </ContextMenuItem>
        {uploadEnabled && onUploadExternalFileList && (
          <ContextMenuItem onClick={() => triggerUploadPicker(undefined)}>
            <Upload size={14} className="mr-2" />{t("sftp.context.uploadFiles")}
          </ContextMenuItem>
        )}
        {folderUploadEnabled && onUploadExternalFolder && (
          <ContextMenuItem onClick={() => void onUploadExternalFolder(undefined)}>
            <Upload size={14} className="mr-2" />{t("sftp.context.uploadFolder")}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>

    {/* Hidden file input backing the "Upload File(s)" context menu item. */}
    {uploadEnabled && onUploadExternalFileList && (
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleUploadInputChange}
      />
    )}

    {/* Footer */}
    <div className="h-9 shrink-0 px-4 flex items-center justify-between text-[11px] text-muted-foreground border-t border-border/40 bg-secondary/30">
      <span>
        {t("sftp.itemsCount", {
          count: sortedDisplayFiles.length - (sortedDisplayFiles[0]?.name === ".." ? 1 : 0),
        })}
        {pane.selectedFiles.size > 0 &&
          ` - ${t("sftp.selectedCount", { count: pane.selectedFiles.size })}`}
      </span>
      <span className="truncate max-w-[200px]">
        {pane.connection.currentPath}
      </span>
    </div>

    {/* Loading overlay - covers entire pane when navigating or reconnecting */}
    {pane.loading && !pane.connection?.reusedConnection && sortedDisplayFiles.length > 0 && !pane.reconnecting && (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/40 backdrop-blur-[1px] z-10">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
        {pane.connectionLogs.length > 0 && (
          <div className="w-full max-w-sm mt-2 space-y-0.5 px-4">
            {pane.connectionLogs.map((log, i) => (
              <div key={i} className="text-[11px] text-muted-foreground truncate">
                {log}
              </div>
            ))}
          </div>
        )}
      </div>
    )}

    {/* Reconnecting overlay - shows when SFTP connection is lost and reconnecting */}
    {pane.reconnecting && (
      <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm z-20">
        <div className="flex flex-col items-center gap-3 p-6 rounded-xl bg-secondary/90 border border-border/60 shadow-lg">
          <Loader2 size={32} className="animate-spin text-primary" />
          <div className="text-center">
            <div className="text-sm font-medium">{t("sftp.reconnecting.title")}</div>
            <div className="text-xs text-muted-foreground mt-1">{t("sftp.reconnecting.desc")}</div>
          </div>
        </div>
      </div>
    )}
  </>
);
});
