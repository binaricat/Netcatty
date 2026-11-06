import { Settings } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { usePluginContributions } from '../../application/state/usePluginContributions';
import { usePluginSettingsModel } from '../../application/state/usePluginSettingsModel';
import { useAvailableFonts } from '../../application/state/fontStore';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { PluginSettingGroups } from './PluginSettingsForm';

export const pluginSettingsButtonClass = 'h-8 w-8 shrink-0 rounded-full border border-border/60 bg-background/95 shadow-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

export function PluginSettingsDialog({ pluginId, onClose, restoreFocusTo }: {
  pluginId: string;
  onClose: () => void;
  restoreFocusTo: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const model = usePluginSettingsModel(pluginId);
  const fonts = useAvailableFonts();
  useEffect(() => {
    if (!model.loading && !model.error && !model.settings.length) onClose();
  }, [model.loading, model.error, model.settings.length, onClose]);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent data-plugin-settings-dialog={pluginId}
      className="app-no-drag flex max-h-[min(80dvh,760px)] w-[calc(100vw-2rem)] max-w-[720px] flex-col gap-0 overflow-hidden rounded-xl p-0"
      overlayClassName="bg-black/40"
      onEscapeKeyDown={event => event.stopPropagation()}
      onCloseAutoFocus={event => {
        const element = restoreFocusTo.current;
        if (element?.isConnected && !element.matches(':disabled')) {
          event.preventDefault(); element.focus({ preventScroll: true });
        }
      }}>
      <DialogHeader className="shrink-0 border-b border-border/60 px-6 py-4 pr-14">
        <DialogTitle className="flex min-w-0 items-center gap-2.5 text-base">
          <Settings size={18} aria-hidden="true" className="shrink-0 text-muted-foreground" />
          <span className="truncate">{model.plugin?.displayName ?? t('settings.plugins.configuration')}</span>
        </DialogTitle>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto p-6" data-plugin-settings-form="">
        {model.loading && <p role="status" className="text-sm text-muted-foreground">{t('settings.plugins.loading')}</p>}
        {model.error && <p role="alert" className="text-sm text-destructive">{model.error.message}</p>}
        {model.contextualScopes.length > 0 && <section className="mb-4 grid gap-3 sm:grid-cols-2" aria-label={t('settings.plugins.scopeTargets')}>
          {model.contextualScopes.map(kind => <label key={kind} className="space-y-1 text-xs font-medium">
            <span>{t('settings.plugins.scopeTarget').replace('{scope}', kind)}</span>
            <select value={model.scopeIds[kind] ?? ''}
              onChange={event => model.setScopeIds(current => ({ ...current, [kind]: event.target.value || undefined }))}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-normal">
              {!model.catalog[kind].length && <option value="">{t('settings.plugins.noScopeTargets')}</option>}
              {model.catalog[kind].map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>)}
        </section>}
        <div className="space-y-4">
          <PluginSettingGroups pluginId={pluginId} settings={model.settings} updateSetting={model.updateSetting}
            resetSetting={model.resetSetting} selectSettingPath={model.selectSettingPath} availableFonts={fonts} />
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}

function AvailableSettingsEntry({ pluginId, name }: { pluginId: string; name: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return <>
    <div className="flex items-center gap-3">
      <Button ref={opener} type="button" variant="ghost" size="icon" className={pluginSettingsButtonClass}
        aria-label={t('settings.plugins.landing.settingsFor').replace('{name}', name)} title={t('common.settings')}
        onClick={() => setOpen(true)}><Settings size={16} /></Button>
    </div>
    {open && <PluginSettingsDialog pluginId={pluginId} onClose={() => setOpen(false)} restoreFocusTo={opener} />}
  </>;
}

export function PluginSettingsEntry({ pluginId }: { pluginId: string }) {
  const { locale } = useI18n();
  const contributions = usePluginContributions({ locale, context: { 'netcatty.surface': 'settings' } });
  const plugin = contributions.snapshot.plugins.find(item => item.id === pluginId);
  if (!plugin?.settings.some(setting => setting.visible)) return null;
  // Removing or replacing the owning contribution also discards its open dialog.
  return <AvailableSettingsEntry key={`${plugin.id}:${plugin.version}`} pluginId={plugin.id} name={plugin.displayName} />;
}
