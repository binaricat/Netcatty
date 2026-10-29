import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('Vault navigation mounts a real content slot, yields to host dialogs, and withdraws stale pages', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'Event']) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key as keyof Window] });
  }
  for (const [key, value] of Object.entries({ getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 200, y: 100, width: 640, height: 480, top: 100, left: 200, right: 840, bottom: 580, toJSON() {} });
  const { default: React, act, useState } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { usePluginVaultPages } = await import('../application/state/usePluginVaultPages');
  const { PluginVaultNavigation, PluginVaultPage } = await import('./plugins/PluginVaultPages');
  const { activeTabStore } = await import('../application/state/activeTabStore');
  const { requestOpenPluginView } = await import('../application/state/usePluginViewLifecycle');
  const { I18nProvider } = await import('../application/i18n/I18nProvider');
  const page = { id: 'com.example.page.main', title: 'Synthetic page', location: 'vault-page', visible: true };
  let snapshot = { locale: 'en', plugins: [{ id: 'com.example.page', version: '1.0.0', displayName: 'Synthetic plugin', commands: [], keybindings: [], menus: [], settings: [], views: [page] }] };
  let changed: (() => void) | undefined;
  const listeners = new Set<(event: NetcattyPluginViewClosedEvent) => void>();
  const opens: NetcattyPluginViewOpenRequest[] = [], closes: string[] = [];
  Object.assign(dom.window, { netcatty: {
    async getPluginRuntimeStatus() { return { available: true }; },
    async getPluginContributions() { return snapshot; },
    onPluginContributionsChanged(fn: () => void) { changed = fn; return () => { changed = undefined; }; },
    onPluginViewClosed(fn: (event: NetcattyPluginViewClosedEvent) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    onHostDrawnPluginViewUpdate() { return () => {}; },
    async openHostDrawnPluginView(payload: NetcattyPluginViewOpenRequest) { opens.push(payload); return { instanceId: payload.instanceId! }; },
    async closeHostDrawnPluginView(id: string) { closes.push(id); },
  } });
  let selectSection!: (section: 'hosts' | `plugin-vault:${string}`) => void;
  function Fixture() {
    const [section, select] = useState<'hosts' | `plugin-vault:${string}`>('hosts'); selectSection = select;
    const model = usePluginVaultPages({ locale: 'en', section, select });
    return <><aside><button data-plugin-vault-fallback onClick={() => select('hosts')}>Hosts</button><PluginVaultNavigation model={model} collapsed={false} /></aside>
      <main data-section="vault-main">{model.selected ? <PluginVaultPage key={model.selected.key} model={model} /> : <p>Built-in hosts</p>}</main></>;
  }
  const root = createRoot(document.getElementById('root')!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 35));
  const clickPage = async () => { await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Synthetic page — Synthetic plugin"]')!.click(); await settle(); }); };
  try {
    activeTabStore.setActiveTabId('vault');
    await act(async () => { root.render(<I18nProvider locale="en"><Fixture /></I18nProvider>); await settle(); });
    assert.equal(opens.length, 0, 'catalog enumeration does not activate the plugin');
    await clickPage();
    assert.ok(document.querySelector('[data-section="vault-main"] [data-plugin-view-slot="vault-page"]'));
    assert.equal(opens.length, 1);
    assert.deepEqual(opens[0].context, { 'netcatty.surface': 'vault-page' }, 'no Vault/session data accompanies navigation');
    await act(async () => { activeTabStore.setActiveTabId('terminal:synthetic'); await settle(); });
    assert.equal(closes.length, 0, 'hiding keeps the logical view available');
    await act(async () => { activeTabStore.setActiveTabId('vault'); await settle(); });
    assert.equal(opens.length, 1, 'returning to Vault reuses the same plugin state');
    await act(async () => { snapshot = { ...snapshot, plugins: [] }; changed?.(); await settle(); });
    await act(async () => { await settle(); });
    // The main process owns immediate invalidation on disable/uninstall.
    await act(async () => { for (const listener of listeners) listener({ instanceId: opens[0].instanceId!, viewId: page.id, pluginId: 'com.example.page', reason: 'plugin-disabled' }); });
    assert.ok(closes.includes(opens[0].instanceId!));
    assert.equal(document.querySelector('[data-plugin-vault-page]'), null);
    assert.equal(document.activeElement?.textContent, 'Hosts');
    await act(async () => { selectSection('plugin-vault:missing'); await settle(); });
    assert.match(document.querySelector('main')!.textContent!, /Built-in hosts/);
    await act(async () => { snapshot = { ...snapshot, plugins: [{ id: 'com.example.page', version: '1.0.0', displayName: 'Synthetic plugin', commands: [], keybindings: [], menus: [], settings: [], views: [page] }] }; changed?.(); await settle(); });
    await act(async () => { requestOpenPluginView({ viewId: page.id }); await settle(); });
    assert.equal(opens.length, 2);
    await act(async () => { selectSection('hosts'); await settle(); });
    assert.equal(document.querySelector('[data-plugin-vault-page]'), null);
  } finally {
    await act(async () => { root.unmount(); (await import('../application/state/pluginViewSession')).pluginViewSessions.dispose(); await settle(); }); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
