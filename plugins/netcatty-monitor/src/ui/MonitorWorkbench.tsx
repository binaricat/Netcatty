import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JsonValue, PluginContext } from '@netcatty/plugin-sdk';
import { PluginSplitPane, usePluginShortcuts } from '@netcatty/plugin-sdk/host-react';
import { computeAlertBadge, DEFAULT_ALERT_THRESHOLDS, normalizeAlertThresholds } from '../domain/alerts';
import { formatLatency, formatLoadAverage, formatMarkdownDiagnostics, formatMemoryPercent } from '../domain/formatting';
import { createTranslator, resolveMonitorLocale } from '../domain/i18n';
import {
  ALL_OVERVIEW_WIDGETS,
  DEFAULT_MONITOR_INTERVAL,
  normalizeMonitorPanels,
  normalizeVisibleWidgets,
  reorderMonitorHosts,
} from '../domain/panels';
import type { AlertThresholds, MonitorHostRef, MonitorPanel, OverviewWidgetKey } from '../domain/types';
import { createMonitorHostBridge, type MonitorHostBridge } from '../services/hostBridge';
import { MonitorEngine, type MonitorEngineSnapshot } from '../services/monitorEngine';
import { FleetOverview } from './FleetOverview';

const HostWorkbench = lazy(() => import('./HostWorkbench'));
const AlertsTab = lazy(() => import('./tabs/AlertsTab'));

const STORAGE_PANELS = 'monitor:panels';
const STORAGE_HOSTS = 'monitor:hosts';
const STORAGE_PINNED = 'monitor:pinned';
const STORAGE_HIDDEN_COLS = 'monitor:hiddenCols';
const STORAGE_THRESHOLDS = 'monitor:thresholds';
const STORAGE_VISIBLE_WIDGETS = 'monitor:visibleWidgets';

function createDefaultPanel(locale: 'en' | 'zh-CN'): MonitorPanel {
  return {
    id: 'default-fleet',
    name: locale === 'zh-CN' ? '默认集群' : 'Default Fleet',
    description: '',
    hostIds: [],
    view: 'charts',
    interval: DEFAULT_MONITOR_INTERVAL,
    range: 15,
    sort: 'manual',
  };
}

export interface MonitorWorkbenchProps {
  context: PluginContext;
  bridgeOverride?: MonitorHostBridge;
}

