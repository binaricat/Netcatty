import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('landing settings entry targets the declared plugin and a manager tab roundtrip clears selection consistently', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'DocumentFragment', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent']) install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../../../application/i18n/I18nProvider');
  const { Tabs } = await import('../../ui/tabs');
  const { default: SettingsPluginsTab } = await import('./SettingsPluginsTab');
  const root = createRoot(document.getElementById('root')!);
  const plugin = { id: 'com.example.alpha', enabled: true, activeVersion: '1.0.0', archiveSha256: 'a'.repeat(64),
    source: { id: 'local', kind: 'local', name: 'Local import', origin: null },
    manifest: { manifestVersion: 1, id: 'com.example.alpha', name: 'Alpha', version: '1.0.0', publisher: 'example', engines: { netcatty: '>=0.0.0', api: '>=0.1.0-internal <0.2.0' }, main: { browser: 'index.js' }, contributes: { settings: [{ id: 'com.example.alpha.setting', label: 'Alpha setting', control: 'text', scope: 'application' }] } },
    runtime: { status: 'stopped', kind: null, lastError: null, quarantinedAt: null } };
  Object.assign(dom.window, { netcatty: {
    async getPluginRuntimeStatus() { return { available: true, experimental: true, credentialStorageAvailable: true }; },
    async listPlugins() { return [plugin]; },
    async setPluginEnabled() { throw new Error('Synthetic management failure'); },
    async getPluginLogStatus() { return { saveToDisk: false, verbose: false, droppedRecords: 0, writeErrors: 0, pendingBytes: 0, maxBytes: 3145728, retentionDays: 7 }; },
    async getPluginContributions() { return { locale: 'en', plugins: [{ id: plugin.id, version: '1.0.0', displayName: 'Alpha', description: 'Synthetic plugin', commands: [], keybindings: [], menus: [], views: [], settings: [{ id: 'com.example.alpha.setting', label: 'Alpha setting', control: 'text', scope: 'application', scopeId: 'application', value: 'synthetic', visible: true, configured: true }] }] }; },
    async getPluginScopeCatalog() { return { workspace: [], host: [], session: [], device: [] }; },
    async listPluginSources() { return []; },
    async listPluginCatalog() { return { entries: [], source: 'builtin', error: null }; },
    async getPluginPermissions() { return { grants: [], audit: [] }; },
  } });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
  const selectTab = async (name: string) => {
    const tab = [...document.querySelectorAll<HTMLElement>('[role=dialog] [role=tab]')].find((element) => element.textContent?.startsWith(name))!;
    assert.ok(tab, name);
    await act(async () => { tab.focus(); tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle(); });
  };
  try {
    await act(async () => { root.render(<I18nProvider locale="en"><Tabs defaultValue="plugins"><SettingsPluginsTab /></Tabs></I18nProvider>); await settle(); });
    const settings = document.querySelector<HTMLButtonElement>('button[aria-label="Settings for Alpha"]')!;
    assert.ok(settings);
    assert.equal(settings.disabled, false);
    await act(async () => { settings.focus(); settings.click(); await settle(); });
    assert.ok(document.querySelector('[data-plugin-settings-dialog]'));
    assert.ok(document.querySelector('input[aria-label="Alpha setting"]'));
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle(); });
    const browse = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Browse')!;
    await act(async () => { browse.focus(); browse.click(); await settle(); });
    await selectTab('Official');
    await selectTab('Installed');
    assert.equal(document.querySelector('[data-plugin-detail]'), null, 'returning to Installed shows the grid, not a stale deep-link detail');
    assert.equal(document.querySelector('input[aria-label="Alpha setting"]'), null);
    const card = document.querySelector<HTMLButtonElement>('[data-plugin-card="com.example.alpha"]')!;
    await act(async () => { card.click(); await settle(); });
    assert.ok(document.querySelector('[data-plugin-detail] button[aria-label="Settings for Alpha"]'), 'details offer the same settings entry');
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle(); });
    assert.equal(document.querySelector('[role=dialog]'), null);
    assert.equal(document.activeElement, browse);
    const toggle = document.querySelector<HTMLButtonElement>('button[aria-label="Disable Alpha"]')!;
    await act(async () => { toggle.click(); await settle(); });
    assert.match(document.querySelector('[role=alert]')!.textContent!, /Synthetic management failure/);
    assert.equal(toggle.getAttribute('aria-checked'), 'true', 'failed mutation retains actual host state');
    const refresh = document.querySelector<HTMLButtonElement>('button[aria-label="Refresh installed plugins"]')!;
    await act(async () => { refresh.click(); await settle(); });
    assert.equal(document.querySelector('[role=alert]'), null, 'explicit successful refresh clears an acknowledged manager error');
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
