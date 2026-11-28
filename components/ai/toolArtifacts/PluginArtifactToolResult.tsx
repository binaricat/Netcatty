import React, { useCallback, useState } from 'react';
import { BarChart3, Check, Code2, ExternalLink, Loader2, Pin, Table2 } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { netcattyBridge } from '../../../infrastructure/services/netcattyBridge';
import { toast } from '../../ui/toast';
import { PluginBiChart } from '../../plugins/primitives/PluginBiChart';
import type {
  PluginArtifactActionSpec,
  PluginBiChartRenderedArtifact,
  PluginRenderedToolArtifact,
  PluginSqlResultRenderedArtifact,
} from './pluginToolArtifact';

const MAX_PREVIEW_ROWS = 10;
const MAX_PREVIEW_COLS = 8;

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '—';
  }
  if (typeof value === 'string') {
    return value.length > 64 ? `${value.slice(0, 61)}...` : value;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 64 ? `${serialized.slice(0, 61)}...` : serialized;
  } catch {
    return String(value);
  }
}

function usePluginArtifactAction(
  pluginId: string | undefined,
  viewId: string | undefined,
) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [doneKeys, setDoneKeys] = useState<Record<string, boolean>>({});

  const runAction = useCallback(async (
    key: string,
    action: PluginArtifactActionSpec,
    successToast: string,
  ) => {
    if (!pluginId) return;
    const invoke = netcattyBridge.get()?.invokePluginAiTool;
    if (typeof invoke !== 'function') {
      toast.error('Plugin action bridge is unavailable.');
      return;
    }
    setBusyKey(key);
    try {
      await invoke({
        pluginId,
        toolName: action.toolName,
        args: action.args,
        ...(viewId ? { viewId } : {}),
      });
      setDoneKeys((prev) => ({ ...prev, [key]: true }));
      toast.success(successToast);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message || 'Action failed.');
    } finally {
      setBusyKey((prev) => (prev === key ? null : prev));
    }
  }, [pluginId, viewId]);

  return { busyKey, doneKeys, runAction };
}

