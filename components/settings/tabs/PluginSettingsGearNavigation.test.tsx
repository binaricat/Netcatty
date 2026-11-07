import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

async function fixture() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'DocumentFragment', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent']) install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../../../application/i18n/I18nProvider');
  const { Tabs } = await import('../../ui/tabs');
  const { default: SettingsPluginsTab } = await import('./SettingsPluginsTab');
  const { OPEN_PLUGIN_VIEW_EVENT } = await import('../../../application/state/usePluginViewLifecycle');
  const viewRequests: unknown[] = [];
  dom.window.addEventListener(OPEN_PLUGIN_VIEW_EVENT, (event) => viewRequests.push((event as CustomEvent).detail));
  const plugin = { id: 'com.example.alpha', enabled: true, activeVersion: '1.0.0', archiveSha256: 'a'.repeat(64),
    source: { id: 'local', kind: 'local', name: 'Local import', origin: null },
    manifest: { manifestVersion: 1, id: 'com.example.alpha', name: 'Alpha', version: '1.0.0', publisher: 'example', engines: { netcatty: '>=0.0.0', api: '>=0.1.0-internal <0.2.0' }, main: { browser: 'index.js' }, contributes: { settings: [{ id: 'com.example.alpha.setting', label: 'Alpha setting', control: 'text', scope: 'application' }] } },
    runtime: { status: 'stopped', kind: null, lastError: null, quarantinedAt: null } };
  let savedValue = 'synthetic';
  let rejectSave = false;
  let installed = plugin;
  let delayed = false;
  const pending: (() => void)[] = [];
  const listeners = new Set<() => void>();
  Object.assign(dom.window, { netcatty: {
    async getPluginRuntimeStatus() { return { available: true, experimental: true, credentialStorageAvailable: true }; },
    async listPlugins() { return [installed]; },
    onPluginContributionsChanged(callback: () => void) { listeners.add(callback); return () => listeners.delete(callback); },
    async getPluginLogStatus() { return { saveToDisk: false, verbose: false, droppedRecords: 0, writeErrors: 0, pendingBytes: 0, maxBytes: 3145728, retentionDays: 7 }; },
    async getPluginContributions(query: NetcattyPluginContributionQuery) {
      if (delayed && query.scopeIds) await new Promise<void>((resolve) => pending.push(resolve));
      if (!installed.enabled) return { locale: 'en', plugins: [] };
      return { locale: 'en', plugins: [{ id: plugin.id, version: '1.0.0', displayName: 'Alpha', commands: [], keybindings: [], menus: [], views: [{ id: 'com.example.alpha.page', title: 'Ordinary page', location: 'tab', visible: true }], settings: [{ id: 'com.example.alpha.setting', label: 'Alpha setting', control: 'text', scope: 'application', scopeId: 'application', value: savedValue, group: 'General', visible: true, configured: true }] }] };
    },
    async getPluginScopeCatalog() { return { workspace: [], host: [], session: [], device: [] }; },
    async listPluginSources() { return []; },
    async listPluginCatalog() { return { entries: [], source: 'builtin', error: null }; },
    async getPluginPermissions() { return { grants: [], audit: [] }; },
    async updatePluginSetting(_pluginId: string, _settingId: string, value: string) {
      if (rejectSave) throw new Error('Could not save');
      savedValue = value; return { restartRequired: false };
    },
    async resetPluginSetting() { savedValue = 'synthetic'; return { restartRequired: false }; },
  } });
  const root = createRoot(document.getElementById('root')!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
  const perform = async (action: () => void) => { await act(async () => { action(); await settle(); }); };
  await perform(() => root.render(<I18nProvider locale="en"><Tabs defaultValue="plugins"><SettingsPluginsTab /></Tabs></I18nProvider>));
  const gear = document.querySelector<HTMLButtonElement>('button[aria-label="Settings for Alpha"]')!;
  assert.ok(gear && !gear.disabled);
  return {
    gear, perform, viewRequests,
    rejectSave: (value: boolean) => { rejectSave = value; },
    section: () => document.querySelector<HTMLElement>('[data-plugin-settings-form]'),
    open: async (slow = false) => { delayed = slow; await perform(() => { gear.focus(); gear.click(); }); },
    release: async () => { delayed = false; await perform(() => { for (const resolve of pending.splice(0)) resolve(); }); },
    close: async () => { await perform(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); },
    disable: async () => { installed = { ...installed, enabled: false }; await perform(() => { for (const callback of [...listeners]) callback(); }); },
    refresh: async () => { await perform(() => { for (const callback of [...listeners]) callback(); }); },
    dispose: async () => {
      await act(async () => { root.unmount(); }); dom.window.close();
      for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    },
  };
}

