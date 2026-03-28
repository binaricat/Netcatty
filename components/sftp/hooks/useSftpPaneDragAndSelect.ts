import React, { useCallback, useRef, useState } from "react";
import type { SftpFileEntry } from "../../../types";
import type { SftpPaneCallbacks, SftpDragCallbacks, SftpTransferSource } from "../SftpContext";
import { isNavigableDirectory } from "../index";
import { joinPath } from "../../../application/state/sftp/utils";

interface UseSftpPaneDragAndSelectParams {
  side: "left" | "right";
  pane: {
    selectedFiles: Set<string>;
    connection?: { currentPath: string; id: string } | null;
  };
  sortedDisplayFiles: SftpFileEntry[];
  draggedFiles: (SftpTransferSource & { side: "left" | "right" })[] | null;
  onDragStart: SftpDragCallbacks["onDragStart"];
  onReceiveFromOtherPane: SftpPaneCallbacks["onReceiveFromOtherPane"];
  onMoveEntriesToPath: SftpPaneCallbacks["onMoveEntriesToPath"];
  onUploadExternalFiles?: SftpPaneCallbacks["onUploadExternalFiles"];
  onOpenEntry: SftpPaneCallbacks["onOpenEntry"];
  onRangeSelect: SftpPaneCallbacks["onRangeSelect"];
  onToggleSelection: SftpPaneCallbacks["onToggleSelection"];
}

interface UseSftpPaneDragAndSelectResult {
  dragOverEntry: string | null;
  isDragOverPane: boolean;
  paneContainerRef: React.RefObject<HTMLDivElement>;
  handlePaneDragOver: (e: React.DragEvent) => void;
  handlePaneDragLeave: (e: React.DragEvent) => void;
  handlePaneDrop: (e: React.DragEvent) => Promise<void>;
  handleFileDragStart: (entry: SftpFileEntry, e: React.DragEvent) => void;
  handleEntryDragOver: (entry: SftpFileEntry, e: React.DragEvent) => void;
  handleEntryDrop: (entry: SftpFileEntry, e: React.DragEvent) => void;
  handleRowDragLeave: () => void;
  handleRowSelect: (entry: SftpFileEntry, index: number, e: React.MouseEvent) => void;
  handleRowOpen: (entry: SftpFileEntry) => void;
}

