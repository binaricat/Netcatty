import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  canReusePluginContributionSnapshot,
  collectOwnedPluginMenus,
  createPluginContributionRefreshGuard,
  failClosedPluginContributionLoad,
  resolvePluginContributionLoadState,
  usePluginContributions,
  type UsePluginContributionsOptions,
  type UsePluginContributionsResult,
} from './usePluginContributions';
import { _resetSharedPluginRuntimeStatusForTests } from './pluginRuntimeStatusCache';

function Probe() {
  const contributions = usePluginContributions();
  return (
    <span>
      {contributions.available ? 'available' : 'unavailable'}:{contributions.snapshot.plugins.length}
    </span>
  );
}

test('plugin contributions fail closed during server rendering', () => {
  assert.equal(renderToStaticMarkup(<Probe />), '<span>unavailable:0</span>');
});

test('plugin contribution refresh failures discard the last successful snapshot', () => {
  const failure = failClosedPluginContributionLoad('bridge unavailable');
  assert.equal(failure.available, false);
  assert.equal(failure.snapshot.plugins.length, 0);
  assert.match(failure.error.message, /bridge unavailable/u);
});

test('plugin contribution query changes hide the prior snapshot synchronously without flipping runtime availability', () => {
  const staleSnapshot = {
    locale: 'en',
    plugins: [{ id: 'com.example.stale' }],
  } as NetcattyPluginContributionSnapshot;
  const selected = resolvePluginContributionLoadState({
    currentQueryKey: '{"context":{"terminal.sessionId":"session-2"}}',
    loadedQueryKey: '{"context":{"terminal.sessionId":"session-1"}}',
    snapshot: staleSnapshot,
    available: true,
    loading: false,
  });

  assert.equal(selected.available, true);
  assert.equal(selected.loading, true);
  assert.equal(selected.snapshot.plugins.length, 0);

  const unavailable = resolvePluginContributionLoadState({
    currentQueryKey: '{"context":{"terminal.sessionId":"session-2"}}',
    loadedQueryKey: '{"context":{"terminal.sessionId":"session-1"}}',
    snapshot: staleSnapshot,
    available: false,
    loading: false,
  });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.loading, true);
  assert.equal(unavailable.snapshot.plugins.length, 0);

  const reused = resolvePluginContributionLoadState({
    currentQueryKey: '{"context":{"terminal.sessionId":"session-2"}}',
    loadedQueryKey: '{"context":{"terminal.sessionId":"session-1"}}',
    snapshot: staleSnapshot,
    available: true,
    loading: false,
    reuseSnapshot: true,
  });
  assert.equal(reused.available, true);
  assert.equal(reused.loading, false);
  assert.equal(reused.snapshot, staleSnapshot);
});

