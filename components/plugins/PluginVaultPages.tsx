import { activeTabStore } from '../../application/state/activeTabStore';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { usePluginVaultPages } from '../../application/state/usePluginVaultPages';
import { usePluginViewBadges } from '../../application/state/usePluginViewBadges';
import { formatPluginViewBadgeAriaText, formatPluginViewBadgeLabel, isPluginViewBadgeVisible } from '../../domain/pluginViewBadge';
import { PluginContributionIcon } from './PluginContributionIcon';
import { PluginViewBadge } from './PluginViewBadge';
import { Button } from '../ui/button';
import { LazyPluginHostDrawnPage, prewarmPluginView } from './LazyPluginHostDrawnPage';

type VaultPages = ReturnType<typeof usePluginVaultPages>;
const subscribeHidden = (hide: () => void) => activeTabStore.subscribeSync((id) => { if (id !== 'vault') hide(); });

export function PluginVaultNavigation({ model, collapsed }: { model: VaultPages; collapsed: boolean }) {
  const badgesByViewId = usePluginViewBadges(model.pages.length > 0);
  if (!model.pages.length) return null;
  return <>
    {model.pages.map((page) => {
      const rawBadge = badgesByViewId.get(page.viewId);
      const activeBadge = isPluginViewBadgeVisible(rawBadge) ? rawBadge : null;
      const badgeLabel = formatPluginViewBadgeLabel(activeBadge);
      const badgeAria = formatPluginViewBadgeAriaText(activeBadge);
      const baseLabel = `${page.title} — ${page.pluginName}`;
      const title = activeBadge?.tooltip
        ? `${baseLabel} · ${activeBadge.tooltip}`
        : badgeLabel
          ? `${baseLabel} (${badgeLabel})`
          : baseLabel;
      const ariaLabel = badgeAria ? `${baseLabel} (${badgeAria})` : baseLabel;
      return <Button key={page.key} type="button"
        variant={model.selected?.key === page.key ? 'secondary' : 'ghost'}
        className={`w-full h-10 ${collapsed ? 'justify-center p-0' : 'justify-start gap-3'} ${model.selected?.key === page.key ? 'bg-foreground/10 text-foreground hover:bg-foreground/15 border-border/40' : ''}`}
        title={title}
        aria-label={ariaLabel}
        aria-current={model.selected?.key === page.key ? 'page' : undefined}
        onMouseEnter={() => prewarmPluginView(page.viewId)}
        onFocus={() => prewarmPluginView(page.viewId)}
        onClick={() => model.select(page.key)}>
        <span className="relative inline-flex shrink-0 items-center justify-center">
          <PluginContributionIcon pluginId={page.pluginId} icon={page.icon} size={16} className="shrink-0" />
          {collapsed && activeBadge && <PluginViewBadge badge={activeBadge} variant="overlay" />}
        </span>
        {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{page.title}</span>}
        {!collapsed && activeBadge && <PluginViewBadge badge={activeBadge} variant="inline" />}
      </Button>;
    })}
  </>;
}

export function PluginVaultPage({ model }: { model: VaultPages }) {
  const { t } = useI18n();
  const page = model.selected!;
  return <section className="flex min-h-0 flex-1 flex-col" aria-label={page.title} data-plugin-vault-page={page.key}>
    <LazyPluginHostDrawnPage pluginId={page.pluginId} viewId={page.viewId} version={page.version} slot="vault-page" active={model.active} context={model.context}
      subscribeHidden={subscribeHidden} unavailable={model.fallback} loadingLabel={t('plugins.vault.loading')} />
  </section>;
}
