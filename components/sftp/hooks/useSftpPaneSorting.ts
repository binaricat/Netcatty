import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_SFTP_COLUMN_VISIBILITY,
  normalizeSftpColumnVisibility,
  type ColumnWidths,
  type SftpColumnVisibility,
  type SortField,
  type SortOrder,
} from "../utils";
import { STORAGE_KEY_SFTP_VISIBLE_COLUMNS } from "../../../infrastructure/config/storageKeys";
import {
  LOCAL_STORAGE_ADAPTER_CHANGED_EVENT,
  localStorageAdapter,
} from "../../../infrastructure/persistence/localStorageAdapter";
import { useSftpDirectoriesFirst } from "../../../application/state/sftp/useSftpDirectoriesFirst";

export interface UseSftpPaneSortingResult {
  sortField: SortField;
  sortOrder: SortOrder;
  directoriesFirst: boolean;
  columnWidths: ColumnWidths;
  visibleColumns: SftpColumnVisibility;
  handleSort: (field: SortField) => void;
  handleResizeStart: (field: keyof ColumnWidths, e: React.MouseEvent) => void;
  toggleColumnVisibility: (field: keyof ColumnWidths) => void;
  toggleDirectoriesFirst: () => void;
}

export const useSftpPaneSorting = (): UseSftpPaneSortingResult => {
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const { directoriesFirst, toggleDirectoriesFirst } = useSftpDirectoriesFirst();
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>({
    name: 56,
    modified: 28,
    size: 7,
    type: 9,
  });
  const [visibleColumns, setVisibleColumns] = useState<SftpColumnVisibility>(() =>
    normalizeSftpColumnVisibility(
      localStorageAdapter.read<Partial<SftpColumnVisibility>>(STORAGE_KEY_SFTP_VISIBLE_COLUMNS),
    ),
  );

  useEffect(() => {
    const syncVisibleColumns = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== STORAGE_KEY_SFTP_VISIBLE_COLUMNS) return;
      if (event instanceof CustomEvent && event.detail?.key !== STORAGE_KEY_SFTP_VISIBLE_COLUMNS) return;
      const next = normalizeSftpColumnVisibility(
        localStorageAdapter.read<Partial<SftpColumnVisibility>>(STORAGE_KEY_SFTP_VISIBLE_COLUMNS),
      );
      setVisibleColumns(next);
    };

    window.addEventListener("storage", syncVisibleColumns);
    window.addEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, syncVisibleColumns);
    return () => {
      window.removeEventListener("storage", syncVisibleColumns);
      window.removeEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, syncVisibleColumns);
    };
  }, []);

  useEffect(() => {
    if (visibleColumns[sortField]) return;
    setSortField("name");
    setSortOrder("asc");
  }, [sortField, visibleColumns]);

  const toggleColumnVisibility = useCallback((field: keyof ColumnWidths) => {
    if (field === "name") return;
    setVisibleColumns((current) => {
      const next = {
        ...DEFAULT_SFTP_COLUMN_VISIBILITY,
        ...current,
        name: true,
        [field]: !current[field],
      };
      localStorageAdapter.write(STORAGE_KEY_SFTP_VISIBLE_COLUMNS, next);
      return next;
    });
  }, []);

  const resizingRef = useRef<{
    field: keyof ColumnWidths;
    startX: number;
    startWidth: number;
  } | null>(null);

  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  }, [sortField]);

  const rafIdRef = useRef<number | null>(null);
  const lastClientXRef = useRef(0);

  const applyColumnWidth = useCallback(() => {
    if (!resizingRef.current) return;
    const { field, startX, startWidth } = resizingRef.current;
    const diff = lastClientXRef.current - startX;
    const limits: Record<keyof ColumnWidths, { min: number; max: number }> = {
      name: { min: 36, max: 78 },
      modified: { min: 18, max: 42 },
      size: { min: 5, max: 16 },
      type: { min: 6, max: 18 },
    };
    const { min, max } = limits[field];
    const newWidth = Math.max(
      min,
      Math.min(max, startWidth + diff / 8),
    );
    setColumnWidths((prev) => ({
      ...prev,
      [field]: newWidth,
    }));
  }, []);

  const handleResizeMove = useCallback((e: MouseEvent) => {
    if (!resizingRef.current) return;
    lastClientXRef.current = e.clientX;
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      applyColumnWidth();
    });
  }, [applyColumnWidth]);

  const handleResizeEnd = useCallback(() => {
    if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    applyColumnWidth();
    rafIdRef.current = null;
    resizingRef.current = null;
    document.removeEventListener("mousemove", handleResizeMove);
    document.removeEventListener("mouseup", handleResizeEnd);
  }, [applyColumnWidth, handleResizeMove]);

  const handleResizeStart = (
    field: keyof ColumnWidths,
    e: React.MouseEvent,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    lastClientXRef.current = e.clientX;
    resizingRef.current = {
      field,
      startX: e.clientX,
      startWidth: columnWidths[field],
    };
    document.addEventListener("mousemove", handleResizeMove);
    document.addEventListener("mouseup", handleResizeEnd);
  };

  return {
    sortField,
    sortOrder,
    directoriesFirst,
    columnWidths,
    visibleColumns,
    handleSort,
    handleResizeStart,
    toggleColumnVisibility,
    toggleDirectoriesFirst,
  };
};