test('canReusePluginContributionSnapshot short-circuits only when settled and context-insensitive', () => {
  const emptySnapshot: NetcattyPluginContributionSnapshot = { locale: 'en', plugins: [] };
  const pluginWithoutKeybindings = {
    locale: 'en',
    plugins: [{ id: 'com.example.theme', keybindings: [] }],
  } as unknown as NetcattyPluginContributionSnapshot;
  const pluginWithKeybindings = {
    locale: 'en',
    plugins: [{ id: 'com.example.kb', keybindings: [{ command: 'run', key: 'ctrl+k', enabled: true }] }],
  } as unknown as NetcattyPluginContributionSnapshot;

  assert.equal(canReusePluginContributionSnapshot({
    settled: false,
    available: true,
    error: null,
    currentRevision: 0,
    loadedRevision: 0,
    currentLocale: 'en',
    loadedLocale: 'en',
    snapshot: emptySnapshot,
  }), false);

  assert.equal(canReusePluginContributionSnapshot({
    settled: true,
    available: false,
    error: null,
    currentRevision: 0,
    loadedRevision: 0,
    currentLocale: 'en',
    loadedLocale: 'en',
    snapshot: emptySnapshot,
  }), true);

  assert.equal(canReusePluginContributionSnapshot({
    settled: true,
    available: true,
    error: null,
    currentRevision: 0,
    loadedRevision: 0,
    currentLocale: 'en',
    loadedLocale: 'en',
    snapshot: emptySnapshot,
  }), true);

  assert.equal(canReusePluginContributionSnapshot({
    settled: true,
    available: true,
    error: null,
    currentRevision: 1,
    loadedRevision: 0,
    currentLocale: 'en',
    loadedLocale: 'en',
    snapshot: emptySnapshot,
  }), false);

  assert.equal(canReusePluginContributionSnapshot({
    settled: true,
    available: true,
    error: null,
    currentRevision: 0,
    loadedRevision: 0,
    currentLocale: 'fr',
    loadedLocale: 'en',
    snapshot: emptySnapshot,
  }), false);

  assert.equal(canReusePluginContributionSnapshot({
    settled: true,
    available: true,
    error: null,
    currentRevision: 0,
    loadedRevision: 0,
    currentLocale: 'en',
    loadedLocale: 'en',
    snapshot: pluginWithoutKeybindings,
  }), false);

  const hasKeybindings = (snapshot: NetcattyPluginContributionSnapshot) =>
    snapshot.plugins.some((plugin) => plugin.keybindings.length > 0);
  assert.equal(canReusePluginContributionSnapshot({
    settled: true,
    available: true,
    error: null,
    currentRevision: 0,
    loadedRevision: 0,
    currentLocale: 'en',
    loadedLocale: 'en',
    snapshot: pluginWithoutKeybindings,
    isContextSensitive: hasKeybindings,
  }), true);
  assert.equal(canReusePluginContributionSnapshot({
    settled: true,
    available: true,
    error: null,
    currentRevision: 0,
    loadedRevision: 0,
    currentLocale: 'en',
    loadedLocale: 'en',
    snapshot: pluginWithKeybindings,
    isContextSensitive: hasKeybindings,
  }), false);
});

test('plugin contribution refreshes reject stale asynchronous results', async () => {
  const guard = createPluginContributionRefreshGuard();
  const committed: string[] = [];
  const oldRequestIsCurrent = guard.begin();
  let resolveOld: (() => void) | undefined;
  const oldRequest = new Promise<void>((resolve) => { resolveOld = resolve; }).then(() => {
    if (oldRequestIsCurrent()) committed.push('old');
  });

  const newRequestIsCurrent = guard.begin();
  if (newRequestIsCurrent()) committed.push('new');
  resolveOld?.();
  await oldRequest;

  assert.deepEqual(committed, ['new']);
  assert.equal(oldRequestIsCurrent(), false);
  assert.equal(newRequestIsCurrent(), true);
  guard.invalidate();
  assert.equal(newRequestIsCurrent(), false);
});

test('owned menu rendering inherits command icons when a placement has no override', () => {
  const commandIcon = { kind: 'theme', name: 'play' } as const;
  const plugins = [{
    id: 'com.example.menu',
    commands: [{ id: 'com.example.menu.run', title: 'Run', enabled: true, icon: commandIcon }],
    menus: [{
      id: 'com.example.menu:menu:0',
      command: 'com.example.menu.run',
      location: 'terminal/toolbar',
      title: 'Run',
      visible: true,
      enabled: true,
    }],
  }] as unknown as NetcattyPluginContributionSnapshot['plugins'];

  assert.deepEqual(collectOwnedPluginMenus(plugins)[0], {
    ...plugins[0].menus[0],
    pluginId: 'com.example.menu',
    icon: commandIcon,
  });
});

