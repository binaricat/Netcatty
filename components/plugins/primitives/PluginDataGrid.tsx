import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown, ArrowUpRight, KeyRound, Link2, Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { matchWorkbenchShortcut } from './shortcuts';
import type {
  PluginDataGridColumn,
  PluginDataGridRow,
  PluginDataGridWidgetProps,
  PluginWidgetEventCallback,
} from './types';

const ROW_HEIGHT = 30;
const HEADER_HEIGHT = 34;
const GUTTER_WIDTH = 64;
const DEFAULT_COL_WIDTH = 156;
const MIN_COL_WIDTH = 68;
const MAX_COL_WIDTH = 640;

export interface PluginDataGridProps extends PluginDataGridWidgetProps {
  onWidgetEvent: PluginWidgetEventCallback;
}

function readCellValue(row: PluginDataGridRow, col: PluginDataGridColumn, colIndex: number): unknown {
  if (Array.isArray(row)) return row[colIndex];
  if (row && typeof row === 'object') return row[col.name];
  return undefined;
}

function formatCellDisplay(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isNumericColumn(col: PluginDataGridColumn, value: unknown): boolean {
  if (typeof value === 'number') return true;
  if (!col.type) return false;
  return /\b(int|bigint|smallint|tinyint|decimal|numeric|float|double|real|number|serial)\b/i.test(col.type);
}

export function PluginDataGrid({
  columns = [],
  rows = [],
  hiddenColumns,
  dirtyCells,
  deletedRowIndices,
  insertedRows = [],
  selectedRowIndices,
  sort = null,
  editable = false,
  loading = false,
  emptyMessage = 'No rows returned',
  onWidgetEvent,
}: PluginDataGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [activeCell, setActiveCell] = useState<{ rowIndex: number; colIndex: number } | null>(null);
  const [editingCell, setEditingCell] = useState<{
    rowIndex: number;
    colIndex: number;
    colName: string;
    draft: string;
  } | null>(null);
  const [lastSelectedRow, setLastSelectedRow] = useState<number | null>(null);

  const deletedSet = useMemo(() => new Set(deletedRowIndices ?? []), [deletedRowIndices]);
  const selectedSet = useMemo(() => new Set(selectedRowIndices ?? []), [selectedRowIndices]);
  const hiddenSet = useMemo(() => new Set(hiddenColumns ?? []), [hiddenColumns]);
  const visibleCols = useMemo(
    () => columns.map((col, origIndex) => ({ col, origIndex })).filter(({ col }) => !hiddenSet.has(col.name)),
    [columns, hiddenSet],
  );
  const totalRows = rows.length + insertedRows.length;

  const getColWidth = useCallback((col: PluginDataGridColumn): number => {
    const custom = colWidths[col.name];
    if (custom !== undefined) return custom;
    if (typeof col.width === 'number' && Number.isFinite(col.width)) {
      return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(col.width)));
    }
    return DEFAULT_COL_WIDTH;
  }, [colWidths]);

  const rowVirtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    initialRect: { width: 960, height: 420 },
  });

  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: visibleCols.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (visibleCols[index] ? getColWidth(visibleCols[index].col) : DEFAULT_COL_WIDTH),
    overscan: 4,
    initialRect: { width: 960, height: 420 },
  });

  useEffect(() => {
    colVirtualizer.measure();
  }, [colWidths, visibleCols, colVirtualizer]);

  useEffect(() => {
    if (editingCell) {
      const focusInput = () => {
        editInputRef.current?.focus();
        editInputRef.current?.select();
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(focusInput);
      } else {
        focusInput();
      }
    }
  }, [editingCell?.rowIndex, editingCell?.colIndex]);

  const getRowAt = useCallback((rowIndex: number): { row: PluginDataGridRow; isInserted: boolean } | null => {
    if (rowIndex < rows.length) return { row: rows[rowIndex], isInserted: false };
    const insertedIdx = rowIndex - rows.length;
    if (insertedIdx >= 0 && insertedIdx < insertedRows.length) {
      return { row: insertedRows[insertedIdx], isInserted: true };
    }
    return null;
  }, [rows, insertedRows]);

  const getEffectiveValue = useCallback((rowIndex: number, col: PluginDataGridColumn, origColIndex: number) => {
    const dirtyKey = `${rowIndex}:${col.name}`;
    const isDirty = Boolean(dirtyCells && Object.prototype.hasOwnProperty.call(dirtyCells, dirtyKey));
    const entry = getRowAt(rowIndex);
    const rawValue = entry ? readCellValue(entry.row, col, origColIndex) : undefined;
    return {
      value: isDirty ? dirtyCells![dirtyKey] : rawValue,
      isDirty,
      isInserted: entry?.isInserted ?? false,
    };
  }, [dirtyCells, getRowAt]);

  const commitEdit = useCallback((cell: { rowIndex: number; colIndex: number; colName: string; draft: string }, asNull = false) => {
    setEditingCell(null);
    onWidgetEvent('cellEdit', {
      rowIndex: cell.rowIndex,
      colName: cell.colName,
      value: asNull ? null : cell.draft,
      isNull: asNull,
    });
  }, [onWidgetEvent]);

  const beginEdit = useCallback((rowIndex: number, visibleColIndex: number) => {
    if (!editable || deletedSet.has(rowIndex)) return;
    const entry = visibleCols[visibleColIndex];
    if (!entry) return;
    const { value } = getEffectiveValue(rowIndex, entry.col, entry.origIndex);
    setActiveCell({ rowIndex, colIndex: visibleColIndex });
    setEditingCell({
      rowIndex,
      colIndex: visibleColIndex,
      colName: entry.col.name,
      draft: value === null || value === undefined ? '' : formatCellDisplay(value),
    });
  }, [editable, deletedSet, visibleCols, getEffectiveValue]);

  const toggleRowSelection = useCallback((rowIndex: number, shiftKey: boolean) => {
    const next = new Set(selectedSet);
    if (shiftKey && lastSelectedRow !== null) {
      const lo = Math.min(lastSelectedRow, rowIndex);
      const hi = Math.max(lastSelectedRow, rowIndex);
      for (let i = lo; i <= hi; i += 1) next.add(i);
    } else if (next.has(rowIndex)) {
      next.delete(rowIndex);
    } else {
      next.add(rowIndex);
    }
    setLastSelectedRow(rowIndex);
    onWidgetEvent('rowSelect', { selectedRowIndices: [...next].sort((a, b) => a - b) });
  }, [selectedSet, lastSelectedRow, onWidgetEvent]);

  const toggleSelectAll = useCallback(() => {
    if (totalRows === 0) return;
    const allSelected = selectedSet.size >= totalRows;
    const next = allSelected ? [] : Array.from({ length: totalRows }, (_, i) => i);
    onWidgetEvent('rowSelect', { selectedRowIndices: next });
  }, [totalRows, selectedSet.size, onWidgetEvent]);

  const handleSortClick = useCallback((col: PluginDataGridColumn) => {
    if (col.sortable === false) return;
    const nextDirection = sort?.column === col.name && sort.direction === 'asc' ? 'desc' : 'asc';
    onWidgetEvent('sortChange', { column: col.name, direction: nextDirection });
  }, [sort, onWidgetEvent]);

  const startResizeColumn = useCallback((event: React.PointerEvent<HTMLDivElement>, col: PluginDataGridColumn) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = getColWidth(col);
    const target = event.currentTarget;
    try { target.setPointerCapture(event.pointerId); } catch {}
    const onMove = (moveEvent: PointerEvent) => {
      const nextWidth = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(startWidth + (moveEvent.clientX - startX))));
      setColWidths((prev) => (prev[col.name] === nextWidth ? prev : { ...prev, [col.name]: nextWidth }));
    };
    const onUp = () => {
      try { target.releasePointerCapture(event.pointerId); } catch {}
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [getColWidth]);

  const handleCellContextMenu = useCallback((
    event: React.MouseEvent,
    rowIndex: number,
    colName: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const surface = scrollRef.current?.closest('[data-plugin-remote-surface]');
    const rect = surface?.getBoundingClientRect();
    const x = Math.round(rect ? event.clientX - rect.left : event.clientX);
    const y = Math.round(rect ? event.clientY - rect.top : event.clientY);
    onWidgetEvent('cellContextMenu', { rowIndex, colName, x, y });
  }, [onWidgetEvent]);

  const copySelectionOrActiveCell = useCallback(() => {
    const selectedIndices = [...selectedSet].sort((a, b) => a - b);
    if (selectedIndices.length > 0 && visibleCols.length > 0) {
      const text = selectedIndices
        .map((rowIdx) => visibleCols.map(({ col, origIndex }) => {
          const { value } = getEffectiveValue(rowIdx, col, origIndex);
          return value === null || value === undefined ? 'NULL' : formatCellDisplay(value);
        }).join('\t'))
        .join('\n');
      try { void navigator.clipboard?.writeText?.(text)?.catch?.(() => {}); } catch {}
      onWidgetEvent('cellCopy', {
        text,
        rowIndex: activeCell?.rowIndex ?? selectedIndices[0],
        colName: activeCell ? visibleCols[activeCell.colIndex]?.col.name ?? null : null,
        rowIndices: selectedIndices,
      });
      return true;
    }
    if (activeCell) {
      const entry = visibleCols[activeCell.colIndex];
      if (!entry) return false;
      const { value } = getEffectiveValue(activeCell.rowIndex, entry.col, entry.origIndex);
      const text = value === null || value === undefined ? 'NULL' : formatCellDisplay(value);
      try { void navigator.clipboard?.writeText?.(text)?.catch?.(() => {}); } catch {}
      onWidgetEvent('cellCopy', {
        text,
        rowIndex: activeCell.rowIndex,
        colName: entry.col.name,
        rowIndices: [activeCell.rowIndex],
      });
      return true;
    }
    return false;
  }, [selectedSet, visibleCols, activeCell, getEffectiveValue, onWidgetEvent]);

  const handleGridKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const mod = event.metaKey || event.ctrlKey;

    // While editing an inline cell input, only forward Cmd/Ctrl+K and Cmd/Ctrl+S.
    if (editingCell) {
      const shortcut = matchWorkbenchShortcut(event, { includeUndoRedo: false });
      if (shortcut === 'mod+k' || shortcut === 'mod+s') {
        event.preventDefault();
        event.stopPropagation();
        onWidgetEvent('shortcut', { shortcut });
      }
      return;
    }

    // Global workbench shortcuts + grid Undo/Redo
    const shortcut = matchWorkbenchShortcut(event, { includeUndoRedo: true });
    if (shortcut) {
      if (shortcut !== 'escape') {
        event.preventDefault();
      }
      event.stopPropagation();
      onWidgetEvent('shortcut', { shortcut });
      return;
    }

    // Cmd/Ctrl+C copies active cell or selected rows
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c') {
      if (copySelectionOrActiveCell()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (!activeCell || visibleCols.length === 0 || totalRows === 0) return;
    const { rowIndex, colIndex } = activeCell;

    if (event.key === 'ArrowDown' && rowIndex + 1 < totalRows) {
      event.preventDefault();
      setActiveCell({ rowIndex: rowIndex + 1, colIndex });
      rowVirtualizer.scrollToIndex(rowIndex + 1);
    } else if (event.key === 'ArrowUp' && rowIndex > 0) {
      event.preventDefault();
      setActiveCell({ rowIndex: rowIndex - 1, colIndex });
      rowVirtualizer.scrollToIndex(rowIndex - 1);
    } else if (event.key === 'ArrowRight' && colIndex + 1 < visibleCols.length) {
      event.preventDefault();
      setActiveCell({ rowIndex, colIndex: colIndex + 1 });
      colVirtualizer.scrollToIndex(colIndex + 1);
    } else if (event.key === 'ArrowLeft' && colIndex > 0) {
      event.preventDefault();
      setActiveCell({ rowIndex, colIndex: colIndex - 1 });
      colVirtualizer.scrollToIndex(colIndex - 1);
    } else if ((event.key === 'Enter' || event.key === 'F2') && editable) {
      event.preventDefault();
      beginEdit(rowIndex, colIndex);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && editable && !deletedSet.has(rowIndex)) {
      const entry = visibleCols[colIndex];
      if (entry && entry.col.nullable !== false) {
        event.preventDefault();
        onWidgetEvent('cellEdit', {
          rowIndex,
          colName: entry.col.name,
          value: null,
          isNull: true,
        });
      }
    }
  }, [
    editingCell,
    activeCell,
    visibleCols,
    totalRows,
    rowVirtualizer,
    colVirtualizer,
    editable,
    deletedSet,
    beginEdit,
    copySelectionOrActiveCell,
    onWidgetEvent,
  ]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualCols = colVirtualizer.getVirtualItems();
  const totalWidth = GUTTER_WIDTH + colVirtualizer.getTotalSize();
  const totalHeight = rowVirtualizer.getTotalSize();
  const allSelected = totalRows > 0 && selectedSet.size >= totalRows;

  return (
    <div
      className="relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground select-none"
      data-plugin-data-grid=""
      tabIndex={0}
      onKeyDown={handleGridKeyDown}
    >
      {loading && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center justify-end px-2 py-1">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/95 px-2 py-0.5 text-[11px] text-muted-foreground shadow-sm">
            <Loader2 size={12} className="animate-spin" />
            Loading...
          </span>
        </div>
      )}

      <div ref={scrollRef} className="relative h-full w-full min-h-0 flex-1 overflow-auto">
        {visibleCols.length === 0 ? (
          <div className="flex h-full w-full items-center justify-center p-6 text-xs text-muted-foreground">
            {emptyMessage}
          </div>
        ) : (
          <div style={{ width: totalWidth, minWidth: '100%', position: 'relative' }}>
            {/* Sticky Header */}
            <div
              role="row"
              className="sticky top-0 z-30 flex border-b border-border bg-muted text-[11px] font-medium text-foreground"
              style={{ height: HEADER_HEIGHT, width: totalWidth, minWidth: '100%' }}
            >
              <div
                className="sticky left-0 z-40 flex shrink-0 items-center justify-between border-r border-border bg-muted px-2 text-[10px] text-muted-foreground"
                style={{ width: GUTTER_WIDTH, height: HEADER_HEIGHT }}
              >
                <input
                  type="checkbox"
                  aria-label="Select all rows"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer"
                />
                <span className="font-mono">#</span>
              </div>

              <div className="relative flex-1" style={{ height: HEADER_HEIGHT }}>
                {virtualCols.map((vCol) => {
                  const colEntry = visibleCols[vCol.index];
                  if (!colEntry) return null;
                  const { col } = colEntry;
                  const isSorted = sort?.column === col.name;
                  const sortable = col.sortable !== false;
                  return (
                    <div
                      key={col.name}
                      role="columnheader"
                      data-col-name={col.name}
                      className="group absolute top-0 bottom-0 flex items-center justify-between gap-1 border-r border-border/70 px-2.5"
                      style={{
                        left: vCol.start,
                        width: vCol.size,
                      }}
                    >
                      <button
                        type="button"
                        disabled={!sortable}
                        onClick={() => handleSortClick(col)}
                        className={`flex min-w-0 flex-1 items-center gap-1.5 text-left ${sortable ? 'cursor-pointer hover:text-primary' : 'cursor-default'}`}
                        title={col.foreignKey
                          ? `${col.name}${col.type ? ` (${col.type})` : ''} -> ${col.foreignKey.schema ? `${col.foreignKey.schema}.` : ''}${col.foreignKey.table}.${col.foreignKey.column}`
                          : col.type ? `${col.name} (${col.type})` : col.name}
                      >
                        {col.primaryKey && (
                          <KeyRound size={11} className="shrink-0 text-amber-500" aria-label="Primary key" />
                        )}
                        {col.foreignKey && (
                          <Link2 size={11} className="shrink-0 text-blue-500" aria-label="Foreign key" />
                        )}
                        <span className="truncate font-medium">{col.name}</span>
                        {col.type && (
                          <span className="truncate font-mono text-[10px] font-normal text-muted-foreground">
                            {col.type}
                          </span>
                        )}
                      </button>
                      {sortable && (
                        <span className="shrink-0 text-muted-foreground/70">
                          {isSorted ? (
                            sort.direction === 'asc' ? <ArrowUp size={11} className="text-primary" /> : <ArrowDown size={11} className="text-primary" />
                          ) : (
                            <ArrowUpDown size={10} className="opacity-0 group-hover:opacity-70 transition-opacity" />
                          )}
                        </span>
                      )}
                      <div
                        role="separator"
                        aria-orientation="vertical"
                        onPointerDown={(e) => startResizeColumn(e, col)}
                        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/60"
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Virtualized Rows Body */}
            {totalRows === 0 ? (
              <div className="flex h-40 w-full items-center justify-center text-xs text-muted-foreground">
                {emptyMessage}
              </div>
            ) : (
              <div style={{ height: totalHeight, width: totalWidth, minWidth: '100%', position: 'relative' }}>
                {virtualRows.map((vRow) => {
                  const rowIndex = vRow.index;
                  const entry = getRowAt(rowIndex);
                  if (!entry) return null;
                  const isDeleted = deletedSet.has(rowIndex);
                  const isSelected = selectedSet.has(rowIndex);
                  const isInserted = entry.isInserted;

                  const rowBg = isDeleted
                    ? 'bg-destructive/10 text-destructive/80 line-through'
                    : isInserted
                      ? 'bg-emerald-500/10'
                      : isSelected
                        ? 'bg-primary/10'
                        : rowIndex % 2 === 1
                          ? 'bg-muted/20'
                          : 'bg-background';

                  return (
                    <div
                      key={rowIndex}
                      role="row"
                      data-row-index={rowIndex}
                      className={`absolute left-0 flex border-b border-border/50 hover:bg-muted/50 ${rowBg}`}
                      style={{
                        top: vRow.start,
                        height: vRow.size,
                        width: totalWidth,
                        minWidth: '100%',
                      }}
                    >
                      {/* Sticky Gutter */}
                      <div
                        className="sticky left-0 z-10 flex shrink-0 items-center justify-between border-r border-border/70 bg-background px-2 font-mono text-[10px] tabular-nums text-muted-foreground"
                        style={{ width: GUTTER_WIDTH, height: ROW_HEIGHT }}
                        onContextMenu={(e) => handleCellContextMenu(e, rowIndex, visibleCols[0]?.col.name ?? '')}
                      >
                        <input
                          type="checkbox"
                          aria-label={`Select row ${rowIndex + 1}`}
                          checked={isSelected}
                          onChange={() => {}}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleRowSelection(rowIndex, e.shiftKey);
                          }}
                          className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer"
                        />
                        <span className={isInserted ? 'font-bold text-emerald-500' : ''}>
                          {isInserted ? '+' : rowIndex + 1}
                        </span>
                      </div>

                      {/* Virtualized Cells */}
                      <div className="relative z-0 flex-1 overflow-hidden" style={{ height: ROW_HEIGHT }}>
                        {virtualCols.map((vCol) => {
                          const visibleColIndex = vCol.index;
                          const colEntry = visibleCols[visibleColIndex];
                          if (!colEntry) return null;
                          const { col, origIndex } = colEntry;
                          const { value, isDirty } = getEffectiveValue(rowIndex, col, origIndex);
                          const isEditing = editingCell?.rowIndex === rowIndex && editingCell?.colIndex === visibleColIndex;
                          const isActive = activeCell?.rowIndex === rowIndex && activeCell?.colIndex === visibleColIndex;
                          const isNull = value === null || value === undefined;
                          const numeric = !isNull && isNumericColumn(col, value);
                          const fk = col.foreignKey;

                          return (
                            <div
                              key={col.name}
                              role="gridcell"
                              data-row-index={rowIndex}
                              data-col-name={col.name}
                              data-dirty={isDirty ? 'true' : undefined}
                              className={`group/cell absolute top-0 bottom-0 flex items-center gap-1 border-r border-border/50 px-2.5 font-mono text-[12px] tabular-nums overflow-hidden ${
                                isDirty ? 'bg-amber-500/15 ring-1 ring-inset ring-amber-500/50' : ''
                              } ${isActive ? 'ring-2 ring-inset ring-primary z-[5]' : ''} ${
                                numeric ? 'justify-end' : 'justify-start'
                              }`}
                              style={{ left: vCol.start, width: vCol.size }}
                              onClick={() => {
                                setActiveCell({ rowIndex, colIndex: visibleColIndex });
                                onWidgetEvent('cellSelect', {
                                  rowIndex,
                                  colName: col.name,
                                  value: value === undefined ? null : value,
                                });
                              }}
                              onDoubleClick={() => {
                                if (editable && !isDeleted) {
                                  beginEdit(rowIndex, visibleColIndex);
                                } else {
                                  onWidgetEvent('cellDoubleClick', {
                                    rowIndex,
                                    colName: col.name,
                                    value: value === undefined ? null : value,
                                  });
                                }
                              }}
                              onContextMenu={(e) => handleCellContextMenu(e, rowIndex, col.name)}
                            >
                              {isEditing ? (
                                <div
                                  className="flex h-full w-full items-center gap-1"
                                  onClick={(e) => e.stopPropagation()}
                                  onDoubleClick={(e) => e.stopPropagation()}
                                >
                                  <input
                                    ref={editInputRef}
                                    type="text"
                                    value={editingCell.draft}
                                    onChange={(e) => setEditingCell({ ...editingCell, draft: e.target.value })}
                                    onKeyDown={(e) => {
                                      const sc = matchWorkbenchShortcut(e, { includeUndoRedo: false });
                                      if (sc === 'mod+k' || sc === 'mod+s') {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        onWidgetEvent('shortcut', { shortcut: sc });
                                        return;
                                      }
                                      e.stopPropagation();
                                      if (e.key === 'Enter') {
                                        e.preventDefault();
                                        commitEdit(editingCell, false);
                                      } else if (e.key === 'Escape') {
                                        e.preventDefault();
                                        setEditingCell(null);
                                      } else if (e.key === 'Tab') {
                                        e.preventDefault();
                                        commitEdit(editingCell, false);
                                        const nextCol = e.shiftKey ? visibleColIndex - 1 : visibleColIndex + 1;
                                        if (nextCol >= 0 && nextCol < visibleCols.length) {
                                          beginEdit(rowIndex, nextCol);
                                        }
                                      }
                                    }}
                                    onBlur={() => {
                                      const snapshot = editingCell;
                                      setTimeout(() => {
                                        setEditingCell((curr) => {
                                          if (curr && curr.rowIndex === snapshot.rowIndex && curr.colIndex === snapshot.colIndex) {
                                            onWidgetEvent('cellEdit', {
                                              rowIndex: curr.rowIndex,
                                              colName: curr.colName,
                                              value: curr.draft,
                                              isNull: false,
                                            });
                                            return null;
                                          }
                                          return curr;
                                        });
                                      }, 0);
                                    }}
                                    className="h-6 min-w-0 flex-1 rounded border border-primary bg-background px-1.5 font-mono text-[12px] text-foreground outline-none"
                                  />
                                  {col.nullable !== false && (
                                    <button
                                      type="button"
                                      onMouseDown={(e) => {
                                        e.preventDefault();
                                        commitEdit(editingCell, true);
                                      }}
                                      className="shrink-0 rounded border border-border bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                                      title="Set value to NULL"
                                    >
                                      NULL
                                    </button>
                                  )}
                                </div>
                              ) : isNull ? (
                                <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] italic text-muted-foreground">
                                  NULL
                                </span>
                              ) : typeof value === 'boolean' ? (
                                <span
                                  className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                    value
                                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                      : 'bg-muted text-muted-foreground'
                                  }`}
                                >
                                  {value ? 'true' : 'false'}
                                </span>
                              ) : (
                                <span className="truncate" title={formatCellDisplay(value)}>
                                  {formatCellDisplay(value)}
                                </span>
                              )}
                              {!isEditing && !isNull && fk && (
                                <button
                                  type="button"
                                  data-fk-jump=""
                                  aria-label={`Jump to ${fk.schema ? `${fk.schema}.` : ''}${fk.table}.${fk.column}`}
                                  title={`Jump to ${fk.schema ? `${fk.schema}.` : ''}${fk.table}.${fk.column} = ${formatCellDisplay(value)}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onWidgetEvent('fkJump', {
                                      rowIndex,
                                      colName: col.name,
                                      value,
                                      targetTable: fk.table,
                                      targetColumn: fk.column,
                                      ...(fk.schema ? { targetSchema: fk.schema } : {}),
                                    });
                                  }}
                                  className="ml-auto shrink-0 inline-flex h-4 w-4 items-center justify-center rounded text-blue-500 opacity-0 transition-opacity hover:bg-blue-500/15 group-hover/cell:opacity-100 focus:opacity-100"
                                >
                                  <ArrowUpRight size={11} />
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
