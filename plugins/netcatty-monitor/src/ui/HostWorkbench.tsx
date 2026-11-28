import React, { Suspense, lazy, useState } from 'react';
import { PluginPopover } from '@netcatty/plugin-sdk/host-react';
import { evaluateHostHealth } from '../domain/alerts';
import { formatLatency } from '../domain/formatting';
import type { I18nKey, MonitorLocale } from '../domain/i18n';
import { ALL_OVERVIEW_WIDGETS, MONITOR_RANGES } from '../domain/panels';
import type {
  AlertEvent,
  AlertThresholds,
  HostRuntimeState,
  MonitorHostRef,
  MonitorInterval,
  MonitorRangeMinutes,
  OverviewWidgetKey,
} from '../domain/types';
import type { MonitorHostBridge } from '../services/hostBridge';
import type { MonitorEngine } from '../services/monitorEngine';
import { OverviewTab } from './tabs/OverviewTab';

const ProcessesTab = lazy(() => import('./tabs/ProcessesTab'));
const ServicesTab = lazy(() => import('./tabs/ServicesTab'));
const PortsTab = lazy(() => import('./tabs/PortsTab'));
const AlertsTab = lazy(() => import('./tabs/AlertsTab'));

export type HostDetailTab = 'overview' | 'processes' | 'services' | 'ports' | 'alerts';

const WIDGET_LABEL_KEY: Record<OverviewWidgetKey, I18nKey> = {
  cpuBreakdown: 'widgetCpuBreakdown',
  memoryPsi: 'widgetMemoryPsi',
  networkTcp: 'widgetNetworkTcp',
  diskIoMounts: 'widgetDiskIoMounts',
  perCore: 'widgetPerCore',
  gpuThermals: 'widgetGpuThermals',
  systemSecurity: 'widgetSystemSecurity',
};

export interface HostWorkbenchProps {
  host: MonitorHostRef;
  state: HostRuntimeState | undefined;
  interval: MonitorInterval;
  range: MonitorRangeMinutes;
  alerts: AlertEvent[];
  thresholds: AlertThresholds;
  visibleWidgets: readonly OverviewWidgetKey[];
  engine: MonitorEngine;
  bridge: MonitorHostBridge;
  locale: MonitorLocale;
  t: (key: I18nKey) => string;
  onBack: () => void;
  onChangeRange: (range: MonitorRangeMinutes) => void;
  onToggleWidget: (widget: OverviewWidgetKey) => void;
  onRetry: () => void;
  onOpenSession: (mode: 'terminal' | 'sftp' | 'remoteDesktop') => void;
  onExportSnapshot: (format: 'json' | 'md') => void;
  onSaveThresholds: (next: AlertThresholds) => void;
  onAckAlert: (id: string) => void;
  onAckAll: () => void;
  onClearResolved: () => void;
}

