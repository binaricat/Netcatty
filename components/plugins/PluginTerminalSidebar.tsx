import { useMemo } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { activeTabStore } from '../../application/state/activeTabStore';
import { subscribeSidePanelLiveSnapshot } from '../../application/state/sidePanelLiveStore';
import { usePluginContributions } from '../../application/state/usePluginContributions';
import { collectPluginTerminalSidebarPages, PLUGIN_TERMINAL_SIDEBAR_CONTEXT, requestOpenPluginTerminalSidebar,
  type PluginTerminalSidebarPage } from '../../application/state/usePluginTerminalSidebar';
import { PluginContributionIcon } from './PluginContributionIcon';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { PluginHostDrawnPage } from './PluginHostDrawnPage';

export function PluginTerminalSidebarLauncher({ sessionId, buttonClassName = 'h-6 w-6' }: { sessionId: string; buttonClassName?: string }) {
  const { locale } = useI18n();
  const contributions = usePluginContributions({ locale, context: PLUGIN_TERMINAL_SIDEBAR_CONTEXT });
  const pages = collectPluginTerminalSidebarPages(contributions.snapshot.plugins);
  if (!pages.length) return null;
  return <>{pages.map((page) => <Tooltip key={page.tool}>
    <TooltipTrigger asChild>
      <Button type="button" variant="ghost" size="icon" className={buttonClassName}
        aria-label={`${page.title} — ${page.pluginName}`}
        onClick={() => requestOpenPluginTerminalSidebar(page.viewId, sessionId)}>
        <PluginContributionIcon pluginId={page.pluginId} icon={page.icon} size={14} />
      </Button>
    </TooltipTrigger>
    <TooltipContent side="bottom">{page.title} — {page.pluginName}</TooltipContent>
  </Tooltip>)}</>;
}

export function PluginTerminalSidebarPageHost({ page, tabId, sessionId, getSession, unavailable, focused, showHeader = true }: {
  page: PluginTerminalSidebarPage;
  tabId: string;
  sessionId: string;
  getSession(): string | null;
  unavailable(): void;
  focused(): void;
  showHeader?: boolean;
}) {
  const { t } = useI18n();
  const subscribeHidden = useMemo(() => (hide: () => void) => {
    const stopTab = activeTabStore.subscribeSync((id) => { if (id !== tabId) hide(); });
    const stopSession = subscribeSidePanelLiveSnapshot(true, () => { if (getSession() !== sessionId) hide(); });
    return () => { stopTab(); stopSession(); };
  }, [getSession, sessionId, tabId]);
  return <section className="flex h-full min-h-0 flex-col overflow-hidden" aria-label={`${page.title} — ${page.pluginName}`} data-plugin-terminal-sidebar>
    {showHeader && <header className="flex h-7 shrink-0 items-center gap-2 border-b border-border px-2 text-xs"><PluginContributionIcon pluginId={page.pluginId} icon={page.icon} size={12} /><span className="truncate">{page.title}</span></header>}
    <div className="min-h-0 flex-1" onFocusCapture={focused}><PluginHostDrawnPage pluginId={page.pluginId} viewId={page.viewId} version={page.version} slot={`terminal-sidebar:${tabId}:${sessionId}`} active context={PLUGIN_TERMINAL_SIDEBAR_CONTEXT} subscribeHidden={subscribeHidden} unavailable={unavailable} loadingLabel={t('plugins.sidebar.loading')} /></div>
  </section>;
}
