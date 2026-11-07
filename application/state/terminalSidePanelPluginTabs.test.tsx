import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('plugin tools stay in the toolbar and retain placement across catalog changes and remount', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'localStorage', 'StorageEvent', 'CustomEvent', 'Event']) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useTerminalSidePanelTabOrder, TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER } = await import('./terminalSidePanelTabs');
  const { STORAGE_KEY_TERMINAL_SIDE_PANEL_TAB_LAYOUT } = await import('../../infrastructure/config/storageKeys');
  const plugin = 'plugin-view:com.example.sidebar.page' as const;
  dom.window.localStorage.setItem(STORAGE_KEY_TERMINAL_SIDE_PANEL_TAB_LAYOUT, JSON.stringify({ order: TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER, placement: {} }));
  let model: ReturnType<typeof useTerminalSidePanelTabOrder>;
  let tools: typeof plugin[] = [];
  function Fixture() { model = useTerminalSidePanelTabOrder(tools); return <div />; }
  const root = createRoot(document.getElementById('root')!);
  const render = async () => { await act(async () => { root.render(<Fixture />); }); };
  try {
    await render();
    tools = [plugin]; await render();
    assert.equal(model!.sidePanelTabOrder[1], plugin, 'new plugin is a visible toolbar item');
    assert.ok(model!.partition([...TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER, plugin]).shown.includes(plugin));
    await act(async () => { model!.setPlacement(plugin, 'collapse', [...TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER, plugin]); });
    tools = []; await render();
    assert.ok(!model!.partition(TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER).collapsed.includes(plugin));
    tools = [plugin]; await render();
    assert.ok(model!.partition([...TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER, plugin]).collapsed.includes(plugin));
    await act(async () => { root.unmount(); });
    const nextRoot = createRoot(document.getElementById('root')!);
    tools = []; await act(async () => { nextRoot.render(<Fixture />); });
    tools = [plugin]; await act(async () => { nextRoot.render(<Fixture />); });
    assert.ok(model!.partition([...TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER, plugin]).collapsed.includes(plugin), 'cold catalog loading preserves preference');
    await act(async () => { nextRoot.unmount(); });
  } finally {
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); dom.window.close();
  }
});
