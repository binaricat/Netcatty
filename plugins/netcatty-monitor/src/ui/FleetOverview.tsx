import React, { useMemo, useState } from 'react';
import {
  PluginDataGrid,
  PluginMetricChart,
  PluginPopover,
  type PluginDataGridColumn,
  type PluginDataGridSort,
} from '@netcatty/plugin-sdk/host-react';
import { evaluateHostHealth } from '../domain/alerts';
import {
  formatCompactCount,
  formatIops,
  formatLatency,
  formatLoadAverage,
  formatMemoryMiB,
  formatMemoryPercent,
  formatMonitorRate,
  formatPercent,
  formatRelativeAge,
  formatUptime,
} from '../domain/formatting';
import type { I18nKey, MonitorLocale } from '../domain/i18n';
import { MONITOR_RANGES } from '../domain/panels';
import type {
  AlertThresholds,
  HostRuntimeState,
  MonitorHostRef,
  MonitorInterval,
  MonitorPanel,
  MonitorRangeMinutes,
} from '../domain/types';
import { isHostStateStale } from '../services/monitorEngine';
import { CompareView } from './CompareView';
import { MonitorIcon } from './MonitorIcon';

export type FleetFilterMode = 'all' | 'pinned' | 'alerts';

export interface FleetOverviewProps {
  panel: MonitorPanel;
  hosts: MonitorHostRef[];
  runtimeHosts: Record<string, HostRuntimeState>;
  pinnedHostIds: ReadonlySet<string>;
  hiddenColumns: readonly string[];
  thresholds: AlertThresholds;
  running: boolean;
  locale: MonitorLocale;
  t: (key: I18nKey) => string;
  onUpdatePanel: (patch: Partial<MonitorPanel>) => void;
  onToggleRunning: () => void;
  onRefreshNow: () => void;
  onAddHosts: () => void;
  onRemoveHost: (hostId: string) => void;
  onTogglePin: (hostId: string) => void;
  onReorderHost: (hostId: string, direction: 'up' | 'down') => void;
  onToggleColumn: (col: string) => void;
  onInspectHost: (hostId: string) => void;
  onRetryHost: (hostId: string) => void;
  onOpenSession: (host: MonitorHostRef, mode: 'terminal' | 'sftp' | 'remoteDesktop') => void;
  onExportSnapshot: (format: 'json' | 'md') => void;
}

const OPTIONAL_TABLE_COLUMNS = [
  'health',
  'cpu',
  'memory',
  'disk',
  'iops',
  'network',
  'drops',
  'gpu',
  'load',
  'uptime',
  'latency',
  'tags',
  'updated',
] as const;

function statusBadgeClass(status: HostRuntimeState['status'] | 'stale'): string {
  if (status === 'live') return 'nm-badge nm-badge-ok';
  if (status === 'stale' || status === 'connecting' || status === 'queued') return 'nm-badge nm-badge-warn';
  if (status === 'offline' || status === 'error' || status === 'login' || status === 'disconnected') {
    return 'nm-badge nm-badge-crit';
  }
  return 'nm-badge';
}

function statusLabel(status: HostRuntimeState['status'] | 'stale', t: (k: I18nKey) => string): string {
  switch (status) {
    case 'live': return t('statusLive');
    case 'stale': return t('statusStale');
    case 'queued': return t('statusQueued');
    case 'connecting': return t('statusConnecting');
    case 'offline': return t('statusOffline');
    case 'login': return t('statusLogin');
    case 'error': return t('statusError');
    case 'unsupported': return t('statusUnsupported');
    case 'disconnected': return t('statusDisconnected');
    default: return t('statusIdle');
  }
}

function barTone(value: number | null | undefined, warn: number, crit: number): string {
  if (value == null || !Number.isFinite(value)) return 'nm-bar-fill';
  if (value >= crit) return 'nm-bar-fill nm-bar-crit';
  if (value >= warn) return 'nm-bar-fill nm-bar-warn';
  return 'nm-bar-fill nm-bar-ok';
}

