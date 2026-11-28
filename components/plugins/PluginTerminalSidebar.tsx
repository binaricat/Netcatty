import { useMemo } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { activeTabStore } from '../../application/state/activeTabStore';
import { subscribeSidePanelLiveSnapshot } from '../../application/state/sidePanelLiveStore';
import { usePluginContributions } from '../../application/state/usePluginContributions';
import { usePluginViewBadges } from '../../application/state/usePluginViewBadges';
import { collectPluginTerminalSidebarPages, PLUGIN_TERMINAL_SIDEBAR_CONTEXT, requestOpenPluginTerminalSidebar,
  type PluginTerminalSidebarPage } from '../../application/state/usePluginTerminalSidebar';
import { formatPluginViewBadgeAriaText, formatPluginViewBadgeLabel, isPluginViewBadgeVisible } from '../../domain/pluginViewBadge';
import { cn } from '../../lib/utils';
import { PluginContributionIcon } from './PluginContributionIcon';
import { PluginViewBadge } from './PluginViewBadge';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { LazyPluginHostDrawnPage, prewarmPluginView } from './LazyPluginHostDrawnPage';

export function PluginTerminalSidebarLauncher({ sessionId, buttonClassName = 'h-6 w-6' }: { sessionId: string; buttonClassName?: string }) {
  const { locale } = useI18n();
  const contributions = usePluginContributions({ locale, context: PLUGIN_TERMINAL_SIDEBAR_CONTEXT });
  const pages = collectPluginTerminalSidebarPages(contributions.snapshot.plugins);
  const badgesByViewId = usePluginViewBadges(pages.length > 0);
  if (!pages.length) return null;
  return <>{pages.map((page) => {
    const rawBadge = badgesByViewId.get(page.viewId);
    const activeBadge = isPluginViewBadgeVisible(rawBadge) ? rawBadge : null;
    const badgeLabel = formatPluginViewBadgeLabel(activeBadge);
    const badgeAria = formatPluginViewBadgeAriaText(activeBadge);
    const baseLabel = `${page.title} — ${page.pluginName}`;
    const tooltip = activeBadge?.tooltip
      ? `${baseLabel} · ${activeBadge.tooltip}`
      : badgeLabel
        ? `${baseLabel} (${badgeLabel})`
        : baseLabel;
    const ariaLabel = badgeAria ? `${baseLabel} (${badgeAria})` : baseLabel;
    return <Tooltip key={page.tool}>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className={cn('relative overflow-visible', buttonClassName)}
          aria-label={ariaLabel}
          onMouseEnter={() => prewarmPluginView(page.viewId)}
          onFocus={() => prewarmPluginView(page.viewId)}
          onClick={() => requestOpenPluginTerminalSidebar(page.viewId, sessionId)}>
          <PluginContributionIcon pluginId={page.pluginId} icon={page.icon} size={14} />
          {activeBadge && <PluginViewBadge badge={activeBadge} variant="compact-overlay" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>;
  })}</>;
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
    <div className="min-h-0 flex-1" onFocusCapture={focused}><LazyPluginHostDrawnPage pluginId={page.pluginId} viewId={page.viewId} version={page.version} slot={`terminal-sidebar:${tabId}:${sessionId}`} active context={PLUGIN_TERMINAL_SIDEBAR_CONTEXT} subscribeHidden={subscribeHidden} unavailable={unavailable} loadingLabel={t('plugins.sidebar.loading')} /></div>
  </section>;
}
