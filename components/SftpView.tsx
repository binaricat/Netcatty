/**
 * SftpView - SFTP File Browser (Refactored)
 *
 * This is the main SFTP view component that provides a dual-pane file browser
 * for transferring files between local and remote systems.
 *
 * Components have been extracted to:
 * - components/sftp/utils.ts - Utility functions
 * - components/sftp/SftpBreadcrumb.tsx - Path navigation
 * - components/sftp/SftpFileRow.tsx - File list row
 * - components/sftp/SftpTransferItem.tsx - Transfer queue item
 * - components/sftp/SftpConflictDialog.tsx - Conflict resolution
 * - components/sftp/SftpPermissionsDialog.tsx - Permissions editor
 * - components/sftp/SftpHostPicker.tsx - Host selection dialog
 */

import React, { memo, useCallback, useMemo, useRef, useState } from "react";
import { useIsSftpActive } from "../application/state/activeTabStore";
import { SftpPane, useSftpState } from "../application/state/useSftpState";
import { cn } from "../lib/utils";
import { Host, SftpFileEntry, SSHKey } from "../types";
import { Button } from "./ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

// Import extracted components
import {
  ColumnWidths,
  SftpBreadcrumb,
  SftpConflictDialog,
  SftpFileRow,
  SftpHostPicker,
  SftpPermissionsDialog,
  SftpTransferItem,
  SortField,
  SortOrder,
} from "./sftp";

import {
  AlertCircle,
  ArrowDown,
  ChevronLeft,
  Copy,
  Folder,
  FolderPlus,
  HardDrive,
  Home,
  Loader2,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Trash2,
  X,
} from "lucide-react";

// SFTP Pane component
interface SftpPaneViewProps {
  side: "left" | "right";
  pane: SftpPane;
  hosts: Host[];
  filteredFiles: SftpFileEntry[];
  onConnect: (host: Host | "local") => void;
  onDisconnect: () => void;
  onNavigateTo: (path: string) => void;
  onNavigateUp: () => void;
  onRefresh: () => void;
  onOpenEntry: (entry: SftpFileEntry) => void;
  onToggleSelection: (fileName: string, multiSelect: boolean) => void;
  onRangeSelect: (fileNames: string[]) => void;
  onClearSelection: () => void;
  onSetFilter: (filter: string) => void;
  onCreateDirectory: (name: string) => Promise<void>;
  onDeleteFiles: (fileNames: string[]) => Promise<void>;
  onRenameFile: (oldName: string, newName: string) => Promise<void>;
  onCopyToOtherPane: (files: { name: string; isDirectory: boolean }[]) => void;
  onReceiveFromOtherPane: (
    files: { name: string; isDirectory: boolean }[],
  ) => void;
  onEditPermissions?: (file: SftpFileEntry) => void;
  draggedFiles:
    | { name: string; isDirectory: boolean; side: "left" | "right" }[]
    | null;
  onDragStart: (
    files: { name: string; isDirectory: boolean }[],
    side: "left" | "right",
  ) => void;
  onDragEnd: () => void;
}

