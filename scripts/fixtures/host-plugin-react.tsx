import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PluginHostDrawnPage } from '../../components/plugins/PluginHostDrawnPage';
import '../../index.css';
import { I18nProvider } from '../../application/i18n/I18nProvider';
import { usePluginContributions } from '../../application/state/usePluginContributions';
import { PluginSettingGroups } from '../../components/plugins/PluginSettingsForm';
import { useAvailableFonts } from '../../application/state/fontStore';
for (const [name, value] of Object.entries({ '--radius': '0.6rem', '--input': '0 0% 30%', '--background': '0 0% 10%', '--foreground': '0 0% 95%', '--muted': '0 0% 16%', '--muted-foreground': '0 0% 70%', '--border': '0 0% 30%', '--primary': '210 90% 55%', '--primary-foreground': '0 0% 100%' })) document.documentElement.style.setProperty(name, value);
document.body.style.background = 'hsl(var(--background))';
const attached = Element.prototype.attachShadow;
Element.prototype.attachShadow = function (init) {
  const root = attached.call(this, init);
  if (!this.closest('[data-plugin-view-popover]')) (window as typeof window & { testPluginShadow?: ShadowRoot }).testPluginShadow = root;
  return root;
};
const name = new URLSearchParams(location.search).get('view') || 'vault';
const surface = name === 'vault' ? 'vault-page' : name === 'sidebar' ? 'terminal-sidebar' : name;
const context = Object.freeze({ 'netcatty.surface': surface });
const subscribeHidden = () => () => {};
const unavailable = () => { document.body.dataset.failure = 'true'; };
const settingsQuery = { locale: 'zh-CN', context: { 'netcatty.surface': 'settings' } };
function SettingsFixture() {
  const contributions = usePluginContributions(settingsQuery);
  const fonts = useAvailableFonts();
  const plugin = contributions.snapshot.plugins[0];
  return <main className="mx-auto max-w-2xl space-y-4 p-6 text-foreground" data-settings-fixture="" data-loading={contributions.loading} data-available={contributions.available} data-count={contributions.snapshot.plugins.length}>
    <h2 className="text-xl font-semibold">你好，React · 插件设置</h2>
    {plugin && <PluginSettingGroups pluginId={plugin.id} settings={plugin.settings} updateSetting={contributions.updateSetting}
      resetSetting={contributions.resetSetting} selectSettingPath={contributions.selectSettingPath} availableFonts={fonts} />}
    {contributions.error && <p role="alert">{contributions.error.message}</p>}
  </main>;
}
function Fixture() {
  const [visible, setVisible] = useState(true);
  return <div style={{ width: 600, height: 500, position: 'relative' }}>
  {visible && <PluginHostDrawnPage pluginId="com.netcatty.hello-react-host" viewId={new URLSearchParams(location.search).get('id') || `com.netcatty.hello-react-host.${name}`} version="0.2.0" slot={surface} active context={context} subscribeHidden={subscribeHidden} unavailable={unavailable} loadingLabel="Loading" />}
  <div id="host-overlay" style={{ position: 'absolute', top: 20, left: 20, width: 100, height: 50, zIndex: 10, background: 'red' }}>Host menu</div>
  <button id="toggle-plugin" style={{ position: 'absolute', left: 0, top: 520 }} onClick={() => setVisible(value => !value)}>Toggle plugin</button>
  <input id="host-private-input" aria-label="Host-only input" style={{ position: 'absolute', left: 150, top: 520 }} />
</div>;
}
createRoot(document.getElementById('root')!).render(<I18nProvider locale="zh-CN">{name === 'settings-form' ? <SettingsFixture /> : <Fixture />}</I18nProvider>);