export function MonitorWorkbench({ context, bridgeOverride }: MonitorWorkbenchProps) {
  const [locale, setLocale] = useState(() => resolveMonitorLocale(context.environment?.locale));
  const [theme, setTheme] = useState(() => context.environment?.theme ?? 'dark');
  const t = useMemo(() => createTranslator(locale), [locale]);

  const bridge = useMemo(() => bridgeOverride ?? createMonitorHostBridge(context), [context, bridgeOverride]);
  const engineRef = useRef<MonitorEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new MonitorEngine(bridge);
  }
  const engine = engineRef.current;

  const [panels, setPanels] = useState<MonitorPanel[]>(() => [createDefaultPanel(resolveMonitorLocale(context.environment?.locale))]);
  const [activePanelId, setActivePanelId] = useState<string>('default-fleet');
  const [hostCatalog, setHostCatalog] = useState<Record<string, MonitorHostRef>>({});
  const [pinnedHostIds, setPinnedHostIds] = useState<string[]>([]);
  const [hiddenColumns, setHiddenColumns] = useState<string[]>([]);
  const [visibleWidgets, setVisibleWidgets] = useState<OverviewWidgetKey[]>([...ALL_OVERVIEW_WIDGETS]);
  const [thresholds, setThresholds] = useState<AlertThresholds>(DEFAULT_ALERT_THRESHOLDS);
  const [running, setRunning] = useState<boolean>(true);
  const [focusedHostId, setFocusedHostId] = useState<string | null>(null);
  const [showGlobalAlerts, setShowGlobalAlerts] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const [panelModal, setPanelModal] = useState<{ mode: 'create' | 'edit'; id?: string; name: string; description: string } | null>(null);
  const [engineSnap, setEngineSnap] = useState<MonitorEngineSnapshot>(() => engine.getSnapshot());

  // Subscribe to host environment changes (locale & theme)
  useEffect(() => {
    const sub = context.environment?.onDidChange?.((env) => {
      setLocale(resolveMonitorLocale(env.locale));
      setTheme(env.theme);
    });
    return () => sub?.dispose();
  }, [context.environment]);

  // Sync active unacknowledged alerts to the Netcatty Vault sidebar badge (deduplicated)
  const lastBadgeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const badge = computeAlertBadge(engineSnap.alerts, locale);
    const key = badge ? `${badge.count}|${badge.tone}|${badge.tooltip}` : 'none';
    if (lastBadgeKeyRef.current === key) return;
    lastBadgeKeyRef.current = key;
    void bridge.setViewBadge(badge);
  }, [bridge, engineSnap.alerts, locale]);

  useEffect(() => {
    return () => {
      lastBadgeKeyRef.current = null;
      void bridge.setViewBadge(null);
    };
  }, [bridge]);

  // Subscribe to MonitorEngine updates and clean up on unmount
  useEffect(() => {
    const unsub = engine.subscribe(() => {
      setEngineSnap(engine.getSnapshot());
    });
    return () => {
      unsub();
      engine.dispose();
    };
  }, [engine]);

  // Hydrate persisted state and refresh durable Vault host bindings
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [rawPanels, rawHosts, rawPinned, rawHidden, rawThresholds, rawWidgets] = await Promise.all([
        bridge.loadStorage<JsonValue>(STORAGE_PANELS),
        bridge.loadStorage<JsonValue>(STORAGE_HOSTS),
        bridge.loadStorage<JsonValue>(STORAGE_PINNED),
        bridge.loadStorage<JsonValue>(STORAGE_HIDDEN_COLS),
        bridge.loadStorage<JsonValue>(STORAGE_THRESHOLDS),
        bridge.loadStorage<JsonValue>(STORAGE_VISIBLE_WIDGETS),
      ]);
      if (cancelled) return;

      const loadedPanels = normalizeMonitorPanels(rawPanels);
      const effectivePanels = loadedPanels.length > 0 ? loadedPanels : [createDefaultPanel(locale)];
      setPanels(effectivePanels);
      setActivePanelId(effectivePanels[0].id);

      const loadedCatalog: Record<string, MonitorHostRef> = {};
      if (rawHosts && typeof rawHosts === 'object' && !Array.isArray(rawHosts)) {
        for (const [id, raw] of Object.entries(rawHosts as Record<string, unknown>)) {
          if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            const h = raw as Record<string, unknown>;
            loadedCatalog[id] = {
              hostId: id,
              hostBindingToken: typeof h.hostBindingToken === 'string' ? h.hostBindingToken : id,
              label: typeof h.label === 'string' ? h.label : id.slice(0, 12),
              hostname: typeof h.hostname === 'string' ? h.hostname : undefined,
              port: typeof h.port === 'number' ? h.port : undefined,
              username: typeof h.username === 'string' ? h.username : undefined,
              protocol: typeof h.protocol === 'string' ? h.protocol : 'ssh',
              group: typeof h.group === 'string' ? h.group : undefined,
              tags: Array.isArray(h.tags) ? h.tags.filter((x): x is string => typeof x === 'string') : [],
              notes: typeof h.notes === 'string' ? h.notes : undefined,
              os: typeof h.os === 'string' ? h.os : undefined,
            };
          }
        }
      }
      setHostCatalog(loadedCatalog);

      if (Array.isArray(rawPinned)) {
        setPinnedHostIds(rawPinned.filter((id): id is string => typeof id === 'string'));
      }
      if (Array.isArray(rawHidden)) {
        setHiddenColumns(rawHidden.filter((col): col is string => typeof col === 'string'));
      }
      setVisibleWidgets(normalizeVisibleWidgets(rawWidgets));
      const normThresholds = normalizeAlertThresholds(rawThresholds);
      setThresholds(normThresholds);
      engine.setThresholds(normThresholds);
      setHydrated(true);

      // Refresh host labels/tags/groups for all persisted durable bindings without showing a modal
      const allTokens = [
        ...new Set(effectivePanels.flatMap((p) => p.hostIds).filter((id) => id.startsWith('hb_'))),
      ];
      if (allTokens.length > 0) {
        const resolved = await bridge.resolveHostBindings(allTokens);
        if (cancelled) return;
        if (resolved.length > 0) {
          setHostCatalog((prev) => {
            const next = { ...prev };
            for (const item of resolved) {
              if (item.status === 'available' && item.host) {
                next[item.hostBindingToken] = item.host;
              }
            }
            return next;
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, engine]);

  const activePanel = useMemo(
    () => panels.find((p) => p.id === activePanelId) ?? panels[0],
    [panels, activePanelId],
  );

  const activePanelHosts = useMemo<MonitorHostRef[]>(() => {
    if (!activePanel) return [];
    return activePanel.hostIds.map(
      (id) =>
        hostCatalog[id] ?? {
          hostId: id,
          hostBindingToken: id,
          label: id.slice(0, 12),
        },
    );
  }, [activePanel, hostCatalog]);

  // Reconcile active panel hosts with MonitorEngine
  useEffect(() => {
    if (!hydrated || !activePanel) return;
    engine.reconcileHosts(activePanelHosts, { running, interval: activePanel.interval });
  }, [hydrated, engine, activePanelHosts, running, activePanel?.interval]);

  const persistPanels = useCallback(
    (next: MonitorPanel[]) => {
      setPanels(next);
      void bridge.saveStorage(STORAGE_PANELS, next as unknown as JsonValue);
    },
    [bridge],
  );

  const persistCatalog = useCallback(
    (next: Record<string, MonitorHostRef>) => {
      setHostCatalog(next);
      void bridge.saveStorage(STORAGE_HOSTS, next as unknown as JsonValue);
    },
    [bridge],
  );

  const handleUpdatePanel = useCallback(
    (patch: Partial<MonitorPanel>) => {
      if (!activePanel) return;
      const next = panels.map((p) => (p.id === activePanel.id ? { ...p, ...patch } : p));
      persistPanels(next);
    },
    [activePanel, panels, persistPanels],
  );

  const handleAddHosts = useCallback(async () => {
    if (!activePanel) return;
    const selected = await bridge.selectHosts(t('selectHosts'));
    if (selected.length === 0) return;
    const nextCatalog = { ...hostCatalog };
    const nextIds = [...activePanel.hostIds];
    for (const h of selected) {
      nextCatalog[h.hostId] = h;
      if (!nextIds.includes(h.hostId)) nextIds.push(h.hostId);
    }
    persistCatalog(nextCatalog);
    persistPanels(panels.map((p) => (p.id === activePanel.id ? { ...p, hostIds: nextIds } : p)));
    setRunning(true);
  }, [activePanel, bridge, hostCatalog, panels, persistCatalog, persistPanels, t]);

  const handleRemoveHost = useCallback(
    (hostId: string) => {
      if (!activePanel) return;
      const nextPanels = panels.map((p) =>
        p.id === activePanel.id ? { ...p, hostIds: p.hostIds.filter((id) => id !== hostId) } : p,
      );
      persistPanels(nextPanels);
      if (focusedHostId === hostId) setFocusedHostId(null);
      const stillReferenced = nextPanels.some((p) => p.hostIds.includes(hostId));
      if (!stillReferenced && hostId.startsWith('hb_')) {
        void bridge.revokeHostBinding(hostId);
      }
    },
    [activePanel, bridge, focusedHostId, panels, persistPanels],
  );

  const handleTogglePin = useCallback(
    (hostId: string) => {
      const next = pinnedHostIds.includes(hostId)
        ? pinnedHostIds.filter((id) => id !== hostId)
        : [...pinnedHostIds, hostId];
      setPinnedHostIds(next);
      void bridge.saveStorage(STORAGE_PINNED, next as unknown as JsonValue);
    },
    [bridge, pinnedHostIds],
  );

  const handleReorderHost = useCallback(
    (hostId: string, direction: 'up' | 'down') => {
      if (!activePanel) return;
      const idx = activePanel.hostIds.indexOf(hostId);
      if (idx < 0) return;
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= activePanel.hostIds.length) return;
      const reordered = reorderMonitorHosts(activePanel.hostIds, hostId, activePanel.hostIds[targetIdx]);
      persistPanels(panels.map((p) => (p.id === activePanel.id ? { ...p, hostIds: reordered } : p)));
    },
    [activePanel, panels, persistPanels],
  );

  const handleToggleColumn = useCallback(
    (col: string) => {
      const next = hiddenColumns.includes(col)
        ? hiddenColumns.filter((c) => c !== col)
        : [...hiddenColumns, col];
      setHiddenColumns(next);
      void bridge.saveStorage(STORAGE_HIDDEN_COLS, next as unknown as JsonValue);
    },
    [bridge, hiddenColumns],
  );

  const handleToggleWidget = useCallback(
    (widget: OverviewWidgetKey) => {
      const exists = visibleWidgets.includes(widget);
      const next = exists
        ? visibleWidgets.length > 1
          ? visibleWidgets.filter((w) => w !== widget)
          : visibleWidgets
        : [...visibleWidgets, widget];
      setVisibleWidgets(next);
      void bridge.saveStorage(STORAGE_VISIBLE_WIDGETS, next as unknown as JsonValue);
    },
    [bridge, visibleWidgets],
  );

  const handleSaveThresholds = useCallback(
    (next: AlertThresholds) => {
      const normalized = normalizeAlertThresholds(next);
      setThresholds(normalized);
      engine.setThresholds(normalized);
      void bridge.saveStorage(STORAGE_THRESHOLDS, normalized as unknown as JsonValue);
    },
    [bridge, engine],
  );

  const handleSavePanelModal = useCallback(() => {
    if (!panelModal || !panelModal.name.trim()) return;
    if (panelModal.mode === 'create') {
      const created: MonitorPanel = {
        id: `panel-${Date.now()}`,
        name: panelModal.name.trim().slice(0, 120),
        description: panelModal.description.trim().slice(0, 1000),
        hostIds: [],
        view: 'charts',
        interval: DEFAULT_MONITOR_INTERVAL,
        range: 15,
        sort: 'manual',
      };
      const next = normalizeMonitorPanels([...panels, created]);
      persistPanels(next);
      setActivePanelId(created.id);
      setFocusedHostId(null);
      setShowGlobalAlerts(false);
    } else if (panelModal.id) {
      const next = normalizeMonitorPanels(
        panels.map((p) =>
          p.id === panelModal.id
            ? {
                ...p,
                name: panelModal.name.trim().slice(0, 120),
                description: panelModal.description.trim().slice(0, 1000),
              }
            : p,
        ),
      );
      persistPanels(next);
    }
    setPanelModal(null);
  }, [panelModal, panels, persistPanels]);

  const handleDeletePanel = useCallback(
    (panelId: string) => {
      if (panels.length <= 1) return;
      const next = panels.filter((p) => p.id !== panelId);
      persistPanels(next);
      if (activePanelId === panelId) {
        setActivePanelId(next[0].id);
        setFocusedHostId(null);
      }
    },
    [activePanelId, panels, persistPanels],
  );

  const handleDuplicatePanel = useCallback(
    (panel: MonitorPanel) => {
      const dup: MonitorPanel = {
        ...panel,
        id: `panel-${Date.now()}`,
        name: `${panel.name} Copy`,
      };
      const next = normalizeMonitorPanels([...panels, dup]);
      persistPanels(next);
      setActivePanelId(dup.id);
    },
    [panels, persistPanels],
  );

  const handleExportSnapshot = useCallback(
    (format: 'json' | 'md', hostId?: string) => {
      const nowIso = new Date().toISOString();
      const baseName = hostId
        ? `monitor-${(hostCatalog[hostId]?.label || 'host').replace(/[^a-zA-Z0-9_-]/g, '_')}`
        : `monitor-${(activePanel?.name || 'fleet').replace(/[^a-zA-Z0-9_-]/g, '_')}`;

      if (format === 'md') {
        const targetHosts = hostId
          ? activePanelHosts.filter((h) => h.hostId === hostId)
          : activePanelHosts;
        const md = formatMarkdownDiagnostics({
          title: hostId ? (hostCatalog[hostId]?.label || 'Host') : (activePanel?.name || 'Fleet'),
          generatedAt: nowIso,
          hosts: targetHosts.map((h) => {
            const st = engineSnap.hosts[h.hostId];
            const s = st?.stats;
            return {
              label: h.label,
              hostname: h.hostname,
              status: st?.status ?? 'idle',
              cpu: s?.cpu ?? null,
              memPercent: formatMemoryPercent(s?.memUsed, s?.memTotal),
              diskPercent: s?.diskPercent ?? null,
              load: formatLoadAverage(s?.loadAverage),
              latency: formatLatency(st?.mode === 'probe' ? st.probe?.rttMs : (s?.latencyMs ?? s?.responseLatencyMs)),
              os: s?.osName || h.os,
            };
          }),
          activeAlerts: engineSnap.alerts
            .filter((a) => !a.resolvedAt && (!hostId || a.hostId === hostId))
            .map((a) => ({ severity: a.severity, message: a.message })),
        });
        void bridge.saveMarkdownReport(`${baseName}.md`, md);
        return;
      }

      const payload = hostId
        ? {
            exportedAt: nowIso,
            host: hostCatalog[hostId],
            runtime: engineSnap.hosts[hostId],
          }
        : {
            exportedAt: nowIso,
            panel: activePanel,
            hosts: activePanelHosts.map((h) => ({ host: h, runtime: engineSnap.hosts[h.hostId] })),
            alerts: engineSnap.alerts,
          };
      void bridge.saveJsonSnapshot(`${baseName}.json`, payload);
    },
    [activePanel, activePanelHosts, bridge, engineSnap, hostCatalog],
  );

  usePluginShortcuts((shortcut) => {
    if (shortcut === 'escape') {
      if (panelModal) setPanelModal(null);
      else if (focusedHostId) setFocusedHostId(null);
      else if (showGlobalAlerts) setShowGlobalAlerts(false);
    }
  });

  const activeAlertsCount = useMemo(
    () => engineSnap.alerts.filter((a) => !a.resolvedAt && !a.acknowledged).length,
    [engineSnap.alerts],
  );

  const pinnedSet = useMemo(() => new Set(pinnedHostIds), [pinnedHostIds]);
  const focusedHost = focusedHostId ? activePanelHosts.find((h) => h.hostId === focusedHostId) ?? hostCatalog[focusedHostId] ?? null : null;
  const brandIconSrc =
    theme.toLowerCase().includes('light') ? 'asset:assets/plugin-icon-light.png' : 'asset:assets/plugin-icon-dark.png';

  return (
    <div className="nm-root" data-monitor-workbench="true">
      <PluginSplitPane className="nm-split" direction="horizontal" initialSize={224} minSize={180} maxSize={340} collapsible>
        {/* Left Navigation & Panels Rail */}
        <aside className="nm-sidebar">
          <div className="nm-sidebar-header">
            <div className="nm-brand">
              <img className="nm-brand-icon" src={brandIconSrc} alt="Monitor" />
              <span className="nm-brand-title">{t('appTitle')}</span>
            </div>
            <button
              type="button"
              className="nm-btn nm-btn-sm nm-btn-ghost"
              title={t('newPanel')}
              onClick={() => setPanelModal({ mode: 'create', name: '', description: '' })}
            >
              +
            </button>
          </div>

          <div className="nm-sidebar-section">
            <div className="nm-section-label">
              <span>{t('panels')}</span>
              <span>{panels.length}</span>
            </div>
            {panels.map((p) => {
              const isSelected = !showGlobalAlerts && p.id === activePanel?.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`nm-panel-item ${isSelected ? 'nm-panel-item-active' : ''}`}
                  onClick={() => {
                    setActivePanelId(p.id);
                    setFocusedHostId(null);
                    setShowGlobalAlerts(false);
                  }}
                >
                  <span className="nm-panel-name">{p.name}</span>
                  <span className="nm-count-pill nm-mono">{p.hostIds.length}</span>
                </button>
              );
            })}

            <div className="nm-section-label" style={{ marginTop: 10 }}>
              <span>{t('tabAlerts')}</span>
            </div>
            <button
              type="button"
              className={`nm-panel-item ${showGlobalAlerts ? 'nm-panel-item-active' : ''}`}
              onClick={() => {
                setShowGlobalAlerts(true);
                setFocusedHostId(null);
              }}
            >
              <span className="nm-panel-name">{t('alertsTitle')}</span>
              {activeAlertsCount > 0 ? (
                <span className="nm-badge nm-badge-crit">{activeAlertsCount}</span>
              ) : (
                <span className="nm-count-pill nm-mono">0</span>
              )}
            </button>
          </div>

          {activePanel && (
            <div className="nm-sidebar-footer">
              <button
                type="button"
                className="nm-btn nm-btn-ghost"
                onClick={() =>
                  setPanelModal({
                    mode: 'edit',
                    id: activePanel.id,
                    name: activePanel.name,
                    description: activePanel.description,
                  })
                }
              >
                {t('editPanel')}
              </button>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="nm-btn nm-btn-sm nm-btn-ghost"
                  style={{ flex: 1 }}
                  onClick={() => handleDuplicatePanel(activePanel)}
                >
                  {t('duplicatePanel')}
                </button>
                <button
                  type="button"
                  className="nm-btn nm-btn-sm nm-btn-danger"
                  style={{ flex: 1 }}
                  disabled={panels.length <= 1}
                  onClick={() => handleDeletePanel(activePanel.id)}
                >
                  {t('deletePanel')}
                </button>
              </div>
            </div>
          )}
        </aside>

        {/* Right Main Canvas */}
        <main className="nm-main">
          {!bridge.supportsHostExec && (
            <div className="nm-inline-banner" style={{ margin: '10px 16px 0' }}>
              <span>{t('execUnavailable')}</span>
            </div>
          )}

          {showGlobalAlerts ? (
            <>
              <header className="nm-topbar">
                <div className="nm-topbar-left">
                  <h1 className="nm-page-title">{t('tabAlerts')}</h1>
                  <span className="nm-page-sub">{t('appSubtitle')}</span>
                </div>
              </header>
              <Suspense fallback={<div className="nm-content">{t('loadingData')}</div>}>
                <AlertsTab
                  alerts={engineSnap.alerts}
                  thresholds={thresholds}
                  locale={locale}
                  t={t}
                  onSaveThresholds={handleSaveThresholds}
                  onAckAlert={(id) => engine.acknowledgeAlert(id)}
                  onAckAll={() => engine.acknowledgeAllAlerts()}
                  onClearResolved={() => engine.clearResolvedAlerts()}
                />
              </Suspense>
            </>
          ) : focusedHost && activePanel ? (
            <Suspense fallback={<div className="nm-content">{t('loadingData')}</div>}>
              <HostWorkbench
                host={focusedHost}
                state={engineSnap.hosts[focusedHost.hostId]}
                interval={activePanel.interval}
                range={activePanel.range}
                alerts={engineSnap.alerts}
                thresholds={thresholds}
                visibleWidgets={visibleWidgets}
                engine={engine}
                bridge={bridge}
                locale={locale}
                t={t}
                onBack={() => setFocusedHostId(null)}
                onChangeRange={(r) => handleUpdatePanel({ range: r })}
                onToggleWidget={handleToggleWidget}
                onRetry={() => engine.retryHost(focusedHost.hostId)}
                onOpenSession={(mode) => void bridge.openHostSession(focusedHost, mode)}
                onExportSnapshot={(fmt) => handleExportSnapshot(fmt, focusedHost.hostId)}
                onSaveThresholds={handleSaveThresholds}
                onAckAlert={(id) => engine.acknowledgeAlert(id)}
                onAckAll={() => engine.acknowledgeAllAlerts()}
                onClearResolved={() => engine.clearResolvedAlerts()}
              />
            </Suspense>
          ) : activePanel ? (
            <>
              <header className="nm-topbar">
                <div className="nm-topbar-left">
                  <h1 className="nm-page-title">{activePanel.name}</h1>
                  {activePanel.description && <span className="nm-page-sub">{activePanel.description}</span>}
                </div>
              </header>
              <FleetOverview
                panel={activePanel}
                hosts={activePanelHosts}
                runtimeHosts={engineSnap.hosts}
                pinnedHostIds={pinnedSet}
                hiddenColumns={hiddenColumns}
                thresholds={thresholds}
                running={running}
                locale={locale}
                t={t}
                onUpdatePanel={handleUpdatePanel}
                onToggleRunning={() => setRunning((r) => !r)}
                onRefreshNow={() => engine.refreshAllNow()}
                onAddHosts={() => void handleAddHosts()}
                onRemoveHost={handleRemoveHost}
                onTogglePin={handleTogglePin}
                onReorderHost={handleReorderHost}
                onToggleColumn={handleToggleColumn}
                onInspectHost={(id) => setFocusedHostId(id)}
                onRetryHost={(id) => engine.retryHost(id)}
                onOpenSession={(host, mode) => void bridge.openHostSession(host, mode)}
                onExportSnapshot={(fmt) => handleExportSnapshot(fmt)}
              />
            </>
          ) : null}
        </main>
      </PluginSplitPane>

      {/* Panel Create / Edit Modal */}
      {panelModal && (
        <div className="nm-modal-backdrop">
          <div className="nm-modal-card">
            <h3 className="nm-panel-card-title">
              {panelModal.mode === 'create' ? t('newPanel') : t('editPanel')}
            </h3>
            <label className="nm-field-label">
              <span>{t('panelName')}</span>
              <input
                type="text"
                className="nm-input"
                maxLength={120}
                value={panelModal.name}
                onChange={(e) => setPanelModal((m) => (m ? { ...m, name: e.target.value } : null))}
              />
            </label>
            <label className="nm-field-label">
              <span>{t('panelDescription')}</span>
              <textarea
                className="nm-textarea"
                rows={3}
                maxLength={1000}
                value={panelModal.description}
                onChange={(e) => setPanelModal((m) => (m ? { ...m, description: e.target.value } : null))}
              />
            </label>
            <div className="nm-modal-actions">
              <button type="button" className="nm-btn" onClick={() => setPanelModal(null)}>
                {t('cancel')}
              </button>
              <button
                type="button"
                className="nm-btn nm-btn-primary"
                disabled={!panelModal.name.trim()}
                onClick={handleSavePanelModal}
              >
                {t('save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
