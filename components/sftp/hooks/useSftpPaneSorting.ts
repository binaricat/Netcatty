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

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

  const rafIdRef = useRef<number | null>(null);

  const handleResizeMove = useCallback((e: MouseEvent) => {
    if (!resizingRef.current) return;
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
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
    });
  }, []);

  const handleResizeEnd = useCallback(() => {
    if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = null;
    resizingRef.current = null;
    document.removeEventListener("mousemove", handleResizeMove);
    document.removeEventListener("mouseup", handleResizeEnd);
  }, [handleResizeMove]);

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

  return {
    sortField,
    sortOrder,
    columnWidths,
    handleSort,
    handleResizeStart,
  };
};
