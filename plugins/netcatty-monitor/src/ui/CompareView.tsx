import React, { useMemo } from 'react';
import {
  PluginDataGrid,
  PluginMetricChart,
  type PluginDataGridColumn,
  type PluginMetricChartColor,
} from '@netcatty/plugin-sdk/host-react';
import { evaluateHostHealth } from '../domain/alerts';
import {
  formatIops,
  formatLatency,
  formatLoadAverage,
  formatMemoryPercent,
  formatMonitorRate,
  formatPercent,
} from '../domain/formatting';
import type { I18nKey } from '../domain/i18n';
import type {
  AlertThresholds,
  HostRuntimeState,
  MonitorHostRef,
  MonitorInterval,
  MonitorRangeMinutes,
} from '../domain/types';

const SERIES_COLORS: readonly PluginMetricChartColor[] = ['emerald', 'sky', 'amber', 'violet', 'rose', 'cyan'];

export interface CompareViewProps {
  hosts: MonitorHostRef[];
  selectedHostIds: string[];
  runtimeHosts: Record<string, HostRuntimeState>;
  interval: MonitorInterval;
  range: MonitorRangeMinutes;
  thresholds: AlertThresholds;
  t: (key: I18nKey) => string;
  onToggleCompareHost: (hostId: string) => void;
  onInspectHost: (hostId: string) => void;
}

