import React, { useCallback, useRef, useState } from "react";
import type { ColumnWidths, SortField, SortOrder } from "../utils";

interface UseSftpPaneSortingResult {
  sortField: SortField;
  sortOrder: SortOrder;
  columnWidths: ColumnWidths;
  handleSort: (field: SortField) => void;
  handleResizeStart: (field: keyof ColumnWidths, e: React.MouseEvent) => void;
}

export const useSftpPaneSorting = (): UseSftpPaneSortingResult => {
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>({
    name: 56,
    modified: 28,
    size: 7,
    type: 9,
  });

  const resizingRef = useRef<{
    field: keyof ColumnWidths;
    startX: number;
    startWidth: number;
  } | null>(null);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

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
    columnWidths,
    handleSort,
    handleResizeStart,
  };
};