function createDomHarness(netcatty: Record<string, unknown>) {
  _resetSharedPluginRuntimeStatusForTests();
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window, { netcatty });
  const root = createRoot(document.getElementById('root')!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const perform = async (action: () => void) => act(async () => {
    action();
    await settle();
  });
  const cleanup = async () => {
    await act(async () => root.unmount());
    dom.window.close();
    _resetSharedPluginRuntimeStatusForTests();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return { root, perform, cleanup };
}

test('usePluginContributions skips context-driven IPC and listener churn when 0 plugins are active and invalidates on change', async () => {
  let statusCalls = 0;
  let contributionCalls = 0;
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  const listeners = new Set<() => void>();
  let currentPlugins: NetcattyPluginContributionSnapshot['plugins'] = [];
  const queriedContexts: Array<Record<string, unknown> | undefined> = [];

  const harness = createDomHarness({
    async getPluginRuntimeStatus() {
      statusCalls += 1;
      return { available: true };
    },
    async getPluginContributions(query?: NetcattyPluginContributionQuery) {
      contributionCalls += 1;
      queriedContexts.push(query?.context);
      return { locale: query?.locale ?? 'en', plugins: currentPlugins };
    },
    onPluginContributionsChanged(callback: () => void) {
      subscribeCalls += 1;
      listeners.add(callback);
      return () => {
        unsubscribeCalls += 1;
        listeners.delete(callback);
      };
    },
  });

  const observed: Array<{ available: boolean; loading: boolean; count: number }> = [];
  let latest!: UsePluginContributionsResult;
  function Fixture({ query, options }: { query: NetcattyPluginContributionQuery; options?: UsePluginContributionsOptions }) {
    latest = usePluginContributions(query, options);
    observed.push({ available: latest.available, loading: latest.loading, count: latest.snapshot.plugins.length });
    return null;
  }

  try {
    await harness.perform(() => harness.root.render(
      <Fixture query={{ locale: 'en', context: { 'netcatty.activeTabId': 'tab-1' } }} />,
    ));
    assert.equal(latest.available, true);
    assert.equal(latest.loading, false);
    assert.equal(statusCalls, 1);
    assert.equal(contributionCalls, 1);
    assert.equal(subscribeCalls, 1);
    assert.equal(unsubscribeCalls, 0);

    observed.length = 0;
    await harness.perform(() => harness.root.render(
      <Fixture query={{ locale: 'en', context: { 'netcatty.activeTabId': 'tab-2' } }} />,
    ));
    assert.equal(latest.available, true);
    assert.equal(latest.loading, false);
    assert.equal(contributionCalls, 1, '0 active plugins should short-circuit context-driven re-query');
    assert.equal(subscribeCalls, 1, 'tab switch should not re-subscribe onPluginContributionsChanged');
    assert.equal(unsubscribeCalls, 0);
    assert.equal(observed.every((entry) => entry.available && !entry.loading), true);

    currentPlugins = [{
      id: 'com.example.active',
      version: '1.0.0',
      displayName: 'Active',
      description: '',
      commands: [],
      keybindings: [{ command: 'com.example.run', key: 'ctrl+k', enabled: true }],
      menus: [],
      settings: [],
      views: [],
    }];
    await harness.perform(() => {
      for (const listener of listeners) listener();
    });
    assert.equal(contributionCalls, 2, 'onPluginContributionsChanged must invalidate and re-query');
    assert.deepEqual(queriedContexts.at(-1), { 'netcatty.activeTabId': 'tab-2' });
    assert.equal(latest.snapshot.plugins.length, 1);
    assert.equal(latest.available, true);
  } finally {
    await harness.cleanup();
  }
});

test('usePluginContributions keeps available true while failing closed on snapshot during context-sensitive reload', async () => {
  let resolveTab2!: (snapshot: NetcattyPluginContributionSnapshot) => void;
  let contributionCalls = 0;
  const pluginTab1 = {
    id: 'com.example.kb',
    version: '1.0.0',
    displayName: 'KB',
    description: '',
    commands: [],
    keybindings: [{ command: 'com.example.tab1', key: 'ctrl+k', enabled: true }],
    menus: [],
    settings: [],
    views: [],
  };
  const pluginTab2 = {
    ...pluginTab1,
    keybindings: [{ command: 'com.example.tab2', key: 'ctrl+k', enabled: false }],
  };

  const harness = createDomHarness({
    async getPluginRuntimeStatus() {
      return { available: true };
    },
    getPluginContributions(query?: NetcattyPluginContributionQuery) {
      contributionCalls += 1;
      if (query?.context?.['netcatty.activeTabId'] === 'tab-1') {
        return Promise.resolve({ locale: 'en', plugins: [pluginTab1] });
      }
      return new Promise<NetcattyPluginContributionSnapshot>((resolve) => {
        resolveTab2 = resolve;
      });
    },
    onPluginContributionsChanged() {
      return () => {};
    },
  });

  let latest!: UsePluginContributionsResult;
  const availableHistory: boolean[] = [];
  function Fixture({ tabId }: { tabId: string }) {
    latest = usePluginContributions({ locale: 'en', context: { 'netcatty.activeTabId': tabId } });
    availableHistory.push(latest.available);
    return null;
  }

  try {
    await harness.perform(() => harness.root.render(<Fixture tabId="tab-1" />));
    assert.equal(latest.available, true);
    assert.equal(latest.loading, false);
    assert.equal(latest.snapshot.plugins[0]?.keybindings[0]?.enabled, true);

    availableHistory.length = 0;
    await harness.perform(() => harness.root.render(<Fixture tabId="tab-2" />));
    assert.equal(contributionCalls, 2);
    assert.equal(latest.available, true, 'runtime available must not flip to false during query reload');
    assert.equal(latest.loading, true);
    assert.equal(latest.snapshot.plugins.length, 0, 'stale Tab 1 snapshot must fail closed on Tab 2');
    assert.deepEqual(availableHistory, [true]);

    await harness.perform(() => resolveTab2({ locale: 'en', plugins: [pluginTab2] }));
    assert.equal(latest.available, true);
    assert.equal(latest.loading, false);
    assert.equal(latest.snapshot.plugins[0]?.keybindings[0]?.enabled, false);
  } finally {
    await harness.cleanup();
  }
});

test('usePluginContributions skips context re-queries while runtime is unavailable until contributions change', async () => {
  let statusCalls = 0;
  let contributionCalls = 0;
  let runtimeAvailable = false;
  const listeners = new Set<() => void>();

  const harness = createDomHarness({
    async getPluginRuntimeStatus() {
      statusCalls += 1;
      return { available: runtimeAvailable };
    },
    async getPluginContributions() {
      contributionCalls += 1;
      return { locale: 'en', plugins: [] };
    },
    onPluginContributionsChanged(callback: () => void) {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },
  });

  let latest!: UsePluginContributionsResult;
  function Fixture({ tabId }: { tabId: string }) {
    latest = usePluginContributions({ locale: 'en', context: { 'netcatty.activeTabId': tabId } });
    return null;
  }

  try {
    await harness.perform(() => harness.root.render(<Fixture tabId="tab-1" />));
    assert.equal(latest.available, false);
    assert.equal(latest.loading, false);
    assert.equal(statusCalls, 1);
    assert.equal(contributionCalls, 0);

    await harness.perform(() => harness.root.render(<Fixture tabId="tab-2" />));
    assert.equal(latest.available, false);
    assert.equal(latest.loading, false);
    assert.equal(statusCalls, 1, 'unavailable runtime should not re-query on tab switch');
    assert.equal(contributionCalls, 0);

    runtimeAvailable = true;
    await harness.perform(() => {
      for (const listener of listeners) listener();
    });
    assert.equal(latest.available, true);
    assert.equal(statusCalls, 2);
    assert.equal(contributionCalls, 1);
  } finally {
    await harness.cleanup();
  }
});
