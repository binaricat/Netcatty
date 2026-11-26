import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { toast } from '../../components/ui/toast';
import { collectSidePanelPanes, isPluginSidePanelTool, type SidePanelLayout } from '../../domain/sidePanelLayout';
import { activeTabStore } from './activeTabStore';
import { getSidePanelLiveSnapshot, subscribeSidePanelLiveSnapshot } from './sidePanelLiveStore';
import { usePluginContributions } from './usePluginContributions';
import { OPEN_PLUGIN_VIEW_EVENT, type OpenPluginViewDetail } from './usePluginViewLifecycle';

const noopSubscribe = () => () => {};
const getNullSnapshot = () => null;

export const OPEN_PLUGIN_TERMINAL_SIDEBAR_EVENT = 'netcatty:open-plugin-terminal-sidebar';
export const PLUGIN_TERMINAL_SIDEBAR_CONTEXT = Object.freeze({ 'netcatty.surface': 'terminal-sidebar' });
/** Required production view-context projection, not a plugin-facing API. */
export interface PluginSidebarHostActions {
  getActiveTerminalSessionId(): string | null;
  handleSwitchSidePanelTab(tool: import('../../domain/sidePanelLayout').SidePanelTool): void;
  handleWithdrawPluginSidebarPane(tabId: string, paneId: string, expectedTool: import('../../domain/sidePanelLayout').SidePanelTool): void;
}
export interface PluginTerminalSidebarPage {
  tool: `plugin-view:${string}`;
  viewId: string;
  pluginId: string;
  pluginName: string;
  version: string;
  title: string;
  icon?: NetcattyPluginIconReference;
  order: number;
}
export function collectPluginTerminalSidebarPages(plugins: NetcattyPluginContributionSnapshot['plugins']): PluginTerminalSidebarPage[] {
  return plugins.flatMap((plugin) => plugin.views.filter((view) => view.location === 'terminal-sidebar' && view.visible)
    .map((view): PluginTerminalSidebarPage => ({ tool: `plugin-view:${view.id}`, viewId: view.id, pluginId: plugin.id,
      pluginName: plugin.displayName, version: plugin.version, title: view.title, icon: view.icon, order: view.order ?? 0 })))
    .sort((a, b) => a.order - b.order || a.viewId.localeCompare(b.viewId));
}
export function requestOpenPluginTerminalSidebar(viewId: string, sessionId: string) {
  window.dispatchEvent(new CustomEvent(OPEN_PLUGIN_TERMINAL_SIDEBAR_EVENT, { detail: { viewId, sessionId } }));
}
export function usePluginTerminalSidebar(host: {
  layouts: ReadonlyMap<string, SidePanelLayout>;
  getSession(): string | null;
  isTerminalTab(tabId: string): boolean;
  select(tool: `plugin-view:${string}`): void;
  withdraw(tabId: string, paneId: string, tool: `plugin-view:${string}`): void;
}) {
  const { locale, t } = useI18n();
  const hostRef = useRef(host);
  hostRef.current = host;
  const query = useMemo(() => ({ locale, context: PLUGIN_TERMINAL_SIDEBAR_CONTEXT }), [locale]);
  const {
    available,
    loading,
    error,
    snapshot,
    refresh,
    executeCommand,
    updateSetting,
    resetSetting,
    selectSettingPath,
    setEnvironment,
    onViewClosed,
  } = usePluginContributions(query);
  const stableContributions = useMemo(
    () => ({
      available,
      loading,
      error,
      snapshot,
      refresh,
      executeCommand,
      updateSetting,
      resetSetting,
      selectSettingPath,
      setEnvironment,
      onViewClosed,
    }),
    [
      available,
      loading,
      error,
      snapshot,
      refresh,
      executeCommand,
      updateSetting,
      resetSetting,
      selectSettingPath,
      setEnvironment,
      onViewClosed,
    ],
  );
  const pages = useMemo(() => collectPluginTerminalSidebarPages(snapshot.plugins), [snapshot.plugins]);
  const hasPages = pages.length > 0;
  // Gate external store subscriptions via no-op subscribe/snapshot guards rather
  // than conditional hook calls so Rules of Hooks stay intact when pages toggle 0 <-> 1+.
  const subscribeActiveTab = useCallback(
    (listener: () => void) => (hasPages ? activeTabStore.subscribe(listener) : noopSubscribe()),
    [hasPages],
  );
  const getActiveTabSnapshot = useCallback(
    () => (hasPages ? activeTabStore.getActiveTabId() : null),
    [hasPages],
  );
  const activeTabId = useSyncExternalStore(
    subscribeActiveTab,
    getActiveTabSnapshot,
    getNullSnapshot,
  );
  // Follow workspace focus without subscribing the whole sidebar to cwd/title
  // or forwarding the host's live session DTO to a plugin.
  const subscribeFocusedSession = useCallback(
    (listener: () => void) => subscribeSidePanelLiveSnapshot(hasPages, listener),
    [hasPages],
  );
  const getFocusedSessionSnapshot = useCallback(
    () => (hasPages ? getSidePanelLiveSnapshot(true).focusedSessionId : null),
    [hasPages],
  );
  useSyncExternalStore(
    subscribeFocusedSession,
    getFocusedSessionSnapshot,
    getNullSnapshot,
  );
  const sessionId = hasPages && activeTabId && hostRef.current.isTerminalTab(activeTabId)
    ? hostRef.current.getSession()
    : null;
  useEffect(() => {
    if (!hasPages) return;
    const open = (event: Event) => {
      const detail = (event as CustomEvent<OpenPluginViewDetail & { sessionId?: string }>).detail;
      const page = pages.find((item) => item.viewId === detail?.viewId);
      if (!page) return;
      const tabId = activeTabStore.getActiveTabId();
      const current = hostRef.current.getSession();
      if (!hostRef.current.isTerminalTab(tabId) || !current || (detail.sessionId && detail.sessionId !== current)) {
        toast.info(t('plugins.sidebar.selectTerminal'));
        return;
      }
      hostRef.current.select(page.tool);
    };
    window.addEventListener(OPEN_PLUGIN_TERMINAL_SIDEBAR_EVENT, open);
    window.addEventListener(OPEN_PLUGIN_VIEW_EVENT, open);
    return () => { window.removeEventListener(OPEN_PLUGIN_TERMINAL_SIDEBAR_EVENT, open); window.removeEventListener(OPEN_PLUGIN_VIEW_EVENT, open); };
  }, [hasPages, pages, t]);
  const { layouts } = host;
  useEffect(() => {
    if (loading) return;
    const allowed = new Set(pages.map((page) => page.tool));
    for (const [tabId, layout] of layouts) for (const pane of collectSidePanelPanes(layout.root)) {
      if (isPluginSidePanelTool(pane.tool) && !allowed.has(pane.tool)) hostRef.current.withdraw(tabId, pane.id, pane.tool);
    }
  }, [layouts, loading, pages]);
  return useMemo(
    () => ({ pages, contributions: stableContributions, tabId: activeTabId, sessionId }),
    [activeTabId, pages, sessionId, stableContributions],
  );
}
