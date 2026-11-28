import React, { useMemo, useState } from 'react';
import { PluginMetricChart } from '@netcatty/plugin-sdk/host-react';
import { buildMonitorDiskListLayout } from '../../domain/disks';
import {
  formatCompactCount,
  formatDiskGiB,
  formatIops,
  formatLatency,
  formatLoadAverage,
  formatMemoryMiB,
  formatMemoryPercent,
  formatMonitorRate,
  formatPercent,
  formatUptime,
} from '../../domain/formatting';
import type { I18nKey, MonitorLocale } from '../../domain/i18n';
import { ALL_OVERVIEW_WIDGETS } from '../../domain/panels';
import type {
  AlertThresholds,
  HostRuntimeState,
  MonitorHostRef,
  MonitorInterval,
  MonitorRangeMinutes,
  OverviewWidgetKey,
} from '../../domain/types';

export interface OverviewTabProps {
  host: MonitorHostRef;
  state: HostRuntimeState | undefined;
  interval: MonitorInterval;
  range: MonitorRangeMinutes;
  thresholds: AlertThresholds;
  visibleWidgets?: readonly OverviewWidgetKey[];
  locale: MonitorLocale;
  t: (key: I18nKey) => string;
}

function coreHeatmapClass(val: number, warn: number, crit: number): string {
  if (val >= crit) return 'nm-core-cell nm-core-cell-crit';
  if (val >= warn) return 'nm-core-cell nm-core-cell-warn';
  if (val >= 40) return 'nm-core-cell nm-core-cell-mid';
  return 'nm-core-cell nm-core-cell-cool';
}

