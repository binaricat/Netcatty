import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('terminal extension pages use actual split panes, focus and session ownership without sharing session data', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'SVGElement', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('PointerEvent', dom.window.MouseEvent);
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window)); install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window)); install('IS_REACT_ACT_ENVIRONMENT', true);
  const rectX = 200;
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => new dom.window.DOMRect(rectX, 100, 400, 300);
  const { default: React, act, useCallback, useRef, useState } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../application/i18n/I18nProvider');
  const { TooltipProvider } = await import('./ui/tooltip');
  const { activeTabStore } = await import('../application/state/activeTabStore');
  const { sidePanelLiveStore, SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT } = await import('../application/state/sidePanelLiveStore');
  const { useTerminalSidePanelLayoutState } = await import('../application/state/useTerminalSidePanelLayoutState');
  const { usePluginTerminalSidebar } = await import('../application/state/usePluginTerminalSidebar');
  const { PluginTerminalSidebarLauncher, PluginTerminalSidebarPageHost } = await import('./plugins/PluginTerminalSidebar');
  const { SidePanelLayoutTree } = await import('./terminalLayer/TerminalLayerSidePanelSection');
  const { PersistentSidePanelPortal } = await import('./terminalLayer/terminalLayerSidePanelSlots');
  const { collectSidePanelPanes } = await import('../domain/sidePanelLayout');
  type Tool = import('../domain/sidePanelLayout').SidePanelTool;
  let selectedSession = 'synthetic-session-a';
  const getSession = () => selectedSession;
  const a = { id: 'com.example.sidebar.first', title: 'First page', location: 'terminal-sidebar', visible: true };
  const b = { ...a, id: 'com.example.sidebar.second', title: 'Second page' };
  let snapshot = { locale: 'en', plugins: [{ id: 'com.example.sidebar', displayName: 'Synthetic plugin', version: '1.0.0', commands: [], keybindings: [], menus: [], settings: [], views: [a, b] }] };
  const changed = new Set<() => void>();
  const opens: NetcattyPluginViewOpenRequest[] = [];
  Object.assign(dom.window, { netcatty: {
    async getPluginRuntimeStatus() { return { available: true }; }, async getPluginContributions() { return snapshot; },
    onPluginContributionsChanged(fn: () => void) { changed.add(fn); return () => { changed.delete(fn); }; },
    onPluginViewClosed() { return () => {}; }, onHostDrawnPluginViewUpdate() { return () => {}; },
    async openHostDrawnPluginView(payload: NetcattyPluginViewOpenRequest) { opens.push(payload); return { instanceId: payload.instanceId! }; },
    async closeHostDrawnPluginView() {},
  } });
  let split!: () => void;
  function Fixture() {
    const state = useTerminalSidePanelLayoutState(); const latest = useRef(state); latest.current = state;
    const model = usePluginTerminalSidebar({ layouts: state.sidePanelLayouts, getSession, isTerminalTab: (id) => id === 'workspace-synthetic' || id === 'synthetic-local-terminal',
      select: (tool) => state.selectSidePanelToolForTab(activeTabStore.getActiveTabId(), tool),
      withdraw: (tabId, paneId, tool) => {
        const layout = state.sidePanelLayoutsRef.current.get(tabId);
        if (layout && collectSidePanelPanes(layout.root).some((pane) => pane.id === paneId && pane.tool === tool)) state.closePane(tabId, paneId);
      } });
    const [hosts, setHosts] = useState(new Map<Tool, HTMLElement>()); const parking = useRef<HTMLDivElement>(null);
    const register = useCallback((tool: Tool, host: HTMLElement | null) => setHosts((prior) => {
      if ((prior.get(tool) ?? null) === host) return prior;
      const next = new Map(prior); if (host) next.set(tool, host); else next.delete(tool); return next;
    }), []);
    const focusPane = useCallback((id: string) => latest.current.focusPane(activeTabStore.getActiveTabId(), id), []);
    const closePane = useCallback((id: string) => { latest.current.closePane(activeTabStore.getActiveTabId(), id); }, []);
    const resize = useCallback(() => {}, []);
    const layout = model.tabId ? state.sidePanelLayouts.get(model.tabId) : null;
    const panes = layout ? collectSidePanelPanes(layout.root) : [];
    split = () => state.splitPane('workspace-synthetic', `plugin-view:${b.id}`, 'vertical', { paneId: 'second-pane', splitId: 'plugin-split' }, 600);
    return <><PluginTerminalSidebarLauncher sessionId={selectedSession} />
      {layout && <SidePanelLayoutTree node={layout.root} layout={layout} paneCount={panes.length} labels={new Map(model.pages.map((page) => [page.tool, page.title]))}
        onClose={closePane} onFocus={focusPane} onHostChange={register} onResize={resize} separator="#777" accent="#4488cc" closePaneLabel="Close pane" resizeLabel="Resize" />}
      <div ref={parking} hidden aria-hidden="true" />
      {model.sessionId && panes.map((pane) => {
        const page = model.pages.find((item) => item.tool === pane.tool); const target = hosts.get(pane.tool) ?? parking.current;
        if (!page || !target) return null;
        return <PersistentSidePanelPortal key={`${pane.id}:${model.sessionId}`} portalKey={`plugin-${pane.id}`} target={target}>
          <PluginTerminalSidebarPageHost page={page} tabId={model.tabId!} sessionId={model.sessionId} getSession={getSession} showHeader={panes.length === 1} focused={() => focusPane(pane.id)} unavailable={() => closePane(pane.id)} />
        </PersistentSidePanelPortal>;
      })}</>;
  }
  const root = createRoot(document.getElementById('root')!); const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
  try {
    activeTabStore.setActiveTabId('workspace-synthetic'); sidePanelLiveStore.update({ ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT, focusedSessionId: selectedSession });
    await act(async () => { root.render(<I18nProvider locale="en"><TooltipProvider><Fixture /></TooltipProvider></I18nProvider>); await settle(); });
    assert.equal(document.querySelector('button[aria-label="Extension pages"]'), null, 'pages do not require opening a grouped menu');
    assert.ok(document.querySelector('button[aria-label="Second page — Synthetic plugin"]'), 'each contributed page has a direct toolbar button');
    const firstButton = document.querySelector<HTMLButtonElement>('button[aria-label="First page — Synthetic plugin"]')!;
    await act(async () => { firstButton.click(); await settle(); });
    assert.equal(document.querySelectorAll('[data-section="terminal-side-panel-pane"]').length, 1);
    assert.ok(document.querySelector('[data-pane-tool] [data-plugin-view-slot="terminal-sidebar"]'));
    assert.equal(document.querySelectorAll('[data-plugin-terminal-sidebar] header').length, 1);
    assert.equal(opens.length, 1); assert.deepEqual(opens[0].context, { 'netcatty.surface': 'terminal-sidebar' });
    await act(async () => { split(); await settle(); });
    assert.equal(document.querySelectorAll('[data-section="terminal-side-panel-pane"]').length, 2);
    assert.equal(document.querySelectorAll('[data-plugin-terminal-sidebar] header').length, 0, 'split pane headers already identify both pages');
    assert.equal(opens.length, 2);
    await act(async () => { document.querySelector<HTMLElement>(`[data-pane-tool="plugin-view:${a.id}"] [data-plugin-view-slot]`)!.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true })); await settle(); });
    assert.equal(document.querySelector(`[data-pane-tool="plugin-view:${a.id}"]`)?.getAttribute('data-focused'), 'true');
    await act(async () => { selectedSession = 'synthetic-session-b'; sidePanelLiveStore.update({ ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT, focusedSessionId: selectedSession }); await settle(); });
    assert.equal(opens.length, 4);
    assert.notEqual(opens[0].scopeId, opens[2].scopeId);
    assert.ok(opens.every((item) => JSON.stringify(item.context) === JSON.stringify({ 'netcatty.surface': 'terminal-sidebar' })));
    await act(async () => { snapshot = { ...snapshot, plugins: [{ ...snapshot.plugins[0], views: [{ ...a, visible: false }, b] }] }; for (const fn of changed) fn(); await settle(); });
    assert.equal(document.querySelectorAll('[data-section="terminal-side-panel-pane"]').length, 1);
    assert.equal(document.querySelector('[data-pane-tool]')?.getAttribute('data-pane-tool'), `plugin-view:${b.id}`);
    await act(async () => { activeTabStore.setActiveTabId('vault'); await settle(); });
    assert.equal(document.querySelector('[data-plugin-terminal-sidebar]'), null);
    await act(async () => { selectedSession = 'synthetic-local-terminal'; activeTabStore.setActiveTabId(selectedSession); await settle(); });
    const localPage = document.querySelector<HTMLButtonElement>('button[aria-label="Second page — Synthetic plugin"]')!;
    await act(async () => { localPage.click(); await settle(); });
    assert.ok(document.querySelector('[data-plugin-view-slot="terminal-sidebar"]'), 'standalone Local Terminal is a valid navigation owner');
    assert.deepEqual(opens.at(-1)!.context, { 'netcatty.surface': 'terminal-sidebar' });
  } finally {
    await act(async () => { root.unmount(); (await import('../application/state/pluginViewSession')).pluginViewSessions.dispose(); await settle(); }); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
