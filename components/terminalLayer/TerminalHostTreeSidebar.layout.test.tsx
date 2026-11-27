import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import type { Host, TerminalSession, TerminalTheme } from '../../types';

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
  let nextFrameId = 1;
  const pendingFrames = new Map<number, FrameRequestCallback>();
  const requestAnimationFrameStub = (cb: FrameRequestCallback) => {
    const id = nextFrameId++;
    pendingFrames.set(id, cb);
    return id;
  };
  const cancelAnimationFrameStub = (id: number) => {
    pendingFrames.delete(id);
  };
  dom.window.requestAnimationFrame = requestAnimationFrameStub;
  dom.window.cancelAnimationFrame = cancelAnimationFrameStub;
  install('requestAnimationFrame', requestAnimationFrameStub);
  install('cancelAnimationFrame', cancelAnimationFrameStub);
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
    drainFrames(maxRounds = 10) {
      for (let round = 0; round < maxRounds && pendingFrames.size > 0; round++) {
        const batch = [...pendingFrames.entries()];
        pendingFrames.clear();
        for (const [, cb] of batch) {
          cb(Date.now());
        }
      }
    },
    cleanup() {
      pendingFrames.clear();
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

const makeTheme = (id: string, bg: string): TerminalTheme => ({
  id,
  name: id,
  type: 'dark',
  colors: {
    background: bg,
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
});

const makeHost = (id: string, themeId?: string): Host => ({
  id,
  label: `host-${id}`,
  hostname: `${id}.example.com`,
  port: 22,
  username: 'root',
  authMethod: 'password',
  tags: [],
  os: 'linux',
  theme: themeId,
});

const makeSession = (id: string, hostId: string): TerminalSession => ({
  id,
  hostId,
  hostLabel: `host-${hostId}`,
  username: 'root',
  hostname: `${hostId}.example.com`,
  status: 'connected',
});

test('TerminalHostTreeSidebar publishes target width once on toggle and snaps without animation on surface change', async () => {
  const env = setupDom();
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../../application/i18n/I18nProvider');
  const { TooltipProvider } = await import('../ui/tooltip');
  const { terminalHostTreeStore } = await import('../../application/state/terminalHostTreeStore');
  const { terminalLayoutSuppressStore } = await import('../../application/state/terminalLayoutSuppressStore');
  const { TerminalHostTreeSidebar } = await import('./TerminalHostTreeSidebar');

  const theme = makeTheme('default', '#111111');
  const hosts = [makeHost('h1')];
  const noop = () => {};

  const updates: Array<{ width: number; animated: boolean }> = [];
  const unsubscribe = terminalHostTreeStore.subscribe(() => {
    updates.push({
      width: terminalHostTreeStore.getLayoutWidth(),
      animated: terminalHostTreeStore.getLayoutTransitionAnimated(),
    });
  });

  const root = createRoot(document.getElementById('root')!);
  try {
    terminalHostTreeStore.setIsOpen(false);
    terminalHostTreeStore.setLayoutWidth(0, false);
    updates.length = 0;

    await act(async () => {
      root.render(
        <I18nProvider locale="en">
          <TooltipProvider>
            <TerminalHostTreeSidebar
              enabled={true}
              surfaceVisible={true}
              hosts={hosts}
              customGroups={[]}
              resolvedPreviewTheme={theme}
              activeHostId="h1"
              onConnect={noop}
            />
          </TooltipProvider>
        </I18nProvider>,
      );
    });
    await act(async () => {
      env.drainFrames();
    });
    assert.equal(terminalHostTreeStore.getLayoutWidth(), 0);
    assert.equal(terminalHostTreeStore.getLayoutTransitionAnimated(), false);

    // 1. Opening publishes target width ONCE with animated=true, then clears animated on transitionend.
    updates.length = 0;
    await act(async () => {
      terminalHostTreeStore.setIsOpen(true);
    });
    await act(async () => {
      env.drainFrames();
    });
    const widthUpdatesOnOpen = updates.filter((u) => u.width > 0);
    assert.equal(widthUpdatesOnOpen.length, 1, 'expected exactly one layoutWidth publish on open');
    assert.equal(widthUpdatesOnOpen[0].width, 220);
    assert.equal(widthUpdatesOnOpen[0].animated, true);
    assert.equal(terminalLayoutSuppressStore.getActive(), true);

    const shell = document.querySelector('[data-section="terminal-host-tree-sidebar-shell"]') as HTMLElement;
    assert.ok(shell);
    await act(async () => {
      const ev = new Event('transitionend', { bubbles: false });
      Object.defineProperty(ev, 'propertyName', { value: 'width' });
      shell.dispatchEvent(ev);
    });
    assert.equal(terminalHostTreeStore.getLayoutWidth(), 220);
    assert.equal(terminalHostTreeStore.getLayoutTransitionAnimated(), false);
    assert.equal(terminalLayoutSuppressStore.getActive(), false);

    // 2. Switching away to Vault (!surfaceVisible) snaps layoutWidth to 0 with animated=false immediately.
    updates.length = 0;
    await act(async () => {
      root.render(
        <I18nProvider locale="en">
          <TooltipProvider>
            <TerminalHostTreeSidebar
              enabled={true}
              surfaceVisible={false}
              hosts={hosts}
              customGroups={[]}
              resolvedPreviewTheme={theme}
              activeHostId={undefined}
              onConnect={noop}
            />
          </TooltipProvider>
        </I18nProvider>,
      );
    });
    await act(async () => {
      env.drainFrames();
    });
    assert.equal(terminalHostTreeStore.getLayoutWidth(), 0);
    assert.equal(terminalHostTreeStore.getLayoutTransitionAnimated(), false);
    assert.equal(updates.some((u) => u.animated), false);

    // 3. Returning to Terminal (surfaceVisible: false -> true) snaps layoutWidth to 220 with animated=false.
    updates.length = 0;
    await act(async () => {
      root.render(
        <I18nProvider locale="en">
          <TooltipProvider>
            <TerminalHostTreeSidebar
              enabled={true}
              surfaceVisible={true}
              hosts={hosts}
              customGroups={[]}
              resolvedPreviewTheme={theme}
              activeHostId="h1"
              onConnect={noop}
            />
          </TooltipProvider>
        </I18nProvider>,
      );
    });
    await act(async () => {
      env.drainFrames();
    });
    assert.equal(terminalHostTreeStore.getLayoutWidth(), 220);
    assert.equal(terminalHostTreeStore.getLayoutTransitionAnimated(), false);
    assert.equal(updates.some((u) => u.animated), false);

    // 4. Closing publishes layoutWidth=0 ONCE with animated=true.
    updates.length = 0;
    await act(async () => {
      terminalHostTreeStore.setIsOpen(false);
    });
    await act(async () => {
      env.drainFrames();
    });
    const closeUpdates = updates.filter((u) => u.width === 0);
    assert.equal(closeUpdates.length, 1, 'expected exactly one layoutWidth publish on close');
    assert.equal(closeUpdates[0].animated, true);
    await act(async () => {
      const ev = new Event('transitionend', { bubbles: false });
      Object.defineProperty(ev, 'propertyName', { value: 'width' });
      shell.dispatchEvent(ev);
    });
    assert.equal(terminalHostTreeStore.getLayoutTransitionAnimated(), false);
    assert.equal(terminalLayoutSuppressStore.getActive(), false);
  } finally {
    unsubscribe();
    await act(async () => {
      root.unmount();
    });
    while (terminalLayoutSuppressStore.getActive()) {
      terminalLayoutSuppressStore.end();
    }
    terminalHostTreeStore.setIsOpen(false);
    terminalHostTreeStore.setLayoutWidth(0, false);
    env.cleanup();
  }
});

test('AppHostTreeLayer does not re-render closed TerminalHostTreeSidebar when switching tabs across hosts/themes', async () => {
  const env = setupDom();
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../../application/i18n/I18nProvider');
  const { TooltipProvider } = await import('../ui/tooltip');
  const { activeTabStore } = await import('../../application/state/activeTabStore');
  const { terminalHostTreeStore } = await import('../../application/state/terminalHostTreeStore');
  const { AppHostTreeLayer } = await import('../../application/app/AppHostTreeLayer');

  const previousTabId = activeTabStore.getActiveTabId();
  const themeA = makeTheme('theme-a', '#101010');
  const themeB = makeTheme('theme-b', '#202020');
  const themeById = new Map([
    [themeA.id, themeA],
    [themeB.id, themeB],
  ]);
  const host1 = makeHost('h1', 'theme-a');
  const host2 = makeHost('h2', 'theme-b');
  const hosts = [host1, host2];
  const hostById = new Map(hosts.map((h) => [h.id, h]));
  const sessions = [makeSession('s1', 'h1'), makeSession('s2', 'h2')];
  const orderedTabs = ['s1', 's2'];
  const noop = () => {};

  const root = createRoot(document.getElementById('root')!);
  try {
    terminalHostTreeStore.setIsOpen(false);
    activeTabStore.setActiveTabId('s1');

    await act(async () => {
      root.render(
        <I18nProvider locale="en">
          <TooltipProvider>
            <AppHostTreeLayer
              enabled={true}
              hosts={hosts}
              customGroups={[]}
              groupConfigs={[]}
              sessions={sessions}
              workspaces={[]}
              editorTabs={[]}
              logViews={[]}
              orderedTabs={orderedTabs}
              currentTerminalTheme={themeA}
              followAppTerminalTheme={false}
              hostById={hostById}
              themeById={themeById}
              onConnect={noop}
            />
          </TooltipProvider>
        </I18nProvider>,
      );
    });
    await act(async () => {
      env.drainFrames();
    });

    assert.equal(document.querySelector('[data-section="terminal-host-tree-sidebar"]'), null);

    // Switching s1 -> s2 while host tree is closed keeps sidebar unmounted
    // and avoids activeHostId/theme churn.
    await act(async () => {
      activeTabStore.setActiveTabId('s2');
    });
    await act(async () => {
      env.drainFrames();
    });
    assert.equal(document.querySelector('[data-section="terminal-host-tree-sidebar"]'), null);

    // Opening the host tree lazily mounts the sidebar directly with the live host theme (theme-b).
    await act(async () => {
      terminalHostTreeStore.setIsOpen(true);
      await import('./TerminalHostTreeSidebar');
    });
    await act(async () => {
      env.drainFrames();
    });
    const sidebar = document.querySelector('[data-section="terminal-host-tree-sidebar"]') as HTMLElement;
    assert.ok(sidebar);
    assert.notEqual(sidebar.style.backgroundColor, 'rgb(16, 16, 16)');
    assert.equal(sidebar.style.backgroundColor, 'rgb(32, 32, 32)');
  } finally {
    await act(async () => {
      root.unmount();
    });
    activeTabStore.setActiveTabId(previousTabId, { recordPrevious: false });
    terminalHostTreeStore.setIsOpen(false);
    terminalHostTreeStore.setLayoutWidth(0, false);
    env.cleanup();
  }
});

test('getTerminalLayerViewStyle applies CSS transition only when visible and animated', async () => {
  const { getTerminalLayerViewStyle } = await import('./TerminalLayerView');
  const { TERMINAL_HOST_TREE_LEFT_TRANSITION } = await import('../../application/state/terminalHostTreeAnimation');

  assert.equal(
    getTerminalLayerViewStyle({
      isTerminalLayerVisible: true,
      hibernateHiddenTabs: false,
      hostTreeLayoutWidth: 220,
      hostTreeLayoutAnimated: true,
    }).transition,
    TERMINAL_HOST_TREE_LEFT_TRANSITION,
  );
  assert.equal(
    getTerminalLayerViewStyle({
      isTerminalLayerVisible: false,
      hibernateHiddenTabs: false,
      hostTreeLayoutWidth: 0,
      hostTreeLayoutAnimated: true,
    }).transition,
    'none',
  );
  assert.equal(
    getTerminalLayerViewStyle({
      isTerminalLayerVisible: true,
      hibernateHiddenTabs: false,
      hostTreeLayoutWidth: 240,
      hostTreeLayoutAnimated: false,
    }).transition,
    'none',
  );
});
