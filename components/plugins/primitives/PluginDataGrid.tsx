import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown, KeyRound, Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
    count: columns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (columns[index] ? getColWidth(columns[index]) : DEFAULT_COL_WIDTH),
    overscan: 4,
    initialRect: { width: 960, height: 420 },
  });

  useEffect(() => {
    colVirtualizer.measure();
  }, [colWidths, columns, colVirtualizer]);

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

  const getEffectiveValue = useCallback((rowIndex: number, col: PluginDataGridColumn, colIndex: number) => {
    const dirtyKey = `${rowIndex}:${col.name}`;
    const isDirty = Boolean(dirtyCells && Object.prototype.hasOwnProperty.call(dirtyCells, dirtyKey));
    const entry = getRowAt(rowIndex);
    const rawValue = entry ? readCellValue(entry.row, col, colIndex) : undefined;
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

  const beginEdit = useCallback((rowIndex: number, colIndex: number) => {
    if (!editable || deletedSet.has(rowIndex)) return;
    const col = columns[colIndex];
    if (!col) return;
    const { value } = getEffectiveValue(rowIndex, col, colIndex);
    setActiveCell({ rowIndex, colIndex });
    setEditingCell({
      rowIndex,
      colIndex,
      colName: col.name,
      draft: value === null || value === undefined ? '' : formatCellDisplay(value),
    });
  }, [editable, deletedSet, columns, getEffectiveValue]);

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

  const handleGridKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (editingCell || !activeCell || columns.length === 0 || totalRows === 0) return;
    const { rowIndex, colIndex } = activeCell;
    if (event.key === 'ArrowDown' && rowIndex + 1 < totalRows) {
      event.preventDefault();
      setActiveCell({ rowIndex: rowIndex + 1, colIndex });
      rowVirtualizer.scrollToIndex(rowIndex + 1);
    } else if (event.key === 'ArrowUp' && rowIndex > 0) {
      event.preventDefault();
      setActiveCell({ rowIndex: rowIndex - 1, colIndex });
      rowVirtualizer.scrollToIndex(rowIndex - 1);
    } else if (event.key === 'ArrowRight' && colIndex + 1 < columns.length) {
      event.preventDefault();
      setActiveCell({ rowIndex, colIndex: colIndex + 1 });
      colVirtualizer.scrollToIndex(colIndex + 1);
    } else if (event.key === 'ArrowLeft' && colIndex > 0) {
      event.preventDefault();
      setActiveCell({ rowIndex, colIndex: colIndex - 1 });
      colVirtualizer.scrollToIndex(colIndex - 1);
    } else if (event.key === 'Enter' && editable) {
      event.preventDefault();
      beginEdit(rowIndex, colIndex);
    }
  }, [editingCell, activeCell, columns.length, totalRows, rowVirtualizer, colVirtualizer, editable, beginEdit]);

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

      <div
        ref={scrollRef}
        className="relative h-full w-full min-h-0 flex-1 overflow-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-corner]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20 hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/40"
      >
        {columns.length === 0 ? (
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
                  const col = columns[vCol.index];
                  if (!col) return null;
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
                        title={col.type ? `${col.name} (${col.type})` : col.name}
                      >
                        {col.primaryKey && (
                          <KeyRound size={11} className="shrink-0 text-amber-500" aria-label="Primary key" />
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
                        onContextMenu={(e) => handleCellContextMenu(e, rowIndex, columns[0]?.name ?? '')}
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
                          const colIndex = vCol.index;
                          const col = columns[colIndex];
                          if (!col) return null;
                          const { value, isDirty } = getEffectiveValue(rowIndex, col, colIndex);
                          const isEditing = editingCell?.rowIndex === rowIndex && editingCell?.colIndex === colIndex;
                          const isActive = activeCell?.rowIndex === rowIndex && activeCell?.colIndex === colIndex;
                          const isNull = value === null || value === undefined;
                          const numeric = !isNull && isNumericColumn(col, value);

                          return (
                            <div
                              key={col.name}
                              role="gridcell"
                              data-row-index={rowIndex}
                              data-col-name={col.name}
                              data-dirty={isDirty ? 'true' : undefined}
                              className={`absolute top-0 bottom-0 flex items-center border-r border-border/50 px-2.5 font-mono text-[12px] tabular-nums overflow-hidden ${
                                isDirty ? 'bg-amber-500/15 ring-1 ring-inset ring-amber-500/50' : ''
                              } ${isActive ? 'ring-2 ring-inset ring-primary z-[5]' : ''} ${
                                numeric ? 'justify-end' : 'justify-start'
                              }`}
                              style={{ left: vCol.start, width: vCol.size }}
                              onClick={() => {
                                setActiveCell({ rowIndex, colIndex });
                                onWidgetEvent('cellSelect', {
                                  rowIndex,
                                  colName: col.name,
                                  value: value === undefined ? null : value,
                                });
                              }}
                              onDoubleClick={() => beginEdit(rowIndex, colIndex)}
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
                                        const nextCol = e.shiftKey ? colIndex - 1 : colIndex + 1;
                                        if (nextCol >= 0 && nextCol < columns.length) {
                                          beginEdit(rowIndex, nextCol);
                                        }
                                      }
                                    }}
                                    onBlur={() => {
                                      // Delay slightly so clicking the inline NULL button wins over blur.
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
