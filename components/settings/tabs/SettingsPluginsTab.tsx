import { PluginThirdPartyMarket } from './PluginThirdPartyMarket';
import { usePluginUpdateCheck } from '../../../application/state/usePluginUpdateCheck';
import { usePluginManager } from '../../../application/state/usePluginManager';
import { PluginManagementDialog } from './PluginManagementDialog';
import { PluginMarketplace } from './PluginMarketplace';
import { PluginPackageManager } from './PluginPackageManager';
import { FolderOpen } from 'lucide-react';
import { PluginStatus } from './PluginStatus';
import { PluginSettingsLanding } from './PluginSettingsLanding';
import { useMemo, useRef, useState } from 'react';

import { usePluginContributions } from '../../../application/state/usePluginContributions';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs';
import { Button } from '../../ui/button';
import { SettingsAnchor, SettingsTabContent } from '../settings-ui';
import { PluginSettingsEntry, PluginSettingsDialog } from '../../plugins/PluginSettingsEntry';

function PluginManagementContent({ manager }: {
  manager: ReturnType<typeof usePluginManager>;
}) {
  const { t } = useI18n();
  const [catalogToolbar, setCatalogToolbar] = useState<HTMLDivElement | null>(null);
  const [selectedInstalled, setSelectedInstalled] = useState<string | null>(null);
  const [pluginView, setPluginView] = useState<'installed' | 'marketplace' | 'thirdparty'>('installed');
  return (
    <div className="space-y-5">
        <Tabs value={pluginView} onValueChange={(value) => { setSelectedInstalled(null); setPluginView(value as 'installed' | 'marketplace' | 'thirdparty'); }} className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList className="h-auto flex-wrap justify-start bg-muted/50">
            <TabsTrigger value="installed">{t('settings.plugins.manager.installed')} <span className="ml-2 text-muted-foreground">{manager.plugins.length}</span></TabsTrigger>
            <TabsTrigger value="marketplace">{t('settings.plugins.sources.official')}</TabsTrigger>
            <TabsTrigger value="thirdparty">{t('settings.plugins.sources.thirdparty')}</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-2">
          {pluginView === 'installed' && <PluginStatus noVault={manager.credentialStorageAvailable === false} />}
          <div ref={setCatalogToolbar} className="flex items-center gap-2" />
          <Button variant="outline" size="sm" disabled={!manager.available || manager.busy} onClick={() => { setPluginView('installed'); void manager.importPackage(); }}><FolderOpen size={14} className="mr-2" />{t('settings.plugins.manager.import')}</Button>
          </div>
        </div>
        <TabsContent forceMount hidden={pluginView !== 'marketplace'} value="marketplace" className="m-0 space-y-6"><PluginMarketplace installed={manager.plugins} toolbarContainer={pluginView === 'marketplace' ? catalogToolbar : undefined} noVault={manager.credentialStorageAvailable === false} /></TabsContent>
        <TabsContent forceMount hidden={pluginView !== 'thirdparty'} value="thirdparty" className="m-0 space-y-6"><PluginThirdPartyMarket installed={manager.plugins} toolbarContainer={pluginView === 'thirdparty' ? catalogToolbar : undefined} noVault={manager.credentialStorageAvailable === false} /></TabsContent>
        <TabsContent value="installed" className="m-0 space-y-6">
        <PluginPackageManager manager={manager} initialSelectedId={selectedInstalled} onSelectionChange={(id) => { setSelectedInstalled(id); }} detailActions={selectedInstalled && <PluginSettingsEntry key={`settings:${selectedInstalled}`} pluginId={selectedInstalled} />} />
        </TabsContent>
        </Tabs>
    </div>
  );
}


export default function SettingsPluginsTab() {
  const { locale } = useI18n();
  const manager = usePluginManager();
  const updates = usePluginUpdateCheck(manager.plugins);
  const [open, setOpen] = useState(false);
  const [settingsPluginId, setSettingsPluginId] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const managerButton = useRef<HTMLButtonElement | null>(null);
  const contributions = usePluginContributions({ locale, context: { 'netcatty.surface': 'settings' } });
  const settingsAvailable = useMemo(() => new Set(contributions.snapshot.plugins
    .filter((plugin) => plugin.settings.some((setting) => setting.visible))
    .map((plugin) => plugin.id)), [contributions.snapshot]);
  return (
    <SettingsTabContent value="plugins">
      <SettingsAnchor anchorId="plugins-root" className="space-y-6">
        <PluginSettingsLanding manager={manager} updates={updates} managerButtonRef={managerButton} settingsAvailable={settingsAvailable} settingsError={contributions.error?.message} onManage={(pluginId, element) => {
          opener.current = element;
          if (pluginId) setSettingsPluginId(pluginId);
          else setOpen(true);
        }} />
        <PluginManagementDialog open={open} onOpenChange={setOpen} trigger={null} restoreFocusTo={opener} fallbackFocusTo={managerButton}>
          <PluginManagementContent manager={manager} />
        </PluginManagementDialog>
        {settingsPluginId && <PluginSettingsDialog key={settingsPluginId} pluginId={settingsPluginId} onClose={() => setSettingsPluginId(null)} restoreFocusTo={opener} />}
      </SettingsAnchor>
    </SettingsTabContent>
  );
}