export function CompareView({
  hosts,
  selectedHostIds,
  runtimeHosts,
  interval,
  range,
  thresholds,
  t,
  onToggleCompareHost,
  onInspectHost,
}: CompareViewProps) {
  const now = Date.now();
  const rangeMs = range * 60_000;
  const intervalMs = interval * 1_000;

  const effectiveSelected = useMemo(() => {
    const valid = selectedHostIds.filter((id) => hosts.some((h) => h.hostId === id)).slice(0, 6);
    if (valid.length >= 2) return valid;
    return hosts.slice(0, Math.min(4, hosts.length)).map((h) => h.hostId);
  }, [hosts, selectedHostIds]);

  const comparedHosts = useMemo(
    () =>
      effectiveSelected
        .map((id, idx) => {
          const host = hosts.find((h) => h.hostId === id);
          if (!host) return null;
          return {
            host,
            state: runtimeHosts[id],
            color: SERIES_COLORS[idx % SERIES_COLORS.length],
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    [effectiveSelected, hosts, runtimeHosts],
  );

  const columns = useMemo<PluginDataGridColumn[]>(
    () => [
      { name: 'host', type: 'text', width: 180, sortable: true },
      { name: 'health', type: 'text', width: 88, sortable: true },
      { name: 'cpu', type: 'text', width: 95 },
      { name: 'iowait', type: 'text', width: 82 },
      { name: 'memory', type: 'text', width: 92 },
      { name: 'disk', type: 'text', width: 82 },
      { name: 'iops', type: 'text', width: 120 },
      { name: 'network', type: 'text', width: 145 },
      { name: 'load', type: 'text', width: 115 },
      { name: 'latency', type: 'text', width: 84 },
    ],
    [],
  );

  const rows = useMemo(
    () =>
      comparedHosts.map(({ host, state }) => {
        const s = state?.stats;
        const { health } = evaluateHostHealth(state, thresholds);
        const memPct = formatMemoryPercent(s?.memUsed, s?.memTotal);
        return {
          _hostId: host.hostId,
          host: host.label,
          health: `${health.score}/100`,
          cpu: formatPercent(s?.cpu, 1),
          iowait: s?.cpuIowait != null ? `${s.cpuIowait.toFixed(1)}%` : '--',
          memory: formatPercent(memPct, 1),
          disk: formatPercent(s?.diskPercent, 0),
          iops: formatIops(s?.diskReadIops, s?.diskWriteIops),
          network: s?.networkReady ? `↓${formatMonitorRate(s.netRxSpeed)} ↑${formatMonitorRate(s.netTxSpeed)}` : '--',
          load: formatLoadAverage(s?.loadAverage),
          latency: formatLatency(state?.mode === 'probe' ? state.probe?.rttMs : (s?.latencyMs ?? s?.responseLatencyMs)),
        };
      }),
    [comparedHosts, thresholds],
  );

  if (hosts.length < 2) {
    return (
      <div className="nm-content">
        <div className="nm-empty">
          <h3 className="nm-empty-title">{t('viewCompare')}</h3>
          <p className="nm-empty-body">{t('compareNeedMore')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="nm-content">
      <div className="nm-panel-card-sub" style={{ marginBottom: 8 }}>
        {t('compareSelectHint')}
      </div>

      {/* Host Selector Chips (2-6 hosts) */}
      <div className="nm-compare-chips">
        {hosts.map((h) => {
          const active = effectiveSelected.includes(h.hostId);
          return (
            <button
              key={h.hostId}
              type="button"
              className={`nm-chip ${active ? 'nm-chip-active' : ''}`}
              onClick={() => onToggleCompareHost(h.hostId)}
            >
              <span>{active ? '✓' : '+'}</span>
              <span>{h.label}</span>
            </button>
          );
        })}
      </div>

      {/* Synchronized Multi-Host Overlay Charts */}
      <div className="nm-chart-grid">
        <section className="nm-panel-card">
          <div className="nm-panel-card-head">
            <h3 className="nm-panel-card-title">{t('metricCpu')} (%)</h3>
            <span className="nm-panel-card-sub nm-mono">{comparedHosts.length} hosts</span>
          </div>
          <PluginMetricChart
            variant="line"
            height={165}
            rangeMs={rangeMs}
            intervalMs={intervalMs}
            endAt={now}
            min={0}
            max={100}
            showGrid
            showAxes
            showLegend
            interactive
            ariaLabel={`${t('viewCompare')} ${t('metricCpu')}`}
            thresholds={[{ value: thresholds.cpuWarning, tone: 'warning' }, { value: thresholds.cpuCritical, tone: 'critical' }]}
            series={comparedHosts.map(({ host, state, color }) => ({
              id: host.hostId,
              label: host.label,
              color,
              unit: '%',
              points: (state?.points ?? []).map((p) => ({ at: p.at, value: p.cpu })),
            }))}
          />
        </section>

        <section className="nm-panel-card">
          <div className="nm-panel-card-head">
            <h3 className="nm-panel-card-title">{t('metricMemory')} (%)</h3>
            <span className="nm-panel-card-sub nm-mono">{comparedHosts.length} hosts</span>
          </div>
          <PluginMetricChart
            variant="line"
            height={165}
            rangeMs={rangeMs}
            intervalMs={intervalMs}
            endAt={now}
            min={0}
            max={100}
            showGrid
            showAxes
            showLegend
            interactive
            ariaLabel={`${t('viewCompare')} ${t('metricMemory')}`}
            thresholds={[{ value: thresholds.memoryWarning, tone: 'warning' }, { value: thresholds.memoryCritical, tone: 'critical' }]}
            series={comparedHosts.map(({ host, state, color }) => ({
              id: host.hostId,
              label: host.label,
              color,
              unit: '%',
              points: (state?.points ?? []).map((p) => ({ at: p.at, value: p.memory })),
            }))}
          />
        </section>

        <section className="nm-panel-card">
          <div className="nm-panel-card-head">
            <h3 className="nm-panel-card-title">{t('metricNetwork')} (RX + TX)</h3>
            <span className="nm-panel-card-sub nm-mono">bytes/s</span>
          </div>
          <PluginMetricChart
            variant="line"
            height={165}
            rangeMs={rangeMs}
            intervalMs={intervalMs}
            endAt={now}
            min={0}
            max="auto"
            showGrid
            showAxes
            showLegend
            interactive
            ariaLabel={`${t('viewCompare')} ${t('metricNetwork')}`}
            series={comparedHosts.map(({ host, state, color }) => ({
              id: host.hostId,
              label: host.label,
              color,
              unit: 'bytes/s',
              points: (state?.points ?? []).map((p) => ({
                at: p.at,
                value: p.rx != null || p.tx != null ? (p.rx ?? 0) + (p.tx ?? 0) : null,
              })),
            }))}
          />
        </section>

        <section className="nm-panel-card">
          <div className="nm-panel-card-head">
            <h3 className="nm-panel-card-title">{t('metricDiskIo')} / {t('metricLatency')}</h3>
            <span className="nm-panel-card-sub nm-mono">ms</span>
          </div>
          <PluginMetricChart
            variant="line"
            height={165}
            rangeMs={rangeMs}
            intervalMs={intervalMs}
            endAt={now}
            min={0}
            max="auto"
            showGrid
            showAxes
            showLegend
            interactive
            ariaLabel={`${t('viewCompare')} ${t('metricLatency')}`}
            thresholds={[{ value: thresholds.latencyWarningMs, tone: 'warning' }]}
            series={comparedHosts.map(({ host, state, color }) => ({
              id: host.hostId,
              label: host.label,
              color,
              unit: 'ms',
              points: (state?.points ?? []).map((p) => ({ at: p.at, value: p.latencyMs })),
            }))}
          />
        </section>
      </div>

      {/* Side-by-Side KPI Matrix */}
      <div className="nm-grid-wrap" style={{ minHeight: 180 }}>
        <PluginDataGrid
          columns={columns}
          rows={rows}
          onCellDoubleClick={({ rowIndex }) => {
            const row = rows[rowIndex];
            if (row?._hostId) onInspectHost(row._hostId);
          }}
          emptyMessage={t('compareNeedMore')}
        />
      </div>
    </div>
  );
}
