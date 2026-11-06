import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('manual update action coalesces clicks, never runs on mount, and reports incomplete source checks honestly', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent']) install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../../../application/i18n/I18nProvider');
  const { PluginSettingsLanding } = await import('./PluginSettingsLanding');
  const { usePluginUpdateCheck } = await import('../../../application/state/usePluginUpdateCheck');
  const root = createRoot(document.getElementById('root')!);
  const source: NetcattyPluginSource = { id: 'official', kind: 'official', name: 'Official source', origin: 'https://plugins.example.com', enabled: true };
  const plugin = { id: 'com.example.alpha', enabled: false, activeVersion: '1.0.0', archiveSha256: 'a'.repeat(64), source,
    manifest: { manifestVersion: 1, id: 'com.example.alpha', name: 'Alpha', version: '1.0.0', publisher: 'example', engines: { netcatty: '>=0.0.0', api: '>=0.1.0-internal <0.2.0' }, main: { browser: 'index.js' } },
    runtime: { status: 'stopped', kind: null, lastError: null, quarantinedAt: null } } as NetcattyInstalledPlugin;
  const plugins = [plugin];
  const manager = { plugins, available: true, statusKnown: true, busy: false, error: null, credentialStorageAvailable: true, async refresh() {}, async setEnabled() {}, async importPackage() {}, async uninstall() {} };
  let catalogReads = 0; let mutations = 0; let offline = false;
  let release: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  Object.assign(dom.window, { netcatty: {
    async listPlugins() { return plugins; }, async listPluginSources() { return [source]; },
    async listPluginCatalog(id: string) { assert.equal(id, source.id); catalogReads++; await gate; return { entries: [{ id: plugin.id, version: '1.1.0', artifact: { url: 'https://plugins.example.com/synthetic.ncpkg', sha256: 'b'.repeat(64) } }], source: offline ? 'cached' : 'registry', error: offline ? 'synthetic offline' : null }; },
    async getPluginLogStatus() { return { saveToDisk: false, verbose: false, droppedRecords: 0, writeErrors: 0, pendingBytes: 0, maxBytes: 3145728, retentionDays: 7 }; },
    async installCatalogPlugin() { mutations++; }, async setPluginEnabled() { mutations++; }, async checkForUpdates() { mutations++; },
  } });
  function Page() { const updates = usePluginUpdateCheck(plugins); return <PluginSettingsLanding manager={manager} updates={updates} settingsAvailable={new Set()} onManage={() => {}} />; }
  const check = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Check for updates')!;
  try {
    await act(async () => root.render(<I18nProvider locale="en"><Page /></I18nProvider>));
    assert.equal(catalogReads, 0, 'rendering settings does not schedule checks');
    await act(async () => { const button = check(); button.click(); button.click(); });
    assert.equal(catalogReads, 1);
    assert.equal([...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Checking…')!.disabled, true);
    await act(async () => release());
    assert.match(document.body.textContent!, /Published updates: 1/);
    assert.match(document.body.textContent!, /Version 1.1.0 available/);
    assert.equal(mutations, 0);
    await act(async () => window.dispatchEvent(new Event('netcatty:plugin-packages-changed')));
    assert.doesNotMatch(document.body.textContent!, /Version 1.1.0 available/, 'source/package changes invalidate prior results');
    offline = true;
    await act(async () => check().click());
    assert.match(document.body.textContent!, /Checked: 0/);
    assert.match(document.body.textContent!, /Not checked: 1/);
    assert.match(document.body.textContent!, /Unavailable sources: 1/);
    assert.doesNotMatch(document.body.textContent!, /Version 1.1.0 available/);
    assert.equal(mutations, 0);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
