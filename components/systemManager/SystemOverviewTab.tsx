import {
  Activity,
  Clock3,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
} from 'lucide-react';
import React, { memo, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { aggregateMountedDiskUsage } from '../../domain/systemDiskUsage';
import { cn } from '../../lib/utils';
import { useServerStats } from '../terminal/hooks/useServerStats';
import { ResourceBar } from './ResourceBar';
import {
  SystemPanelEmpty,
  SystemPanelError,
  SystemPanelInlineError,
  SystemPanelLoading,
  SystemPanelShell,
} from './SystemPanelUi';

interface SystemOverviewTabProps {
  sessionId: string;
  isVisible: boolean;
  isSupportedOs: boolean;
  refreshIntervalSec: number;
}

interface OverviewSample {
  at: number;
  cpu: number;
  memory: number;
  disk: number;
  network: number;
}

function clampPercent(value: number | null | undefined): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Number(value)));
}

function ratioPercent(used: number | null | undefined, total: number | null | undefined): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(total) || Number(total) <= 0) return null;
  return clampPercent((Number(used) / Number(total)) * 100);
}

function formatPercent(value: number | null | undefined, digits = 0): string {
  if (!Number.isFinite(value)) return '--';
  return `${Number(value).toFixed(digits)}%`;
}

function formatBytes(bytes: number): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${Math.round(value)} B`;
}

function formatThroughput(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatStorageGb(gb: number | null | undefined): string {
  if (!Number.isFinite(gb)) return '--';
  const value = Number(gb);
  if (value >= 1024) return `${(value / 1024).toFixed(1)} TB`;
  return `${value.toFixed(value >= 10 ? 0 : 1)} GB`;
}

function formatMemoryMb(mb: number | null | undefined): string {
  if (!Number.isFinite(mb)) return '--';
  const value = Number(mb);
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GB`;
  return `${Math.round(value)} MB`;
}

function formatDuration(seconds: number | null | undefined, t: ReturnType<typeof useI18n>['t']): string {
  if (!Number.isFinite(seconds) || Number(seconds) < 0) return '--';
  const totalHours = Math.floor(Number(seconds) / 3600);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = Math.floor((Number(seconds) % 3600) / 60);
  if (days > 0) return t('systemManager.overview.duration.daysHours', { days, hours });
  if (hours > 0) return t('systemManager.overview.duration.hoursMinutes', { hours, minutes });
  return t('systemManager.overview.duration.minutes', { minutes });
}

function formatLoad(loadAverage: number[] | undefined): string {
  if (!loadAverage || loadAverage.length === 0) return '--';
  return loadAverage.map((load) => load.toFixed(2)).join(' / ');
}

