import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('closing plugin overlays preserves the underlying plugin tab and closing that tab still removes it', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), netcatty: {
    async getPluginRuntimeStatus() { return { available: true }; },
    async getPluginContributions() { return { locale: 'en', plugins: [{ id: 'example.plugin', version: '1.0.0', displayName: 'Example',
      commands: [], keybindings: [], menus: [], settings: [], views: ['tab', 'modal', 'aside', 'panel'].map(location => ({
        id: `example.plugin.${location}`, title: location, location, visible: true,
      })) }] }; },
    onPluginContributionsChanged() { return () => {}; },
    async setPluginEnvironment() {},
  } });
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { usePluginViewLifecycle, requestOpenPluginView } = await import('./usePluginViewLifecycle');
  const { pluginViewTabStore } = await import('./pluginViewTabStore');
  const { activeTabStore } = await import('./activeTabStore');
  const context = { 'netcatty.surface': 'keybinding' };
  let model!: ReturnType<typeof usePluginViewLifecycle>;
  function Fixture() {
    model = usePluginViewLifecycle({ locale: 'en', theme: 'dark', keybindingContext: context });
    return React.createElement('button', { onClick: () => void model.close() }, model.activeView?.view.id ?? 'none');
  }
  const root = createRoot(document.getElementById('root')!);
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));
  const perform = async (action: () => void) => act(async () => { action(); await settle(); });
  try {
    activeTabStore.setActiveTabId('vault');
    const tab = pluginViewTabStore.open({ pluginId: 'example.plugin', pluginName: 'Example', viewId: 'example.plugin.tab', title: 'Tab' });
    await perform(() => root.render(React.createElement(Fixture)));
    assert.equal(model.activeView?.view.id, tab.viewId);
    for (const location of ['modal', 'aside', 'panel']) {
      await perform(() => requestOpenPluginView({ viewId: `example.plugin.${location}` }));
      assert.equal(model.activeView?.view.location, location);
      await perform(() => document.querySelector('button')!.click());
      assert.equal(activeTabStore.getActiveTabId(), tab.id, `closing ${location} preserves the active tab`);
      assert.equal(pluginViewTabStore.getTabs()[0]?.id, tab.id);
      assert.equal(model.activeView?.view.id, tab.viewId, `closing ${location} returns to the underlying view`);
    }
    await perform(() => document.querySelector('button')!.click());
    assert.equal(pluginViewTabStore.getTabs().length, 0, 'closing the tab itself still removes it');
  } finally {
    await act(async () => root.unmount());
    pluginViewTabStore.retain(new Set()); activeTabStore.setActiveTabId('vault'); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
