import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComponentProps } from 'react';
import { JSDOM } from 'jsdom';
import type { Host, TerminalSession, Workspace } from '../../types';

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost',
  });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
    'CustomEvent',
    'Event',
    'DOMException',
  ]) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('localStorage', dom.window.localStorage);
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number);
  install('cancelAnimationFrame', (id: number) => clearTimeout(id));
  install(
    'ResizeObserver',
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  install('IS_REACT_ACT_ENVIRONMENT', true);

  return {
    dom,
    cleanup() {
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
    },
  };
}

const flushTabStore = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

async function waitForAct(
  act: (fn: () => Promise<void>) => Promise<void>,
  condition: () => boolean,
  timeoutMs = 3000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
    });
  }
}

const makeSession = (id: string, hostId: string): TerminalSession => ({
  id,
  hostId,
  hostLabel: `host-${hostId}`,
  username: 'root',
  hostname: `${hostId}.example.com`,
  status: 'connected',
});

const makeWorkspace = (id: string, sessionId: string): Workspace => ({
  id,
  title: `Workspace ${id}`,
  focusedSessionId: sessionId,
  root: { id: `pane-${id}`, type: 'pane', sessionId },
});

const makeHost = (id: string): Host => ({
  id,
  label: `host-${id}`,
  hostname: `${id}.example.com`,
  port: 22,
  username: 'root',
  authMethod: 'password',
  tags: [],
  os: 'linux',
});

test('usePluginVaultPages does not re-render on non-vault tab switches while preserving active state', async () => {
  const env = setupDom();
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { activeTabStore } = await import('../state/activeTabStore');
  const { usePluginVaultPages } = await import('../state/usePluginVaultPages');

  const previousTabId = activeTabStore.getActiveTabId();
  Object.assign(env.dom.window, {
    netcatty: {
      async getPluginRuntimeStatus() {
        return { available: true };
      },
      async getPluginContributions() {
        return { locale: 'en', plugins: [] };
      },
      onPluginContributionsChanged() {
        return () => {};
      },
    },
  });

  let renders = 0;
  let lastActive: boolean | null = null;
  const select = () => {};

  function Harness() {
    renders += 1;
    const model = usePluginVaultPages({ locale: 'en', section: 'hosts', select });
    lastActive = model.active;
    return <div data-active={String(model.active)} />;
  }

  const root = createRoot(document.getElementById('root')!);
  try {
    activeTabStore.setActiveTabId('session-1');
    await flushTabStore();

    await act(async () => {
      root.render(<Harness />);
      await flushTabStore();
    });
    assert.equal(lastActive, false);
    const settledRenders = renders;

    // Switching between terminal tabs and other non-vault tabs must cause 0 re-renders.
    await act(async () => {
      activeTabStore.setActiveTabId('session-2');
      await flushTabStore();
    });
    await act(async () => {
      activeTabStore.setActiveTabId('workspace-1');
      await flushTabStore();
    });
    await act(async () => {
      activeTabStore.setActiveTabId('sftp');
      await flushTabStore();
    });
    assert.equal(renders, settledRenders);
    assert.equal(lastActive, false);

    // Switching to vault flips active to true with exactly 1 render.
    await act(async () => {
      activeTabStore.setActiveTabId('vault');
      await flushTabStore();
    });
    assert.equal(renders, settledRenders + 1);
    assert.equal(lastActive, true);

    // Switching back to a terminal tab flips active back to false.
    await act(async () => {
      activeTabStore.setActiveTabId('session-1');
      await flushTabStore();
    });
    assert.equal(renders, settledRenders + 2);
    assert.equal(lastActive, false);
  } finally {
    await act(async () => {
      root.unmount();
      await flushTabStore();
    });
    activeTabStore.setActiveTabId(previousTabId, { recordPrevious: false });
    env.cleanup();
  }
});