export default function HostWorkbench({
  host,
  state,
  interval,
  range,
  alerts,
  thresholds,
  visibleWidgets,
  engine,
  bridge,
  locale,
  t,
  onBack,
  onChangeRange,
  onToggleWidget,
  onRetry,
  onOpenSession,
  onExportSnapshot,
  onSaveThresholds,
  onAckAlert,
  onAckAll,
  onClearResolved,
}: HostWorkbenchProps) {
  const [activeTab, setActiveTab] = useState<HostDetailTab>('overview');
  const [widgetsOpen, setWidgetsOpen] = useState(false);
  const isProbe = state?.mode === 'probe' || host.protocol === 'rdp' || host.protocol === 'vnc';
  const { health } = evaluateHostHealth(state, thresholds);
  const hostAlerts = alerts.filter((a) => a.hostId === host.hostId && !a.resolvedAt);
  const latency = isProbe ? state?.probe?.rttMs : (state?.stats?.latencyMs ?? state?.stats?.responseLatencyMs);

  return (
    <div className="nm-main">
      {/* Host Inspector Header */}
      <header className="nm-topbar">
        <div className="nm-topbar-left">
          <button type="button" className="nm-btn nm-btn-ghost" onClick={onBack}>
            ← {t('backToFleet')}
          </button>
          <div>
            <h2 className="nm-page-title">
              {host.label}
              {host.hostname ? ` (${host.hostname})` : ''}
            </h2>
            <span className="nm-page-sub nm-mono">
              {state?.stats?.osName || host.os || host.protocol || 'SSH'} · {formatLatency(latency)}
            </span>
          </div>
          <span
            className={`nm-badge ${
              health.level === 'healthy'
                ? 'nm-badge-ok'
                : health.level === 'warning'
                  ? 'nm-badge-warn'
                  : health.level === 'critical' || health.level === 'offline'
                    ? 'nm-badge-crit'
                    : ''
            }`}
          >
            {health.score}/100
          </span>
          {state?.stats?.rebootRequired && <span className="nm-badge nm-badge-warn">{t('rebootPending')}</span>}
        </div>

        <div className="nm-topbar-right">
          <select
            className="nm-select"
            aria-label={t('range')}
            value={String(range)}
            onChange={(e) => onChangeRange(Number(e.target.value) as MonitorRangeMinutes)}
          >
            {MONITOR_RANGES.map((m) => (
              <option key={m} value={m}>
                {m === 60 ? '1h' : `${m}m`}
              </option>
            ))}
          </select>

          {!isProbe && activeTab === 'overview' && (
            <>
              <button
                type="button"
                id="nm-widgets-trigger"
                className="nm-btn nm-btn-ghost"
                onClick={() => setWidgetsOpen((v) => !v)}
              >
                {t('customizeWidgets')}
              </button>
              <PluginPopover anchor="nm-widgets-trigger" open={widgetsOpen} onClose={() => setWidgetsOpen(false)}>
                <div className="nm-popover-menu">
                  {ALL_OVERVIEW_WIDGETS.map((w) => (
                    <label key={w} className="nm-checkbox-row">
                      <input
                        type="checkbox"
                        checked={visibleWidgets.includes(w)}
                        onChange={() => onToggleWidget(w)}
                      />
                      <span>{t(WIDGET_LABEL_KEY[w])}</span>
                    </label>
                  ))}
                </div>
              </PluginPopover>
            </>
          )}

          <button type="button" className="nm-btn nm-btn-ghost" onClick={onRetry}>
            {t('refreshNow')}
          </button>
          <button type="button" className="nm-btn nm-btn-ghost" onClick={() => onExportSnapshot('json')}>
            JSON
          </button>
          <button type="button" className="nm-btn nm-btn-ghost" onClick={() => onExportSnapshot('md')}>
            {t('exportMarkdown')}
          </button>
          {isProbe ? (
            <button type="button" className="nm-btn nm-btn-primary" onClick={() => onOpenSession('remoteDesktop')}>
              {t('openRemoteDesktop')}
            </button>
          ) : (
            <>
              <button type="button" className="nm-btn nm-btn-ghost" onClick={() => onOpenSession('sftp')}>
                {t('openSftp')}
              </button>
              <button type="button" className="nm-btn nm-btn-primary" onClick={() => onOpenSession('terminal')}>
                {t('openTerminal')}
              </button>
            </>
          )}
        </div>
      </header>

      {/* Operational Tabs */}
      <nav className="nm-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'overview'}
          className={`nm-tab ${activeTab === 'overview' ? 'nm-tab-active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          {t('tabOverview')}
        </button>
        {!isProbe && (
          <>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'processes'}
              className={`nm-tab ${activeTab === 'processes' ? 'nm-tab-active' : ''}`}
              onClick={() => setActiveTab('processes')}
            >
              {t('tabProcesses')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'services'}
              className={`nm-tab ${activeTab === 'services' ? 'nm-tab-active' : ''}`}
              onClick={() => setActiveTab('services')}
            >
              {t('tabServices')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'ports'}
              className={`nm-tab ${activeTab === 'ports' ? 'nm-tab-active' : ''}`}
              onClick={() => setActiveTab('ports')}
            >
              {t('tabNetwork')}
            </button>
          </>
        )}
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'alerts'}
          className={`nm-tab ${activeTab === 'alerts' ? 'nm-tab-active' : ''}`}
          onClick={() => setActiveTab('alerts')}
        >
          {t('tabAlerts')}
          {hostAlerts.length > 0 && <span className="nm-badge nm-badge-crit">{hostAlerts.length}</span>}
        </button>
      </nav>

      {/* Active Tab Content */}
      {activeTab === 'overview' ? (
        <OverviewTab
          host={host}
          state={state}
          interval={interval}
          range={range}
          thresholds={thresholds}
          visibleWidgets={visibleWidgets}
          locale={locale}
          t={t}
        />
      ) : (
        <Suspense fallback={<div className="nm-content">{t('loadingData')}</div>}>
          {activeTab === 'processes' && <ProcessesTab host={host} engine={engine} bridge={bridge} t={t} />}
          {activeTab === 'services' && <ServicesTab host={host} engine={engine} bridge={bridge} t={t} />}
          {activeTab === 'ports' && <PortsTab host={host} engine={engine} bridge={bridge} t={t} />}
          {activeTab === 'alerts' && (
            <AlertsTab
              alerts={alerts}
              thresholds={thresholds}
              hostFilterId={host.hostId}
              locale={locale}
              t={t}
              onSaveThresholds={onSaveThresholds}
              onAckAlert={onAckAlert}
              onAckAll={onAckAll}
              onClearResolved={onClearResolved}
            />
          )}
        </Suspense>
      )}
    </div>
  );
}
