import { createRoot } from 'react-dom/client';
import { createElement, useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import type { Disposable, PluginViews } from './index.js';
import { registerHostDomView } from './hostDom.js';

/** Author ordinary React while Netcatty owns the visible DOM. */
export function registerHostReactView(views: PluginViews, viewId: string, render: () => ReactNode, css = ''): Disposable {
  return registerHostDomView(views, viewId, (container) => {
    const root = createRoot(container); root.render(render()); return () => root.unmount();
  }, css);
}

export interface PluginPopoverProps {
  anchor?: string;
  anchorX?: number;
  anchorY?: number;
  width?: number;
  maxHeight?: number;
  open: boolean;
  onClose(): void;
  children: ReactNode;
}

/** A host-positioned popup with freely authored content. */
export function PluginPopover({
  anchor,
  anchorX,
  anchorY,
  width,
  maxHeight,
  open,
  onClose,
  children,
}: PluginPopoverProps) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = ref.current; if (!node) return;
    node.addEventListener('netcatty-dismiss', onClose);
    return () => node.removeEventListener('netcatty-dismiss', onClose);
  }, [onClose]);
  return createElement(
    'div',
    {
      ref,
      'data-plugin-popover': 'true',
      ...(anchor ? { 'data-plugin-anchor': anchor } : {}),
      ...(anchorX !== undefined ? { 'data-plugin-anchor-x': String(anchorX) } : {}),
      ...(anchorY !== undefined ? { 'data-plugin-anchor-y': String(anchorY) } : {}),
      ...(width !== undefined ? { 'data-plugin-popover-width': String(width) } : {}),
      ...(maxHeight !== undefined ? { 'data-plugin-popover-max-height': String(maxHeight) } : {}),
      ...(open ? { open: true } : {}),
    },
    children,
  );
}

type WidgetEventDetail = { widgetEvent?: string; detail?: Record<string, unknown> };

function useWidgetEventBridge(
  ref: React.RefObject<HTMLElement | null>,
  handler: (widgetEvent: string, detail: Record<string, unknown>) => void,
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const listener = (event: Event) => {
      const payload = (event as CustomEvent<WidgetEventDetail>).detail;
      if (!payload || typeof payload.widgetEvent !== 'string') return;
      handlerRef.current(payload.widgetEvent, payload.detail ?? {});
    };
    node.addEventListener('netcatty-widget-event', listener);
    return () => node.removeEventListener('netcatty-widget-event', listener);
  }, [ref]);
}

export interface PluginCodeEditorCompletionColumn {
  name: string;
  type?: string;
}

export interface PluginCodeEditorCompletionTable {
  name: string;
  schema?: string;
  columns?: PluginCodeEditorCompletionColumn[];
}

export interface PluginCodeEditorCompletionFunction {
  name: string;
  detail?: string;
  insertText?: string;
}

export interface PluginCodeEditorCompletionSchema {
  tables?: PluginCodeEditorCompletionTable[];
  functions?: PluginCodeEditorCompletionFunction[];
  keywords?: string[];
}

export interface PluginCodeEditorDiagnostic {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity?: 'error' | 'warning' | 'info' | 'hint';
}

export interface PluginCodeEditorProps {
  value: string;
  language?: 'sql' | 'pgsql' | 'mysql' | 'json' | 'plaintext';
  readOnly?: boolean;
  placeholder?: string;
  lineNumbers?: 'on' | 'off' | 'relative';
  minimap?: boolean;
  wordWrap?: 'on' | 'off' | 'wordWrapColumn' | 'bounded';
  completionSchema?: PluginCodeEditorCompletionSchema;
  diagnostics?: PluginCodeEditorDiagnostic[];
  height?: number | string;
  className?: string;
  style?: CSSProperties;
  onChange?: (detail: { value: string }) => void;
  onSelection?: (detail: { selectionStart: number; selectionEnd: number; selectedText: string }) => void;
  onExecute?: (detail: { value: string; selectedText: string; currentStatement: string }) => void;
  onFormat?: (detail: { value: string }) => void;
}

