import { Activity, Box, CircuitBoard, Cog, Gauge, LayoutList, Loader2, Network, TerminalSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { SYSTEM_MANAGER_TAB_LAYOUT_DEFAULTS } from '../../application/state/systemManagerTabLayout';
import { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import { useToolbarItemLayout } from '../../application/state/useToolbarItemLayout';
import type { TerminalSettings } from '../../domain/models';
import type { Host } from '../../domain/models/connection';
import type { SystemManagerSubTab } from '../../domain/systemManager/types';
import { resolveCapabilityPanelState } from '../../domain/systemManagerPanelState';
import {
  allowSystemManagerMutations,
  buildSystemManagerTabs,
  shouldCollectServerStats,
} from '../../domain/systemManager/systemTarget';
import { hostRestrictsExtraSshChannels } from '../../domain/host';
import { partitionToolbarItems } from '../../domain/toolbarItemLayout';
import { STORAGE_KEY_SYSTEM_MANAGER_TAB_LAYOUT } from '../../infrastructure/config/storageKeys';
import type { Snippet, TerminalSession } from '../../types';
import { cn } from '../../lib/utils';
import { DockerManagerTab } from './DockerManagerTab';
import { GpuManagerTab } from './GpuManagerTab';
import { PortsManagerTab } from './PortsManagerTab';
import { ProcessManagerTab } from './ProcessManagerTab';
import { ServicesManagerTab } from './ServicesManagerTab';
import { SystemOverviewTab } from './SystemOverviewTab';
import { TmuxManagerTab } from './TmuxManagerTab';
import { WorkspaceSidebarHostHeader } from '../terminalLayer/WorkspaceSidebarHostHeader';
import { TERMINAL_SIDE_PANEL_INNER_HEADER_CLASS } from '../terminalLayer/terminalSidePanelChrome';
import { SystemPanelEmpty, SystemPanelShell } from './SystemPanelUi';
import { useSessionCapabilities } from '../../application/state/useSystemManager';
import {
  ToolbarCustomizeContextMenu,
  ToolbarOverflowMenu,
  type ToolbarCustomizeItem,
} from '../ui/toolbar-item-layout';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import {
  applyHorizontalWheelToScrollContainer,
  measureSystemManagerTabBarLabeledFit,
  resolveSystemManagerTabBarIconOnly,
  scrollSystemManagerTabIntoView,
  SYSTEM_MANAGER_TAB_BAR_ICON_ONLY_CLASS,
  SYSTEM_MANAGER_TAB_BAR_SETTLE_MS,
} from './systemManagerTabBarScroll';

const SystemPanelChecking = memo(function SystemPanelChecking({
  message,
}: {
  message: string;
}) {
  return (
    <div className="flex h-full min-h-[180px] flex-col items-center justify-center px-4 py-10 text-center text-xs text-muted-foreground">
      <Loader2 size={18} className="mb-2 animate-spin opacity-70" />
      <span>{message}</span>
    </div>
  );
});

interface SystemManagerSidePanelProps {
  session: TerminalSession | null;
  sessionHost: Host | null;
  showWorkspaceHostHeader?: boolean;
  isVisible: boolean;
  terminalSettings: TerminalSettings;
  snippets: Snippet[];
  onRequestTerminalFocus?: () => void;
}

export const SystemManagerSidePanel = memo(function SystemManagerSidePanel({
  session,
  sessionHost,
  showWorkspaceHostHeader = false,
  isVisible,
  terminalSettings,
  snippets,
  onRequestTerminalFocus,
}: SystemManagerSidePanelProps) {
  const { t } = useI18n();
  const backend = useSystemManagerBackend();
  const sessionId = session?.id ?? null;
  const isConnected = session?.status === 'connected';
  const systemManagerSupported = !hostRestrictsExtraSshChannels(sessionHost);

  const capabilitiesTtlMs = terminalSettings.systemManagerProcessRefreshInterval * 1000;

  const { capabilities, refreshCapabilities } = useSessionCapabilities(
    sessionId,
    isConnected,
    backend,
    isVisible && systemManagerSupported,
    capabilitiesTtlMs,
  );

  const availableTabs = useMemo(
    () => buildSystemManagerTabs(sessionHost, capabilities, session),
    [capabilities, session, sessionHost],
  );
  const availableTabsKey = availableTabs.join(',');
  const isStatsSupportedOs = useMemo(
    () => shouldCollectServerStats(sessionHost, capabilities, session),
    [capabilities, session, sessionHost],
  );
  const allowMutations = useMemo(
    () => allowSystemManagerMutations(sessionHost),
    [sessionHost],
  );

  const tabLayout = useToolbarItemLayout(
    STORAGE_KEY_SYSTEM_MANAGER_TAB_LAYOUT,
    SYSTEM_MANAGER_TAB_LAYOUT_DEFAULTS,
  );

  const tabDefs = useMemo(
    (): { id: SystemManagerSubTab; icon: LucideIcon; label: string }[] => [
      { id: 'overview', icon: Gauge, label: t('systemManager.tabs.overview') },
      { id: 'processes', icon: LayoutList, label: t('systemManager.tabs.processes') },
      { id: 'ports', icon: Network, label: t('systemManager.tabs.ports') },
      { id: 'services', icon: Cog, label: t('systemManager.tabs.services') },
      { id: 'tmux', icon: TerminalSquare, label: t('systemManager.tabs.tmux') },
      { id: 'docker', icon: Box, label: t('systemManager.tabs.docker') },
      { id: 'gpu', icon: CircuitBoard, label: t('systemManager.tabs.gpu') },
    ],
    [t],
  );
  const tabDefById = useMemo(
    () => new Map(tabDefs.map((tab) => [tab.id, tab])),
    [tabDefs],
  );

  // Host-available sections only; layout order / placement still covers the full set.
  const tabPartition = useMemo(
    () => tabLayout.partition(availableTabs),
    [availableTabs, tabLayout],
  );
  const shownTabs = tabPartition.shown as SystemManagerSubTab[];
  const collapsedTabs = tabPartition.collapsed as SystemManagerSubTab[];
  const reachableTabs = useMemo(
    () => [...shownTabs, ...collapsedTabs],
    [collapsedTabs, shownTabs],
  );

  // Customize menu lists every host-available section (including hidden) so
  // users can re-show hidden tabs; order follows persisted layout.
  const customizeItems = useMemo<ToolbarCustomizeItem[]>(() => {
    const available = new Set(availableTabs);
    return tabLayout.layout.order
      .filter((id): id is SystemManagerSubTab => available.has(id as SystemManagerSubTab))
      .map((id) => {
        const def = tabDefById.get(id);
        if (!def) return null;
        const Icon = def.icon;
        return {
          id,
          label: def.label,
          icon: <Icon size={12} />,
          locked: id === 'overview',
        } satisfies ToolbarCustomizeItem;
      })
      .filter((item): item is ToolbarCustomizeItem => item != null);
  }, [availableTabs, tabDefById, tabLayout.layout.order]);

  const [activeTab, setActiveTab] = useState<SystemManagerSubTab>('overview');
  const resolvedTab = reachableTabs.includes(activeTab)
    ? activeTab
    : (shownTabs[0] ?? collapsedTabs[0] ?? 'overview');

  const [tabBarEl, setTabBarEl] = useState<HTMLDivElement | null>(null);
  const tabBarRef = useCallback((node: HTMLDivElement | null) => {
    setTabBarEl((prev) => (prev === node ? prev : node));
  }, []);
  const [iconOnlyTabs, setIconOnlyTabs] = useState(false);
  const iconOnlyTabsRef = React.useRef(iconOnlyTabs);
  iconOnlyTabsRef.current = iconOnlyTabs;
  const isConnectedSession = Boolean(sessionId && session && isConnected);
  const shownTabsKey = shownTabs.join(',');

  // Icon-only when labeled tabs would overflow the real bar width (not a rem guess).
  // Debounced so side-panel drag does not thrash; re-check on pointerup.
  useEffect(() => {
    if (!isConnectedSession || !tabBarEl) return;

    let cancelled = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const applyCompact = () => {
      if (cancelled) return;
      const next = resolveSystemManagerTabBarIconOnly(
        measureSystemManagerTabBarLabeledFit(tabBarEl),
        iconOnlyTabsRef.current,
      );
      setIconOnlyTabs((prev) => (prev === next ? prev : next));
    };

    const scheduleCompact = () => {
      if (settleTimer != null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        applyCompact();
      }, SYSTEM_MANAGER_TAB_BAR_SETTLE_MS);
    };

    // Immediate measure (and again next frame after layout from tab mount/paint).
    applyCompact();
    const rafId = requestAnimationFrame(() => {
      if (!cancelled) applyCompact();
    });

    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          scheduleCompact();
        })
      : null;
    ro?.observe(tabBarEl);
    const shell = tabBarEl.closest('[data-section="system-manager-panel"]');
    if (shell instanceof HTMLElement && shell !== tabBarEl) {
      ro?.observe(shell);
    }

    // Side-panel drag ends on pointerup — re-measure even if RO was quiet.
    const onPointerUp = () => {
      scheduleCompact();
    };
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (settleTimer != null) clearTimeout(settleTimer);
      ro?.disconnect();
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [isConnectedSession, isVisible, availableTabsKey, shownTabsKey, tabBarEl]);

  // Keep the active sub-tab visible when the strip overflows (icon-only or labeled).
  useLayoutEffect(() => {
    if (!isConnectedSession || !tabBarEl) return;
    const active = tabBarEl.querySelector<HTMLElement>('[data-system-tab-active="true"]');
    scrollSystemManagerTabIntoView(tabBarEl, active, 'smooth');
  }, [resolvedTab, availableTabsKey, isConnectedSession, isVisible, tabBarEl, shownTabsKey, iconOnlyTabs]);

  // Vertical mouse wheel → horizontal scroll when the row overflows.
  useEffect(() => {
    if (!isConnectedSession || !tabBarEl) return;

    const onWheel = (event: WheelEvent) => {
      if (applyHorizontalWheelToScrollContainer(tabBarEl, event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    tabBarEl.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      tabBarEl.removeEventListener('wheel', onWheel);
    };
  }, [isConnectedSession, isVisible, availableTabsKey, tabBarEl]);

  // Must be defined before early returns to comply with React rules of hooks.
  const prevTabRef = React.useRef(resolvedTab);
  const probingRef = React.useRef(false);
  React.useEffect(() => {
    const prev = prevTabRef.current;
    prevTabRef.current = resolvedTab;
    if (prev === resolvedTab) return;
    if (resolvedTab === 'docker' && capabilities?.hasDocker !== true) {
      if (!probingRef.current) {
        probingRef.current = true;
        refreshCapabilities().finally(() => { probingRef.current = false; });
      }
    } else if (resolvedTab === 'tmux' && capabilities?.hasTmux !== true) {
      void refreshCapabilities();
    }
  }, [resolvedTab, capabilities, refreshCapabilities]);

  // Auto-poll for Docker capabilities while Docker tab is active and Docker not yet detected.
  // Use setTimeout recursion so the next probe only starts after the previous one finishes,
  // avoiding overlapping probes (e.g. SSH timeout 8s vs user-configured interval 2s).
  // First poll is delayed by one interval to avoid overlapping with the tab-switch probe above.
  //
  // Use a ref to store refreshCapabilities so that if its reference changes on every render,
  // the useEffect below is NOT re-run (which would cancel the timer and bypass the interval).
  const refreshRef = React.useRef(refreshCapabilities);
  refreshRef.current = refreshCapabilities;

  // Auto-poll for Docker capabilities while Docker tab is active and Docker not yet detected.
  // Each effect generation gets its own cancelled flag and timerId via closure,
  // preventing stale probes from surviving cleanup (unlike cancelledRef which is shared).
  // First poll is delayed by one interval to avoid overlapping with the tab-switch probe.
  React.useEffect(() => {
    if (!isVisible || resolvedTab !== 'docker' || capabilities?.hasDocker === true) return;

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout>;

    const pollOnce = async () => {
      if (cancelled) return;
      if (probingRef.current) {
        // probe is in-flight, reschedule for next cycle
        timerId = setTimeout(pollOnce, capabilitiesTtlMs);
        return;
      }
      probingRef.current = true;
      try {
        await refreshRef.current();
      } catch {
        // Transient error - keep polling next round
      }
      probingRef.current = false;
      if (cancelled) return;
      timerId = setTimeout(pollOnce, capabilitiesTtlMs);
    };

    timerId = setTimeout(pollOnce, capabilitiesTtlMs);

    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [isVisible, resolvedTab, capabilities?.hasDocker, capabilitiesTtlMs]);

  const selectTab = useCallback((id: SystemManagerSubTab) => {
    setActiveTab(id);
  }, []);

  const handleSetTabPlacement = useCallback(
    (id: string, placement: 'show' | 'collapse' | 'hide') => {
      const next = tabLayout.setPlacement(id, placement, availableTabs);
      // Hide of the active tab → jump to the first still-reachable section.
      if (activeTab === id && (next.placement[id] ?? 'show') === 'hide') {
        const part = partitionToolbarItems(next, availableTabs);
        const fallback = (part.shown[0] ?? part.collapsed[0]) as SystemManagerSubTab | undefined;
        if (fallback) setActiveTab(fallback);
      }
    },
    [activeTab, availableTabs, tabLayout],
  );

  const workspaceHostHeader = showWorkspaceHostHeader && sessionHost ? (
    <WorkspaceSidebarHostHeader
      host={sessionHost}
      section="terminal-system-host-header"
    />
  ) : null;

  if (!sessionId || !session) {
    return (
      <SystemPanelShell section="system-manager-panel">
        {workspaceHostHeader}
        <SystemPanelEmpty icon={Activity} message={t('systemManager.noSession')} />
      </SystemPanelShell>
    );
  }

  if (!isConnected) {
    return (
      <SystemPanelShell section="system-manager-panel">
        {workspaceHostHeader}
        <SystemPanelEmpty icon={Activity} message={t('systemManager.notConnected')} />
      </SystemPanelShell>
    );
  }

  if (!systemManagerSupported) {
    return (
      <SystemPanelShell section="system-manager-panel">
        {workspaceHostHeader}
        <SystemPanelEmpty icon={Activity} message={t('systemManager.unsupportedRemote')} />
      </SystemPanelShell>
    );
  }

  const tmuxReady = capabilities?.hasTmux === true;
  const dockerReady = capabilities?.hasDocker === true;
  const gpuReady = capabilities?.hasNvidiaSmi === true || capabilities?.hasNpuSmi === true;
  const portsReady = (
    capabilities?.hasSs === true
    || capabilities?.hasNetstat === true
    || capabilities?.hasLsof === true
  );
  const servicesReady = capabilities?.hasSystemctl === true;
  const tmuxPanelState = resolveCapabilityPanelState({
    isActive: resolvedTab === 'tmux',
    ready: tmuxReady,
    capabilitiesKnown: capabilities !== undefined,
  });
  const dockerPanelState = resolveCapabilityPanelState({
    isActive: resolvedTab === 'docker',
    ready: dockerReady,
    capabilitiesKnown: capabilities !== undefined,
  });
  const gpuPanelState = resolveCapabilityPanelState({
    isActive: resolvedTab === 'gpu',
    ready: gpuReady,
    capabilitiesKnown: capabilities !== undefined,
  });
  const portsPanelState = resolveCapabilityPanelState({
    isActive: resolvedTab === 'ports',
    ready: portsReady,
    capabilitiesKnown: capabilities !== undefined,
  });
  const servicesPanelState = resolveCapabilityPanelState({
    isActive: resolvedTab === 'services',
    ready: servicesReady,
    capabilitiesKnown: capabilities !== undefined,
  });

  return (
    <SystemPanelShell section="system-manager-panel">
      {workspaceHostHeader}
      <div
        ref={tabBarRef}
        className={cn(
          TERMINAL_SIDE_PANEL_INNER_HEADER_CLASS,
          'system-manager-tab-bar flex min-w-0 w-full items-center px-2 border-b border-border/50',
          iconOnlyTabs && SYSTEM_MANAGER_TAB_BAR_ICON_ONLY_CLASS,
        )}
        role="tablist"
        aria-label={t('systemManager.tabs.ariaLabel')}
        data-section="system-manager-tabs"
        data-icon-only={iconOnlyTabs ? 'true' : undefined}
      >
        <ToolbarCustomizeContextMenu
          items={customizeItems}
          placementOf={(id) => tabLayout.layout.placement[id] ?? 'show'}
          onSetPlacement={handleSetTabPlacement}
          onMove={(id, direction) =>
            tabLayout.move(id, direction, availableTabs)
          }
          onReset={tabLayout.reset}
          t={t}
          className="flex min-w-0 w-full items-center gap-0.5"
          dataSection="system-manager-tab-customize"
        >
          {shownTabs.map((id) => {
            const def = tabDefById.get(id);
            if (!def) return null;
            const { icon: Icon, label } = def;
            const isActive = resolvedTab === id;
            return (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    aria-label={label}
                    data-system-tab-active={isActive ? 'true' : undefined}
                    className={cn(
                      'system-manager-tab h-6 flex items-center gap-1.5 px-2 rounded text-[11px] transition-colors',
                      isActive
                        ? 'bg-muted text-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={(event) => {
                      selectTab(id);
                      scrollSystemManagerTabIntoView(tabBarEl, event.currentTarget, 'smooth');
                    }}
                  >
                    <Icon size={12} className="shrink-0" />
                    <span className="system-manager-tab-label">{label}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {label}
                </TooltipContent>
              </Tooltip>
            );
          })}
          <div className="ml-auto shrink-0" data-section="system-manager-tab-overflow">
            <ToolbarOverflowMenu
              hasItems={collapsedTabs.length > 0}
              label={t('common.more')}
              orientation="horizontal"
              buttonClassName="h-6 w-6 shrink-0 rounded-md p-0"
              contentClassName="min-w-[10rem] p-1"
            >
              <div className="flex min-w-[10rem] flex-col">
                {collapsedTabs.map((id) => {
                  const def = tabDefById.get(id);
                  if (!def) return null;
                  const { icon: Icon, label } = def;
                  const isActive = resolvedTab === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={cn(
                        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary',
                        isActive && 'bg-secondary font-medium',
                      )}
                      onClick={() => selectTab(id)}
                    >
                      <Icon size={12} className="shrink-0" />
                      <span className="truncate">{label}</span>
                    </button>
                  );
                })}
              </div>
            </ToolbarOverflowMenu>
          </div>
        </ToolbarCustomizeContextMenu>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {/* Keep Overview mounted (CSS-hidden) like other system tabs so shared
            server-stats cache + sparkline history survive tab switches. */}
        <div className={cn('flex-1 min-h-0 flex flex-col', resolvedTab !== 'overview' && 'hidden')}>
          <SystemOverviewTab
            sessionId={sessionId}
            isVisible={isVisible && resolvedTab === 'overview'}
            isSupportedOs={isStatsSupportedOs}
            refreshIntervalSec={terminalSettings.serverStatsRefreshInterval}
          />
        </div>
        {availableTabs.includes('processes') ? (
          <div className={cn('flex-1 min-h-0 flex flex-col', resolvedTab !== 'processes' && 'hidden')}>
            <ProcessManagerTab
              sessionId={sessionId}
              isVisible={isVisible && resolvedTab === 'processes'}
              backend={backend}
              refreshIntervalSec={terminalSettings.systemManagerProcessRefreshInterval}
            />
          </div>
        ) : null}
        {portsPanelState === 'unavailable' ? (
          <div className="flex-1 min-h-0">
            <SystemPanelEmpty icon={Network} message={t('systemManager.ports.unavailable')} />
          </div>
        ) : portsPanelState === 'checking' ? (
          <div className="flex-1 min-h-0">
            <SystemPanelChecking message={t('systemManager.common.checkingAvailability')} />
          </div>
        ) : portsPanelState === 'ready' ? (
          <div className={cn('flex-1 min-h-0 flex flex-col', resolvedTab !== 'ports' && 'hidden')}>
            <PortsManagerTab
              sessionId={sessionId}
              isVisible={isVisible && resolvedTab === 'ports'}
              backend={backend}
              refreshIntervalSec={terminalSettings.systemManagerProcessRefreshInterval}
              allowMutations={allowMutations}
            />
          </div>
        ) : null}
        {servicesPanelState === 'unavailable' ? (
          <div className="flex-1 min-h-0">
            <SystemPanelEmpty icon={Cog} message={t('systemManager.services.unavailable')} />
          </div>
        ) : servicesPanelState === 'checking' ? (
          <div className="flex-1 min-h-0">
            <SystemPanelChecking message={t('systemManager.common.checkingAvailability')} />
          </div>
        ) : servicesPanelState === 'ready' ? (
          <div className={cn('flex-1 min-h-0 flex flex-col', resolvedTab !== 'services' && 'hidden')}>
            <ServicesManagerTab
              sessionId={sessionId}
              isVisible={isVisible && resolvedTab === 'services'}
              backend={backend}
              refreshIntervalSec={terminalSettings.systemManagerProcessRefreshInterval}
              allowMutations={allowMutations}
            />
          </div>
        ) : null}
        {tmuxPanelState === 'unavailable' ? (
          <div className="flex-1 min-h-0">
            <SystemPanelEmpty icon={TerminalSquare} message={t('systemManager.tmux.unavailable')} />
          </div>
        ) : tmuxPanelState === 'checking' ? (
          <div className="flex-1 min-h-0">
            <SystemPanelChecking message={t('systemManager.common.checkingAvailability')} />
          </div>
        ) : tmuxPanelState === 'ready' ? (
          <div className={cn('flex-1 min-h-0 flex flex-col', resolvedTab !== 'tmux' && 'hidden')}>
            <TmuxManagerTab
              sessionId={sessionId}
              parentSession={session}
              isVisible={isVisible && resolvedTab === 'tmux'}
              warmupEnabled={isVisible && resolvedTab !== 'tmux'}
              backend={backend}
              refreshIntervalSec={terminalSettings.systemManagerTmuxRefreshInterval}
              snippets={snippets}
              onRequestTerminalFocus={onRequestTerminalFocus}
            />
          </div>
        ) : null}
        {dockerPanelState === 'unavailable' ? (
          <div className="flex-1 min-h-0">
            <SystemPanelEmpty icon={Box} message={t('systemManager.docker.unavailable')} />
          </div>
        ) : dockerPanelState === 'checking' ? (
          <div className="flex-1 min-h-0">
            <SystemPanelChecking message={t('systemManager.common.checkingAvailability')} />
          </div>
        ) : dockerPanelState === 'ready' ? (
          <div className={cn('flex-1 min-h-0 flex flex-col', resolvedTab !== 'docker' && 'hidden')}>
            <DockerManagerTab
              sessionId={sessionId}
              parentSession={session}
              isVisible={isVisible && resolvedTab === 'docker'}
              warmupEnabled={isVisible && resolvedTab !== 'docker'}
              backend={backend}
              listRefreshIntervalSec={terminalSettings.systemManagerDockerListRefreshInterval}
              statsRefreshIntervalSec={terminalSettings.systemManagerDockerStatsRefreshInterval}
            />
          </div>
        ) : null}
        {gpuPanelState === 'unavailable' ? (
          <div className="flex-1 min-h-0">
            <SystemPanelEmpty icon={CircuitBoard} message={t('systemManager.gpu.unavailable')} />
          </div>
        ) : gpuPanelState === 'checking' ? (
          <div className="flex-1 min-h-0">
            <SystemPanelChecking message={t('systemManager.common.checkingAvailability')} />
          </div>
        ) : gpuPanelState === 'ready' ? (
          <div className={cn('flex-1 min-h-0 flex flex-col', resolvedTab !== 'gpu' && 'hidden')}>
            <GpuManagerTab
              sessionId={sessionId}
              isVisible={isVisible && resolvedTab === 'gpu'}
              backend={backend}
              refreshIntervalSec={terminalSettings.systemManagerProcessRefreshInterval}
            />
          </div>
        ) : null}
      </div>
    </SystemPanelShell>
  );
});
