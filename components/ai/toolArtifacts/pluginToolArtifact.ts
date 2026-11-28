import type { PluginBiChartWidgetProps } from '../../plugins/primitives/types';
import { parseResultPayload } from './toolArtifactResultPayload';

const VALID_BI_CHART_TYPES = new Set([
  'bar',
  'horizontal-bar',
  'stacked-bar',
  'line',
  'area',
  'pie',
  'donut',
  'scatter',
  'funnel',
  'combo',
]);

const VALID_TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,47}$/;
const QUALIFIED_PLUGIN_TOOL_RE = /^plugin_[0-9a-f]{6}_([a-z][a-z0-9_]{0,47})$/;

export interface PluginArtifactActionSpec {
  readonly toolName: string;
  readonly label?: string;
  readonly args: Record<string, unknown>;
}

export interface PluginBiChartArtifactKpi {
  readonly label: string;
  readonly value: string;
  readonly delta?: string;
  readonly tone?: 'default' | 'positive' | 'negative' | 'warning';
}

export interface PluginBiChartRenderedArtifact {
  readonly kind: 'bi-chart';
  readonly pluginId?: string;
  readonly pluginName?: string;
  readonly viewId?: string;
  readonly sourceToolName?: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly chartSpec: PluginBiChartWidgetProps;
  readonly kpis?: readonly PluginBiChartArtifactKpi[];
  readonly sql?: string;
  readonly pinAction?: PluginArtifactActionSpec;
  readonly openAction?: PluginArtifactActionSpec;
}

export interface PluginSqlResultRenderedArtifact {
  readonly kind: 'sql-result';
  readonly pluginId?: string;
  readonly pluginName?: string;
  readonly viewId?: string;
  readonly sourceToolName?: string;
  readonly title?: string;
  readonly sql: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly rowCount: number;
  readonly totalRows?: number;
  readonly durationMs?: number;
  readonly truncated?: boolean;
  readonly openAction?: PluginArtifactActionSpec;
  readonly chartAction?: PluginArtifactActionSpec;
}

export type PluginRenderedToolArtifact =
  | PluginBiChartRenderedArtifact
  | PluginSqlResultRenderedArtifact;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNonEmptyString(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function parseArtifactAction(value: unknown): PluginArtifactActionSpec | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const toolName = typeof record.toolName === 'string' ? record.toolName.trim() : '';
  if (!VALID_TOOL_NAME_RE.test(toolName)) return undefined;
  const args = asRecord(record.args) ?? {};
  const label = asNonEmptyString(record.label, 64);
  return {
    toolName,
    ...(label ? { label } : {}),
    args,
  };
}

function parseKpis(value: unknown): PluginBiChartArtifactKpi[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: PluginBiChartArtifactKpi[] = [];
  for (const raw of value.slice(0, 4)) {
    const record = asRecord(raw);
    if (!record) continue;
    const label = asNonEmptyString(record.label, 64);
    const val = asNonEmptyString(record.value, 64);
    if (!label || !val) continue;
    const delta = asNonEmptyString(record.delta, 32);
    const tone = record.tone === 'positive' || record.tone === 'negative' || record.tone === 'warning'
      ? record.tone
      : 'default';
    items.push({
      label,
      value: val,
      ...(delta ? { delta } : {}),
      tone,
    });
  }
  return items.length > 0 ? items : undefined;
}

export function parsePluginToolArtifact(
  toolName: string | undefined,
  result: unknown,
  isError?: boolean,
): PluginRenderedToolArtifact | null {
  if (isError) return null;
  if (typeof toolName !== 'string') return null;
  const qualifiedMatch = QUALIFIED_PLUGIN_TOOL_RE.exec(toolName.trim());
  if (!qualifiedMatch) return null;
  const expectedToolSuffix = qualifiedMatch[1];

  const payload = parseResultPayload(result);
  if (!payload) return null;
  const artifact = asRecord(payload._netcattyArtifact);
  if (!artifact) return null;

  const pluginId = asNonEmptyString(artifact._netcattyPluginId, 160);
  const pluginName = asNonEmptyString(artifact._netcattyPluginName, 120);
  const viewId = asNonEmptyString(artifact._netcattyViewId, 256);
  const sourceToolName = asNonEmptyString(artifact._netcattyToolName, 64);
  if (!pluginId || sourceToolName !== expectedToolSuffix) return null;

  if (artifact.kind === 'bi-chart') {
    const rawChartSpec = asRecord(artifact.chartSpec);
    if (!rawChartSpec) return null;
    const chartType = typeof rawChartSpec.type === 'string' ? rawChartSpec.type : '';
    if (!VALID_BI_CHART_TYPES.has(chartType)) return null;
    const hasSeries = Array.isArray(rawChartSpec.series) && rawChartSpec.series.length > 0;
    const hasPoints = Array.isArray(rawChartSpec.points) && rawChartSpec.points.length > 0;
    if (!hasSeries && !hasPoints) return null;

    return {
      kind: 'bi-chart',
      pluginId,
      pluginName,
      viewId,
      sourceToolName,
      title: asNonEmptyString(artifact.title, 140) ?? asNonEmptyString(rawChartSpec.title, 140),
      subtitle: asNonEmptyString(artifact.subtitle, 180) ?? asNonEmptyString(rawChartSpec.subtitle, 180),
      chartSpec: rawChartSpec as unknown as PluginBiChartWidgetProps,
      kpis: parseKpis(artifact.kpis),
      sql: asNonEmptyString(artifact.sql, 8000),
      pinAction: parseArtifactAction(artifact.pinAction),
      openAction: parseArtifactAction(artifact.openAction),
    };
  }

  if (artifact.kind === 'sql-result') {
    const sql = asNonEmptyString(artifact.sql, 8000);
    if (!sql) return null;
    const columns = Array.isArray(artifact.columns)
      ? artifact.columns.slice(0, 32).map((col) => String(col ?? ''))
      : [];
    const rows = Array.isArray(artifact.rows)
      ? artifact.rows.slice(0, 50).map((row) => (Array.isArray(row) ? row.slice(0, 32) : [row]))
      : [];
    const rowCount = typeof artifact.rowCount === 'number' && Number.isFinite(artifact.rowCount)
      ? Math.max(0, Math.floor(artifact.rowCount))
      : rows.length;
    const totalRows = typeof artifact.totalRows === 'number' && Number.isFinite(artifact.totalRows)
      ? Math.max(rowCount, Math.floor(artifact.totalRows))
      : undefined;
    const durationMs = typeof artifact.durationMs === 'number' && Number.isFinite(artifact.durationMs)
      ? Math.max(0, Math.round(artifact.durationMs))
      : undefined;

    return {
      kind: 'sql-result',
      pluginId,
      pluginName,
      viewId,
      sourceToolName,
      title: asNonEmptyString(artifact.title, 140),
      sql,
      columns,
      rows,
      rowCount,
      totalRows,
      durationMs,
      truncated: artifact.truncated === true,
      openAction: parseArtifactAction(artifact.openAction),
      chartAction: parseArtifactAction(artifact.chartAction),
    };
  }

  return null;
}
