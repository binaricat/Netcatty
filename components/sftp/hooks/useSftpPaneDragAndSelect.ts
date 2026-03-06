import React, { useCallback, useEffect, useRef, useState } from "react";
import type { SftpFileEntry } from "../../../types";
import type { SftpPaneCallbacks, SftpDragCallbacks } from "../SftpContext";
import { isNavigableDirectory } from "../index";

interface UseSftpPaneDragAndSelectParams {
  side: "left" | "right";
  pane: { selectedFiles: Set<string> };
  sortedDisplayFiles: SftpFileEntry[];
  draggedFiles: { name: string; isDirectory: boolean; side: "left" | "right" }[] | null;
  onDragStart: SftpDragCallbacks["onDragStart"];
  onReceiveFromOtherPane: SftpPaneCallbacks["onReceiveFromOtherPane"];
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
  const sortedFilesRef = useRef(sortedDisplayFiles);

  useEffect(() => {
    selectedFilesRef.current = pane.selectedFiles;
  }, [pane.selectedFiles]);

  useEffect(() => {
    sortedFilesRef.current = sortedDisplayFiles;
  }, [sortedDisplayFiles]);

  const handlePaneDragOver = (e: React.DragEvent) => {
    const hasFiles = e.dataTransfer.types.includes("Files");

    if (hasFiles) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setIsDragOverPane(true);
      return;
    }

    if (!draggedFiles || draggedFiles[0]?.side === side) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setIsDragOverPane(true);
  };

  const handlePaneDragLeave = (e: React.DragEvent) => {
    const relatedTarget = e.relatedTarget as Node | null;
    if (relatedTarget && paneContainerRef.current?.contains(relatedTarget)) return;
    setIsDragOverPane(false);
    setDragOverEntry(null);
  };

  const handlePaneDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOverPane(false);
    setDragOverEntry(null);

    if (draggedFiles && draggedFiles.length > 0) {
      if (draggedFiles[0]?.side !== side) {
        onReceiveFromOtherPane(
          draggedFiles.map((f) => ({ name: f.name, isDirectory: f.isDirectory })),
        );
      }
      return;
    }

    if (e.dataTransfer.items.length > 0 && onUploadExternalFiles) {
      await onUploadExternalFiles(e.dataTransfer);
    }
  };

  const handleFileDragStart = useCallback(
    (entry: SftpFileEntry, e: React.DragEvent) => {
      if (entry.name === "..") {
        e.preventDefault();
        return;
      }
      const selectedNames = Array.from(selectedFilesRef.current);
      const files = selectedNames.includes(entry.name)
        ? sortedFilesRef.current
          .filter((f) => selectedNames.includes(f.name))
          .map((f) => ({
            name: f.name,
            isDirectory: isNavigableDirectory(f),
            side,
          }))
        : [
          {
            name: entry.name,
            isDirectory: isNavigableDirectory(entry),
            side,
          },
        ];
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData("text/plain", files.map((f) => f.name).join("\n"));
      onDragStart(files, side);
    },
    [onDragStart, side],
  );

  const handleEntryDragOver = useCallback(
    (entry: SftpFileEntry, e: React.DragEvent) => {
      if (!draggedFiles || draggedFiles[0]?.side === side) return;
      if (isNavigableDirectory(entry) && entry.name !== "..") {
        e.preventDefault();
        e.stopPropagation();
        setDragOverEntry(entry.name);
      }
    },
    [draggedFiles, side],
  );

  const handleEntryDrop = useCallback(
    (entry: SftpFileEntry, e: React.DragEvent) => {
      if (!draggedFiles || draggedFiles[0]?.side === side) return;
      if (isNavigableDirectory(entry) && entry.name !== "..") {
        e.preventDefault();
        e.stopPropagation();
        setDragOverEntry(null);
        setIsDragOverPane(false);
        onReceiveFromOtherPane(
          draggedFiles.map((f) => ({ name: f.name, isDirectory: f.isDirectory })),
        );
      }
    },
    [draggedFiles, onReceiveFromOtherPane, side],
  );

  const handleRowSelect = useCallback(
    (entry: SftpFileEntry, index: number, e: React.MouseEvent) => {
      if (entry.name === "..") return;
      if (e.shiftKey && lastSelectedIndexRef.current !== null) {
        const start = Math.min(lastSelectedIndexRef.current, index);
        const end = Math.max(lastSelectedIndexRef.current, index);
        const selectedFileNames = sortedDisplayFiles
          .slice(start, end + 1)
          .filter((f) => f.name !== "..")
          .map((f) => f.name);
        onRangeSelect(selectedFileNames);
      } else {
        onToggleSelection(entry.name, e.ctrlKey || e.metaKey);
        lastSelectedIndexRef.current = index;
      }
    },
    [onRangeSelect, onToggleSelection, sortedDisplayFiles],
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