test('useShowHostTreeToggle and TopTabs avoid re-renders when switching between two terminal tabs', async () => {
  const env = setupDom();
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { activeTabStore } = await import('../state/activeTabStore');
  const { TopTabs, useShowHostTreeToggle } = await import('../../components/TopTabs');
  const { I18nProvider } = await import('../i18n/I18nProvider');
  const { TooltipProvider } = await import('../../components/ui/tooltip');

  const previousTabId = activeTabStore.getActiveTabId();
  const session1 = makeSession('session-1', 'h1');
  const session2 = makeSession('session-2', 'h2');
  const workspace1 = makeWorkspace('workspace-1', 'session-1');
  const hosts = [makeHost('h1'), makeHost('h2')];
  const hostById = new Map(hosts.map((h) => [h.id, h]));
  const sessions = [session1, session2];
  const orphanSessions = [session1, session2];
  const workspaces = [workspace1];
  const logViews: never[] = [];
  const orderedTabs = ['session-1', 'session-2', 'workspace-1'];
  const editorTabs: never[] = [];
  const pluginViewTabs: never[] = [];
  const sessionIds = new Set(['session-1', 'session-2']);
  const workspaceIds = new Set(['workspace-1']);
  const logViewIds = new Set(['log-1']);

  let selectorRenders = 0;
  let lastVisible: boolean | null = null;
  function SelectorHarness({ enabled }: { enabled: boolean }) {
    selectorRenders += 1;
    lastVisible = useShowHostTreeToggle({
      enabled,
      logViewIds,
      orderedTabs,
      sessionIds,
      workspaceIds,
    });
    return <div data-show={String(lastVisible)} />;
  }

  const noop = () => {};

  const root = createRoot(document.getElementById('root')!);
  try {
    // 1. Direct selector test across all tab transitions
    activeTabStore.setActiveTabId('session-1');
    await flushTabStore();

    await act(async () => {
      root.render(<SelectorHarness enabled={true} />);
      await flushTabStore();
    });
    assert.equal(lastVisible, true);
    const rendersAfterMount = selectorRenders;

    for (const nextTab of ['session-2', 'workspace-1', 'log-1', 'editor:file-1', 'session-1']) {
      await act(async () => {
        activeTabStore.setActiveTabId(nextTab);
        await flushTabStore();
      });
    }
    assert.equal(selectorRenders, rendersAfterMount);
    assert.equal(lastVisible, true);

    await act(async () => {
      activeTabStore.setActiveTabId('vault');
      await flushTabStore();
    });
    assert.equal(selectorRenders, rendersAfterMount + 1);
    assert.equal(lastVisible, false);

    await act(async () => {
      activeTabStore.setActiveTabId('sftp');
      await flushTabStore();
    });
    assert.equal(selectorRenders, rendersAfterMount + 1);
    assert.equal(lastVisible, false);

    await act(async () => {
      activeTabStore.setActiveTabId('session-2');
      await flushTabStore();
    });
    assert.equal(selectorRenders, rendersAfterMount + 2);
    assert.equal(lastVisible, true);

    // Disabled host tree never re-renders on tab switches
    await act(async () => {
      root.render(<SelectorHarness enabled={false} />);
      await flushTabStore();
    });
    const rendersWhenDisabled = selectorRenders;
    await act(async () => {
      activeTabStore.setActiveTabId('vault');
      await flushTabStore();
    });
    await act(async () => {
      activeTabStore.setActiveTabId('session-1');
      await flushTabStore();
    });
    assert.equal(selectorRenders, rendersWhenDisabled);
    assert.equal(lastVisible, false);

    // 2. Full TopTabs mount: verify host-tree toggle stays visible across session-1 -> session-2
    // and hides when switching to vault.
    activeTabStore.setActiveTabId('session-1');
    await flushTabStore();
    await act(async () => {
      root.render(
        <I18nProvider locale="en">
          <TooltipProvider>
            <TopTabs
              theme="dark"
              themePreference="dark"
              hosts={hosts}
              sessions={sessions}
              orphanSessions={orphanSessions}
              workspaces={workspaces}
              logViews={logViews}
              orderedTabs={orderedTabs}
              draggingSessionId={null}
              isMacClient={false}
              onCloseSession={noop}
              onRenameSession={noop}
              onCopySession={noop}
              onCopySessionToNewWindow={noop}
              onRenameWorkspace={noop}
              onCopyWorkspace={noop}
              onCloseWorkspace={noop}
              onCloseLogView={noop}
              onCloseTabsBatch={noop}
              onOpenQuickSwitcher={noop}
              onThemeChange={noop}
              onOpenSettings={noop}
              externalMcpEnabled={false}
              onToggleExternalMcp={noop}
              windowOpacity={1}
              setWindowOpacity={noop}
              onStartSessionDrag={noop}
              onEndSessionDrag={noop}
              onReorderTabs={noop}
              onRemoveSessionFromWorkspace={noop}
              showSftpTab={true}
              showHostTreeSidebar={true}
              switchTabKeyBinding={null}
              tabDoubleClickBehavior="copy"
              editorTabs={editorTabs}
              pluginViewTabs={pluginViewTabs}
              onClosePluginViewTab={noop}
              onRequestCloseEditorTab={noop}
              hostById={hostById}
            />
          </TooltipProvider>
        </I18nProvider>,
      );
    });

    await waitForAct(
      act,
      () =>
        document
          .querySelector('[data-section="top-tabs-host-tree-toggle"]')
          ?.getAttribute('data-visible') === 'true',
    );
    const hostTreeToggleSlot = document.querySelector('[data-section="top-tabs-host-tree-toggle"]')!;
    assert.equal(hostTreeToggleSlot.getAttribute('data-visible'), 'true');

    await act(async () => {
      activeTabStore.setActiveTabId('session-2');
      await flushTabStore();
    });
    assert.equal(hostTreeToggleSlot.getAttribute('data-visible'), 'true');

    await act(async () => {
      activeTabStore.setActiveTabId('vault');
      await flushTabStore();
    });
    await waitForAct(
      act,
      () => hostTreeToggleSlot.getAttribute('data-visible') === 'false',
    );
  } finally {
    await act(async () => {
      root.unmount();
      await flushTabStore();
    });
    activeTabStore.setActiveTabId(previousTabId, { recordPrevious: false });
    env.cleanup();
  }
});