const SftpPaneViewInner: React.FC<SftpPaneViewProps> = ({
  side,
  pane,
  hosts,
  filteredFiles,
  onConnect,
  onDisconnect,
  onNavigateTo,
  onNavigateUp,
  onRefresh,
  onOpenEntry,
  onToggleSelection,
  onRangeSelect,
  onClearSelection,
  onSetFilter,
  onCreateDirectory,
  onDeleteFiles,
  onRenameFile,
  onCopyToOtherPane,
  onReceiveFromOtherPane,
  onEditPermissions,
  draggedFiles,
  onDragStart,
  onDragEnd,
}) => {
  // Dialog states
  const [showHostPicker, setShowHostPicker] = useState(false);
  const [hostSearch, setHostSearch] = useState("");
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<string[]>([]);

  // Drag states
  const [dragOverEntry, setDragOverEntry] = useState<string | null>(null);
  const [isDragOverPane, setIsDragOverPane] = useState(false);
  const paneContainerRef = useRef<HTMLDivElement>(null);
  const fileListRef = useRef<HTMLDivElement>(null);
  const lastSelectedIndexRef = useRef<number | null>(null);

  // Sorting state
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");

  // Column widths (percentages)
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>({
    name: 45,
    modified: 25,
    size: 15,
    type: 15,
  });
  const resizingRef = useRef<{
    field: keyof ColumnWidths;
    startX: number;
    startWidth: number;
  } | null>(null);

  // Editable path state
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [editingPathValue, setEditingPathValue] = useState("");
  const [showPathSuggestions, setShowPathSuggestions] = useState(false);
  const [pathSuggestionIndex, setPathSuggestionIndex] = useState(-1);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const pathDropdownRef = useRef<HTMLDivElement>(null);

  // Path suggestions
  const pathSuggestions = useMemo(() => {
    if (!isEditingPath || !pane.connection) return [];
    const currentValue = editingPathValue.trim().toLowerCase();
    const suggestions: { path: string; type: "folder" | "history" }[] = [];

    const folders = filteredFiles.filter(
      (f) => f.type === "directory" && f.name !== "..",
    );
    folders.forEach((f) => {
      const fullPath =
        pane.connection?.currentPath === "/"
          ? `/${f.name}`
          : `${pane.connection?.currentPath}/${f.name}`;
      if (
        !currentValue ||
        fullPath.toLowerCase().includes(currentValue) ||
        f.name.toLowerCase().includes(currentValue)
      ) {
        suggestions.push({ path: fullPath, type: "folder" });
      }
    });

    const quickPaths = [
      "/home",
      "/var",
      "/etc",
      "/tmp",
      "/usr",
      "/opt",
      "/root",
    ];
    quickPaths.forEach((qp) => {
      if (!currentValue || qp.toLowerCase().includes(currentValue)) {
        if (!suggestions.some((s) => s.path === qp)) {
          suggestions.push({ path: qp, type: "history" });
        }
      }
    });

    return suggestions.slice(0, 8);
  }, [isEditingPath, editingPathValue, filteredFiles, pane.connection]);

  // Display files with parent entry
  const displayFiles = useMemo(() => {
    if (!pane.connection) return [];
    if (pane.connection.currentPath === "/") return filteredFiles;
    const parentEntry: SftpFileEntry = {
      name: "..",
      type: "directory",
      size: 0,
      sizeFormatted: "--",
      lastModified: 0,
      lastModifiedFormatted: "--",
    };
    return [parentEntry, ...filteredFiles.filter((f) => f.name !== "..")];
  }, [pane.connection, filteredFiles]);

  // Sorted files
  const sortedDisplayFiles = useMemo(() => {
    if (!displayFiles.length) return displayFiles;

    const parentEntry = displayFiles.find((f) => f.name === "..");
    const otherFiles = displayFiles.filter((f) => f.name !== "..");

    const sorted = [...otherFiles].sort((a, b) => {
      if (sortField !== "type") {
        if (a.type === "directory" && b.type !== "directory") return -1;
        if (a.type !== "directory" && b.type === "directory") return 1;
      }

      let cmp = 0;
      switch (sortField) {
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "size":
          cmp = (a.size || 0) - (b.size || 0);
          break;
        case "modified":
          cmp = (a.lastModified || 0) - (b.lastModified || 0);
          break;
        case "type": {
          const extA =
            a.type === "directory"
              ? "folder"
              : a.name.split(".").pop()?.toLowerCase() || "";
          const extB =
            b.type === "directory"
              ? "folder"
              : b.name.split(".").pop()?.toLowerCase() || "";
          cmp = extA.localeCompare(extB);
          break;
        }
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });

    return parentEntry ? [parentEntry, ...sorted] : sorted;
  }, [displayFiles, sortField, sortOrder]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

  // Column resize handlers
  const handleResizeStart = (
    field: keyof ColumnWidths,
    e: React.MouseEvent,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = {
      field,
      startX: e.clientX,
      startWidth: columnWidths[field],
    };
    document.addEventListener("mousemove", handleResizeMove);
    document.addEventListener("mouseup", handleResizeEnd);
  };

  const handleResizeMove = useCallback((e: MouseEvent) => {
    if (!resizingRef.current) return;
    const diff = e.clientX - resizingRef.current.startX;
    const newWidth = Math.max(
      10,
      Math.min(60, resizingRef.current.startWidth + diff / 5),
    );
    setColumnWidths((prev) => ({
      ...prev,
      [resizingRef.current!.field]: newWidth,
    }));
  }, []);

  const handleResizeEnd = useCallback(() => {
    resizingRef.current = null;
    document.removeEventListener("mousemove", handleResizeMove);
    document.removeEventListener("mouseup", handleResizeEnd);
  }, [handleResizeMove]);

  // Path editing handlers
  const handlePathDoubleClick = () => {
    if (!pane.connection) return;
    setEditingPathValue(pane.connection.currentPath);
    setIsEditingPath(true);
    setShowPathSuggestions(true);
    setPathSuggestionIndex(-1);
    setTimeout(() => pathInputRef.current?.select(), 0);
  };

  const handlePathSubmit = (pathOverride?: string) => {
    const newPath = (pathOverride ?? editingPathValue).trim() || "/";
    setIsEditingPath(false);
    setShowPathSuggestions(false);
    setPathSuggestionIndex(-1);
    if (pane.connection && newPath !== pane.connection.currentPath) {
      onNavigateTo(newPath.startsWith("/") ? newPath : `/${newPath}`);
    }
  };

  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (showPathSuggestions && pathSuggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPathSuggestionIndex((prev) =>
          prev < pathSuggestions.length - 1 ? prev + 1 : 0,
        );
        return;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setPathSuggestionIndex((prev) =>
          prev > 0 ? prev - 1 : pathSuggestions.length - 1,
        );
        return;
      } else if (e.key === "Tab" && pathSuggestionIndex >= 0) {
        e.preventDefault();
        setEditingPathValue(pathSuggestions[pathSuggestionIndex].path);
        return;
      }
    }
    if (e.key === "Enter") {
      if (pathSuggestionIndex >= 0 && pathSuggestions[pathSuggestionIndex]) {
        handlePathSubmit(pathSuggestions[pathSuggestionIndex].path);
      } else {
        handlePathSubmit();
      }
    } else if (e.key === "Escape") {
      setIsEditingPath(false);
      setShowPathSuggestions(false);
      setPathSuggestionIndex(-1);
    }
  };

  const handlePathBlur = () => {
    setTimeout(() => {
      if (!pathDropdownRef.current?.contains(document.activeElement)) {
        handlePathSubmit();
      }
    }, 150);
  };

  // File operations
  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      await onCreateDirectory(newFolderName.trim());
      setShowNewFolderDialog(false);
      setNewFolderName("");
    } catch (_err) {
      /* Error handling */
    }
  };

  const handleRename = async () => {
    if (!renameTarget || !renameName.trim()) return;
    try {
      await onRenameFile(renameTarget, renameName.trim());
      setShowRenameDialog(false);
      setRenameTarget(null);
      setRenameName("");
    } catch (_err) {
      /* Error handling */
    }
  };

  const handleDelete = async () => {
    if (deleteTargets.length === 0) return;
    try {
      await onDeleteFiles(deleteTargets);
      setShowDeleteConfirm(false);
      setDeleteTargets([]);
      onClearSelection();
    } catch (_err) {
      /* Error handling */
    }
  };

  // Drag handlers
  const handlePaneDragOver = (e: React.DragEvent) => {
    if (!draggedFiles || draggedFiles[0]?.side === side) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setIsDragOverPane(true);
  };

  const handlePaneDragLeave = (e: React.DragEvent) => {
    const relatedTarget = e.relatedTarget as Node | null;
    if (relatedTarget && paneContainerRef.current?.contains(relatedTarget))
      return;
    setIsDragOverPane(false);
    setDragOverEntry(null);
  };

  const handlePaneDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOverPane(false);
    setDragOverEntry(null);
    if (!draggedFiles || draggedFiles[0]?.side === side) return;
    onReceiveFromOtherPane(
      draggedFiles.map((f) => ({ name: f.name, isDirectory: f.isDirectory })),
    );
  };

  const handleFileDragStart = (entry: SftpFileEntry, e: React.DragEvent) => {
    if (entry.name === "..") {
      e.preventDefault();
      return;
    }
    const selectedNames = Array.from(pane.selectedFiles);
    const files = selectedNames.includes(entry.name)
      ? sortedDisplayFiles
          .filter((f) => selectedNames.includes(f.name))
          .map((f) => ({
            name: f.name,
            isDirectory: f.type === "directory",
            side,
          }))
      : [{ name: entry.name, isDirectory: entry.type === "directory", side }];
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("text/plain", files.map((f) => f.name).join("\n"));
    onDragStart(files, side);
  };

  const handleEntryDragOver = (entry: SftpFileEntry, e: React.DragEvent) => {
    if (!draggedFiles || draggedFiles[0]?.side === side) return;
    if (entry.type === "directory" && entry.name !== "..") {
      e.preventDefault();
      e.stopPropagation();
      setDragOverEntry(entry.name);
    }
  };

  const handleEntryDrop = (entry: SftpFileEntry, e: React.DragEvent) => {
    if (!draggedFiles || draggedFiles[0]?.side === side) return;
    if (entry.type === "directory" && entry.name !== "..") {
      e.preventDefault();
      e.stopPropagation();
      setDragOverEntry(null);
      setIsDragOverPane(false);
      onReceiveFromOtherPane(
        draggedFiles.map((f) => ({ name: f.name, isDirectory: f.isDirectory })),
      );
    }
  };

  const openRenameDialog = (name: string) => {
    setRenameTarget(name);
    setRenameName(name);
    setShowRenameDialog(true);
  };

  const openDeleteConfirm = (names: string[]) => {
    setDeleteTargets(names);
    setShowDeleteConfirm(true);
  };

  // No connection state
  if (!pane.connection) {
    return (
      <div className="absolute inset-0 flex flex-col">
        <div className="h-12 px-4 border-b border-border/60 flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            {side === "left" ? <Monitor size={14} /> : <HardDrive size={14} />}
            <span>{side === "left" ? "Local" : "Remote"}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3"
            onClick={() => setShowHostPicker(true)}
          >
            <Plus size={14} className="mr-2" /> Select host
          </Button>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center text-center gap-4 p-6">
          <div className="h-14 w-14 rounded-xl bg-secondary/60 text-primary flex items-center justify-center">
            {side === "left" ? <Monitor size={24} /> : <HardDrive size={24} />}
          </div>
          <div>
            <div className="text-sm font-semibold mb-1">
              Select a host to start
            </div>
            <div className="text-xs text-muted-foreground">
              Choose a local or remote filesystem to browse
            </div>
          </div>
          <Button onClick={() => setShowHostPicker(true)}>
            <Plus size={14} className="mr-2" /> Select host
          </Button>
        </div>

        <SftpHostPicker
          open={showHostPicker}
          onOpenChange={setShowHostPicker}
          hosts={hosts}
          side={side}
          hostSearch={hostSearch}
          onHostSearchChange={setHostSearch}
          onSelectLocal={() => onConnect("local")}
          onSelectHost={onConnect}
        />
      </div>
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
      {/* Header */}
      <div className="h-12 px-4 border-b border-border/60 flex items-center gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          {pane.connection.isLocal ? (
            <Monitor size={14} />
          ) : (
            <HardDrive size={14} />
          )}
          <span>{pane.connection.hostLabel}</span>
          {(pane.connection.status === "connecting" || pane.reconnecting) && (
            <Loader2 size={12} className="animate-spin text-muted-foreground" />
          )}
          {pane.reconnecting && (
            <span className="text-xs text-muted-foreground">
              Reconnecting...
            </span>
          )}
          {pane.connection.status === "error" && !pane.reconnecting && (
            <AlertCircle size={12} className="text-destructive" />
          )}
        </div>

        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3"
          onClick={() => setShowHostPicker(true)}
        >
          <RefreshCw size={12} className="mr-1" /> Change
        </Button>

        <div className="flex items-center gap-1 ml-auto">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={pane.filter}
              onChange={(e) => onSetFilter(e.target.value)}
              placeholder="Filter..."
              className="h-8 w-36 pl-8 pr-7 text-xs bg-secondary/40"
            />
            {pane.filter && (
              <button
                onClick={() => onSetFilter("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X size={12} />
              </button>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onRefresh}
            title="Refresh"
          >
            <RefreshCw
              size={14}
              className={
                pane.loading || pane.reconnecting ? "animate-spin" : ""
              }
            />
          </Button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="h-10 px-4 flex items-center gap-2 border-b border-border/40 bg-secondary/20">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onNavigateUp}
          title="Go up"
        >
          <ChevronLeft size={14} />
        </Button>

        {/* Editable Breadcrumb with autocomplete */}
        {isEditingPath ? (
          <div className="relative flex-1">
            <Input
              ref={pathInputRef}
              value={editingPathValue}
              onChange={(e) => {
                setEditingPathValue(e.target.value);
                setShowPathSuggestions(true);
                setPathSuggestionIndex(-1);
              }}
              onBlur={handlePathBlur}
              onKeyDown={handlePathKeyDown}
              onFocus={() => setShowPathSuggestions(true)}
              className="h-7 w-full text-xs bg-background"
              autoFocus
            />
            {showPathSuggestions && pathSuggestions.length > 0 && (
              <div
                ref={pathDropdownRef}
                className="absolute top-full left-0 right-0 mt-1 bg-popover border border-border rounded-md shadow-lg z-50 max-h-48 overflow-auto"
              >
                {pathSuggestions.map((suggestion, idx) => (
                  <button
                    key={suggestion.path}
                    type="button"
                    className={cn(
                      "w-full px-3 py-2 text-left text-xs flex items-center gap-2 hover:bg-secondary/60 transition-colors",
                      idx === pathSuggestionIndex && "bg-secondary/80",
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handlePathSubmit(suggestion.path);
                    }}
                  >
                    {suggestion.type === "folder" ? (
                      <Folder size={12} className="text-primary shrink-0" />
                    ) : (
                      <Home
                        size={12}
                        className="text-muted-foreground shrink-0"
                      />
                    )}
                    <span className="truncate font-mono">
                      {suggestion.path}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div
            className="flex-1 cursor-text hover:bg-secondary/50 rounded px-1 transition-colors"
            onDoubleClick={handlePathDoubleClick}
            title="Double-click to edit path"
          >
            <SftpBreadcrumb
              path={pane.connection.currentPath}
              onNavigate={onNavigateTo}
              onHome={() =>
                pane.connection?.homeDir &&
                onNavigateTo(pane.connection.homeDir)
              }
            />
          </div>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setShowNewFolderDialog(true)}
          >
            <FolderPlus size={12} className="mr-1" /> New Folder
          </Button>
        </div>
      </div>

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
          <span>Name</span>
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
          <span>Modified</span>
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
          <span>Size</span>
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
          <span>Kind</span>
        </div>
      </div>

      {/* File list */}
      <div
        ref={fileListRef}
        className={cn(
          "flex-1 min-h-0 overflow-y-auto relative",
          isDragOverPane && "ring-2 ring-primary/30 ring-inset",
        )}
      >
        {pane.loading && sortedDisplayFiles.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 size={24} className="animate-spin text-muted-foreground" />
          </div>
        ) : pane.error ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-destructive">
            <AlertCircle size={24} />
            <span className="text-sm">{pane.error}</span>
            <Button variant="outline" size="sm" onClick={onRefresh}>
              Retry
            </Button>
          </div>
        ) : sortedDisplayFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Folder size={32} className="mb-2 opacity-50" />
            <span className="text-sm">Empty directory</span>
          </div>
        ) : (
          <div className="divide-y divide-border/30">
            {sortedDisplayFiles.map((entry, idx) => (
              <ContextMenu key={`${entry.name}-${idx}`}>
                <ContextMenuTrigger>
                  <SftpFileRow
                    entry={entry}
                    isSelected={pane.selectedFiles.has(entry.name)}
                    isDragOver={dragOverEntry === entry.name}
                    columnWidths={columnWidths}
                    onSelect={(e) => {
                      if (entry.name === "..") return;
                      if (e.shiftKey && lastSelectedIndexRef.current !== null) {
                        const start = Math.min(
                          lastSelectedIndexRef.current,
                          idx,
                        );
                        const end = Math.max(lastSelectedIndexRef.current, idx);
                        const selectedFileNames = sortedDisplayFiles
                          .slice(start, end + 1)
                          .filter((f) => f.name !== "..")
                          .map((f) => f.name);
                        onRangeSelect(selectedFileNames);
                      } else {
                        onToggleSelection(entry.name, e.ctrlKey || e.metaKey);
                        lastSelectedIndexRef.current = idx;
                      }
                    }}
                    onOpen={() => onOpenEntry(entry)}
                    onDragStart={(e) => handleFileDragStart(entry, e)}
                    onDragEnd={onDragEnd}
                    onDragOver={(e) => handleEntryDragOver(entry, e)}
                    onDragLeave={() => setDragOverEntry(null)}
                    onDrop={(e) => handleEntryDrop(entry, e)}
                  />
                </ContextMenuTrigger>
                {entry.name !== ".." && (
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => onOpenEntry(entry)}>
                      {entry.type === "directory" ? "Open" : "Download"}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      onClick={() => {
                        const files = pane.selectedFiles.has(entry.name)
                          ? Array.from(pane.selectedFiles)
                          : [entry.name];
                        const fileData = files.map((name) => {
                          const file = sortedDisplayFiles.find(
                            (f) => f.name === name,
                          );
                          return {
                            name,
                            isDirectory: file?.type === "directory" || false,
                          };
                        });
                        onCopyToOtherPane(fileData);
                      }}
                    >
                      <Copy size={14} className="mr-2" /> Copy to other pane
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      onClick={() => openRenameDialog(entry.name)}
                    >
                      <Pencil size={14} className="mr-2" /> Rename
                    </ContextMenuItem>
                    {onEditPermissions &&
                      pane.connection &&
                      !pane.connection.isLocal && (
                        <ContextMenuItem
                          onClick={() => onEditPermissions(entry)}
                        >
                          <Shield size={14} className="mr-2" /> Permissions
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
                      <Trash2 size={14} className="mr-2" /> Delete
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={onRefresh}>
                      <RefreshCw size={14} className="mr-2" /> Refresh
                    </ContextMenuItem>
                    <ContextMenuItem
                      onClick={() => setShowNewFolderDialog(true)}
                    >
                      <FolderPlus size={14} className="mr-2" /> New Folder
                    </ContextMenuItem>
                  </ContextMenuContent>
                )}
              </ContextMenu>
            ))}
          </div>
        )}

        {/* Drop overlay */}
        {isDragOverPane && draggedFiles && draggedFiles[0]?.side !== side && (
          <div className="absolute inset-0 flex items-center justify-center bg-primary/5 pointer-events-none">
            <div className="flex flex-col items-center gap-2 text-primary">
              <ArrowDown size={32} />
              <span className="text-sm font-medium">Drop files here</span>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="h-9 shrink-0 px-4 flex items-center justify-between text-[11px] text-muted-foreground border-t border-border/40 bg-secondary/30">
        <span>
          {sortedDisplayFiles.filter((f) => f.name !== "..").length} items
          {pane.selectedFiles.size > 0 &&
            ` - ${pane.selectedFiles.size} selected`}
        </span>
        <span className="truncate max-w-[200px]">
          {pane.connection.currentPath}
        </span>
      </div>

      {/* Dialogs */}
      <Dialog open={showNewFolderDialog} onOpenChange={setShowNewFolderDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New Folder</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Folder name</Label>
              <Input
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="Enter folder name"
                onKeyDown={(e) => e.key === "Enter" && handleCreateFolder()}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowNewFolderDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateFolder}
              disabled={!newFolderName.trim()}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showRenameDialog} onOpenChange={setShowRenameDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>New name</Label>
              <Input
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                placeholder="Enter new name"
                onKeyDown={(e) => e.key === "Enter" && handleRename()}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowRenameDialog(false)}
            >
              Cancel
            </Button>
            <Button onClick={handleRename} disabled={!renameName.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Delete {deleteTargets.length} item
              {deleteTargets.length > 1 ? "s" : ""}?
            </DialogTitle>
            <DialogDescription>
              This action cannot be undone. The following will be deleted:
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-32 overflow-auto text-sm space-y-1">
            {deleteTargets.map((name) => (
              <div
                key={name}
                className="flex items-center gap-2 text-muted-foreground"
              >
                <Trash2 size={12} />
                <span className="truncate">{name}</span>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteConfirm(false)}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SftpHostPicker
        open={showHostPicker}
        onOpenChange={setShowHostPicker}
        hosts={hosts}
        side={side}
        hostSearch={hostSearch}
        onHostSearchChange={setHostSearch}
        onSelectLocal={() => {
          onDisconnect();
          onConnect("local");
        }}
        onSelectHost={(host) => {
          onDisconnect();
          onConnect(host);
        }}
      />
    </div>
  );
};

const SftpPaneView = memo(SftpPaneViewInner);
SftpPaneView.displayName = "SftpPaneView";

// Main SftpView component
interface SftpViewProps {
  hosts: Host[];
  keys: SSHKey[];
}

const SftpViewInner: React.FC<SftpViewProps> = ({ hosts, keys }) => {
  const isActive = useIsSftpActive();
  const sftp = useSftpState(hosts, keys);
  const [permissionsState, setPermissionsState] = useState<{
    file: SftpFileEntry;
    side: "left" | "right";
  } | null>(null);
  const [draggedFiles, setDraggedFiles] = useState<
    { name: string; isDirectory: boolean; side: "left" | "right" }[] | null
  >(null);

  // Memoized callbacks
  const handleDragStart = useCallback(
    (
      files: { name: string; isDirectory: boolean }[],
      side: "left" | "right",
    ) => {
      setDraggedFiles(files.map((f) => ({ ...f, side })));
    },
    [],
  );

  const handleDragEnd = useCallback(() => {
    setDraggedFiles(null);
  }, []);

  const handleCopyToOtherPaneLeft = useCallback(
    (files: { name: string; isDirectory: boolean }[]) =>
      sftp.startTransfer(files, "left", "right"),
    [sftp.startTransfer],
  );
  const handleCopyToOtherPaneRight = useCallback(
    (files: { name: string; isDirectory: boolean }[]) =>
      sftp.startTransfer(files, "right", "left"),
    [sftp.startTransfer],
  );
  const handleReceiveFromOtherPaneLeft = useCallback(
    (files: { name: string; isDirectory: boolean }[]) =>
      sftp.startTransfer(files, "right", "left"),
    [sftp.startTransfer],
  );
  const handleReceiveFromOtherPaneRight = useCallback(
    (files: { name: string; isDirectory: boolean }[]) =>
      sftp.startTransfer(files, "left", "right"),
    [sftp.startTransfer],
  );

  const handleConnectLeft = useCallback(
    (host: Host) => sftp.connect("left", host),
    [sftp.connect],
  );
  const handleConnectRight = useCallback(
    (host: Host) => sftp.connect("right", host),
    [sftp.connect],
  );
  const handleDisconnectLeft = useCallback(
    () => sftp.disconnect("left"),
    [sftp.disconnect],
  );
  const handleDisconnectRight = useCallback(
    () => sftp.disconnect("right"),
    [sftp.disconnect],
  );
  const handleNavigateToLeft = useCallback(
    (path: string) => sftp.navigateTo("left", path),
    [sftp.navigateTo],
  );
  const handleNavigateToRight = useCallback(
    (path: string) => sftp.navigateTo("right", path),
    [sftp.navigateTo],
  );
  const handleNavigateUpLeft = useCallback(
    () => sftp.navigateUp("left"),
    [sftp.navigateUp],
  );
  const handleNavigateUpRight = useCallback(
    () => sftp.navigateUp("right"),
    [sftp.navigateUp],
  );
  const handleRefreshLeft = useCallback(
    () => sftp.refresh("left"),
    [sftp.refresh],
  );
  const handleRefreshRight = useCallback(
    () => sftp.refresh("right"),
    [sftp.refresh],
  );
  const handleOpenEntryLeft = useCallback(
    (entry: SftpFileEntry) => sftp.openEntry("left", entry),
    [sftp.openEntry],
  );
  const handleOpenEntryRight = useCallback(
    (entry: SftpFileEntry) => sftp.openEntry("right", entry),
    [sftp.openEntry],
  );
  const handleToggleSelectionLeft = useCallback(
    (name: string, multi: boolean) => sftp.toggleSelection("left", name, multi),
    [sftp.toggleSelection],
  );
  const handleToggleSelectionRight = useCallback(
    (name: string, multi: boolean) =>
      sftp.toggleSelection("right", name, multi),
    [sftp.toggleSelection],
  );
  const handleRangeSelectLeft = useCallback(
    (fileNames: string[]) => sftp.rangeSelect("left", fileNames),
    [sftp.rangeSelect],
  );
  const handleRangeSelectRight = useCallback(
    (fileNames: string[]) => sftp.rangeSelect("right", fileNames),
    [sftp.rangeSelect],
  );
  const handleClearSelectionLeft = useCallback(
    () => sftp.clearSelection("left"),
    [sftp.clearSelection],
  );
  const handleClearSelectionRight = useCallback(
    () => sftp.clearSelection("right"),
    [sftp.clearSelection],
  );
  const handleSetFilterLeft = useCallback(
    (filter: string) => sftp.setFilter("left", filter),
    [sftp.setFilter],
  );
  const handleSetFilterRight = useCallback(
    (filter: string) => sftp.setFilter("right", filter),
    [sftp.setFilter],
  );
  const handleCreateDirectoryLeft = useCallback(
    (name: string) => sftp.createDirectory("left", name),
    [sftp.createDirectory],
  );
  const handleCreateDirectoryRight = useCallback(
    (name: string) => sftp.createDirectory("right", name),
    [sftp.createDirectory],
  );
  const handleDeleteFilesLeft = useCallback(
    (names: string[]) => sftp.deleteFiles("left", names),
    [sftp.deleteFiles],
  );
  const handleDeleteFilesRight = useCallback(
    (names: string[]) => sftp.deleteFiles("right", names),
    [sftp.deleteFiles],
  );
  const handleRenameFileLeft = useCallback(
    (old: string, newName: string) => sftp.renameFile("left", old, newName),
    [sftp.renameFile],
  );
  const handleRenameFileRight = useCallback(
    (old: string, newName: string) => sftp.renameFile("right", old, newName),
    [sftp.renameFile],
  );
  const handleEditPermissionsLeft = useCallback(
    (file: SftpFileEntry) => setPermissionsState({ file, side: "left" }),
    [],
  );
  const handleEditPermissionsRight = useCallback(
    (file: SftpFileEntry) => setPermissionsState({ file, side: "right" }),
    [],
  );

  const leftFilteredFiles = useMemo(
    () => sftp.getFilteredFiles(sftp.leftPane),
    [sftp.leftPane, sftp.getFilteredFiles],
  );
  const rightFilteredFiles = useMemo(
    () => sftp.getFilteredFiles(sftp.rightPane),
    [sftp.rightPane, sftp.getFilteredFiles],
  );
  const visibleTransfers = useMemo(
    () => sftp.transfers.slice(-5),
    [sftp.transfers],
  );

  const containerStyle: React.CSSProperties = isActive
    ? {}
    : {
        visibility: "hidden",
        pointerEvents: "none",
        position: "absolute",
        zIndex: -1,
      };

  return (
    <div
      className={cn(
        "absolute inset-0 min-h-0 flex flex-col",
        isActive ? "z-20" : "",
      )}
      style={containerStyle}
    >
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 min-h-0 border-t border-border/70">
        <div className="relative border-r border-border/70">
          <SftpPaneView
            side="left"
            pane={sftp.leftPane}
            hosts={hosts}
            filteredFiles={leftFilteredFiles}
            onConnect={handleConnectLeft}
            onDisconnect={handleDisconnectLeft}
            onNavigateTo={handleNavigateToLeft}
            onNavigateUp={handleNavigateUpLeft}
            onRefresh={handleRefreshLeft}
            onOpenEntry={handleOpenEntryLeft}
            onToggleSelection={handleToggleSelectionLeft}
            onRangeSelect={handleRangeSelectLeft}
            onClearSelection={handleClearSelectionLeft}
            onSetFilter={handleSetFilterLeft}
            onCreateDirectory={handleCreateDirectoryLeft}
            onDeleteFiles={handleDeleteFilesLeft}
            onRenameFile={handleRenameFileLeft}
            onCopyToOtherPane={handleCopyToOtherPaneLeft}
            onReceiveFromOtherPane={handleReceiveFromOtherPaneLeft}
            onEditPermissions={handleEditPermissionsLeft}
            draggedFiles={draggedFiles}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          />
        </div>
        <div className="relative">
          <SftpPaneView
            side="right"
            pane={sftp.rightPane}
            hosts={hosts}
            filteredFiles={rightFilteredFiles}
            onConnect={handleConnectRight}
            onDisconnect={handleDisconnectRight}
            onNavigateTo={handleNavigateToRight}
            onNavigateUp={handleNavigateUpRight}
            onRefresh={handleRefreshRight}
            onOpenEntry={handleOpenEntryRight}
            onToggleSelection={handleToggleSelectionRight}
            onRangeSelect={handleRangeSelectRight}
            onClearSelection={handleClearSelectionRight}
            onSetFilter={handleSetFilterRight}
            onCreateDirectory={handleCreateDirectoryRight}
            onDeleteFiles={handleDeleteFilesRight}
            onRenameFile={handleRenameFileRight}
            onCopyToOtherPane={handleCopyToOtherPaneRight}
            onReceiveFromOtherPane={handleReceiveFromOtherPaneRight}
            onEditPermissions={handleEditPermissionsRight}
            draggedFiles={draggedFiles}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          />
        </div>
      </div>

      {sftp.transfers.length > 0 && (
        <div className="border-t border-border/70 bg-secondary/80 backdrop-blur-sm shrink-0">
          <div className="flex items-center justify-between px-4 py-2 text-xs text-muted-foreground border-b border-border/40">
            <span className="font-medium">
              Transfers
              {sftp.activeTransfersCount > 0 && (
                <span className="ml-2 text-primary">
                  ({sftp.activeTransfersCount} active)
                </span>
              )}
            </span>
            {sftp.transfers.some(
              (t) => t.status === "completed" || t.status === "cancelled",
            ) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={sftp.clearCompletedTransfers}
              >
                Clear completed
              </Button>
            )}
          </div>
          <div className="max-h-40 overflow-auto">
            {visibleTransfers.map((task) => (
              <SftpTransferItem
                key={task.id}
                task={task}
                onCancel={() => sftp.cancelTransfer(task.id)}
                onRetry={() => sftp.retryTransfer(task.id)}
                onDismiss={() => sftp.dismissTransfer(task.id)}
              />
            ))}
          </div>
        </div>
      )}

      <SftpConflictDialog
        conflicts={sftp.conflicts}
        onResolve={sftp.resolveConflict}
        formatFileSize={sftp.formatFileSize}
      />

      <SftpPermissionsDialog
        open={!!permissionsState}
        onOpenChange={(open) => !open && setPermissionsState(null)}
        file={permissionsState?.file ?? null}
        onSave={(file, permissions) => {
          if (permissionsState) {
            const fullPath = sftp.joinPath(
              permissionsState.side === "left"
                ? sftp.leftPane.connection?.currentPath || ""
                : sftp.rightPane.connection?.currentPath || "",
              file.name,
            );
            sftp.changePermissions(
              permissionsState.side,
              fullPath,
              permissions,
            );
          }
          setPermissionsState(null);
        }}
      />
    </div>
  );
};

const sftpViewAreEqual = (prev: SftpViewProps, next: SftpViewProps): boolean =>
  prev.hosts === next.hosts && prev.keys === next.keys;

export const SftpView = memo(SftpViewInner, sftpViewAreEqual);
SftpView.displayName = "SftpView";
