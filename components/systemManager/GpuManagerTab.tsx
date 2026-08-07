import { CircuitBoard, Cpu, Thermometer, Zap } from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import type {
  AcceleratorDeviceInfo,
  AcceleratorProcessInfo,
  AcceleratorSnapshot,
} from '../../domain/systemManager/types';
import { cn } from '../../lib/utils';
import { ResourceBar } from './ResourceBar';
import {
  SystemPanelEmpty,
  SystemPanelError,
  SystemPanelInlineError,
  SystemPanelList,
  SystemPanelLoading,
  SystemPanelRefreshButton,
  SystemPanelRow,
  SystemPanelShell,
  SystemPanelStatusBadge,
  SystemPanelToolbar,
} from './SystemPanelUi';
import { usePolling, useStableTranslate } from '../../application/state/useSystemManager';

type Backend = ReturnType<typeof useSystemManagerBackend>;

interface GpuManagerTabProps {
  sessionId: string;
  isVisible: boolean;
  backend: Backend;
  refreshIntervalSec: number;
}

const HISTORY_LIMIT = 24;

interface DeviceHistorySample {
  util: number;
  memory: number;
}

function formatMb(mb: number | null | undefined): string {
  if (!Number.isFinite(mb)) return '--';
  const value = Number(mb);
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GB`;
  return `${Math.round(value)} MB`;
}

function memoryPercent(device: AcceleratorDeviceInfo): number | null {
  if (!Number.isFinite(device.memoryUsedMb) || !Number.isFinite(device.memoryTotalMb)) return null;
  if (!device.memoryTotalMb || device.memoryTotalMb <= 0) return null;
  return Math.max(0, Math.min(100, (Number(device.memoryUsedMb) / Number(device.memoryTotalMb)) * 100));
}

function vendorLabel(
  vendor: AcceleratorDeviceInfo['vendor'],
  t: ReturnType<typeof useI18n>['t'],
): string {
  return vendor === 'nvidia'
    ? t('systemManager.gpu.vendor.nvidia')
    : t('systemManager.gpu.vendor.ascend');
}

function deviceKey(device: AcceleratorDeviceInfo): string {
  return `${device.vendor}-${device.index}-${device.uuid || device.name}`;
}

/** Compact nvtop-style sparkline (area + stroke), reusing the overview chart feel. */
function GpuSparkline({
  values,
  className,
}: {
  values: number[];
  className?: string;
}) {
  const width = 120;
  const height = 28;
  const safeValues = values.length > 1 ? values : [values[0] ?? 0, values[0] ?? 0];
  const points = safeValues.map((value, index) => {
    const x = safeValues.length === 1 ? width : (index / (safeValues.length - 1)) * width;
    const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
    const y = height - (clamped / 100) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `M0,${height} L${points.join(' L')} L${width},${height} Z`;

  return (
    <svg
      className={cn('h-7 w-full overflow-visible', className)}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-hidden
    >
      <path d={area} fill="currentColor" opacity="0.12" />
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="transition-opacity duration-300"
      />
    </svg>
  );
}

const DeviceCard = memo(function DeviceCard({
  device,
  utilHistory,
  memHistory,
}: {
  device: AcceleratorDeviceInfo;
  utilHistory: number[];
  memHistory: number[];
}) {
  const { t } = useI18n();
  const memPct = memoryPercent(device);
  const util = Number.isFinite(device.utilizationPercent) ? Number(device.utilizationPercent) : null;
  const tone = device.vendor === 'ascend' ? 'text-orange-500' : 'text-emerald-500';

  return (
    <div className="border-b border-border/30 px-3 py-2.5 space-y-2">
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-medium truncate">
              [{device.index}] {device.name}
            </span>
            <SystemPanelStatusBadge tone="muted">
              {vendorLabel(device.vendor, t)}
            </SystemPanelStatusBadge>
            {device.health ? (
              <SystemPanelStatusBadge tone={/ok|healthy|good/i.test(device.health) ? 'success' : 'warning'}>
                {device.health}
              </SystemPanelStatusBadge>
            ) : null}
          </div>
          {device.driverVersion ? (
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {t('systemManager.gpu.driver', { version: device.driverVersion })}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2 shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {Number.isFinite(device.temperatureC) ? (
            <span className="inline-flex items-center gap-0.5" title={t('systemManager.gpu.temperature')}>
              <Thermometer size={10} />
              {Math.round(Number(device.temperatureC))}°C
            </span>
          ) : null}
          {Number.isFinite(device.powerDrawW) ? (
            <span className="inline-flex items-center gap-0.5" title={t('systemManager.gpu.power')}>
              <Zap size={10} />
              {Number(device.powerDrawW).toFixed(0)}
              {Number.isFinite(device.powerLimitW) ? `/${Math.round(Number(device.powerLimitW))}` : ''}
              W
            </span>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_72px] gap-2 items-end">
        <div className="min-w-0 space-y-1.5">
          <ResourceBar
            label={t('systemManager.gpu.util')}
            value={util}
            size="md"
          />
          <div className="flex items-center gap-2 min-w-0">
            <ResourceBar
              label={device.vendor === 'ascend' ? t('systemManager.gpu.hbm') : t('systemManager.gpu.memory')}
              value={memPct}
              className="flex-1"
              size="md"
            />
            <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">
              {formatMb(device.memoryUsedMb)} / {formatMb(device.memoryTotalMb)}
            </span>
          </div>
        </div>
        <div className={cn('min-w-0', tone)} title={t('systemManager.gpu.util')}>
          <GpuSparkline values={utilHistory.length ? utilHistory : [util ?? 0]} />
          <GpuSparkline
            values={memHistory.length ? memHistory : [memPct ?? 0]}
            className="opacity-80"
          />
        </div>
      </div>

      {Number.isFinite(device.fanPercent) ? (
        <div className="text-[10px] text-muted-foreground">
          {t('systemManager.gpu.fan', { value: Math.round(Number(device.fanPercent)) })}
        </div>
      ) : null}
    </div>
  );
});

const ProcessRow = memo(function ProcessRow({
  process,
}: {
  process: AcceleratorProcessInfo;
}) {
  const { t } = useI18n();
  return (
    <SystemPanelRow
      title={process.processName || '—'}
      subtitle={`${vendorLabel(process.vendor, t)} #${process.gpuIndex}`}
      trailing={(
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground tabular-nums">
          <span>PID {process.pid}</span>
          <span>{formatMb(process.memoryUsedMb)}</span>
        </div>
      )}
    />
  );
});