export const useSftpPaneDragAndSelect = ({
  side,
  pane,
  sortedDisplayFiles,
  draggedFiles,
  onDragStart,
  onReceiveFromOtherPane,
  onMoveEntriesToPath,
  onUploadExternalFiles,
  onOpenEntry,
  onRangeSelect,
  onToggleSelection,
}: UseSftpPaneDragAndSelectParams): UseSftpPaneDragAndSelectResult => {
  const [dragOverEntry, setDragOverEntry] = useState<string | null>(null);
  const [isDragOverPane, setIsDragOverPane] = useState(false);
  const paneContainerRef = useRef<HTMLDivElement>(null);
  const lastSelectedIndexRef = useRef<number | null>(null);

  const selectedFilesRef = useRef(pane.selectedFiles);
  selectedFilesRef.current = pane.selectedFiles;
  const sortedFilesRef = useRef(sortedDisplayFiles);
  sortedFilesRef.current = sortedDisplayFiles;
  const draggedFilesRef = useRef(draggedFiles);
  draggedFilesRef.current = draggedFiles;
  const onReceiveRef = useRef(onReceiveFromOtherPane);
  onReceiveRef.current = onReceiveFromOtherPane;
  const onMoveEntriesToPathRef = useRef(onMoveEntriesToPath);
  onMoveEntriesToPathRef.current = onMoveEntriesToPath;
  const onUploadRef = useRef(onUploadExternalFiles);
  onUploadRef.current = onUploadExternalFiles;

  const getSamePaneDragPaths = useCallback((): string[] | null => {
    const dragged = draggedFilesRef.current;
    if (!dragged || dragged.length === 0) return null;
    if (dragged[0]?.side !== side) return null;

    const currentConnectionId = pane.connection?.id;
    const paths = dragged
      .filter((file) => file.sourceConnectionId === currentConnectionId && file.sourcePath)
      .map((file) => joinPath(file.sourcePath!, file.name));

    return paths.length > 0 ? paths : null;
  }, [pane.connection?.id, side]);

  const handlePaneDragOver = useCallback((e: React.DragEvent) => {
    const hasFiles = e.dataTransfer.types.includes("Files");

    if (hasFiles) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setIsDragOverPane(true);
      return;
    }

    if (!draggedFilesRef.current || draggedFilesRef.current[0]?.side === side) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setIsDragOverPane(true);
  }, [side]);

  const handlePaneDragLeave = useCallback((e: React.DragEvent) => {
    const relatedTarget = e.relatedTarget as Node | null;
    if (relatedTarget && paneContainerRef.current?.contains(relatedTarget)) return;
    setIsDragOverPane(false);
    setDragOverEntry(null);
  }, []);

  const handlePaneDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOverPane(false);
    setDragOverEntry(null);

    if (draggedFilesRef.current && draggedFilesRef.current.length > 0) {
      if (draggedFilesRef.current[0]?.side !== side) {
        onReceiveRef.current(draggedFilesRef.current);
      }
      return;
    }

    if (e.dataTransfer.items.length > 0 && onUploadRef.current) {
      await onUploadRef.current(e.dataTransfer);
    }
  }, [side]);

  const handleFileDragStart = useCallback(
    (entry: SftpFileEntry, e: React.DragEvent) => {
      if (entry.name === "..") {
        e.preventDefault();
        return;
      }
      const selectedNames = new Set(selectedFilesRef.current);
      const files = selectedNames.has(entry.name)
        ? sortedFilesRef.current
          .filter((f) => selectedNames.has(f.name))
          .map((f) => ({
            name: f.name,
            isDirectory: isNavigableDirectory(f),
            sourceConnectionId: pane.connection?.id,
            sourcePath: pane.connection?.currentPath,
            side,
          }))
        : [
          {
            name: entry.name,
            isDirectory: isNavigableDirectory(entry),
            sourceConnectionId: pane.connection?.id,
            sourcePath: pane.connection?.currentPath,
            side,
          },
        ];
      e.dataTransfer.effectAllowed = "copyMove";
      e.dataTransfer.setData("text/plain", files.map((f) => f.name).join("\n"));
      onDragStart(files, side);
    },
    [onDragStart, pane.connection?.currentPath, pane.connection?.id, side],
  );

  const handleEntryDragOver = useCallback(
    (entry: SftpFileEntry, e: React.DragEvent) => {
      const samePaneDragPaths = getSamePaneDragPaths();
      if (samePaneDragPaths && isNavigableDirectory(entry) && entry.name !== "..") {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setDragOverEntry(entry.name);
        return;
      }

      // Handle cross-pane internal drag
      if (draggedFilesRef.current && draggedFilesRef.current[0]?.side !== side) {
        if (isNavigableDirectory(entry) && entry.name !== "..") {
          e.preventDefault();
          e.stopPropagation();
          setDragOverEntry(entry.name);
        }
        return;
      }
      // Handle external file drag (from OS file explorer)
      const hasFiles = e.dataTransfer.types.includes("Files");
      if (hasFiles && isNavigableDirectory(entry) && entry.name !== "..") {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setDragOverEntry(entry.name);
      }
    },
    [getSamePaneDragPaths, side],
  );

  const handleEntryDrop = useCallback(
    async (entry: SftpFileEntry, e: React.DragEvent) => {
      const samePaneDragPaths = getSamePaneDragPaths();
      if (samePaneDragPaths && isNavigableDirectory(entry) && entry.name !== "..") {
        e.preventDefault();
        e.stopPropagation();
        setDragOverEntry(null);
        setIsDragOverPane(false);
        const targetPath = pane.connection?.currentPath
          ? joinPath(pane.connection.currentPath, entry.name)
          : undefined;
        if (targetPath) {
          await onMoveEntriesToPathRef.current(samePaneDragPaths, targetPath);
        }
        return;
      }

      // Handle cross-pane internal drag
      if (draggedFilesRef.current && draggedFilesRef.current[0]?.side !== side) {
        if (isNavigableDirectory(entry) && entry.name !== "..") {
          e.preventDefault();
          e.stopPropagation();
          setDragOverEntry(null);
          setIsDragOverPane(false);
          const targetPath = pane.connection?.currentPath
            ? joinPath(pane.connection.currentPath, entry.name)
            : undefined;
          onReceiveRef.current(
            draggedFilesRef.current.map((file) => ({ ...file, targetPath })),
          );
        }
        return;
      }
      // Handle external file drop on a directory entry
      const hasFiles = e.dataTransfer.types.includes("Files");
      if (hasFiles && isNavigableDirectory(entry) && entry.name !== "..") {
        e.preventDefault();
        e.stopPropagation();
        setDragOverEntry(null);
        setIsDragOverPane(false);
        if (onUploadRef.current && pane.connection?.currentPath) {
          const targetPath = joinPath(pane.connection.currentPath, entry.name);
          void onUploadRef.current(e.dataTransfer, targetPath);
        }
      }
    },
    [getSamePaneDragPaths, side, pane.connection?.currentPath],
  );

  const handleRowSelect = useCallback(
    (entry: SftpFileEntry, index: number, e: React.MouseEvent) => {
      if (entry.name === "..") return;
      if (e.shiftKey && lastSelectedIndexRef.current !== null) {
        const start = Math.min(lastSelectedIndexRef.current, index);
        const end = Math.max(lastSelectedIndexRef.current, index);
        const selectedFileNames = sortedFilesRef.current
          .slice(start, end + 1)
          .filter((f) => f.name !== "..")
          .map((f) => f.name);
        onRangeSelect(selectedFileNames);
      } else {
        onToggleSelection(entry.name, e.ctrlKey || e.metaKey);
        lastSelectedIndexRef.current = index;
      }
    },
    [onRangeSelect, onToggleSelection],
  );

  const handleRowOpen = useCallback(
    (entry: SftpFileEntry) => {
      onOpenEntry(entry);
    },
    [onOpenEntry],
  );

  const handleRowDragLeave = useCallback(() => {
    setDragOverEntry(null);
  }, []);

  return {
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
  };
};
