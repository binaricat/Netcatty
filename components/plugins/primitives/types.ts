export type PluginWidgetEventCallback = (
  widgetEvent: string,
  detail?: Record<string, unknown>,
) => void;

export type PluginWorkbenchShortcut =
  | 'mod+k'
  | 'mod+s'
  | 'mod+t'
  | 'mod+w'
  | 'mod+z'
  | 'mod+shift+z'
  | 'escape';

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

export interface PluginCodeEditorWidgetProps {
  value?: string;
  language?: 'sql' | 'pgsql' | 'mysql' | 'json' | 'plaintext';
  readOnly?: boolean;
  placeholder?: string;
  lineNumbers?: 'on' | 'off' | 'relative';
  minimap?: boolean;
  wordWrap?: 'on' | 'off' | 'wordWrapColumn' | 'bounded';
  completionSchema?: PluginCodeEditorCompletionSchema;
  diagnostics?: PluginCodeEditorDiagnostic[];
  height?: number | string;
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

export interface PluginDataGridWidgetProps {
  columns?: PluginDataGridColumn[];
  rows?: PluginDataGridRow[];
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
}

export interface PluginSplitPaneWidgetProps {
  direction?: 'horizontal' | 'vertical';
  initialSize?: number;
  minSize?: number;
  maxSize?: number;
  collapsible?: boolean;
  collapsed?: boolean;
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

export interface PluginErCanvasWidgetProps {
  tables?: PluginErTable[];
  relations?: PluginErRelation[];
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

export interface PluginMetricChartWidgetProps {
  variant?: 'area' | 'line' | 'sparkline' | 'bar';
  series?: PluginMetricChartSeries[];
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
}