export const GpuManagerTab = memo(function GpuManagerTab({
  sessionId,
  isVisible,
  backend,
  refreshIntervalSec,
}: GpuManagerTabProps) {
  const { t } = useI18n();
  const stableT = useStableTranslate();
  const intervalMs = Math.max(2, refreshIntervalSec) * 1000;
  const [gpuListPending, setGpuListPending] = useState(false);
  const [historyByDevice, setHistoryByDevice] = useState<Record<string, DeviceHistorySample[]>>({});

  useEffect(() => {
    setGpuListPending(false);
    setHistoryByDevice({});
  }, [sessionId]);

  const fetcher = useCallback(async (): Promise<AcceleratorSnapshot | null> => {
    const result = await backend.listAccelerators(sessionId);
    if (result.pending) {
      setGpuListPending(true);
      return null;
    }
    setGpuListPending(false);
    if (!result.success) {
      throw new Error(result.error || stableT('systemManager.errors.loadGpu'));
    }
    return {
      devices: result.devices || [],
      processes: result.processes || [],
      nvidiaDriverVersion: result.nvidiaDriverVersion ?? null,
      probedAt: result.probedAt || Date.now(),
    };
  }, [backend, sessionId, stableT]);

  const { data, error, loading, refresh } = usePolling(
    fetcher,
    intervalMs,
    isVisible,
    undefined,
    { resetKey: sessionId },
  );

  const devices = useMemo(() => data?.devices ?? [], [data?.devices]);
  const processes = useMemo(() => data?.processes ?? [], [data?.processes]);
  const isRefreshActive = loading || gpuListPending;

  useEffect(() => {
    if (!isVisible || !devices.length) return;
    setHistoryByDevice((prev) => {
      const next: Record<string, DeviceHistorySample[]> = { ...prev };
      for (const device of devices) {
        const key = deviceKey(device);
        const sample: DeviceHistorySample = {
          util: Number.isFinite(device.utilizationPercent) ? Number(device.utilizationPercent) : 0,
          memory: memoryPercent(device) ?? 0,
        };
        const series = [...(next[key] || []), sample].slice(-HISTORY_LIMIT);
        next[key] = series;
      }
      return next;
    });
  }, [devices, isVisible, data?.probedAt]);

  const meta = useMemo(() => {
    const nvidiaCount = devices.filter((d) => d.vendor === 'nvidia').length;
    const ascendCount = devices.filter((d) => d.vendor === 'ascend').length;
    return t('systemManager.gpu.meta', {
      devices: devices.length,
      processes: processes.length,
      nvidia: nvidiaCount,
      ascend: ascendCount,
    });
  }, [devices, processes, t]);

  if (!isVisible && !data) {
    return null;
  }

  if (!data) {
    if (error && !isRefreshActive) {
      return (
        <SystemPanelShell section="system-manager-gpu">
          <SystemPanelError
            message={error}
            retryLabel={t('history.action.refresh')}
            onRetry={() => void refresh()}
          />
        </SystemPanelShell>
      );
    }
    return (
      <SystemPanelShell section="system-manager-gpu">
        <SystemPanelLoading message={t('systemManager.gpu.loading')} />
      </SystemPanelShell>
    );
  }

  if (!devices.length && !processes.length) {
    return (
      <SystemPanelShell section="system-manager-gpu">
        <SystemPanelToolbar trailing={(
          <SystemPanelRefreshButton
            title={t('history.action.refresh')}
            loading={isRefreshActive}
            onClick={() => void refresh()}
          />
        )}>
          <span className="text-[11px] text-muted-foreground truncate">{meta}</span>
        </SystemPanelToolbar>
        <SystemPanelEmpty icon={CircuitBoard} message={t('systemManager.gpu.empty')} />
      </SystemPanelShell>
    );
  }

  return (
    <SystemPanelShell section="system-manager-gpu">
      <SystemPanelToolbar trailing={(
        <SystemPanelRefreshButton
          title={t('history.action.refresh')}
          loading={isRefreshActive}
          onClick={() => void refresh()}
        />
      )}>
        <span className="text-[11px] text-muted-foreground truncate">{meta}</span>
      </SystemPanelToolbar>
      {error && !isRefreshActive ? (
        <SystemPanelInlineError
          message={error}
          retryLabel={t('history.action.refresh')}
          onRetry={() => void refresh()}
        />
      ) : null}
      <SystemPanelList>
        <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
          <Cpu size={10} />
          {t('systemManager.gpu.devices')}
        </div>
        {devices.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-muted-foreground">
            {t('systemManager.gpu.empty')}
          </div>
        ) : (
          devices.map((device) => {
            const key = deviceKey(device);
            const series = historyByDevice[key] || [];
            return (
              <DeviceCard
                key={key}
                device={device}
                utilHistory={series.map((sample) => sample.util)}
                memHistory={series.map((sample) => sample.memory)}
              />
            );
          })
        )}
        <div className="px-3 pt-3 pb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('systemManager.gpu.processes')}
        </div>
        {processes.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-muted-foreground">
            {t('systemManager.gpu.noProcesses')}
          </div>
        ) : (
          processes.map((process) => (
            <ProcessRow
              key={`${process.vendor}-${process.gpuIndex}-${process.pid}-${process.processName}`}
              process={process}
            />
          ))
        )}
      </SystemPanelList>
    </SystemPanelShell>
  );
});
