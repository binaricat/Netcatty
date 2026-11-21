import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../application/i18n/I18nProvider';
import { PluginHostDrawnPage } from '../../components/plugins/PluginHostDrawnPage';
import { PluginHostActionHost } from '../../components/plugins/PluginHostActionHost';
import { PluginHostInteractionHost } from '../../components/plugins/PluginHostInteractionHost';
import { registerAppAppLockRuntime, registerAppSettingsRuntime, registerAppVaultRuntime } from '../../application/state/appRuntimeBridge';
import { sanitizeHost } from '../../domain/host';
import type { Host } from '../../domain/models';
import '../../index.css';

const fixture = await (window as unknown as { fixture: { configuration(): Promise<{ host: Host }> } }).fixture.configuration();
const hosts = [sanitizeHost(fixture.host)];
const vault = { hosts, groupConfigs: [], customGroups: [], snippets: [], managedSources: [], keys: [], identities: [], proxyProfiles: [], knownHosts: [], isInitialized: true,
  readCurrentHostActionState: () => ({ hosts, groupConfigs: vault.groupConfigs, snippets: vault.snippets, managedSources: vault.managedSources }),
  readPersistedHosts: async () => hosts.map((host) => ({ ...host })),
};
registerAppVaultRuntime(vault as never);
registerAppAppLockRuntime({ initialized: true, locked: false } as never);
registerAppSettingsRuntime({ terminalSettings: { verifyHostKeys: false, keepaliveInterval: 30, keepaliveCountMax: 10 } } as never);
for (const [name, value] of Object.entries({ '--radius': '0.6rem', '--input': '0 0% 30%', '--background': '0 0% 10%', '--foreground': '0 0% 95%', '--secondary': '0 0% 18%', '--muted': '0 0% 16%', '--muted-foreground': '0 0% 70%', '--border': '0 0% 30%', '--primary': '210 90% 55%', '--primary-foreground': '0 0% 100%' })) document.documentElement.style.setProperty(name, value);
document.body.style.background = 'hsl(var(--background))';
document.documentElement.classList.add('dark');
const attached = Element.prototype.attachShadow;
Element.prototype.attachShadow = function (options) {
  const shadow = attached.call(this, options);
  (window as unknown as { testPluginShadow: ShadowRoot }).testPluginShadow = shadow;
  return shadow;
};
const surface = new URLSearchParams(location.search).get('surface') === 'sidebar' ? 'sidebar' : 'vault';
const slot = surface === 'sidebar' ? 'terminal-sidebar' : 'vault-page';
createRoot(document.getElementById('root')!).render(<I18nProvider locale="zh-CN">
  <div style={{ width: surface === 'sidebar' ? 360 : 880, height: 900, position: 'relative', margin: 'auto' }}>
    <PluginHostDrawnPage pluginId="com.netcatty.database-host" viewId={`com.netcatty.database-host.${surface}`} version="0.1.0" slot={slot} active context={{ 'netcatty.surface': slot }} subscribeHidden={() => () => {}} unavailable={() => { document.body.dataset.failure = 'true'; }} loadingLabel="正在加载数据库插件…" />
  </div>
  <PluginHostActionHost /><PluginHostInteractionHost />
</I18nProvider>);
