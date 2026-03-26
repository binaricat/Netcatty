import React, { useCallback, useMemo, useState } from "react";
import { ArrowDown, ChevronDown, ClipboardCopy, Copy, Download, Edit2, ExternalLink, FilePlus, Folder, FolderPlus, Loader2, Pencil, RefreshCw, Shield, Trash2, Unplug } from "lucide-react";
import { Button } from "../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { cn } from "../../lib/utils";
import { joinPath } from "../../application/state/sftp/utils";
import type { SftpFileEntry } from "../../types";
import type { SftpPane } from "../../application/state/sftp/types";
import type { ColumnWidths, SortField, SortOrder } from "./utils";
import { isNavigableDirectory } from "./index";
import { isKnownBinaryFile } from "../../lib/sftpFileUtils";
import { SftpFileRow } from "./index";

interface SftpPaneFileListProps {
  t: (key: string, params?: Record<string, unknown>) => string;
  pane: SftpPane;
  side: "left" | "right";
  columnWidths: ColumnWidths;
  sortField: SortField;
  sortOrder: SortOrder;
  handleSort: (field: SortField) => void;
  handleResizeStart: (field: keyof ColumnWidths, e: React.MouseEvent) => void;
  fileListRef: React.RefObject<HTMLDivElement>;
  handleFileListScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  shouldVirtualize: boolean;
  totalHeight: number;
  sortedDisplayFiles: SftpFileEntry[];
  isDragOverPane: boolean;
  draggedFiles: { name: string; isDirectory: boolean; side: "left" | "right" }[] | null;
  onRefresh: () => void;
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
  onCopyToOtherPane: (files: { name: string; isDirectory: boolean }[]) => void;
  onOpenFileWith?: (entry: SftpFileEntry) => void;
  onEditFile?: (entry: SftpFileEntry) => void;
  onDownloadFile?: (entry: SftpFileEntry) => void;
  onEditPermissions?: (entry: SftpFileEntry) => void;
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

export const SftpPaneFileList: React.FC<SftpPaneFileListProps> = ({
  t,
  pane,
  side,
  columnWidths,
  sortField,
  sortOrder,
  handleSort,
  handleResizeStart,
  fileListRef,
  handleFileListScroll,
  shouldVirtualize,
  totalHeight,
  sortedDisplayFiles,
  isDragOverPane,
  draggedFiles,
  onRefresh,
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
  onOpenFileWith,
  onEditFile,
  onDownloadFile,
  onEditPermissions,
  openRenameDialog,
  openDeleteConfirm,
  rowHeight,
  visibleRows,
}) => {
  const filesByName = useMemo(() => {
    const map = new Map<string, SftpFileEntry>();
    sortedDisplayFiles.forEach((entry) => {
      map.set(entry.name, entry);
    });
    return map;
  }, [sortedDisplayFiles]);

  const renderRow = useCallback(
    (entry: SftpFileEntry, index: number) => (
      <ContextMenu>
        <ContextMenuTrigger>
          <SftpFileRow
            entry={entry}
            index={index}
            isSelected={pane.selectedFiles.has(entry.name)}
            isDragOver={dragOverEntry === entry.name}
            columnWidths={columnWidths}
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
              <ContextMenuItem onClick={() => onDownloadFile(entry)}>
                <Download size={14} className="mr-2" />{" "}
                {t("sftp.context.download")}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() => {
                const files = pane.selectedFiles.has(entry.name)
                  ? Array.from(pane.selectedFiles)
                  : [entry.name];
                const fileData = files.map((name) => {
                  const fileName = String(name);
                  const file = filesByName.get(fileName);
                  return {
                    name: fileName,
                    isDirectory: file ? isNavigableDirectory(file) : false,
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
            <ContextMenuItem onClick={() => openRenameDialog(entry.name)}>
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
                const files = pane.selectedFiles.has(entry.name)
                  ? Array.from(pane.selectedFiles)
                  : [entry.name];
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
          </ContextMenuContent>
        )}
      </ContextMenu>
    ),
    [
      columnWidths,
      dragOverEntry,
      filesByName,
      handleEntryDragOver,
      handleEntryDrop,
      handleFileDragStart,
      handleRowDragLeave,
      handleRowOpen,
      handleRowSelect,
      onCopyToOtherPane,
      onDownloadFile,
      onDragEnd,
      onEditFile,
      onEditPermissions,
      onOpenFileWith,
      onRefresh,
      openDeleteConfirm,
      openRenameDialog,
      pane.connection,
      pane.selectedFiles,
      setShowNewFolderDialog,
      setShowNewFileDialog,
      t,
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
    [renderRow, rowHeight, shouldVirtualize, sortedDisplayFiles, visibleRows],
  );

  return (
    <>
      {/* File list header */}
    <div
      className="text-[11px] uppercase tracking-wide text-muted-foreground px-4 py-2 border-b border-border/40 bg-secondary/10 select-none"
      style={{
        display: "grid",
        gridTemplateColumns: `${columnWidths.name}% ${columnWidths.modified}% ${columnWidths.size}% ${columnWidths.type}%`,
      }}
    >
      <div
        className="flex items-center gap-1 cursor-pointer hover:text-foreground relative pr-2"
        onClick={() => handleSort("name")}
      >
        <span>{t("sftp.columns.name")}</span>
        {sortField === "name" && (
          <span className="text-primary">
            {sortOrder === "asc" ? "↑" : "↓"}
          </span>
        )}
        <div
          className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
          onMouseDown={(e) => handleResizeStart("name", e)}
        />
      </div>
      <div
        className="flex items-center gap-1 cursor-pointer hover:text-foreground relative pr-2"
        onClick={() => handleSort("modified")}
      >
        <span>{t("sftp.columns.modified")}</span>
        {sortField === "modified" && (
          <span className="text-primary">
            {sortOrder === "asc" ? "↑" : "↓"}
          </span>
        )}
        <div
          className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
          onMouseDown={(e) => handleResizeStart("modified", e)}
        />
      </div>
      <div
        className="flex items-center gap-1 cursor-pointer hover:text-foreground relative pr-2 justify-end"
        onClick={() => handleSort("size")}
      >
        {sortField === "size" && (
          <span className="text-primary">
            {sortOrder === "asc" ? "↑" : "↓"}
          </span>
        )}
        <span>{t("sftp.columns.size")}</span>
        <div
          className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
          onMouseDown={(e) => handleResizeStart("size", e)}
        />
      </div>
      <div
        className="flex items-center gap-1 cursor-pointer hover:text-foreground justify-end"
        onClick={() => handleSort("type")}
      >
        {sortField === "type" && (
          <span className="text-primary">
            {sortOrder === "asc" ? "↑" : "↓"}
          </span>
        )}
        <span>{t("sftp.columns.kind")}</span>
      </div>
    </div>

    {/* File list with empty area context menu */}
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={fileListRef}
          className={cn(
            "flex-1 min-h-0 overflow-y-auto relative",
            isDragOverPane && "ring-2 ring-primary/30 ring-inset",
          )}
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
      </ContextMenuContent>
    </ContextMenu>

    {/* Footer */}
    <div className="h-9 shrink-0 px-4 flex items-center justify-between text-[11px] text-muted-foreground border-t border-border/40 bg-secondary/30">
      <span>
        {t("sftp.itemsCount", {
          count: sortedDisplayFiles.filter((f) => f.name !== "..").length,
        })}
        {pane.selectedFiles.size > 0 &&
          ` - ${t("sftp.selectedCount", { count: pane.selectedFiles.size })}`}
      </span>
      <span className="truncate max-w-[200px]">
        {pane.connection.currentPath}
      </span>
    </div>

    {/* Loading overlay - covers entire pane when navigating or reconnecting */}
    {pane.loading && sortedDisplayFiles.length > 0 && !pane.reconnecting && (
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
};