export function FleetOverview({
  panel,
  hosts,
  runtimeHosts,
  pinnedHostIds,
  hiddenColumns,
  thresholds,
  running,
  locale,
  t,
  onUpdatePanel,
  onToggleRunning,
  onRefreshNow,
  onAddHosts,
  onRemoveHost,
  onTogglePin,
  onReorderHost,
  onToggleColumn,
  onInspectHost,
  onRetryHost,
  onOpenSession,
  onExportSnapshot,
}: FleetOverviewProps) {
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<FleetFilterMode>('all');
  const [colsOpen, setColsOpen] = useState(false);
  const [gridSort, setGridSort] = useState<PluginDataGridSort | null>(null);
  const [selectedRowIdx, setSelectedRowIdx] = useState<number | null>(null);

  const now = Date.now();
  const rangeMs = panel.range * 60_000;
  const intervalMs = panel.interval * 1_000;

  const enriched = useMemo(() => {
    return hosts.map((host) => {
      const state = runtimeHosts[host.hostId];
      const stale = isHostStateStale(state, panel.interval, now);
      const effectiveStatus = stale ? ('stale' as const) : (state?.status ?? 'idle');
      const { health } = evaluateHostHealth(state, thresholds);
      const memPct = formatMemoryPercent(state?.stats?.memUsed, state?.stats?.memTotal);
      return {
        host,
        state,
        effectiveStatus,
        health,
        memPct,
        pinned: pinnedHostIds.has(host.hostId),
      };
    });
  }, [hosts, runtimeHosts, panel.interval, thresholds, pinnedHostIds, now]);

  const kpis = useMemo(() => {
    let online = 0;
    let warnings = 0;
    let critical = 0;
    let cpuSum = 0;
    let cpuCount = 0;
    let memSum = 0;
    let memCount = 0;
    for (const item of enriched) {
      if (item.effectiveStatus === 'live') online += 1;
      if (item.health.level === 'warning') warnings += 1;
      if (item.health.level === 'critical' || item.health.level === 'offline') critical += 1;
      const cpu = item.state?.stats?.cpu;
      if (typeof cpu === 'number' && Number.isFinite(cpu)) {
        cpuSum += cpu;
        cpuCount += 1;
      }
      if (typeof item.memPct === 'number' && Number.isFinite(item.memPct)) {
        memSum += item.memPct;
        memCount += 1;
      }
    }
    return {
      total: enriched.length,
      online,
      warnings,
      critical,
      avgCpu: cpuCount > 0 ? cpuSum / cpuCount : null,
      avgMem: memCount > 0 ? memSum / memCount : null,
    };
  }, [enriched]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = enriched.filter((item) => {
      if (filterMode === 'pinned' && !item.pinned) return false;
      if (filterMode === 'alerts' && item.health.level !== 'warning' && item.health.level !== 'critical' && item.health.level !== 'offline') {
        return false;
      }
      if (!q) return true;
      const hay = [
        item.host.label,
        item.host.hostname,
        item.host.group,
        item.host.notes,
        item.state?.stats?.hostname,
        item.state?.stats?.osName,
        ...(item.host.tags ?? []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });

    list = [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (panel.sort === 'name') return a.host.label.localeCompare(b.host.label);
      if (panel.sort === 'health') return a.health.score - b.health.score;
      if (panel.sort === 'cpu') return (b.state?.stats?.cpu ?? -1) - (a.state?.stats?.cpu ?? -1);
      if (panel.sort === 'memory') return (b.memPct ?? -1) - (a.memPct ?? -1);
      return 0;
    });
    return list;
  }, [enriched, search, filterMode, panel.sort]);

  const tableColumns = useMemo<PluginDataGridColumn[]>(
    () => [
      { name: 'host', type: 'text', width: 200, sortable: true },
      { name: 'status', type: 'text', width: 90, sortable: true },
      { name: 'health', type: 'text', width: 88, sortable: true },
      { name: 'cpu', type: 'number', width: 84, sortable: true },
      { name: 'memory', type: 'text', width: 140, sortable: true },
      { name: 'disk', type: 'number', width: 82, sortable: true },
      { name: 'iops', type: 'text', width: 112 },
      { name: 'network', type: 'text', width: 150 },
      { name: 'drops', type: 'text', width: 78 },
      { name: 'gpu', type: 'text', width: 82 },
      { name: 'load', type: 'text', width: 115 },
      { name: 'uptime', type: 'text', width: 90 },
      { name: 'latency', type: 'text', width: 80, sortable: true },
      { name: 'tags', type: 'text', width: 120 },
      { name: 'updated', type: 'text', width: 90 },
    ],
    [],
  );

  const tableRows = useMemo(() => {
    const mapped = filtered.map((item) => {
      const s = item.state?.stats;
      const netText =
        s && s.networkReady
          ? `↓${formatMonitorRate(s.netRxSpeed)} ↑${formatMonitorRate(s.netTxSpeed)}`
          : '--';
      const memText =
        s && s.memTotal != null && s.memUsed != null
          ? `${formatPercent(item.memPct, 0)} (${formatMemoryMiB(s.memUsed)}/${formatMemoryMiB(s.memTotal)})`
          : '--';
      return {
        _hostId: item.host.hostId,
        host: `${item.pinned ? '★ ' : ''}${item.host.label}${item.host.hostname ? ` (${item.host.hostname})` : ''}`,
        status: statusLabel(item.effectiveStatus, t),
        health: `${item.health.score} · ${
          item.health.level === 'healthy'
            ? t('healthHealthy')
            : item.health.level === 'warning'
              ? t('healthWarning')
              : item.health.level === 'critical'
                ? t('healthCritical')
                : item.health.level === 'offline'
                  ? t('healthOffline')
                  : t('healthPending')
        }`,
        cpu: s?.cpu != null ? `${s.cpu}%` : '--',
        memory: memText,
        disk: s?.diskPercent != null ? `${s.diskPercent}%` : '--',
        iops: formatIops(s?.diskReadIops, s?.diskWriteIops),
        network: netText,
        drops: s?.networkReady ? formatCompactCount((s.netDropsDelta ?? 0) + (s.netErrorsDelta ?? 0)) : '--',
        gpu: s?.gpu != null ? `${s.gpu}%` : '--',
        load: formatLoadAverage(s?.loadAverage),
        uptime: formatUptime(s?.uptimeSeconds, locale),
        latency: formatLatency(item.state?.mode === 'probe' ? item.state?.probe?.rttMs : (s?.latencyMs ?? s?.responseLatencyMs)),
        tags: (item.host.tags ?? []).join(', ') || '--',
        updated: formatRelativeAge(item.state?.updatedAt ?? 0, now, locale),
      };
    });

    if (gridSort) {
      const dir = gridSort.direction === 'asc' ? 1 : -1;
      mapped.sort((a, b) => {
        const av = String((a as Record<string, unknown>)[gridSort.column] ?? '');
        const bv = String((b as Record<string, unknown>)[gridSort.column] ?? '');
        return av.localeCompare(bv, undefined, { numeric: true }) * dir;
      });
    }
    return mapped;
  }, [filtered, gridSort, locale, now, t]);

  const selectedTableItem =
    selectedRowIdx != null && tableRows[selectedRowIdx]
      ? filtered.find((item) => item.host.hostId === tableRows[selectedRowIdx]._hostId) ?? null
      : null;

  const handleToggleCompareHost = (hostId: string) => {
    const current = panel.compareHostIds ?? hosts.slice(0, Math.min(4, hosts.length)).map((h) => h.hostId);
    const exists = current.includes(hostId);
    const next = exists
      ? current.length > 2
        ? current.filter((id) => id !== hostId)
        : current
      : [...current, hostId].slice(0, 6);
    onUpdatePanel({ compareHostIds: next });
  };

  return (
    <div className="nm-main">
      {/* KPI Summary Strip */}
      <div className="nm-kpi-strip">
        <div className="nm-kpi-card">
          <div className="nm-kpi-head">
            <MonitorIcon name="hosts" />
            <span className="nm-kpi-label">{t('summaryTotal')}</span>
          </div>
          <span className="nm-kpi-value nm-mono">{kpis.total}</span>
        </div>
        <div className="nm-kpi-card">
          <div className="nm-kpi-head">
            <MonitorIcon name="online" />
            <span className="nm-kpi-label">{t('summaryOnline')}</span>
          </div>
          <span className="nm-kpi-value nm-mono" style={{ color: 'var(--plugin-ok)' }}>
            {kpis.online}
          </span>
        </div>
        <div className="nm-kpi-card">
          <div className="nm-kpi-head">
            <MonitorIcon name="warnings" />
            <span className="nm-kpi-label">{t('summaryWarnings')}</span>
          </div>
          <span className="nm-kpi-value nm-mono" style={{ color: kpis.warnings > 0 ? 'var(--plugin-warn)' : undefined }}>
            {kpis.warnings}
          </span>
        </div>
        <div className="nm-kpi-card">
          <div className="nm-kpi-head">
            <MonitorIcon name="critical" />
            <span className="nm-kpi-label">{t('summaryCritical')}</span>
          </div>
          <span className="nm-kpi-value nm-mono" style={{ color: kpis.critical > 0 ? 'var(--plugin-crit)' : undefined }}>
            {kpis.critical}
          </span>
        </div>
        <div className="nm-kpi-card">
          <div className="nm-kpi-head">
            <MonitorIcon name="cpu" />
            <span className="nm-kpi-label">{t('summaryAvgCpu')}</span>
          </div>
          <span className="nm-kpi-value nm-mono">{formatPercent(kpis.avgCpu, 1)}</span>
        </div>
        <div className="nm-kpi-card">
          <div className="nm-kpi-head">
            <MonitorIcon name="memory" />
            <span className="nm-kpi-label">{t('summaryAvgMem')}</span>
          </div>
          <span className="nm-kpi-value nm-mono">{formatPercent(kpis.avgMem, 1)}</span>
        </div>
      </div>

      {/* Filter & Controls Toolbar */}
      <div className="nm-toolbar">
        <div className="nm-toolbar-group">
          <input
            type="search"
            className="nm-input nm-search"
            placeholder={t('searchHosts')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="nm-segmented" role="group" aria-label="Filter hosts">
            <button
              type="button"
              className={`nm-seg-btn ${filterMode === 'all' ? 'nm-seg-btn-active' : ''}`}
              onClick={() => setFilterMode('all')}
            >
              {t('allHosts')}
            </button>
            <button
              type="button"
              className={`nm-seg-btn ${filterMode === 'pinned' ? 'nm-seg-btn-active' : ''}`}
              onClick={() => setFilterMode('pinned')}
            >
              {t('pinnedOnly')}
            </button>
            <button
              type="button"
              className={`nm-seg-btn ${filterMode === 'alerts' ? 'nm-seg-btn-active' : ''}`}
              onClick={() => setFilterMode('alerts')}
            >
              {t('alertsOnly')}
            </button>
          </div>
        </div>

        <div className="nm-toolbar-group">
          <div className="nm-segmented" role="group" aria-label="View mode">
            <button
              type="button"
              className={`nm-seg-btn ${panel.view === 'charts' ? 'nm-seg-btn-active' : ''}`}
              onClick={() => onUpdatePanel({ view: 'charts' })}
            >
              {t('viewGrid')}
            </button>
            <button
              type="button"
              className={`nm-seg-btn ${panel.view === 'list' ? 'nm-seg-btn-active' : ''}`}
              onClick={() => onUpdatePanel({ view: 'list' })}
            >
              {t('viewTable')}
            </button>
            <button
              type="button"
              className={`nm-seg-btn ${panel.view === 'wallboard' ? 'nm-seg-btn-active' : ''}`}
              onClick={() => onUpdatePanel({ view: 'wallboard' })}
            >
              {t('viewWallboard')}
            </button>
            <button
              type="button"
              className={`nm-seg-btn ${panel.view === 'compare' ? 'nm-seg-btn-active' : ''}`}
              onClick={() => onUpdatePanel({ view: 'compare' })}
            >
              {t('viewCompare')}
            </button>
          </div>

          <select
            className="nm-select"
            aria-label={t('interval')}
            value={String(panel.interval)}
            onChange={(e) => onUpdatePanel({ interval: Number(e.target.value) as MonitorInterval })}
          >
            {[1, 2, 3, 5, 10, 30, 60].map((sec) => (
              <option key={sec} value={sec}>
                {sec}s
              </option>
            ))}
          </select>

          <select
            className="nm-select"
            aria-label={t('range')}
            value={String(panel.range)}
            onChange={(e) => onUpdatePanel({ range: Number(e.target.value) as MonitorRangeMinutes })}
          >
            {MONITOR_RANGES.map((mins) => (
              <option key={mins} value={mins}>
                {mins === 60 ? '1h' : `${mins}m`}
              </option>
            ))}
          </select>

          <select
            className="nm-select"
            aria-label={t('sortBy')}
            value={panel.sort}
            onChange={(e) => onUpdatePanel({ sort: e.target.value as MonitorPanel['sort'] })}
          >
            <option value="manual">{t('sortManual')}</option>
            <option value="name">{t('sortName')}</option>
            <option value="health">{t('sortHealth')}</option>
            <option value="cpu">{t('sortCpu')}</option>
            <option value="memory">{t('sortMemory')}</option>
          </select>

          {panel.view === 'list' && (
            <>
              <button
                type="button"
                id="nm-cols-trigger"
                className="nm-btn"
                onClick={() => setColsOpen((v) => !v)}
              >
                {t('columns')}
              </button>
              <PluginPopover anchor="nm-cols-trigger" open={colsOpen} onClose={() => setColsOpen(false)}>
                <div className="nm-popover-menu">
                  {OPTIONAL_TABLE_COLUMNS.map((col) => (
                    <label key={col} className="nm-checkbox-row">
                      <input
                        type="checkbox"
                        checked={!hiddenColumns.includes(col)}
                        onChange={() => onToggleColumn(col)}
                      />
                      <span>{col}</span>
                    </label>
                  ))}
                </div>
              </PluginPopover>
            </>
          )}

          <button type="button" className={`nm-btn ${running ? 'nm-btn-active' : 'nm-btn-primary'}`} onClick={onToggleRunning}>
            {running ? t('stopMonitoring') : t('startMonitoring')}
          </button>
          <button type="button" className="nm-btn nm-btn-ghost" onClick={onRefreshNow}>
            {t('refreshNow')}
          </button>
          <button type="button" className="nm-btn nm-btn-ghost" onClick={() => onExportSnapshot('json')}>
            JSON
          </button>
          <button type="button" className="nm-btn nm-btn-ghost" onClick={() => onExportSnapshot('md')}>
            {t('exportMarkdown')}
          </button>
          <button type="button" className="nm-btn nm-btn-primary" onClick={onAddHosts}>
            + {t('addHosts')}
          </button>
        </div>
      </div>

      {/* Empty Panel State */}
      {hosts.length === 0 ? (
        <div className="nm-content">
          <div className="nm-empty">
            <img className="nm-empty-icon" src="asset:assets/plugin-icon-dark.png" alt="Netcatty Monitor" />
            <h2 className="nm-empty-title">{t('emptyPanelTitle')}</h2>
            <p className="nm-empty-body">{t('emptyPanelBody')}</p>
            <button type="button" className="nm-btn nm-btn-primary" onClick={onAddHosts}>
              + {t('selectHosts')}
            </button>
          </div>
        </div>
      ) : panel.view === 'compare' ? (
        <CompareView
          hosts={filtered.map((item) => item.host)}
          selectedHostIds={panel.compareHostIds ?? []}
          runtimeHosts={runtimeHosts}
          interval={panel.interval}
          range={panel.range}
          thresholds={thresholds}
          t={t}
          onToggleCompareHost={handleToggleCompareHost}
          onInspectHost={onInspectHost}
        />
      ) : panel.view === 'wallboard' ? (
        <div className="nm-content">
          <div className="nm-wallboard-grid">
            {filtered.map((item) => {
              const s = item.state?.stats;
              const isProbe = item.state?.mode === 'probe' || item.host.protocol === 'rdp' || item.host.protocol === 'vnc';
              const tileClass =
                item.health.level === 'critical' || item.health.level === 'offline'
                  ? 'nm-wall-tile nm-wall-tile-crit'
                  : item.health.level === 'warning'
                    ? 'nm-wall-tile nm-wall-tile-warn'
                    : item.health.level === 'pending'
                      ? 'nm-wall-tile nm-wall-tile-pending'
                      : 'nm-wall-tile';
              return (
                <button
                  key={item.host.hostId}
                  type="button"
                  className={tileClass}
                  onClick={() => onInspectHost(item.host.hostId)}
                >
                  <div className="nm-wall-head">
                    <div className="nm-wall-title-row">
                      <span
                        className={
                          item.health.level === 'critical' || item.health.level === 'offline'
                            ? 'nm-dot nm-dot-critical'
                            : item.health.level === 'warning'
                              ? 'nm-dot nm-dot-warning'
                              : item.health.level === 'pending'
                                ? 'nm-dot'
                                : 'nm-dot nm-dot-live'
                        }
                      />
                      <span className="nm-wall-name">
                        {item.pinned ? '★ ' : ''}
                        {item.host.label}
                      </span>
                    </div>
                    <span className={statusBadgeClass(item.effectiveStatus)}>{item.health.score}</span>
                  </div>
                  {isProbe ? (
                    <div className="nm-wall-foot nm-mono">
                      <span>{(item.host.protocol ?? 'RDP').toUpperCase()}</span>
                      <span>{formatLatency(item.state?.probe?.rttMs)}</span>
                    </div>
                  ) : (
                    <div className="nm-wall-bars nm-mono">
                      <div className="nm-wall-metric-row">
                        <span>CPU</span>
                        <div className="nm-bar-track">
                          <div
                            className={barTone(s?.cpu, thresholds.cpuWarning, thresholds.cpuCritical)}
                            style={{ width: `${Math.max(0, Math.min(100, s?.cpu ?? 0))}%` }}
                          />
                        </div>
                        <span>{formatPercent(s?.cpu, 0)}</span>
                      </div>
                      <div className="nm-wall-metric-row">
                        <span>MEM</span>
                        <div className="nm-bar-track">
                          <div
                            className={barTone(item.memPct, thresholds.memoryWarning, thresholds.memoryCritical)}
                            style={{ width: `${Math.max(0, Math.min(100, item.memPct ?? 0))}%` }}
                          />
                        </div>
                        <span>{formatPercent(item.memPct, 0)}</span>
                      </div>
                      <div className="nm-wall-metric-row">
                        <span>DSK</span>
                        <div className="nm-bar-track">
                          <div
                            className={barTone(s?.diskPercent, thresholds.diskWarning, thresholds.diskCritical)}
                            style={{ width: `${Math.max(0, Math.min(100, s?.diskPercent ?? 0))}%` }}
                          />
                        </div>
                        <span>{formatPercent(s?.diskPercent, 0)}</span>
                      </div>
                    </div>
                  )}
                  <div className="nm-wall-foot nm-mono">
                    <span>{formatLatency(isProbe ? item.state?.probe?.rttMs : (s?.latencyMs ?? s?.responseLatencyMs))}</span>
                    <span>{s?.gpu != null ? `GPU ${s.gpu}%` : formatUptime(s?.uptimeSeconds, locale)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : panel.view === 'list' ? (
        <div className="nm-content-flush">
          {selectedTableItem && (
            <div className="nm-action-bar">
              <span>
                <strong>{selectedTableItem.host.label}</strong>
                {selectedTableItem.host.hostname ? ` · ${selectedTableItem.host.hostname}` : ''}
              </span>
              <div className="nm-toolbar-group">
                <button
                  type="button"
                  className="nm-btn nm-btn-sm nm-btn-primary"
                  onClick={() => onInspectHost(selectedTableItem.host.hostId)}
                >
                  {t('inspectHost')}
                </button>
                {selectedTableItem.state?.mode === 'probe' ? (
                  <button
                    type="button"
                    className="nm-btn nm-btn-sm"
                    onClick={() => onOpenSession(selectedTableItem.host, 'remoteDesktop')}
                  >
                    {t('openRemoteDesktop')}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="nm-btn nm-btn-sm"
                      onClick={() => onOpenSession(selectedTableItem.host, 'terminal')}
                    >
                      {t('openTerminal')}
                    </button>
                    <button
                      type="button"
                      className="nm-btn nm-btn-sm"
                      onClick={() => onOpenSession(selectedTableItem.host, 'sftp')}
                    >
                      {t('openSftp')}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="nm-btn nm-btn-sm"
                  onClick={() => onTogglePin(selectedTableItem.host.hostId)}
                >
                  {selectedTableItem.pinned ? t('unpinHost') : t('pinHost')}
                </button>
                <button
                  type="button"
                  className="nm-btn nm-btn-sm nm-btn-danger"
                  onClick={() => onRemoveHost(selectedTableItem.host.hostId)}
                >
                  {t('removeHost')}
                </button>
              </div>
            </div>
          )}
          <div className="nm-grid-wrap">
            <PluginDataGrid
              columns={tableColumns}
              rows={tableRows}
              hiddenColumns={[...hiddenColumns]}
              sort={gridSort}
              onSortChange={setGridSort}
              onCellSelect={({ rowIndex }) => setSelectedRowIdx(rowIndex)}
              onCellDoubleClick={({ rowIndex }) => {
                const row = tableRows[rowIndex];
                if (row?._hostId) onInspectHost(row._hostId);
              }}
              emptyMessage={t('emptyPanelBody')}
            />
          </div>
        </div>
      ) : (
        <div className="nm-content">
          <div className="nm-card-grid">
            {filtered.map((item, idx) => {
              const s = item.state?.stats;
              const points = item.state?.points ?? [];
              const cardClass =
                item.health.level === 'critical' || item.health.level === 'offline'
                  ? 'nm-host-card nm-host-card-critical'
                  : item.health.level === 'warning'
                    ? 'nm-host-card nm-host-card-warning'
                    : item.health.level === 'pending'
                      ? 'nm-host-card nm-host-card-pending'
                      : 'nm-host-card';
              const dotClass =
                item.effectiveStatus === 'live'
                  ? item.health.level === 'critical'
                    ? 'nm-dot nm-dot-critical'
                    : item.health.level === 'warning'
                      ? 'nm-dot nm-dot-warning'
                      : 'nm-dot nm-dot-live'
                  : item.effectiveStatus === 'connecting'
                    ? 'nm-dot nm-dot-connecting'
                    : 'nm-dot nm-dot-critical';
              return (
                <article key={item.host.hostId} className={cardClass}>
                  <div className="nm-card-head">
                    <div className="nm-card-title-wrap">
                      <div className="nm-card-title-row">
                        <span className={dotClass} />
                        <button
                          type="button"
                          className="nm-card-title"
                          onClick={() => onInspectHost(item.host.hostId)}
                        >
                          {item.pinned ? '★ ' : ''}
                          {item.host.label}
                        </button>
                      </div>
                      <div className="nm-card-sub nm-mono">
                        {item.host.hostname || s?.hostname || item.host.hostId}
                        {s?.osName ? ` · ${s.osName}` : ''}
                      </div>
                    </div>
                    <div className="nm-card-actions">
                      {s?.gpu != null && <span className="nm-badge nm-badge-info nm-mono">GPU {s.gpu}%</span>}
                      {s?.rebootRequired && <span className="nm-badge nm-badge-warn">{t('rebootPending')}</span>}
                      {item.health.level === 'warning' || item.health.level === 'critical' ? (
                        <span
                          className={`nm-badge nm-mono ${item.health.level === 'critical' ? 'nm-badge-crit' : 'nm-badge-warn'}`}
                        >
                          {item.health.score}/100
                        </span>
                      ) : (
                        <span className={statusBadgeClass(item.effectiveStatus)}>
                          {statusLabel(item.effectiveStatus, t)}
                        </span>
                      )}
                      <button
                        type="button"
                        className="nm-btn nm-btn-sm nm-btn-ghost"
                        title={item.pinned ? t('unpinHost') : t('pinHost')}
                        onClick={() => onTogglePin(item.host.hostId)}
                      >
                        {item.pinned ? '★' : '☆'}
                      </button>
                    </div>
                  </div>

                  {item.state?.error && item.effectiveStatus !== 'live' && (
                    <div className="nm-card-sub" style={{ color: 'var(--plugin-crit)' }}>
                      {item.state.error}
                    </div>
                  )}

                  {/* Core Metric Sparklines + Progress Bars (or RDP/VNC Reachability Probe) */}
                  {item.state?.mode === 'probe' || item.host.protocol === 'rdp' || item.host.protocol === 'vnc' ? (
                    <div className="nm-mini-metric">
                      <div className="nm-mini-head">
                        <span>
                          {(item.state?.probe?.protocol ?? item.host.protocol ?? 'RDP').toUpperCase()} :
                          {item.state?.probe?.port ?? item.host.port ?? (item.host.protocol === 'vnc' ? 5900 : 3389)}
                          {item.state?.probe?.bannerVerified ? ` · ${t('probeBannerVerified')}` : ''}
                        </span>
                        <span className="nm-mini-val nm-mono">
                          {formatLatency(item.state?.probe?.rttMs)}
                        </span>
                      </div>
                      <PluginMetricChart
                        variant="sparkline"
                        height={44}
                        rangeMs={rangeMs}
                        intervalMs={Math.max(intervalMs, 5_000)}
                        endAt={now}
                        min={0}
                        max="auto"
                        interactive={false}
                        series={[
                          {
                            id: 'latency',
                            label: t('metricLatency'),
                            color: item.effectiveStatus === 'live' ? 'sky' : 'rose',
                            unit: 'ms',
                            points: points.map((p) => ({ at: p.at, value: p.latencyMs })),
                          },
                        ]}
                      />
                    </div>
                  ) : (
                    <div className="nm-card-metrics">
                      <div className="nm-mini-metric">
                        <div className="nm-mini-head">
                          <span>
                            {t('metricCpu')}
                            {s?.cpuIowait != null && s.cpuIowait >= 5 ? ` · io ${s.cpuIowait.toFixed(0)}%` : ''}
                          </span>
                          <span
                            className={`nm-mini-val nm-mono ${(s?.cpu ?? 0) >= thresholds.cpuCritical ? 'nm-val-crit' : (s?.cpu ?? 0) >= thresholds.cpuWarning ? 'nm-val-warn' : ''}`}
                          >
                            {formatPercent(s?.cpu, 0)}
                          </span>
                        </div>
                        <PluginMetricChart
                          variant="sparkline"
                          height={30}
                          rangeMs={rangeMs}
                          intervalMs={intervalMs}
                          endAt={now}
                          min={0}
                          max={100}
                          interactive={false}
                          series={[
                            {
                              id: 'cpu',
                              label: 'CPU',
                              color: (s?.cpu ?? 0) >= thresholds.cpuCritical ? 'rose' : (s?.cpu ?? 0) >= thresholds.cpuWarning ? 'amber' : 'emerald',
                              unit: '%',
                              points: points.map((p) => ({ at: p.at, value: p.cpu })),
                            },
                          ]}
                        />
                      </div>

                      <div className="nm-mini-metric">
                        <div className="nm-mini-head">
                          <span>{t('metricMemory')}</span>
                          <span
                            className={`nm-mini-val nm-mono ${(item.memPct ?? 0) >= thresholds.memoryCritical ? 'nm-val-crit' : (item.memPct ?? 0) >= thresholds.memoryWarning ? 'nm-val-warn' : ''}`}
                          >
                            {formatPercent(item.memPct, 0)}
                          </span>
                        </div>
                        <PluginMetricChart
                          variant="sparkline"
                          height={30}
                          rangeMs={rangeMs}
                          intervalMs={intervalMs}
                          endAt={now}
                          min={0}
                          max={100}
                          interactive={false}
                          series={[
                            {
                              id: 'mem',
                              label: 'Memory',
                              color: (item.memPct ?? 0) >= thresholds.memoryCritical ? 'rose' : (item.memPct ?? 0) >= thresholds.memoryWarning ? 'amber' : 'sky',
                              unit: '%',
                              points: points.map((p) => ({ at: p.at, value: p.memory })),
                            },
                          ]}
                        />
                      </div>

                      <div className="nm-mini-metric">
                        <div className="nm-mini-head">
                          <span>
                            {t('metricDisk')}
                            {s?.diskReadIops != null ? ` · ${formatCompactCount((s.diskReadIops ?? 0) + (s.diskWriteIops ?? 0))} IOPS` : ''}
                          </span>
                          <span
                            className={`nm-mini-val nm-mono ${(s?.diskPercent ?? 0) >= thresholds.diskCritical ? 'nm-val-crit' : (s?.diskPercent ?? 0) >= thresholds.diskWarning ? 'nm-val-warn' : ''}`}
                          >
                            {formatPercent(s?.diskPercent, 0)}
                          </span>
                        </div>
                        <div className="nm-bar-track">
                          <div
                            className={barTone(s?.diskPercent, thresholds.diskWarning, thresholds.diskCritical)}
                            style={{ width: `${Math.max(0, Math.min(100, s?.diskPercent ?? 0))}%` }}
                          />
                        </div>
                      </div>

                      <div className="nm-mini-metric">
                        <div className="nm-mini-head">
                          <span>{t('metricNetwork')}</span>
                          <span className="nm-mini-val nm-mono">
                            {s?.networkReady ? formatMonitorRate(s.netRxSpeed + s.netTxSpeed) : '--'}
                          </span>
                        </div>
                        <div className="nm-card-sub nm-mono">
                          ↓{s?.networkReady ? formatMonitorRate(s.netRxSpeed) : '--'} · ↑{s?.networkReady ? formatMonitorRate(s.netTxSpeed) : '--'}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Compact Single-Line Telemetry Summary */}
                  <div className="nm-card-meta-line nm-mono">
                    {item.state?.mode === 'probe' || item.host.protocol === 'rdp' || item.host.protocol === 'vnc'
                      ? `${item.state?.probe?.reachable ? t('probeReachable') : t('probeUnreachable')} · ${formatLatency(item.state?.probe?.rttMs)}`
                      : `${t('metricLoad')} ${formatLoadAverage(s?.loadAverage)} · ${formatLatency(s?.latencyMs ?? s?.responseLatencyMs)} · ${formatUptime(s?.uptimeSeconds, locale)}`}
                  </div>

                  {/* Card Footer & Quiet Quick Actions */}
                  <div className="nm-card-footer">
                    <div className="nm-card-actions">
                      {panel.sort === 'manual' && (
                        <>
                          <button
                            type="button"
                            className="nm-btn nm-btn-sm nm-btn-ghost"
                            disabled={idx === 0}
                            title={t('moveUp')}
                            onClick={() => onReorderHost(item.host.hostId, 'up')}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="nm-btn nm-btn-sm nm-btn-ghost"
                            disabled={idx === filtered.length - 1}
                            title={t('moveDown')}
                            onClick={() => onReorderHost(item.host.hostId, 'down')}
                          >
                            ↓
                          </button>
                        </>
                      )}
                    </div>
                    <div className="nm-card-actions">
                      {(item.effectiveStatus === 'error' || item.effectiveStatus === 'login' || item.effectiveStatus === 'offline') && (
                        <button
                          type="button"
                          className="nm-btn nm-btn-sm nm-btn-ghost"
                          onClick={() => onRetryHost(item.host.hostId)}
                        >
                          {t('retryHost')}
                        </button>
                      )}
                      {item.state?.mode === 'probe' || item.host.protocol === 'rdp' || item.host.protocol === 'vnc' ? (
                        <button
                          type="button"
                          className="nm-btn nm-btn-sm nm-btn-ghost"
                          onClick={() => onOpenSession(item.host, 'remoteDesktop')}
                        >
                          {t('openRemoteDesktop')}
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="nm-btn nm-btn-sm nm-btn-ghost"
                            onClick={() => onOpenSession(item.host, 'terminal')}
                          >
                            {t('openTerminal')}
                          </button>
                          <button
                            type="button"
                            className="nm-btn nm-btn-sm nm-btn-ghost"
                            onClick={() => onOpenSession(item.host, 'sftp')}
                          >
                            {t('openSftp')}
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="nm-btn nm-btn-sm"
                        onClick={() => onInspectHost(item.host.hostId)}
                      >
                        {t('inspectHost')}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