function MetricTrend({
  values,
  max,
  className,
}: {
  values: number[];
  max?: number;
  className?: string;
}) {
  const width = 120;
  const height = 34;
  const finite = values.filter((value) => Number.isFinite(value));
  const computedMax = max ?? Math.max(1, ...finite);
  const safeValues = values.length > 1 ? values : [0, values[0] ?? 0];
  const points = safeValues.map((value, index) => {
    const x = safeValues.length === 1 ? width : (index / (safeValues.length - 1)) * width;
    const clamped = Math.max(0, Math.min(computedMax, Number.isFinite(value) ? value : 0));
    const y = height - (clamped / computedMax) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `M0,${height} L${points.join(' L')} L${width},${height} Z`;

  return (
    <svg className={cn('h-9 w-full overflow-visible', className)} viewBox={`0 0 ${width} ${height}`} role="img">
      <path d={area} fill="currentColor" opacity="0.10" />
      <polyline points={points.join(' ')} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RadialGauge({
  value,
  className,
}: {
  value: number | null;
  className?: string;
}) {
  const clamped = clampPercent(value) ?? 0;
  return (
    <div className={cn('relative h-16 w-16 shrink-0', className)}>
      <svg viewBox="0 0 44 44" className="h-full w-full -rotate-90">
        <circle cx="22" cy="22" r="18" fill="none" stroke="currentColor" strokeWidth="5" className="text-muted/70" />
        <circle
          cx="22"
          cy="22"
          r="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${clamped} ${100 - clamped}`}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-[12px] font-semibold tabular-nums text-foreground">
        {formatPercent(value)}
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  gaugeValue,
  trendValues,
  trendMax,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  gaugeValue: number | null;
  trendValues: number[];
  trendMax?: number;
  tone: string;
}) {
  return (
    <section className="rounded-md border border-border/60 bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Icon size={13} className={tone} />
            <span>{label}</span>
          </div>
          <div className="truncate text-lg font-semibold tabular-nums leading-tight text-foreground">{value}</div>
          <div className="mt-1 truncate text-[10px] text-muted-foreground">{detail}</div>
        </div>
        <RadialGauge value={gaugeValue} className={tone} />
      </div>
      <MetricTrend values={trendValues} max={trendMax} className={cn('mt-2', tone)} />
    </section>
  );
}

function InfoPill({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-md border border-border/50 bg-background/70 px-2.5 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-xs font-medium text-foreground">{value || '--'}</div>
    </div>
  );
}

export const SystemOverviewTab = memo(function SystemOverviewTab({
  sessionId,
  isVisible,
  isSupportedOs,
  refreshIntervalSec,
}: SystemOverviewTabProps) {
  const { t } = useI18n();
  const [history, setHistory] = useState<OverviewSample[]>([]);

  const {
    stats,
    error,
    isLoading: loading,
    refresh,
  } = useServerStats({
    sessionId,
    enabled: isVisible,
    refreshInterval: refreshIntervalSec,
    isSupportedOs,
    isConnected: true,
  });
  const hasStats = Boolean(stats.lastUpdated);

  const memoryPercent = ratioPercent(stats?.memUsed, stats?.memTotal);
  const mountedDiskUsage = aggregateMountedDiskUsage(stats.disks);
  const diskUsed = mountedDiskUsage?.used ?? stats.diskUsed;
  const diskTotal = mountedDiskUsage?.total ?? stats.diskTotal;
  const diskPercent = mountedDiskUsage?.percent ?? clampPercent(stats.diskPercent);
  const networkSpeed = (stats?.netRxSpeed ?? 0) + (stats?.netTxSpeed ?? 0);
  const networkGauge = Math.min(100, Math.log10(networkSpeed + 1) * 14);
  const loadOne = stats?.loadAverage?.[0] ?? null;
  const loadPercent = ratioPercent(loadOne, stats?.cpuCores);

  useEffect(() => {
    setHistory([]);
  }, [sessionId]);

  useEffect(() => {
    if (!isVisible || !hasStats) return;
    setHistory((prev) => {
      const next = [
        ...prev,
        {
          at: Date.now(),
          cpu: clampPercent(stats.cpu) ?? 0,
          memory: memoryPercent ?? 0,
          disk: diskPercent ?? 0,
          network: networkSpeed,
        },
      ];
      return next.slice(-24);
    });
  }, [diskPercent, hasStats, isVisible, memoryPercent, networkSpeed, stats.cpu]);

  const trends = useMemo(() => ({
    cpu: history.map((sample) => sample.cpu),
    memory: history.map((sample) => sample.memory),
    disk: history.map((sample) => sample.disk),
    network: history.map((sample) => sample.network),
  }), [history]);

  const showBlockingError = Boolean(error && !hasStats && !loading);
  const showInitialLoading = Boolean(loading && !hasStats);

  return (
    <SystemPanelShell section="system-manager-overview">
      {error && hasStats && !loading && (
        <SystemPanelInlineError
          message={error}
          onRetry={() => void refresh()}
          retryLabel={t('history.action.retry')}
          loading={loading}
        />
      )}

      {showBlockingError && error ? (
        <SystemPanelError message={error} onRetry={() => void refresh()} retryLabel={t('history.action.retry')} loading={loading} />
      ) : showInitialLoading ? (
        <SystemPanelLoading message={t('systemManager.overview.loading')} />
      ) : !hasStats ? (
        <SystemPanelEmpty icon={Activity} message={t('systemManager.overview.empty')} />
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
          <div className="grid grid-cols-2 gap-2">
            <MetricCard
              label="CPU"
              value={formatPercent(stats.cpu)}
              detail={stats.cpuCores ? t('systemManager.overview.cores', { count: String(stats.cpuCores) }) : '--'}
              icon={Cpu}
              gaugeValue={stats.cpu}
              trendValues={trends.cpu}
              trendMax={100}
              tone="text-sky-500"
            />
            <MetricCard
              label={t('systemManager.overview.memory')}
              value={formatPercent(memoryPercent)}
              detail={`${formatMemoryMb(stats.memUsed)} / ${formatMemoryMb(stats.memTotal)}`}
              icon={MemoryStick}
              gaugeValue={memoryPercent}
              trendValues={trends.memory}
              trendMax={100}
              tone="text-emerald-500"
            />
            <MetricCard
              label={t('systemManager.overview.disk')}
              value={formatPercent(diskPercent)}
              detail={`${formatStorageGb(diskUsed)} / ${formatStorageGb(diskTotal)}`}
              icon={HardDrive}
              gaugeValue={diskPercent}
              trendValues={trends.disk}
              trendMax={100}
              tone="text-amber-500"
            />
            <MetricCard
              label={t('systemManager.overview.network')}
              value={formatThroughput(networkSpeed)}
              detail={`${t('systemManager.overview.rx')} ${formatThroughput(stats.netRxSpeed)} · ${t('systemManager.overview.tx')} ${formatThroughput(stats.netTxSpeed)}`}
              icon={Network}
              gaugeValue={networkGauge}
              trendValues={trends.network}
              tone="text-cyan-500"
            />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <InfoPill label={t('systemManager.overview.load')} value={formatLoad(stats.loadAverage)} />
            <InfoPill label={t('systemManager.overview.uptime')} value={formatDuration(stats.uptimeSeconds, t)} />
            <InfoPill label={t('systemManager.overview.system')} value={stats.osName || '--'} />
            <InfoPill label={t('systemManager.overview.kernel')} value={stats.kernelRelease || '--'} />
            <InfoPill label={t('systemManager.overview.swap')} value={`${formatMemoryMb(stats.swapUsed)} / ${formatMemoryMb(stats.swapTotal)}`} />
            <InfoPill label={t('systemManager.overview.latency')} value={Number.isFinite(stats.latencyMs) ? `${Math.round(stats.latencyMs ?? 0)} ms` : '--'} />
          </div>

          <section className="mt-3 rounded-md border border-border/60 bg-muted/20 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Cpu size={13} className="text-sky-500" />
                {t('systemManager.overview.cpuCores')}
              </div>
              <span className="text-[10px] text-muted-foreground">
                {loadPercent !== null ? `${t('systemManager.overview.load')} ${formatPercent(loadPercent)}` : t('systemManager.overview.noData')}
              </span>
            </div>
            {stats.cpuPerCore.length > 0 ? (
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                {stats.cpuPerCore.slice(0, 12).map((core, index) => (
                  <ResourceBar key={`core-${index}`} label={`C${index + 1}`} value={core} />
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground">{t('systemManager.overview.noData')}</div>
            )}
          </section>

          <section className="mt-3 rounded-md border border-border/60 bg-muted/20 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
              <HardDrive size={13} className="text-amber-500" />
              {t('systemManager.overview.disks')}
            </div>
            {stats.disks.length > 0 ? (
              <div className="space-y-2">
                {stats.disks.map((disk) => (
                  <div key={disk.mountPoint} className="space-y-1">
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="min-w-0 truncate text-foreground">{disk.mountPoint}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {formatStorageGb(disk.used)} / {formatStorageGb(disk.total)}
                      </span>
                    </div>
                    <ResourceBar label="" value={disk.percent} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground">{t('systemManager.overview.noDisks')}</div>
            )}
          </section>

          <section className="mt-3 rounded-md border border-border/60 bg-muted/20 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
              <Network size={13} className="text-cyan-500" />
              {t('systemManager.overview.interfaces')}
            </div>
            {stats.netInterfaces.length > 0 ? (
              <div className="space-y-2">
                {stats.netInterfaces.slice(0, 5).map((iface) => (
                  <div key={iface.name} className="grid grid-cols-[1fr_auto] items-center gap-2 text-[11px]">
                    <span className="min-w-0 truncate text-foreground">{iface.name}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {t('systemManager.overview.rx')} {formatThroughput(iface.rxSpeed)} · {t('systemManager.overview.tx')} {formatThroughput(iface.txSpeed)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground">{t('systemManager.overview.noInterfaces')}</div>
            )}
          </section>

          <section className="mt-3 rounded-md border border-border/60 bg-muted/20 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
              <Clock3 size={13} className="text-rose-500" />
              {t('systemManager.overview.topProcesses')}
            </div>
            {stats.topProcesses.length > 0 ? (
              <div className="space-y-2">
                {stats.topProcesses.slice(0, 5).map((proc) => (
                  <div key={`${proc.pid}-${proc.command}`} className="space-y-1">
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="min-w-0 truncate text-foreground">{proc.command}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">PID {proc.pid}</span>
                    </div>
                    <ResourceBar label="MEM" value={proc.memPercent} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground">{t('systemManager.overview.noTopProcesses')}</div>
            )}
          </section>
        </div>
      )}
    </SystemPanelShell>
  );
});
