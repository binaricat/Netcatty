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

test('tab switches do not tear down MutationObserver, call setPluginEnvironment, or re-query IPC without keybinding plugins', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  let observerConstructions = 0;
  let observerDisconnects = 0;
  let computedStyleCalls = 0;
  let matchMediaCalls = 0;
  let setEnvironmentCalls = 0;
  let contributionCalls = 0;
  let contributionsSubscribed = 0;
  let contributionsUnsubscribed = 0;

  class TrackingMutationObserver {
    constructor(callback: MutationCallback) {
      void callback;
      observerConstructions += 1;
    }
    observe() {}
    disconnect() {
      observerDisconnects += 1;
    }
    takeRecords() { return []; }
  }
  install('MutationObserver', TrackingMutationObserver);
  install('getComputedStyle', (element: Element) => {
    computedStyleCalls += 1;
    return dom.window.getComputedStyle(element);
  });
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);

  Object.assign(dom.window, {
    matchMedia: () => {
      matchMediaCalls += 1;
      return { matches: false, addEventListener() {}, removeEventListener() {} };
    },
    netcatty: {
      async getPluginRuntimeStatus() { return { available: true }; },
      async getPluginContributions(query?: NetcattyPluginContributionQuery) {
        contributionCalls += 1;
        return {
          locale: query?.locale ?? 'en',
          plugins: [{
            id: 'example.views-only',
            version: '1.0.0',
            displayName: 'Views Only',
            description: '',
            commands: [],
            keybindings: [],
            menus: [],
            settings: [],
            views: [{ id: 'example.views-only.tab', title: 'Tab', location: 'tab', visible: true }],
          }],
        };
      },
      onPluginContributionsChanged() {
        contributionsSubscribed += 1;
        return () => { contributionsUnsubscribed += 1; };
      },
      async setPluginEnvironment() {
        setEnvironmentCalls += 1;
      },
    },
  });

  const { _resetSharedPluginRuntimeStatusForTests } = await import('./pluginRuntimeStatusCache');
  _resetSharedPluginRuntimeStatusForTests();
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { usePluginViewLifecycle } = await import('./usePluginViewLifecycle');
  const { activeTabStore } = await import('./activeTabStore');
  const { pluginViewTabStore } = await import('./pluginViewTabStore');

  function Fixture({ locale, theme, tabId }: { locale: string; theme: string; tabId: string }) {
    const keybindingContext = React.useMemo(() => ({
      'netcatty.surface': 'keybinding',
      'netcatty.activeTabId': tabId,
      'terminal.sessionId': tabId,
    }), [tabId]);
    usePluginViewLifecycle({ locale, theme, keybindingContext });
    return null;
  }

  const root = createRoot(document.getElementById('root')!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  const perform = async (action: () => void) => act(async () => { action(); await settle(); });

  try {
    activeTabStore.setActiveTabId('term-a');
    await perform(() => root.render(React.createElement(Fixture, { locale: 'en', theme: 'dark', tabId: 'term-a' })));

    assert.equal(observerConstructions, 1);
    assert.equal(observerDisconnects, 0);
    assert.equal(matchMediaCalls, 3);
    assert.equal(computedStyleCalls, 1);
    assert.equal(setEnvironmentCalls, 1);
    const initialContributionCalls = contributionCalls;
    const initialSubscriptions = contributionsSubscribed;

    // Switch between terminal tabs repeatedly
    await perform(() => {
      activeTabStore.setActiveTabId('term-b');
      root.render(React.createElement(Fixture, { locale: 'en', theme: 'dark', tabId: 'term-b' }));
    });
    await perform(() => {
      activeTabStore.setActiveTabId('term-c');
      root.render(React.createElement(Fixture, { locale: 'en', theme: 'dark', tabId: 'term-c' }));
    });

    assert.equal(observerConstructions, 1, 'tab switch must not recreate MutationObserver');
    assert.equal(observerDisconnects, 0, 'tab switch must not disconnect MutationObserver');
    assert.equal(matchMediaCalls, 3, 'tab switch must not recreate matchMedia queries');
    assert.equal(computedStyleCalls, 1, 'tab switch must not trigger getComputedStyle');
    assert.equal(setEnvironmentCalls, 1, 'tab switch must not republish plugin environment');
    assert.equal(contributionCalls, initialContributionCalls, 'tab switch must not re-query IPC when 0 keybinding plugins exist');
    assert.equal(contributionsSubscribed, initialSubscriptions, 'tab switch must not resubscribe onPluginContributionsChanged');
    assert.equal(contributionsUnsubscribed, 0);

    // Real theme change still publishes environment without tearing down the observer
    await perform(() => root.render(React.createElement(Fixture, { locale: 'en', theme: 'light', tabId: 'term-c' })));
    assert.equal(setEnvironmentCalls, 2, 'real theme change must publish environment');
    assert.equal(observerConstructions, 1, 'theme change does not recreate MutationObserver');
    assert.equal(observerDisconnects, 0);
  } finally {
    await act(async () => root.unmount());
    pluginViewTabStore.retain(new Set());
    activeTabStore.setActiveTabId('vault');
    _resetSharedPluginRuntimeStatusForTests();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('context-sensitive keybinding plugins stay fail-closed during tab switch without tearing down MutationObserver or republishing environment', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'CustomEvent']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }

  let observerConstructions = 0;
  let observerDisconnects = 0;
  let setEnvironmentCalls = 0;
  const executedCommands: Array<{ command: string; context?: Record<string, unknown> }> = [];
  const changeListeners = new Set<() => void>();
  let keybindingPluginInstalled = false;
  let deferTabB = false;
  let resolveTabB: ((snapshot: NetcattyPluginContributionSnapshot) => void) | null = null;

  class TrackingMutationObserver {
    constructor(callback: MutationCallback) {
      void callback;
      observerConstructions += 1;
    }
    observe() {}
    disconnect() {
      observerDisconnects += 1;
    }
    takeRecords() { return []; }
  }
  install('MutationObserver', TrackingMutationObserver);
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const buildSnapshotForContext = (context?: Record<string, unknown>): NetcattyPluginContributionSnapshot => ({
    locale: 'en',
    plugins: keybindingPluginInstalled
      ? [{
          id: 'example.kb',
          version: '1.0.0',
          displayName: 'Keybinding Plugin',
          description: '',
          commands: [{ id: 'example.kb.run', title: 'Run', enabled: true }],
          keybindings: [{
            command: 'example.kb.run',
            key: 'ctrl+shift+k',
            enabled: context?.['netcatty.activeTabId'] === 'term-a',
          }],
          menus: [],
          settings: [],
          views: [],
        }]
      : [],
  });

  Object.assign(dom.window, {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    netcatty: {
      async getPluginRuntimeStatus() { return { available: true }; },
      getPluginContributions(query?: NetcattyPluginContributionQuery) {
        if (deferTabB && query?.context?.['netcatty.activeTabId'] === 'term-b') {
          return new Promise<NetcattyPluginContributionSnapshot>((resolve) => {
            resolveTabB = resolve;
          });
        }
        return Promise.resolve(buildSnapshotForContext(query?.context));
      },
      onPluginContributionsChanged(callback: () => void) {
        changeListeners.add(callback);
        return () => { changeListeners.delete(callback); };
      },
      async executePluginCommand(command: string, _args?: unknown, context?: Record<string, unknown>) {
        executedCommands.push({ command, context });
      },
      async setPluginEnvironment() {
        setEnvironmentCalls += 1;
      },
    },
  });

  const { _resetSharedPluginRuntimeStatusForTests } = await import('./pluginRuntimeStatusCache');
  _resetSharedPluginRuntimeStatusForTests();
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { usePluginViewLifecycle } = await import('./usePluginViewLifecycle');
  const { activeTabStore } = await import('./activeTabStore');
  const { pluginViewTabStore } = await import('./pluginViewTabStore');

  function Fixture({ tabId }: { tabId: string }) {
    const keybindingContext = React.useMemo(() => ({
      'netcatty.surface': 'keybinding',
      'netcatty.activeTabId': tabId,
      'terminal.sessionId': tabId,
    }), [tabId]);
    usePluginViewLifecycle({ locale: 'en', theme: 'dark', keybindingContext });
    return null;
  }

  const root = createRoot(document.getElementById('root')!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  const perform = async (action: () => void) => act(async () => { action(); await settle(); });
  const dispatchShortcut = () => {
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    }));
  };

  try {
    activeTabStore.setActiveTabId('term-a');
    await perform(() => root.render(React.createElement(Fixture, { tabId: 'term-a' })));
    assert.equal(observerConstructions, 1);
    assert.equal(setEnvironmentCalls, 1);

    // Install keybinding plugin and notify contributions changed
    keybindingPluginInstalled = true;
    await perform(() => {
      for (const listener of changeListeners) listener();
    });

    // Shortcut fires on term-a with full activeTabId/sessionId context
    await perform(dispatchShortcut);
    assert.equal(executedCommands.length, 1);
    assert.equal(executedCommands[0]?.command, 'example.kb.run');
    assert.equal(executedCommands[0]?.context?.['netcatty.activeTabId'], 'term-a');
    assert.equal(executedCommands[0]?.context?.['terminal.sessionId'], 'term-a');

    // Switch to term-b with in-flight contribution query
    deferTabB = true;
    await perform(() => {
      activeTabStore.setActiveTabId('term-b');
      root.render(React.createElement(Fixture, { tabId: 'term-b' }));
    });

    // While term-b query is pending, stale term-a keybinding MUST NOT fire (fail-closed)
    await perform(dispatchShortcut);
    assert.equal(executedCommands.length, 1, 'stale Tab A keybinding must not fire while Tab B query is in flight');
    assert.equal(observerConstructions, 1, 'context-sensitive reload must not recreate MutationObserver');
    assert.equal(observerDisconnects, 0, 'context-sensitive reload must not disconnect MutationObserver');
    assert.equal(setEnvironmentCalls, 1, 'context-sensitive reload must not republish plugin environment');

    // Resolve term-b query (keybinding disabled on term-b)
    assert.ok(resolveTabB, 'expected term-b query to be in flight');
    await perform(() => resolveTabB?.(buildSnapshotForContext({ 'netcatty.activeTabId': 'term-b' })));
    await perform(dispatchShortcut);
    assert.equal(executedCommands.length, 1, 'disabled Tab B keybinding must remain inactive');
    assert.equal(observerDisconnects, 0);
    assert.equal(setEnvironmentCalls, 1);
  } finally {
    await act(async () => root.unmount());
    pluginViewTabStore.retain(new Set());
    activeTabStore.setActiveTabId('vault');
    _resetSharedPluginRuntimeStatusForTests();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