/** Host-rendered Monaco code editor with local zero-IPC schema completion. */
export function PluginCodeEditor({
  value,
  language,
  readOnly,
  placeholder,
  lineNumbers,
  minimap,
  wordWrap,
  completionSchema,
  diagnostics,
  height,
  className,
  style,
  onChange,
  onSelection,
  onExecute,
  onFormat,
}: PluginCodeEditorProps) {
  const ref = useRef<HTMLElement>(null);
  useWidgetEventBridge(ref, (eventName, detail) => {
    if (eventName === 'change') onChange?.(detail as { value: string });
    else if (eventName === 'selection') onSelection?.(detail as { selectionStart: number; selectionEnd: number; selectedText: string });
    else if (eventName === 'execute') onExecute?.(detail as { value: string; selectedText: string; currentStatement: string });
    else if (eventName === 'format') onFormat?.(detail as { value: string });
  });
  const serialized = useMemo(
    () => JSON.stringify({
      value,
      ...(language !== undefined ? { language } : {}),
      ...(readOnly !== undefined ? { readOnly } : {}),
      ...(placeholder !== undefined ? { placeholder } : {}),
      ...(lineNumbers !== undefined ? { lineNumbers } : {}),
      ...(minimap !== undefined ? { minimap } : {}),
      ...(wordWrap !== undefined ? { wordWrap } : {}),
      ...(completionSchema !== undefined ? { completionSchema } : {}),
      ...(diagnostics !== undefined ? { diagnostics } : {}),
      ...(height !== undefined ? { height } : {}),
    }),
    [value, language, readOnly, placeholder, lineNumbers, minimap, wordWrap, completionSchema, diagnostics, height],
  );
  return createElement('div', {
    ref,
    className,
    style,
    'data-plugin-widget': 'code-editor',
    'data-plugin-widget-props': serialized,
  });
}

export interface PluginDataGridColumn {
  name: string;
  type?: string;
  primaryKey?: boolean;
  nullable?: boolean;
  width?: number;
  sortable?: boolean;
}

export interface PluginDataGridSort {
  column: string;
  direction: 'asc' | 'desc';
}

export type PluginDataGridRow = Record<string, unknown> | unknown[];

export interface PluginDataGridProps {
  columns: PluginDataGridColumn[];
  rows: PluginDataGridRow[];
  rowKeyField?: string;
  dirtyCells?: Record<string, unknown>;
  deletedRowIndices?: number[];
  insertedRows?: PluginDataGridRow[];
  selectedRowIndices?: number[];
  sort?: PluginDataGridSort | null;
  editable?: boolean;
  loading?: boolean;
  emptyMessage?: string;
  className?: string;
  style?: CSSProperties;
  onCellSelect?: (detail: { rowIndex: number; colName: string; value: unknown }) => void;
  onCellEdit?: (detail: { rowIndex: number; colName: string; value: unknown; isNull: boolean }) => void;
  onCellContextMenu?: (detail: { rowIndex: number; colName: string; x: number; y: number }) => void;
  onSortChange?: (detail: { column: string; direction: 'asc' | 'desc' }) => void;
  onRowSelect?: (detail: { selectedRowIndices: number[] }) => void;
}