const BiChartArtifactView: React.FC<{ artifact: PluginBiChartRenderedArtifact }> = ({ artifact }) => {
  const [showSql, setShowSql] = useState(false);
  const { busyKey, doneKeys, runAction } = usePluginArtifactAction(artifact.pluginId, artifact.viewId);
  const canInvoke = Boolean(artifact.pluginId);

  const chartProps = {
    ...artifact.chartSpec,
    // Render header in our quiet artifact frame instead of duplicating titles.
    title: undefined,
    subtitle: undefined,
    height: artifact.chartSpec.height ?? 215,
  };

  return (
    <div
      data-plugin-ai-artifact="bi-chart"
      className="min-w-0 rounded-xl bg-muted/30 dark:bg-white/[0.035] px-3 py-2.5 space-y-2.5"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <BarChart3 size={13} className="shrink-0 text-primary/80" />
            <span className="truncate text-[12px] font-medium text-foreground">
              {artifact.title || 'BI Chart'}
            </span>
          </div>
          {artifact.subtitle && (
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground/75">
              {artifact.subtitle}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {artifact.sql && (
            <button
              type="button"
              onClick={() => setShowSql((prev) => !prev)}
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer',
                showSql
                  ? 'bg-primary/15 text-primary'
                  : 'bg-background/60 text-muted-foreground hover:bg-background hover:text-foreground',
              )}
            >
              <Code2 size={11} />
              <span>SQL</span>
            </button>
          )}
          {canInvoke && artifact.openAction && (
            <button
              type="button"
              disabled={busyKey === 'open'}
              onClick={() => void runAction('open', artifact.openAction!, 'Opened in SQL Editor')}
              className="inline-flex items-center gap-1 rounded-md bg-background/60 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-background hover:text-foreground cursor-pointer disabled:opacity-50"
            >
              {busyKey === 'open' ? <Loader2 size={11} className="animate-spin" /> : <ExternalLink size={11} />}
              <span>{artifact.openAction.label || 'Open SQL'}</span>
            </button>
          )}
          {canInvoke && artifact.pinAction && (
            <button
              type="button"
              disabled={busyKey === 'pin'}
              onClick={() => void runAction('pin', artifact.pinAction!, 'Pinned to BI Dashboard')}
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-50',
                doneKeys.pin
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-primary/12 text-primary hover:bg-primary/20',
              )}
            >
              {busyKey === 'pin'
                ? <Loader2 size={11} className="animate-spin" />
                : doneKeys.pin
                  ? <Check size={11} />
                  : <Pin size={11} />}
              <span>{doneKeys.pin ? 'Pinned' : (artifact.pinAction.label || 'Pin to BI Dashboard')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Optional compact KPI strip */}
      {artifact.kpis && artifact.kpis.length > 0 && (
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {artifact.kpis.map((kpi, index) => (
            <div
              key={`${kpi.label}-${index}`}
              className="min-w-0 rounded-lg bg-background/55 dark:bg-white/[0.03] px-2.5 py-1.5"
            >
              <div className="truncate text-[10px] text-muted-foreground/75">{kpi.label}</div>
              <div className="mt-0.5 flex items-baseline gap-1.5 min-w-0">
                <span className="truncate text-[13px] font-semibold tabular-nums text-foreground">
                  {kpi.value}
                </span>
                {kpi.delta && (
                  <span
                    className={cn(
                      'truncate text-[10px] font-medium tabular-nums',
                      kpi.tone === 'positive'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : kpi.tone === 'negative'
                          ? 'text-rose-600 dark:text-rose-400'
                          : kpi.tone === 'warning'
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-muted-foreground',
                    )}
                  >
                    {kpi.delta}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Host-rendered interactive PluginBiChart */}
      <div className="min-w-0 rounded-lg bg-background/70 dark:bg-black/20 p-1.5">
        <PluginBiChart {...chartProps} />
      </div>

      {/* Optional collapsible SQL inspector */}
      {showSql && artifact.sql && (
        <pre className="overflow-x-auto rounded-lg bg-background/75 dark:bg-black/25 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground/85 whitespace-pre-wrap break-words">
          {artifact.sql}
        </pre>
      )}
    </div>
  );
};

const SqlResultArtifactView: React.FC<{ artifact: PluginSqlResultRenderedArtifact }> = ({ artifact }) => {
  const [showSql, setShowSql] = useState(false);
  const { busyKey, doneKeys, runAction } = usePluginArtifactAction(artifact.pluginId, artifact.viewId);
  const canInvoke = Boolean(artifact.pluginId);

  const visibleColumns = artifact.columns.slice(0, MAX_PREVIEW_COLS);
  const hiddenColumnCount = Math.max(0, artifact.columns.length - visibleColumns.length);
  const visibleRows = artifact.rows.slice(0, MAX_PREVIEW_ROWS);

  return (
    <div
      data-plugin-ai-artifact="sql-result"
      className="min-w-0 rounded-xl bg-muted/30 dark:bg-white/[0.035] px-3 py-2.5 space-y-2"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Table2 size={13} className="shrink-0 text-primary/80" />
          <span className="truncate text-[12px] font-medium text-foreground">
            {artifact.title || 'Query Result'}
          </span>
          <span className="shrink-0 rounded-md bg-background/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {artifact.rowCount} {artifact.rowCount === 1 ? 'row' : 'rows'}
            {artifact.durationMs != null ? ` · ${artifact.durationMs} ms` : ''}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setShowSql((prev) => !prev)}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer',
              showSql
                ? 'bg-primary/15 text-primary'
                : 'bg-background/60 text-muted-foreground hover:bg-background hover:text-foreground',
            )}
          >
            <Code2 size={11} />
            <span>SQL</span>
          </button>
          {canInvoke && artifact.openAction && (
            <button
              type="button"
              disabled={busyKey === 'open'}
              onClick={() => void runAction('open', artifact.openAction!, 'Opened in SQL Editor')}
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-50',
                doneKeys.open
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-primary/12 text-primary hover:bg-primary/20',
              )}
            >
              {busyKey === 'open'
                ? <Loader2 size={11} className="animate-spin" />
                : doneKeys.open
                  ? <Check size={11} />
                  : <ExternalLink size={11} />}
              <span>{doneKeys.open ? 'Opened' : (artifact.openAction.label || 'Open in SQL Editor')}</span>
            </button>
          )}
        </div>
      </div>

      {showSql && (
        <pre className="overflow-x-auto rounded-lg bg-background/75 dark:bg-black/25 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground/85 whitespace-pre-wrap break-words">
          {artifact.sql}
        </pre>
      )}

      {visibleColumns.length > 0 && visibleRows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg bg-background/65 dark:bg-black/20">
          <table className="w-full border-collapse text-left text-[11px]">
            <thead>
              <tr className="border-b border-border/25 text-muted-foreground/80">
                {visibleColumns.map((col, idx) => (
                  <th
                    key={`${col}-${idx}`}
                    className="px-2.5 py-1.5 font-medium whitespace-nowrap"
                  >
                    {col}
                  </th>
                ))}
                {hiddenColumnCount > 0 && (
                  <th className="px-2 py-1.5 font-normal text-muted-foreground/60 whitespace-nowrap">
                    +{hiddenColumnCount}
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/15">
              {visibleRows.map((row, rowIdx) => (
                <tr key={rowIdx} className="hover:bg-muted/25">
                  {visibleColumns.map((_, colIdx) => {
                    const cell = row[colIdx];
                    const isNull = cell === null || cell === undefined;
                    return (
                      <td
                        key={colIdx}
                        className={cn(
                          'px-2.5 py-1 font-mono whitespace-nowrap tabular-nums',
                          isNull ? 'text-muted-foreground/45 italic' : 'text-foreground/85',
                        )}
                      >
                        {formatCellValue(cell)}
                      </td>
                    );
                  })}
                  {hiddenColumnCount > 0 && (
                    <td className="px-2 py-1 text-muted-foreground/45">…</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {(artifact.rowCount > visibleRows.length || artifact.truncated) && (
            <div className="px-2.5 py-1 text-[10px] text-muted-foreground/65">
              Showing {visibleRows.length} of {artifact.totalRows ?? artifact.rowCount} rows
              {artifact.truncated ? ' (capped)' : ''}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg bg-background/50 px-2.5 py-2 text-[11px] text-muted-foreground">
          Query returned 0 rows.
        </div>
      )}
    </div>
  );
};

export const PluginArtifactToolResult: React.FC<{
  artifact: PluginRenderedToolArtifact;
}> = ({ artifact }) => {
  if (artifact.kind === 'bi-chart') {
    return <BiChartArtifactView artifact={artifact} />;
  }
  return <SqlResultArtifactView artifact={artifact} />;
};
