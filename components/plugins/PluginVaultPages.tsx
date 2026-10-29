import { activeTabStore } from '../../application/state/activeTabStore';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { usePluginVaultPages } from '../../application/state/usePluginVaultPages';
import { PluginContributionIcon } from './PluginContributionIcon';
import { Button } from '../ui/button';
import { PluginHostDrawnPage } from './PluginHostDrawnPage';

type VaultPages = ReturnType<typeof usePluginVaultPages>;
const subscribeHidden = (hide: () => void) => activeTabStore.subscribeSync((id) => { if (id !== 'vault') hide(); });

export function PluginVaultNavigation({ model, collapsed }: { model: VaultPages; collapsed: boolean }) {
  if (!model.pages.length) return null;
  return <>
    {model.pages.map((page) => <Button key={page.key} type="button"
      variant={model.selected?.key === page.key ? 'secondary' : 'ghost'}
      className={`w-full h-10 ${collapsed ? 'justify-center p-0' : 'justify-start gap-3'} ${model.selected?.key === page.key ? 'bg-foreground/10 text-foreground hover:bg-foreground/15 border-border/40' : ''}`}
      title={`${page.title} — ${page.pluginName}`}
      aria-label={`${page.title} — ${page.pluginName}`}
      aria-current={model.selected?.key === page.key ? 'page' : undefined}
      onClick={() => model.select(page.key)}>
      <PluginContributionIcon pluginId={page.pluginId} icon={page.icon} size={16} className="shrink-0" />
      {!collapsed && <span className="truncate">{page.title}</span>}
    </Button>)}
  </>;
}

export function PluginVaultPage({ model }: { model: VaultPages }) {
  const { t } = useI18n();
  const page = model.selected!;
  return <section className="flex min-h-0 flex-1 flex-col" aria-label={page.title} data-plugin-vault-page={page.key}>
    <PluginHostDrawnPage pluginId={page.pluginId} viewId={page.viewId} version={page.version} slot="vault-page" active={model.active} context={model.context}
      subscribeHidden={subscribeHidden} unavailable={model.fallback} loadingLabel={t('plugins.vault.loading')} />
  </section>;
}