export function OverviewTab({
  host,
  state,
  interval,
  range,
  thresholds,
  visibleWidgets = ALL_OVERVIEW_WIDGETS,
  locale,
  t,
}: OverviewTabProps) {
  const [showSystemDisks, setShowSystemDisks] = useState(false);
  const stats = state?.stats;
  const points = state?.points ?? [];
  const now = Date.now();
  const rangeMs = range * 60_000;
  const intervalMs = interval * 1_000;
  const isProbe = state?.mode === 'probe' || host.protocol === 'rdp' || host.protocol === 'vnc';
  const show = (key: OverviewWidgetKey) => visibleWidgets.includes(key);

  const rttSummary = useMemo(() => {
    const values = points
      .map((p) => p.latencyMs)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
    if (values.length === 0) return null;
    const min = Math.round(Math.min(...values));
    const max = Math.round(Math.max(...values));
    const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    return { min, avg, max };
  }, [points]);

  if (isProbe) {
    const probe = state?.probe;
    return (
      <div className="nm-content">
        <div className="nm-chart-grid">
          <section className="nm-panel-card">
            <div className="nm-panel-card-head">
              <div>
                <h3 className="nm-panel-card-title">{t('probeLatencyTrend')}</h3>
                <span className="nm-panel-card-sub nm-mono">
                  {(probe?.protocol ?? host.protocol ?? 'rdp').toUpperCase()} :
                  {probe?.port ?? host.port ?? (host.protocol === 'vnc' ? 5900 : 3389)}
                  {probe?.bannerVerified ? ` · ${t('probeBannerVerified')}` : ''}
                  {probe?.bannerDetail ? ` (${probe.bannerDetail})` : ''}
                </span>
              </div>
              <span className={`nm-badge ${probe?.reachable ? 'nm-badge-ok' : 'nm-badge-crit'}`}>
                {probe?.reachable ? t('probeReachable') : t('probeUnreachable')} · {formatLatency(probe?.rttMs)}
              </span>
            </div>
            <PluginMetricChart
              variant="area"
              height={170}
              rangeMs={rangeMs}
              intervalMs={Math.max(intervalMs, 5_000)}
              endAt={now}
              min={0}
              max="auto"
              showGrid
              showAxes
              interactive
              ariaLabel={t('probeLatencyTrend')}
              thresholds={[
                { value: thresholds.latencyWarningMs, tone: 'warning', label: `${thresholds.latencyWarningMs}ms` },
                { value: thresholds.latencyCriticalMs, tone: 'critical', label: `${thresholds.latencyCriticalMs}ms` },
              ]}
              series={[
                {
                  id: 'rtt',
                  label: t('metricLatency'),
                  color: 'sky',
                  unit: 'ms',
                  points: points.map((p) => ({ at: p.at, value: p.latencyMs })),
                },
              ]}
            />
            {rttSummary && (
              <div className="nm-panel-card-sub nm-mono">
                {t('probeRttStats')}: {rttSummary.min} ms / {rttSummary.avg} ms / {rttSummary.max} ms
              </div>
            )}
          </section>

          <section className="nm-panel-card">
            <h3 className="nm-panel-card-title">{t('hostMetadata')}</h3>
            <div className="nm-meta-grid">
              <div className="nm-meta-item">
                <span className="nm-meta-label">{t('metaAddress')}</span>
                <span className="nm-meta-val nm-mono">
                  {host.hostname || '--'}:{probe?.port ?? host.port ?? (host.protocol === 'vnc' ? 5900 : 3389)}
                </span>
              </div>
              <div className="nm-meta-item">
                <span className="nm-meta-label">{t('metaOs')}</span>
                <span className="nm-meta-val">{host.os || (probe?.protocol ?? host.protocol ?? 'RDP').toUpperCase()}</span>
              </div>
              {host.group && (
                <div className="nm-meta-item">
                  <span className="nm-meta-label">{t('metaGroup')}</span>
                  <span className="nm-meta-val">{host.group}</span>
                </div>
              )}
              {host.tags && host.tags.length > 0 && (
                <div className="nm-meta-item">
                  <span className="nm-meta-label">{t('metaTags')}</span>
                  <div className="nm-badges-row">
                    {host.tags.map((tag) => (
                      <span key={tag} className="nm-badge">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {host.notes && (
              <div className="nm-meta-item" style={{ marginTop: 4 }}>
                <span className="nm-meta-label">{t('metaNotes')}</span>
                <span className="nm-panel-card-sub">{host.notes}</span>
              </div>
            )}
          </section>
        </div>
      </div>
    );
  }

  const memPct = formatMemoryPercent(stats?.memUsed, stats?.memTotal);
  const swapPct = formatMemoryPercent(stats?.swapUsed, stats?.swapTotal);
  const fdPct =
    stats?.fdUsed != null && stats?.fdMax != null && stats.fdMax > 0
      ? Math.min(100, (stats.fdUsed / stats.fdMax) * 100)
      : null;

  const diskLayout = useMemo(
    () => buildMonitorDiskListLayout(stats, showSystemDisks, thresholds.diskWarning),
    [stats, showSystemDisks, thresholds.diskWarning],
  );

  const hasCpuBreakdown = points.some((p) => p.cpuUser != null || p.cpuSystem != null);

  return (
    <div className="nm-content">
      {/* 4 Primary Real-Time Multi-Series Charts */}
      <div className="nm-chart-grid">
        {/* CPU Deep Breakdown Chart */}
        {show('cpuBreakdown') && (
          <section className="nm-panel-card">
            <div className="nm-panel-card-head">
              <div>
                <h3 className="nm-panel-card-title">{t('metricCpu')}</h3>
                <span className="nm-panel-card-sub nm-mono">
                  {stats?.cpuCores ? `${stats.cpuCores}c` : '--'}
                  {stats?.cpuUser != null ? ` · ${t('cpuUser')} ${stats.cpuUser}%` : ''}
                  {stats?.cpuSystem != null ? ` · ${t('cpuSystem')} ${stats.cpuSystem}%` : ''}
                  {stats?.cpuIowait != null ? ` · ${t('cpuIowait')} ${stats.cpuIowait}%` : ''}
                  {stats?.cpuSteal != null ? ` · ${t('cpuSteal')} ${stats.cpuSteal}%` : ''}
                </span>
              </div>
              <span className="nm-kpi-value nm-mono">{formatPercent(stats?.cpu, 1)}</span>
            </div>
            <PluginMetricChart
              variant={hasCpuBreakdown ? 'line' : 'area'}
              height={152}
              rangeMs={rangeMs}
              intervalMs={intervalMs}
              endAt={now}
              min={0}
              max={100}
              showGrid
              showAxes
              showLegend={hasCpuBreakdown}
              interactive
              ariaLabel={t('metricCpu')}
              thresholds={[
                { value: thresholds.cpuWarning, tone: 'warning', label: `${thresholds.cpuWarning}%` },
                { value: thresholds.cpuCritical, tone: 'critical', label: `${thresholds.cpuCritical}%` },
              ]}
              series={
                hasCpuBreakdown
                  ? [
                      {
                        id: 'cpu',
                        label: t('metricCpu'),
                        color: 'emerald',
                        unit: '%',
                        points: points.map((p) => ({ at: p.at, value: p.cpu })),
                      },
                      {
                        id: 'user',
                        label: t('cpuUser'),
                        color: 'sky',
                        unit: '%',
                        points: points.map((p) => ({ at: p.at, value: p.cpuUser ?? null })),
                      },
                      {
                        id: 'sys',
                        label: t('cpuSystem'),
                        color: 'violet',
                        unit: '%',
                        points: points.map((p) => ({ at: p.at, value: p.cpuSystem ?? null })),
                      },
                      {
                        id: 'iowait',
                        label: t('cpuIowait'),
                        color: 'amber',
                        unit: '%',
                        points: points.map((p) => ({ at: p.at, value: p.cpuIowait ?? null })),
                      },
                      {
                        id: 'steal',
                        label: t('cpuSteal'),
                        color: 'rose',
                        unit: '%',
                        points: points.map((p) => ({ at: p.at, value: p.cpuSteal ?? null })),
                      },
                    ]
                  : [
                      {
                        id: 'cpu',
                        label: t('metricCpu'),
                        color: 'emerald',
                        unit: '%',
                        points: points.map((p) => ({ at: p.at, value: p.cpu })),
                      },
                    ]
              }
            />
            {(stats?.contextSwitchesPerSec != null || stats?.procsRunning != null) && (
              <div className="nm-micro-grid nm-mono">
                <div className="nm-micro-pill">
                  <span className="nm-micro-label">{t('cpuCtxt')}</span>
                  <span className="nm-micro-val">{formatCompactCount(stats?.contextSwitchesPerSec)}</span>
                </div>
                <div className="nm-micro-pill">
                  <span className="nm-micro-label">{t('cpuIntr')}</span>
                  <span className="nm-micro-val">{formatCompactCount(stats?.interruptsPerSec)}</span>
                </div>
                <div className="nm-micro-pill">
                  <span className="nm-micro-label">{t('cpuProcs')}</span>
                  <span className="nm-micro-val">
                    {stats?.procsRunning ?? '--'} / {stats?.procsBlocked ?? '--'}
                  </span>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Memory, Swap & Linux PSI */}
        {show('memoryPsi') && (
          <section className="nm-panel-card">
            <div className="nm-panel-card-head">
              <div>
                <h3 className="nm-panel-card-title">{t('metricMemory')}</h3>
                <span className="nm-panel-card-sub nm-mono">
                  {formatMemoryMiB(stats?.memUsed)} / {formatMemoryMiB(stats?.memTotal)}
                  {stats?.memCached != null ? ` · ${t('memCached')} ${formatMemoryMiB(stats.memCached)}` : ''}
                  {stats?.memSlab != null ? ` · ${t('memSlab')} ${formatMemoryMiB(stats.memSlab)}` : ''}
                </span>
              </div>
              <span className="nm-kpi-value nm-mono">{formatPercent(memPct, 1)}</span>
            </div>
            <PluginMetricChart
              variant="area"
              height={152}
              rangeMs={rangeMs}
              intervalMs={intervalMs}
              endAt={now}
              min={0}
              max={100}
              showGrid
              showAxes
              showLegend={Boolean(stats?.swapTotal)}
              interactive
              ariaLabel={t('metricMemory')}
              thresholds={[
                { value: thresholds.memoryWarning, tone: 'warning', label: `${thresholds.memoryWarning}%` },
                { value: thresholds.memoryCritical, tone: 'critical', label: `${thresholds.memoryCritical}%` },
              ]}
              series={[
                {
                  id: 'memory',
                  label: t('metricMemory'),
                  color: 'sky',
                  unit: '%',
                  points: points.map((p) => ({ at: p.at, value: p.memory })),
                },
                ...(stats?.swapTotal
                  ? [
                      {
                        id: 'swap',
                        label: `${t('metricSwap')} (${formatPercent(swapPct, 0)})`,
                        color: 'amber' as const,
                        unit: '%' as const,
                        points: points.map((p) => ({ at: p.at, value: p.swap ?? null })),
                      },
                    ]
                  : []),
              ]}
            />
            {stats?.psi && (
              <div className="nm-micro-grid nm-mono">
                <div className="nm-micro-pill">
                  <span className="nm-micro-label">{t('psiCpu')}</span>
                  <span className="nm-micro-val">
                    {stats.psi.cpuSome10?.toFixed(1) ?? '--'}% / {stats.psi.cpuSome60?.toFixed(1) ?? '--'}%
                  </span>
                </div>
                <div className="nm-micro-pill">
                  <span className="nm-micro-label">{t('psiMem')}</span>
                  <span className="nm-micro-val">
                    {stats.psi.memSome10?.toFixed(1) ?? '--'}% / {stats.psi.memFull10?.toFixed(1) ?? '--'}%
                  </span>
                </div>
                <div className="nm-micro-pill">
                  <span className="nm-micro-label">{t('psiIo')}</span>
                  <span className="nm-micro-val">
                    {stats.psi.ioSome10?.toFixed(1) ?? '--'}% / {stats.psi.ioFull10?.toFixed(1) ?? '--'}%
                  </span>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Network RX/TX & TCP Stack */}
        {show('networkTcp') && (
          <section className="nm-panel-card">
            <div className="nm-panel-card-head">
              <div>
                <h3 className="nm-panel-card-title">{t('metricNetwork')}</h3>
                <span className="nm-panel-card-sub nm-mono">
                  {t('netRx')} {stats?.networkReady ? formatMonitorRate(stats.netRxSpeed) : '--'} ·{' '}
                  {t('netTx')} {stats?.networkReady ? formatMonitorRate(stats.netTxSpeed) : '--'}
                </span>
              </div>
              <span className="nm-badge nm-badge-info nm-mono">
                {formatLatency(stats?.latencyMs ?? stats?.responseLatencyMs)}
              </span>
            </div>
            <PluginMetricChart
              variant="line"
              height={152}
              rangeMs={rangeMs}
              intervalMs={intervalMs}
              endAt={now}
              min={0}
              max="auto"
              showGrid
              showAxes
              showLegend
              interactive
              ariaLabel={t('metricNetwork')}
              series={[
                {
                  id: 'rx',
                  label: t('netRx'),
                  color: 'cyan',
                  unit: 'bytes/s',
                  points: points.map((p) => ({ at: p.at, value: p.rx })),
                },
                {
                  id: 'tx',
                  label: t('netTx'),
                  color: 'violet',
                  unit: 'bytes/s',
                  points: points.map((p) => ({ at: p.at, value: p.tx })),
                },
              ]}
            />
            {stats?.networkReady && (
              <div className="nm-micro-grid nm-mono">
                <div className="nm-micro-pill">
                  <span className="nm-micro-label">{t('netPps')}</span>
                  <span className="nm-micro-val">
                    ↓{formatCompactCount(stats.netRxPps)} ↑{formatCompactCount(stats.netTxPps)}/s
                  </span>
                </div>
                <div className="nm-micro-pill">
                  <span className="nm-micro-label">{t('netDrops')}</span>
                  <span
                    className="nm-micro-val"
                    style={{
                      color:
                        (stats.netDropsDelta ?? 0) + (stats.netErrorsDelta ?? 0) > 0
                          ? 'var(--plugin-warn)'
                          : undefined,
                    }}
                  >
                    {stats.netDropsDelta ?? 0} / {stats.netErrorsDelta ?? 0}
                  </span>
                </div>
                <div className="nm-micro-pill">
                  <span className="nm-micro-label">{t('tcpRetrans')}</span>
                  <span className="nm-micro-val">
                    {stats.tcpRetransmitsPerSec != null ? `${stats.tcpRetransmitsPerSec}/s` : '--'}
                  </span>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Disk I/O, IOPS, %Util & Queue Depth */}
        {show('diskIoMounts') && (
          <section className="nm-panel-card">
            <div className="nm-panel-card-head">
              <div>
                <h3 className="nm-panel-card-title">{t('metricDiskIo')}</h3>
                <span className="nm-panel-card-sub nm-mono">
                  {t('diskRead')} {formatMonitorRate(stats?.diskReadSpeed)} ·{' '}
                  {t('diskWrite')} {formatMonitorRate(stats?.diskWriteSpeed)}
                </span>
              </div>
              <span className="nm-badge nm-mono">{formatPercent(stats?.diskPercent, 0)} /</span>
            </div>
            <PluginMetricChart
              variant="line"
              height={152}
              rangeMs={rangeMs}
              intervalMs={intervalMs}
              endAt={now}
              min={0}
              max="auto"
              showGrid
              showAxes
              showLegend
              interactive
              ariaLabel={t('metricDiskIo')}
              series={[
                {
                  id: 'diskRead',
                  label: t('diskRead'),
                  color: 'emerald',
                  unit: 'bytes/s',
                  points: points.map((p) => ({ at: p.at, value: p.diskRead })),
                },
                {
                  id: 'diskWrite',
                  label: t('diskWrite'),
                  color: 'amber',
                  unit: 'bytes/s',
                  points: points.map((p) => ({ at: p.at, value: p.diskWrite })),
                },
              ]}
            />
            {(stats?.diskReadIops != null || stats?.diskUtilPercent != null) && (
              <div className="nm-micro-grid nm-mono">
                <div className="nm-micro-pill">
                  <span className="nm-micro-label">{t('diskIops')}</span>
                  <span className="nm-micro-val">{formatIops(stats?.diskReadIops, stats?.diskWriteIops)}</span>
                </div>
                <div className="nm-micro-pill">
                  <span className="nm-micro-label">{t('diskUtil')}</span>
                  <span className="nm-micro-val">
                    {formatPercent(stats?.diskUtilPercent, 0)} · Q={stats?.diskQueueDepth ?? 0}
                  </span>
                </div>
              </div>
            )}
          </section>
        )}
      </div>

      {/* Per-Core CPU Heatmap Matrix */}
      {show('perCore') && stats && stats.cpuPerCore.length > 0 && (
        <section className="nm-panel-card" style={{ marginBottom: 14 }}>
          <div className="nm-panel-card-head">
            <h3 className="nm-panel-card-title">{t('cpuPerCore')}</h3>
            <span className="nm-panel-card-sub nm-mono">
              {t('metricLoad')}: {formatLoadAverage(stats.loadAverage)}
            </span>
          </div>
          <div className="nm-core-grid">
            {stats.cpuPerCore.map((val, i) => (
              <div key={i} className={coreHeatmapClass(val, thresholds.cpuWarning, thresholds.cpuCritical)}>
                <div className="nm-core-top nm-mono">
                  <span>C{i}</span>
                  <strong>{val}%</strong>
                </div>
                <div className="nm-bar-track">
                  <div
                    className={
                      val >= thresholds.cpuCritical
                        ? 'nm-bar-fill nm-bar-crit'
                        : val >= thresholds.cpuWarning
                          ? 'nm-bar-fill nm-bar-warn'
                          : 'nm-bar-fill nm-bar-ok'
                    }
                    style={{ width: `${Math.max(0, Math.min(100, val))}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Disk Mounts + Inodes | System Security + GPU & Thermals */}
      <div className="nm-two-col">
        {show('diskIoMounts') && (
          <section className="nm-panel-card">
            <div className="nm-panel-card-head">
              <h3 className="nm-panel-card-title">{t('diskMounts')}</h3>
              <span className="nm-panel-card-sub nm-mono">{stats?.disks.length ?? 0} mounts</span>
            </div>
            <div className="nm-disk-list">
              {diskLayout.rows.map((row, idx) => {
                if (row.kind === 'system') {
                  return (
                    <button
                      key={`sys-${idx}`}
                      type="button"
                      className="nm-btn"
                      style={{ justifyContent: 'space-between', width: '100%' }}
                      disabled={diskLayout.forcedExpanded}
                      onClick={() => setShowSystemDisks((v) => !v)}
                    >
                      <span>
                        {t('systemDisks')} ({row.count}) {row.alert ? '!' : ''}
                      </span>
                      <span>{row.expanded ? t('hideSystemDisks') : t('showSystemDisks')}</span>
                    </button>
                  );
                }
                const pct = row.disk.percent ?? 0;
                return (
                  <div key={row.disk.mountPoint} className={`nm-disk-row ${row.alert ? 'nm-disk-row-alert' : ''}`}>
                    <div className="nm-disk-head">
                      <span className="nm-disk-mount nm-mono">{row.disk.mountPoint}</span>
                      <span className="nm-mono">
                        {formatDiskGiB(row.disk.used)} / {formatDiskGiB(row.disk.total)} ({formatPercent(row.disk.percent, 0)})
                      </span>
                    </div>
                    <div className="nm-bar-track">
                      <div
                        className={
                          pct >= thresholds.diskCritical
                            ? 'nm-bar-fill nm-bar-crit'
                            : pct >= thresholds.diskWarning
                              ? 'nm-bar-fill nm-bar-warn'
                              : 'nm-bar-fill nm-bar-sky'
                        }
                        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                      />
                    </div>
                    {(row.disk.filesystemType || row.disk.diskReadSpeed != null || row.disk.inodePercent != null) && (
                      <div className="nm-disk-meta nm-mono">
                        {row.disk.filesystemType && <span>{row.disk.filesystemType}</span>}
                        {row.disk.inodePercent != null && (
                          <span
                            style={{
                              color:
                                row.disk.inodePercent >= thresholds.inodeCritical
                                  ? 'var(--plugin-crit)'
                                  : row.disk.inodePercent >= thresholds.inodeWarning
                                    ? 'var(--plugin-warn)'
                                    : undefined,
                            }}
                          >
                            {t('inodesLabel')}: {row.disk.inodePercent}%
                          </span>
                        )}
                        {row.disk.diskReadSpeed != null && (
                          <span>
                            R: {formatMonitorRate(row.disk.diskReadSpeed)} · W: {formatMonitorRate(row.disk.diskWriteSpeed)}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {show('systemSecurity') && (
            <section className="nm-panel-card">
              <div className="nm-panel-card-head">
                <h3 className="nm-panel-card-title">{t('hostMetadata')}</h3>
                {stats?.activeUsers != null && (
                  <span className="nm-badge nm-mono">
                    {t('activeUsersLabel')}: {stats.activeUsers}
                  </span>
                )}
              </div>
              <div className="nm-meta-grid">
                <div className="nm-meta-item">
                  <span className="nm-meta-label">{t('metaHostname')}</span>
                  <span className="nm-meta-val nm-mono">{stats?.hostname || host.hostname || '--'}</span>
                </div>
                <div className="nm-meta-item">
                  <span className="nm-meta-label">{t('metaAddress')}</span>
                  <span className="nm-meta-val nm-mono">
                    {host.username ? `${host.username}@` : ''}
                    {host.hostname || '--'}
                    {host.port ? `:${host.port}` : ''}
                  </span>
                </div>
                <div className="nm-meta-item">
                  <span className="nm-meta-label">{t('metaOs')}</span>
                  <span className="nm-meta-val">{stats?.osName || host.os || '--'}</span>
                </div>
                <div className="nm-meta-item">
                  <span className="nm-meta-label">{t('metaKernel')}</span>
                  <span className="nm-meta-val nm-mono">{stats?.kernelRelease || '--'}</span>
                </div>
                <div className="nm-meta-item">
                  <span className="nm-meta-label">{t('metricUptime')}</span>
                  <span className="nm-meta-val nm-mono">{formatUptime(stats?.uptimeSeconds, locale)}</span>
                </div>
                <div className="nm-meta-item">
                  <span className="nm-meta-label">{t('metricLoad')}</span>
                  <span className="nm-meta-val nm-mono">{formatLoadAverage(stats?.loadAverage)}</span>
                </div>
              </div>
              {stats?.fdUsed != null && stats?.fdMax != null && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div className="nm-disk-head nm-mono">
                    <span className="nm-meta-label">{t('openFds')}</span>
                    <span>
                      {formatCompactCount(stats.fdUsed)} / {formatCompactCount(stats.fdMax)} ({formatPercent(fdPct, 1)})
                    </span>
                  </div>
                  <div className="nm-bar-track">
                    <div
                      className={(fdPct ?? 0) >= 80 ? 'nm-bar-fill nm-bar-warn' : 'nm-bar-fill nm-bar-sky'}
                      style={{ width: `${Math.max(1, Math.min(100, fdPct ?? 0))}%` }}
                    />
                  </div>
                </div>
              )}
              {host.notes && (
                <div className="nm-meta-item">
                  <span className="nm-meta-label">{t('metaNotes')}</span>
                  <span className="nm-panel-card-sub">{host.notes}</span>
                </div>
              )}
            </section>
          )}

          {show('gpuThermals') &&
            ((stats?.gpus && stats.gpus.length > 0) || (stats?.thermals && stats.thermals.length > 0)) && (
              <section className="nm-panel-card">
                <h3 className="nm-panel-card-title">
                  {stats?.gpus.length ? t('metricGpu') : t('metricThermals')}
                </h3>
                {stats?.gpus.map((gpu) => {
                  const vramPct = formatMemoryPercent(gpu.memoryUsed, gpu.memoryTotal);
                  return (
                    <div key={gpu.index} className="nm-gpu-card">
                      <div className="nm-disk-head">
                        <span className="nm-disk-mount">
                          GPU {gpu.index} · {gpu.name}
                        </span>
                        <span className="nm-mono">{formatPercent(gpu.utilization, 0)}</span>
                      </div>
                      <div className="nm-bar-track">
                        <div
                          className="nm-bar-fill nm-bar-violet"
                          style={{ width: `${Math.max(0, Math.min(100, gpu.utilization ?? 0))}%` }}
                        />
                      </div>
                      <div className="nm-disk-meta nm-mono">
                        <span>
                          {t('gpuVram')}: {formatMemoryMiB(gpu.memoryUsed)} / {formatMemoryMiB(gpu.memoryTotal)} ({formatPercent(vramPct, 0)})
                        </span>
                        {gpu.temperatureC != null && (
                          <span>
                            {t('gpuTemp')}: {gpu.temperatureC}°C
                          </span>
                        )}
                        {gpu.powerWatts != null && (
                          <span>
                            {t('gpuPower')}: {gpu.powerWatts.toFixed(1)}W
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}

                {stats?.thermals && stats.thermals.length > 0 && (
                  <div>
                    <div className="nm-meta-label" style={{ marginBottom: 6 }}>
                      {t('metricThermals')}
                    </div>
                    <div className="nm-thermal-grid">
                      {stats.thermals.map((sensor) => (
                        <span key={sensor.id} className="nm-thermal-chip nm-mono">
                          <span>{sensor.label}</span>
                          <strong
                            style={{
                              color:
                                sensor.temperatureC >= 85
                                  ? 'var(--plugin-crit)'
                                  : sensor.temperatureC >= 70
                                    ? 'var(--plugin-warn)'
                                    : 'var(--plugin-ok)',
                            }}
                          >
                            {sensor.temperatureC.toFixed(1)}°C
                          </strong>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )}
        </div>
      </div>
    </div>
  );
}