test('gear opens a dedicated settings modal without management chrome and restores focus', async () => {
  const f = await fixture();
  try {
    await f.open();
    assert.ok(document.querySelector('[data-plugin-settings-dialog="com.example.alpha"]'));
    assert.equal(document.querySelector('[data-plugin-detail]'), null);
    assert.equal(document.querySelector('[role=dialog] [role=tablist]'), null);
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Alpha setting"]')!;
    input.focus(); await f.refresh();
    assert.equal(document.activeElement, input, 'refresh cannot steal focus');
    await f.close();
    assert.equal(document.querySelector('[role=dialog]'), null);
    assert.equal(document.activeElement, f.gear);
    assert.deepEqual(f.viewRequests, [], 'settings never open custom plugin pages');
  } finally { await f.dispose(); }
});

test('settings modal saves across reopening, reports failures and resets', async () => {
  const f = await fixture();
  try {
    await f.open();
    const section = f.section()!;
    assert.equal(document.querySelector('[data-host-security-surface]'), null);
    assert.equal(section.querySelector('h4')?.textContent, 'General');
    assert.doesNotMatch(section.textContent!, /com\.example\.alpha|Ordinary page/);
    assert.equal(section.querySelector('[data-plugin-remote-surface]'), null);
    const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Alpha setting"]')!;
    const edit = async (value: string) => {
      await f.perform(() => {
        input().focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
        input().dispatchEvent(new Event('input', { bubbles: true }));
        input().blur();
      });
    };
    await edit('Saved preference');
    await f.close(); await f.open();
    assert.equal(input().value, 'Saved preference');
    f.rejectSave(true); await edit('Rejected preference');
    assert.match(f.section()!.querySelector('[role=alert]')!.textContent!, /Could not save/);
    f.rejectSave(false);
    await f.close(); await f.open();
    assert.equal(input().value, 'Saved preference', 'failed save did not replace the stored value');
    await f.perform(() => [...f.section()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === 'Reset')!.click());
    assert.equal(input().value, 'synthetic');
    assert.deepEqual(f.viewRequests, [], 'settings never open custom plugin pages');
  } finally { await f.dispose(); }
});

test('a slow settings response renders in the modal and never reopens a dismissed modal', async () => {
  const f = await fixture();
  try {
    await f.open(true);
    assert.ok(document.querySelector('[role=dialog] [role=status]'));
    await f.release();
    assert.ok(document.querySelector('input[aria-label="Alpha setting"]'));
    await f.close(); await f.open(true); await f.close(); await f.release();
    assert.equal(document.querySelector('[role=dialog]'), null);
    assert.equal(document.activeElement, f.gear);
  } finally { await f.dispose(); }
});

test('removing settings contributions closes the open modal', async () => {
  const f = await fixture();
  try {
    await f.open(); await f.disable();
    assert.equal(document.querySelector('[data-plugin-settings-dialog]'), null);
  } finally { await f.dispose(); }
});

test('plugin details offer the same modal and Escape returns to the detail first', async () => {
  const f = await fixture();
  try {
    const browse = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Browse')!;
    await f.perform(() => { browse.focus(); browse.click(); });
    await f.perform(() => document.querySelector<HTMLButtonElement>('[data-plugin-card="com.example.alpha"]')!.click());
    assert.equal(f.section(), null, 'settings are not embedded below management content');
    const gear = document.querySelector<HTMLButtonElement>('[data-plugin-detail] button[aria-label="Settings for Alpha"]')!;
    assert.ok(gear);
    await f.perform(() => { gear.focus(); gear.click(); });
    assert.ok(f.section());
    await f.close();
    assert.equal(f.section(), null);
    assert.ok(document.querySelector('[data-plugin-detail]'));
    assert.equal(document.activeElement, gear);
    await f.close(); assert.equal(document.activeElement, browse);
  } finally { await f.dispose(); }
});