test('LogViewWrapper does not re-render on unrelated tab switches', async () => {
  const env = setupDom();
  const { Profiler, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { activeTabStore } = await import('../state/activeTabStore');
  const { LogViewWrapper } = await import('./AppMounts');

  const previousTabId = activeTabStore.getActiveTabId();
  const logView = {
    id: 'log-view-1',
    connectionLogId: 'log-1',
    log: {
      id: 'log-1',
      hostId: 'host-1',
      hostLabel: 'Prod',
      hostname: 'prod.example.com',
      username: 'root',
      protocol: 'ssh' as const,
      startTime: 1,
      localUsername: 'local',
      localHostname: 'localhost',
      saved: false,
      terminalData: '',
    },
  };
  const defaultTerminalTheme = {
    id: 'default',
    name: 'Default',
    type: 'dark' as const,
    colors: {
      background: '#000000',
      foreground: '#ffffff',
      cursor: '#ffffff',
      selection: '#444444',
      black: '#000000',
      red: '#ff0000',
      green: '#00ff00',
      yellow: '#ffff00',
      blue: '#0000ff',
      magenta: '#ff00ff',
      cyan: '#00ffff',
      white: '#ffffff',
      brightBlack: '#888888',
      brightRed: '#ff8888',
      brightGreen: '#88ff88',
      brightYellow: '#ffff88',
      brightBlue: '#8888ff',
      brightMagenta: '#ff88ff',
      brightCyan: '#88ffff',
      brightWhite: '#ffffff',
    },
  };

  let commitCount = 0;
  const onRender = () => {
    commitCount += 1;
  };
  const onClose = () => {};
  const onUpdateLog = () => {};

  const originalConsoleError = console.error;
  // LazyLogView imports @xterm/xterm/css/xterm.css which is unsupported under Node ESM
  // and settles into LazyLoadBoundary's alert fallback; silence that expected boundary log.
  console.error = () => {};

  const root = createRoot(document.getElementById('root')!);
  try {
    activeTabStore.setActiveTabId('session-1');
    await flushTabStore();

    await act(async () => {
      root.render(
        <Profiler id="log-view-wrapper" onRender={onRender}>
          <LogViewWrapper
            logView={logView}
            defaultTerminalTheme={defaultTerminalTheme}
            defaultFontSize={14}
            onClose={onClose}
            onUpdateLog={onUpdateLog}
          />
        </Profiler>,
      );
    });
    await waitForAct(act, () => document.querySelector('[role="alert"]') !== null);

    const commitsAfterMount = commitCount;
    const container = document.getElementById('root')!.firstElementChild as HTMLElement;
    assert.equal(container.getAttribute('data-inactive-app-surface'), 'true');

    // Switching between two terminal tabs and vault must cause 0 re-renders of LogViewWrapper.
    await act(async () => {
      activeTabStore.setActiveTabId('session-2');
      await flushTabStore();
    });
    await act(async () => {
      activeTabStore.setActiveTabId('vault');
      await flushTabStore();
    });
    assert.equal(commitCount, commitsAfterMount);
    assert.equal(container.getAttribute('data-inactive-app-surface'), 'true');

    // Activating this log view re-renders it and reveals the surface.
    await act(async () => {
      activeTabStore.setActiveTabId(logView.id);
      await flushTabStore();
    });
    assert.equal(commitCount, commitsAfterMount + 1);
    assert.equal(container.getAttribute('data-inactive-app-surface'), null);

    // Leaving this log view hides it again.
    await act(async () => {
      activeTabStore.setActiveTabId('session-1');
      await flushTabStore();
    });
    assert.equal(commitCount, commitsAfterMount + 2);
    assert.equal(container.getAttribute('data-inactive-app-surface'), 'true');
  } finally {
    console.error = originalConsoleError;
    await act(async () => {
      root.unmount();
      await flushTabStore();
    });
    activeTabStore.setActiveTabId(previousTabId, { recordPrevious: false });
    env.cleanup();
  }
});

test('useIsTerminalSurfaceActive and TerminalLayerMount avoid re-renders on terminal-to-terminal switches', async () => {
  const env = setupDom();
  const { Profiler, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { activeTabStore } = await import('../state/activeTabStore');
  const { TerminalLayerMount, useIsTerminalSurfaceActive } = await import('./AppMounts');

  const previousTabId = activeTabStore.getActiveTabId();
  const sessions = [makeSession('session-1', 'h1'), makeSession('session-2', 'h2')];
  const workspaces = [makeWorkspace('workspace-1', 'session-1')];
  const sessionIds = new Set(['session-1', 'session-2']);
  const workspaceIds = new Set(['workspace-1']);

  let renders = 0;
  let lastActive: boolean | null = null;

  function Harness() {
    renders += 1;
    lastActive = useIsTerminalSurfaceActive(sessionIds, workspaceIds);
    return <div data-terminal-active={String(lastActive)} />;
  }

  const originalConsoleError = console.error;
  console.error = () => {};

  const root = createRoot(document.getElementById('root')!);
  try {
    activeTabStore.setActiveTabId('session-1');
    await flushTabStore();

    await act(async () => {
      root.render(<Harness />);
      await flushTabStore();
    });
    assert.equal(lastActive, true);
    const rendersAfterMount = renders;

    // Switching between two terminal sessions and a workspace keeps surface active -> 0 re-renders.
    await act(async () => {
      activeTabStore.setActiveTabId('session-2');
      await flushTabStore();
    });
    await act(async () => {
      activeTabStore.setActiveTabId('workspace-1');
      await flushTabStore();
    });
    assert.equal(renders, rendersAfterMount);
    assert.equal(lastActive, true);

    // Switching to vault flips active true -> false (1 re-render).
    await act(async () => {
      activeTabStore.setActiveTabId('vault');
      await flushTabStore();
    });
    assert.equal(renders, rendersAfterMount + 1);
    assert.equal(lastActive, false);

    // Switching vault -> sftp -> log view keeps surface inactive -> 0 re-renders.
    await act(async () => {
      activeTabStore.setActiveTabId('sftp');
      await flushTabStore();
    });
    await act(async () => {
      activeTabStore.setActiveTabId('log-1');
      await flushTabStore();
    });
    assert.equal(renders, rendersAfterMount + 1);
    assert.equal(lastActive, false);

    // Returning to a terminal tab flips false -> true (1 re-render).
    await act(async () => {
      activeTabStore.setActiveTabId('session-2');
      await flushTabStore();
    });
    assert.equal(renders, rendersAfterMount + 2);
    assert.equal(lastActive, true);

    // Verify TerminalLayerMount itself does not re-render on session-1 -> session-2 -> workspace-1
    let mountCommits = 0;
    activeTabStore.setActiveTabId('session-1');
    await flushTabStore();

    await act(async () => {
      root.render(
        <Profiler
          id="terminal-layer-mount"
          onRender={() => {
            mountCommits += 1;
          }}
        >
          <TerminalLayerMount
            {...({
              sessions,
              workspaces,
              draggingSessionId: null,
            } as unknown as ComponentProps<typeof TerminalLayerMount>)}
          />
        </Profiler>,
      );
    });
    await waitForAct(act, () => document.querySelector('[role="alert"]') !== null);

    const commitsAfterTerminalMount = mountCommits;
    await act(async () => {
      activeTabStore.setActiveTabId('session-2');
      await flushTabStore();
    });
    await act(async () => {
      activeTabStore.setActiveTabId('workspace-1');
      await flushTabStore();
    });
    assert.equal(mountCommits, commitsAfterTerminalMount);

    // Switching away to vault flips isVisible (and LazyLoadBoundary resetKey) and triggers a re-render.
    await act(async () => {
      activeTabStore.setActiveTabId('vault');
      await flushTabStore();
    });
    assert.ok(mountCommits > commitsAfterTerminalMount);
  } finally {
    console.error = originalConsoleError;
    await act(async () => {
      root.unmount();
      await flushTabStore();
    });
    activeTabStore.setActiveTabId(previousTabId, { recordPrevious: false });
    env.cleanup();
  }
});

test('usePluginAIContextHost does not re-render on tab switches and reads live activeTabId on demand', async () => {
  const env = setupDom();
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { activeTabStore } = await import('../state/activeTabStore');
  const { usePluginAIContextHost } = await import('../state/usePluginAIContextHost');
  const { registerAppAppLockRuntime, getAppAppLockRuntime } = await import('../state/appRuntimeBridge');

  const previousTabId = activeTabStore.getActiveTabId();
  const oldLock = getAppAppLockRuntime();
  registerAppAppLockRuntime({ locked: false } as NonNullable<ReturnType<typeof getAppAppLockRuntime>>);

  const sessions = [makeSession('session-1', 'h1'), makeSession('session-2', 'h2')];
  const workspaces = [makeWorkspace('workspace-1', 'session-1')];

  let requestHandler: ((req: {
    kind: string;
    requestId: string;
    runtimeId: string;
    actionToken: string;
    payload: Record<string, unknown>;
  }) => void) | null = null;
  const responses: Array<{ requestId: string; result?: unknown; error?: boolean }> = [];

  Object.assign(env.dom.window, {
    netcatty: {
      onPluginAIHostRequest(handler: typeof requestHandler) {
        requestHandler = handler;
        return () => {
          requestHandler = null;
        };
      },
      async setPluginAIHostReady() {},
      async respondPluginAIHost(payload: { requestId: string; result?: unknown; error?: boolean }) {
        responses.push(payload);
      },
    },
  });

  let renders = 0;
  let latestChoice: ReturnType<typeof usePluginAIContextHost>['choice'] = null;
  function Harness() {
    renders += 1;
    const host = usePluginAIContextHost({ sessions, workspaces });
    latestChoice = host.choice;
    return <div data-testid="ai-context-host" />;
  }

  const root = createRoot(document.getElementById('root')!);
  try {
    activeTabStore.setActiveTabId('session-1');
    await flushTabStore();

    await act(async () => {
      root.render(<Harness />);
      await flushTabStore();
    });
    const rendersAfterMount = renders;

    // Switching across any tabs must cause 0 re-renders.
    for (const nextTab of ['session-2', 'workspace-1', 'vault', 'sftp', 'session-2']) {
      await act(async () => {
        activeTabStore.setActiveTabId(nextTab);
        await flushTabStore();
      });
    }
    assert.equal(renders, rendersAfterMount);

    // Triggering selection on demand without re-rendering must read live activeTabId ('session-2').
    assert.ok(requestHandler, 'expected plugin AI host request listener to be registered');
    await act(async () => {
      requestHandler!({
        kind: 'context.select',
        requestId: 'req-1',
        runtimeId: 'rt-1',
        actionToken: 'tok-1',
        payload: {},
      });
    });
    await waitForAct(act, () => latestChoice !== null);

    await act(async () => {
      latestChoice!.confirm('');
    });
    await waitForAct(act, () => responses.length === 1);

    assert.equal(responses[0].error, undefined);
    const result = responses[0].result as {
      items: Array<{ hostHandle: string; scope: string; title: string; version: string }>;
    };
    const sessionItem = result.items.find((item) => item.scope === 'session');
    assert.ok(sessionItem, 'expected active session source to be included');
    assert.equal(sessionItem.title, 'host-h2');

    // Switching tabs without re-rendering must make context.current immediately report false.
    const rendersBeforeSwitch = renders;
    await act(async () => {
      activeTabStore.setActiveTabId('session-1');
      await flushTabStore();
    });
    assert.equal(renders, rendersBeforeSwitch);

    await act(async () => {
      requestHandler!({
        kind: 'context.current',
        requestId: 'req-2',
        runtimeId: 'rt-1',
        actionToken: 'tok-2',
        payload: { hostHandle: sessionItem.hostHandle, version: sessionItem.version },
      });
    });
    await waitForAct(act, () => responses.length === 2);
    assert.deepEqual(responses[1].result, { current: false });
  } finally {
    registerAppAppLockRuntime(oldLock);
    await act(async () => {
      root.unmount();
      await flushTabStore();
    });
    activeTabStore.setActiveTabId(previousTabId, { recordPrevious: false });
    env.cleanup();
  }
});
