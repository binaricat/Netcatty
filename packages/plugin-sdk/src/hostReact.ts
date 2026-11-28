import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { createElement, useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import type { Disposable, PluginViews } from './index.js';
import { registerHostDomView } from './hostDom.js';

/** Author ordinary React while Netcatty owns the visible DOM. */
export function registerHostReactView(views: PluginViews, viewId: string, render: () => ReactNode, css = ''): Disposable {
  return registerHostDomView(views, viewId, (container) => {
    const root = createRoot(container);
    flushSync(() => { root.render(render()); });
    return () => root.unmount();
  }, css);
}

export type PluginWorkbenchShortcut =
  | 'mod+k'
  | 'mod+s'
  | 'mod+t'
  | 'mod+w'
  | 'mod+z'
  | 'mod+shift+z'
  | 'escape';

/**
 * Subscribe to normalized global workbench shortcuts forwarded from both the
 * Shadow DOM surface and slotted host-rendered widgets (CodeEditor, DataGrid, ErCanvas).
 */
export function usePluginShortcuts(handler: (shortcut: PluginWorkbenchShortcut) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const listener = (event: Event) => {
      const shortcut = (event as CustomEvent<{ shortcut?: PluginWorkbenchShortcut }>).detail?.shortcut;
      if (typeof shortcut === 'string') {
        handlerRef.current(shortcut);
      }
    };
    document.addEventListener('netcatty-shortcut', listener);
    return () => document.removeEventListener('netcatty-shortcut', listener);
  }, []);
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
  handler: (widgetEvent: string, detail: Record<string, unknown>) => boolean | void,
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const listener = (event: Event) => {
      const payload = (event as CustomEvent<WidgetEventDetail>).detail;
      if (!payload || typeof payload.widgetEvent !== 'string') return;
      if (handlerRef.current(payload.widgetEvent, payload.detail ?? {}) === true) {
        event.preventDefault();
      }
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
  onShortcut?: (detail: { shortcut: PluginWorkbenchShortcut }) => void;
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
  onShortcut,
}: PluginCodeEditorProps) {
  const ref = useRef<HTMLElement>(null);
  useWidgetEventBridge(ref, (eventName, detail) => {
    if (eventName === 'change') onChange?.(detail as { value: string });
    else if (eventName === 'selection') onSelection?.(detail as { selectionStart: number; selectionEnd: number; selectedText: string });
    else if (eventName === 'execute') onExecute?.(detail as { value: string; selectedText: string; currentStatement: string });
    else if (eventName === 'format') onFormat?.(detail as { value: string });
    else if (eventName === 'shortcut' && onShortcut) { onShortcut(detail as { shortcut: PluginWorkbenchShortcut }); return true; }
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

export interface PluginDataGridForeignKey {
  table: string;
  column: string;
  schema?: string;
}

export interface PluginDataGridColumn {
  name: string;
  type?: string;
  primaryKey?: boolean;
  nullable?: boolean;
  width?: number;
  sortable?: boolean;
  foreignKey?: PluginDataGridForeignKey;
}

export interface PluginDataGridSort {
  column: string;
  direction: 'asc' | 'desc';
}

export type PluginDataGridRow = Record<string, unknown> | unknown[];

export interface PluginDataGridProps {
  columns: PluginDataGridColumn[];
  rows: PluginDataGridRow[];
  hiddenColumns?: string[];
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
  onCellDoubleClick?: (detail: { rowIndex: number; colName: string; value: unknown }) => void;
  onCellEdit?: (detail: { rowIndex: number; colName: string; value: unknown; isNull: boolean }) => void;
  onCellContextMenu?: (detail: { rowIndex: number; colName: string; x: number; y: number }) => void;
  onCellCopy?: (detail: { text: string; rowIndex: number | null; colName: string | null; rowIndices: number[] }) => void;
  onFkJump?: (detail: { rowIndex: number; colName: string; value: unknown; targetTable: string; targetColumn: string; targetSchema?: string }) => void;
  onSortChange?: (detail: { column: string; direction: 'asc' | 'desc' }) => void;
  onRowSelect?: (detail: { selectedRowIndices: number[] }) => void;
  onShortcut?: (detail: { shortcut: PluginWorkbenchShortcut }) => void;
}

/** Host-rendered virtualized editable data grid powered by @tanstack/react-virtual. */
export function PluginDataGrid({
  columns,
  rows,
  hiddenColumns,
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
  onCellDoubleClick,
  onCellEdit,
  onCellContextMenu,
  onCellCopy,
  onFkJump,
  onSortChange,
  onRowSelect,
  onShortcut,
}: PluginDataGridProps) {
  const ref = useRef<HTMLElement>(null);
  useWidgetEventBridge(ref, (eventName, detail) => {
    if (eventName === 'cellSelect') onCellSelect?.(detail as { rowIndex: number; colName: string; value: unknown });
    else if (eventName === 'cellDoubleClick') onCellDoubleClick?.(detail as { rowIndex: number; colName: string; value: unknown });
    else if (eventName === 'cellEdit') onCellEdit?.(detail as { rowIndex: number; colName: string; value: unknown; isNull: boolean });
    else if (eventName === 'cellContextMenu') onCellContextMenu?.(detail as { rowIndex: number; colName: string; x: number; y: number });
    else if (eventName === 'cellCopy') onCellCopy?.(detail as { text: string; rowIndex: number | null; colName: string | null; rowIndices: number[] });
    else if (eventName === 'fkJump') onFkJump?.(detail as { rowIndex: number; colName: string; value: unknown; targetTable: string; targetColumn: string; targetSchema?: string });
    else if (eventName === 'sortChange') onSortChange?.(detail as { column: string; direction: 'asc' | 'desc' });
    else if (eventName === 'rowSelect') onRowSelect?.(detail as { selectedRowIndices: number[] });
    else if (eventName === 'shortcut' && onShortcut) { onShortcut(detail as { shortcut: PluginWorkbenchShortcut }); return true; }
  });
  const serialized = useMemo(
    () => JSON.stringify({
      columns,
      rows,
      ...(hiddenColumns !== undefined ? { hiddenColumns } : {}),
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
    [columns, rows, hiddenColumns, rowKeyField, dirtyCells, deletedRowIndices, insertedRows, selectedRowIndices, sort, editable, loading, emptyMessage],
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
  onDelete?: string;
  onUpdate?: string;
}

export interface PluginErCanvasProps {
  tables: PluginErTable[];
  relations: PluginErRelation[];
  className?: string;
  style?: CSSProperties;
  onTableClick?: (detail: { table: string; schema?: string }) => void;
  onTableDoubleClick?: (detail: { table: string; schema?: string }) => void;
  onExportSvg?: (detail: { svg: string }) => void;
  onShortcut?: (detail: { shortcut: PluginWorkbenchShortcut }) => void;
}

/** Host-rendered interactive pan/zoom SVG ER diagram canvas. */
export function PluginErCanvas({
  tables,
  relations,
  className,
  style,
  onTableClick,
  onTableDoubleClick,
  onExportSvg,
  onShortcut,
}: PluginErCanvasProps) {
  const ref = useRef<HTMLElement>(null);
  useWidgetEventBridge(ref, (eventName, detail) => {
    if (eventName === 'tableClick') onTableClick?.(detail as { table: string; schema?: string });
    else if (eventName === 'tableDoubleClick') onTableDoubleClick?.(detail as { table: string; schema?: string });
    else if (eventName === 'exportSvg') onExportSvg?.(detail as { svg: string });
    else if (eventName === 'shortcut' && onShortcut) { onShortcut(detail as { shortcut: PluginWorkbenchShortcut }); return true; }
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

export type PluginMetricChartColor =
  | 'primary'
  | 'sky'
  | 'emerald'
  | 'amber'
  | 'violet'
  | 'rose'
  | 'cyan'
  | 'muted';

export type PluginMetricChartUnit = '%' | 'bytes/s' | 'ms' | 'count' | 'temp' | 'bytes' | '';

export interface PluginMetricChartPoint {
  at: number;
  value: number | null;
}

export interface PluginMetricChartSeries {
  id: string;
  label: string;
  color?: PluginMetricChartColor;
  unit?: PluginMetricChartUnit;
  points: PluginMetricChartPoint[];
}

export interface PluginMetricChartThreshold {
  value: number;
  tone: 'warning' | 'critical';
  label?: string;
}

export interface PluginMetricChartProps {
  variant?: 'area' | 'line' | 'sparkline' | 'bar';
  series: PluginMetricChartSeries[];
  rangeMs?: number;
  intervalMs?: number;
  endAt?: number;
  min?: number;
  max?: number | 'auto';
  height?: number;
  thresholds?: PluginMetricChartThreshold[];
  showGrid?: boolean;
  showLegend?: boolean;
  showAxes?: boolean;
  interactive?: boolean;
  emptyText?: string;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}

/** Host-rendered responsive real-time time-series chart and sparkline widget. */
export function PluginMetricChart({
  variant,
  series,
  rangeMs,
  intervalMs,
  endAt,
  min,
  max,
  height,
  thresholds,
  showGrid,
  showLegend,
  showAxes,
  interactive,
  emptyText,
  ariaLabel,
  className,
  style,
}: PluginMetricChartProps) {
  const serialized = useMemo(
    () => JSON.stringify({
      ...(variant !== undefined ? { variant } : {}),
      series,
      ...(rangeMs !== undefined ? { rangeMs } : {}),
      ...(intervalMs !== undefined ? { intervalMs } : {}),
      ...(endAt !== undefined ? { endAt } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(thresholds !== undefined ? { thresholds } : {}),
      ...(showGrid !== undefined ? { showGrid } : {}),
      ...(showLegend !== undefined ? { showLegend } : {}),
      ...(showAxes !== undefined ? { showAxes } : {}),
      ...(interactive !== undefined ? { interactive } : {}),
      ...(emptyText !== undefined ? { emptyText } : {}),
      ...(ariaLabel !== undefined ? { ariaLabel } : {}),
    }),
    [variant, series, rangeMs, intervalMs, endAt, min, max, height, thresholds, showGrid, showLegend, showAxes, interactive, emptyText, ariaLabel],
  );
  const resolvedStyle: CSSProperties | undefined = height !== undefined
    ? { height: `${height}px`, ...style }
    : style;
  return createElement('div', {
    className,
    style: resolvedStyle,
    'data-plugin-widget': 'metric-chart',
    'data-plugin-widget-props': serialized,
  });
}

export type PluginBiChartType =
  | 'bar'
  | 'horizontal-bar'
  | 'stacked-bar'
  | 'line'
  | 'area'
  | 'pie'
  | 'donut'
  | 'scatter'
  | 'funnel'
  | 'combo';

export type PluginBiChartColor =
  | 'primary'
  | 'sky'
  | 'emerald'
  | 'amber'
  | 'violet'
  | 'rose'
  | 'cyan'
  | 'indigo'
  | 'teal'
  | 'orange'
  | 'slate'
  | 'muted';

export type PluginBiChartPalette = 'default' | 'categorical' | 'cool' | 'warm' | 'monochrome';

export type PluginBiChartValueFormat = 'number' | 'compact' | 'currency' | 'percent' | 'bytes' | 'ms';

export interface PluginBiChartScatterPoint {
  x: number;
  y: number;
  label?: string;
  size?: number;
}

export interface PluginBiChartSeries {
  id: string;
  name: string;
  data?: Array<number | null>;
  points?: PluginBiChartScatterPoint[];
  renderAs?: 'bar' | 'line' | 'area';
  yAxis?: 'left' | 'right';
  color?: PluginBiChartColor;
  format?: PluginBiChartValueFormat;
  currency?: string;
}

export interface PluginBiChartActiveFilter {
  seriesIndex?: number;
  datumIndex?: number;
  category?: string;
}

export interface PluginBiChartDatumClickDetail {
  seriesIndex: number;
  seriesName: string;
  datumIndex: number;
  category: string;
  value: number | null;
  x?: number;
  y?: number;
}

export interface PluginBiChartExportSvgDetail {
  svg: string;
  suggestedName: string;
  downloadedByHost?: boolean;
}

export interface PluginBiChartExportPngDetail {
  dataUrl?: string;
  suggestedName: string;
  downloadedByHost?: boolean;
}

export interface PluginBiChartProps {
  type: PluginBiChartType;
  title?: string;
  subtitle?: string;
  categories?: string[];
  series: PluginBiChartSeries[];
  palette?: PluginBiChartPalette;
  xAxisLabel?: string;
  yAxisLabel?: string;
  yAxisRightLabel?: string;
  valueFormat?: PluginBiChartValueFormat;
  currency?: string;
  height?: number;
  showGrid?: boolean;
  showLegend?: boolean;
  showDataLabels?: boolean;
  smooth?: boolean;
  donutInnerRatio?: number;
  exportable?: boolean;
  activeFilter?: PluginBiChartActiveFilter | null;
  emptyText?: string;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  onDatumClick?: (detail: PluginBiChartDatumClickDetail) => void;
  onExportSvg?: (detail: PluginBiChartExportSvgDetail) => void;
  onExportPng?: (detail: PluginBiChartExportPngDetail) => void;
  onShortcut?: (detail: { shortcut: PluginWorkbenchShortcut }) => void;
}

/** Host-rendered interactive BI analytics chart supporting 10 chart types, cross-filtering, and SVG/PNG export. */
export function PluginBiChart({
  type,
  title,
  subtitle,
  categories,
  series,
  palette,
  xAxisLabel,
  yAxisLabel,
  yAxisRightLabel,
  valueFormat,
  currency,
  height,
  showGrid,
  showLegend,
  showDataLabels,
  smooth,
  donutInnerRatio,
  exportable,
  activeFilter,
  emptyText,
  ariaLabel,
  className,
  style,
  onDatumClick,
  onExportSvg,
  onExportPng,
  onShortcut,
}: PluginBiChartProps) {
  const ref = useRef<HTMLElement>(null);
  useWidgetEventBridge(ref, (eventName, detail) => {
    if (eventName === 'datumClick') onDatumClick?.(detail as unknown as PluginBiChartDatumClickDetail);
    else if (eventName === 'exportSvg') onExportSvg?.(detail as unknown as PluginBiChartExportSvgDetail);
    else if (eventName === 'exportPng') onExportPng?.(detail as unknown as PluginBiChartExportPngDetail);
    else if (eventName === 'shortcut' && onShortcut) {
      onShortcut(detail as { shortcut: PluginWorkbenchShortcut });
      return true;
    }
  });
  const serialized = useMemo(
    () => JSON.stringify({
      type,
      ...(title !== undefined ? { title } : {}),
      ...(subtitle !== undefined ? { subtitle } : {}),
      ...(categories !== undefined ? { categories } : {}),
      series,
      ...(palette !== undefined ? { palette } : {}),
      ...(xAxisLabel !== undefined ? { xAxisLabel } : {}),
      ...(yAxisLabel !== undefined ? { yAxisLabel } : {}),
      ...(yAxisRightLabel !== undefined ? { yAxisRightLabel } : {}),
      ...(valueFormat !== undefined ? { valueFormat } : {}),
      ...(currency !== undefined ? { currency } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(showGrid !== undefined ? { showGrid } : {}),
      ...(showLegend !== undefined ? { showLegend } : {}),
      ...(showDataLabels !== undefined ? { showDataLabels } : {}),
      ...(smooth !== undefined ? { smooth } : {}),
      ...(donutInnerRatio !== undefined ? { donutInnerRatio } : {}),
      ...(exportable !== undefined ? { exportable } : {}),
      ...(activeFilter !== undefined ? { activeFilter } : {}),
      ...(emptyText !== undefined ? { emptyText } : {}),
      ...(ariaLabel !== undefined ? { ariaLabel } : {}),
    }),
    [
      type, title, subtitle, categories, series, palette, xAxisLabel, yAxisLabel,
      yAxisRightLabel, valueFormat, currency, height, showGrid, showLegend,
      showDataLabels, smooth, donutInnerRatio, exportable, activeFilter, emptyText, ariaLabel,
    ],
  );
  return createElement('div', {
    ref,
    className,
    style,
    'data-plugin-widget': 'bi-chart',
    'data-plugin-widget-props': serialized,
  });
}