/** Host-rendered virtualized editable data grid powered by @tanstack/react-virtual. */
export function PluginDataGrid({
  columns,
  rows,
  rowKeyField,
  dirtyCells,
  deletedRowIndices,
  insertedRows,
  selectedRowIndices,
  sort,
  editable,
  loading,
  emptyMessage,
  className,
  style,
  onCellSelect,
  onCellEdit,
  onCellContextMenu,
  onSortChange,
  onRowSelect,
}: PluginDataGridProps) {
  const ref = useRef<HTMLElement>(null);
  useWidgetEventBridge(ref, (eventName, detail) => {
    if (eventName === 'cellSelect') onCellSelect?.(detail as { rowIndex: number; colName: string; value: unknown });
    else if (eventName === 'cellEdit') onCellEdit?.(detail as { rowIndex: number; colName: string; value: unknown; isNull: boolean });
    else if (eventName === 'cellContextMenu') onCellContextMenu?.(detail as { rowIndex: number; colName: string; x: number; y: number });
    else if (eventName === 'sortChange') onSortChange?.(detail as { column: string; direction: 'asc' | 'desc' });
    else if (eventName === 'rowSelect') onRowSelect?.(detail as { selectedRowIndices: number[] });
  });
  const serialized = useMemo(
    () => JSON.stringify({
      columns,
      rows,
      ...(rowKeyField !== undefined ? { rowKeyField } : {}),
      ...(dirtyCells !== undefined ? { dirtyCells } : {}),
      ...(deletedRowIndices !== undefined ? { deletedRowIndices } : {}),
      ...(insertedRows !== undefined ? { insertedRows } : {}),
      ...(selectedRowIndices !== undefined ? { selectedRowIndices } : {}),
      ...(sort !== undefined ? { sort } : {}),
      ...(editable !== undefined ? { editable } : {}),
      ...(loading !== undefined ? { loading } : {}),
      ...(emptyMessage !== undefined ? { emptyMessage } : {}),
    }),
    [columns, rows, rowKeyField, dirtyCells, deletedRowIndices, insertedRows, selectedRowIndices, sort, editable, loading, emptyMessage],
  );
  return createElement('div', {
    ref,
    className,
    style,
    'data-plugin-widget': 'data-grid',
    'data-plugin-widget-props': serialized,
  });
}

export interface PluginSplitPaneProps {
  direction?: 'horizontal' | 'vertical';
  initialSize?: number;
  minSize?: number;
  maxSize?: number;
  collapsible?: boolean;
  collapsed?: boolean;
  className?: string;
  style?: CSSProperties;
  onResizeEnd?: (detail: { size: number; collapsed?: boolean }) => void;
  children: ReactNode;
}

/** Host-rendered 60fps resizable 2-child split pane container. */
export function PluginSplitPane({
  direction = 'horizontal',
  initialSize,
  minSize,
  maxSize,
  collapsible,
  collapsed,
  className,
  style,
  onResizeEnd,
  children,
}: PluginSplitPaneProps) {
  const ref = useRef<HTMLElement>(null);
  useWidgetEventBridge(ref, (eventName, detail) => {
    if (eventName === 'resizeEnd') onResizeEnd?.(detail as { size: number; collapsed?: boolean });
  });
  const serialized = useMemo(
    () => JSON.stringify({
      direction,
      ...(initialSize !== undefined ? { initialSize } : {}),
      ...(minSize !== undefined ? { minSize } : {}),
      ...(maxSize !== undefined ? { maxSize } : {}),
      ...(collapsible !== undefined ? { collapsible } : {}),
      ...(collapsed !== undefined ? { collapsed } : {}),
    }),
    [direction, initialSize, minSize, maxSize, collapsible, collapsed],
  );
  return createElement(
    'div',
    {
      ref,
      className,
      style,
      'data-plugin-widget': 'split-pane',
      'data-plugin-widget-props': serialized,
    },
    children,
  );
}

export interface PluginErColumn {
  name: string;
  type: string;
  isPk?: boolean;
  isFk?: boolean;
  nullable?: boolean;
}

export interface PluginErTable {
  name: string;
  schema?: string;
  columns: PluginErColumn[];
  x?: number;
  y?: number;
}

export interface PluginErRelation {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  name?: string;
}

export interface PluginErCanvasProps {
  tables: PluginErTable[];
  relations: PluginErRelation[];
  className?: string;
  style?: CSSProperties;
  onTableClick?: (detail: { table: string; schema?: string }) => void;
}

/** Host-rendered interactive pan/zoom SVG ER diagram canvas. */
export function PluginErCanvas({
  tables,
  relations,
  className,
  style,
  onTableClick,
}: PluginErCanvasProps) {
  const ref = useRef<HTMLElement>(null);
  useWidgetEventBridge(ref, (eventName, detail) => {
    if (eventName === 'tableClick') onTableClick?.(detail as { table: string; schema?: string });
  });
  const serialized = useMemo(
    () => JSON.stringify({ tables, relations }),
    [tables, relations],
  );
  return createElement('div', {
    ref,
    className,
    style,
    'data-plugin-widget': 'er-canvas',
    'data-plugin-widget-props': serialized,
  });
}
