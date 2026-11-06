import { X } from 'lucide-react';

import { useI18n } from '../../application/i18n/I18nProvider';
import {
  requestOpenPluginView,
  usePluginViewLifecycle,
} from '../../application/state/usePluginViewLifecycle';
import { Button } from '../ui/button';
import { PluginContributionIcon } from './PluginContributionIcon';
import { PluginHostDrawnPage } from './PluginHostDrawnPage';

export { requestOpenPluginView };

const subscribeNoop = () => () => {};

const DEFAULT_KEYBINDING_CONTEXT = Object.freeze({ 'netcatty.surface': 'keybinding' });

export function PluginContributionHost({
  locale,
  theme,
  themeTokens: suppliedThemeTokens,
  keybindingContext = DEFAULT_KEYBINDING_CONTEXT,
}: {
  locale: string;
  theme: string;
  themeTokens?: Record<string, string>;
  keybindingContext?: Record<string, unknown>;
}) {
  const { t } = useI18n();
  const {
    activeView,
    close,
    effectiveRequested,
    viewQueryContext,
  } = usePluginViewLifecycle({
    locale,
    theme,
    suppliedThemeTokens,
    keybindingContext,
  });

  if (!effectiveRequested || !activeView) return null;
  const location = activeView.view.location;
  const content = <PluginHostDrawnPage pluginId={activeView.plugin.id} viewId={activeView.view.id} version={activeView.plugin.version} slot={`view:${activeView.view.id}`} active context={viewQueryContext}
        subscribeHidden={subscribeNoop} unavailable={() => void close()} loadingLabel={t('plugins.vault.loading')} />;
  const containerClass = location === 'aside'
    ? 'absolute inset-y-0 right-0 z-40 w-[420px] border-l border-border bg-background shadow-2xl'
    : location === 'tab'
      ? 'absolute inset-0 z-40 flex p-2 pt-0'
    : location === 'panel'
      ? 'absolute inset-x-0 bottom-0 z-40 h-[42%] border-t border-border bg-background shadow-2xl'
      : location === 'modal'
        ? 'fixed left-1/2 top-1/2 z-40 h-[70vh] w-[min(800px,85vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background shadow-2xl'
        : 'absolute inset-0 z-40 bg-background';

  if (location === 'tab') {
    return (
      <section className={containerClass} role="region" aria-label={activeView.view.title}>
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border border-border/60 bg-background shadow-sm">
          {content}
        </div>
      </section>
    );
  }

  return (
    <section
      className={`${containerClass} flex flex-col`}
      role={location === 'modal' ? 'dialog' : 'region'}
      data-plugin-dialog={location === 'modal' ? 'true' : undefined}
      aria-modal={location === 'modal' ? true : undefined}
      aria-label={activeView.view.title}
    >
      <header className="app-no-drag flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <PluginContributionIcon pluginId={activeView.plugin.id} icon={activeView.view.icon} className="shrink-0" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{activeView.view.title}</div>
            <div className="truncate text-[10px] text-muted-foreground">{activeView.plugin.displayName}</div>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => void close()}
          aria-label={t('common.close')}
          autoFocus={location === 'modal'}
        >
          <X size={14} />
        </Button>
      </header>
      <div className={location === 'modal' ? 'flex min-h-0 flex-1 p-3' : 'flex min-h-0 flex-1'}>
        {content}
      </div>
    </section>
  );
}
