import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  normalizeTerminalSidePanelTabOrder,
  reorderTerminalSidePanelTab,
  fitTerminalSidePanelTabs,
  TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER,
} from '../../application/state/terminalSidePanelTabs.ts';
import {
  getTerminalSidePanelShellWidth,
  listenForSidePanelPaneFocus,
  resolveMagnifiedSidePanelHosts,
} from './TerminalLayerSidePanelSection.tsx';
import {
  getFocusedPortalDescendant,
  movePersistentPortalNode,
  resolveSidePanelPortalTarget,
} from './terminalLayerSidePanelSlots.tsx';

test('magnified side panels use a continuous 1px inset outline in the side panel accent', () => {
  const source = readFileSync(new URL('./TerminalLayerSidePanelSection.tsx', import.meta.url), 'utf8');
  const chromeStart = source.indexOf('className="absolute inset-3');
  const chromeSource = source.slice(chromeStart, source.indexOf('\n        >', chromeStart));

  assert.match(chromeSource, /overflow-hidden rounded-md bg-background shadow-2xl/);
  assert.match(chromeSource, /outline: `1px solid \$\{sidePanelTheme\.accent\}`/);
  assert.match(chromeSource, /outlineOffset: -1/);
  assert.doesNotMatch(chromeSource, /\bborder(?:Color|Width|Style)?\b/);
});

test('AI side panel shell can be force-hidden for layout isolation', () => {
  assert.equal(getTerminalSidePanelShellWidth({
    activeSidePanelTab: 'ai',
    forceHideAiShell: true,
    isSidePanelOpenForCurrentTab: true,
    resizePreviewWidth: null,
    sidePanelWidth: 420,
  }), 0);
});

test('non-AI side panels keep their open width', () => {
  assert.equal(getTerminalSidePanelShellWidth({
    activeSidePanelTab: 'sftp',
    forceHideAiShell: true,
    isSidePanelOpenForCurrentTab: true,
    resizePreviewWidth: null,
    sidePanelWidth: 420,
  }), 420);
});

test('resize preview width is still honored for visible side panels', () => {
  assert.equal(getTerminalSidePanelShellWidth({
    activeSidePanelTab: 'theme',
    forceHideAiShell: true,
    isSidePanelOpenForCurrentTab: true,
    resizePreviewWidth: 512,
    sidePanelWidth: 420,
  }), 512);
});

test('closed side panel shell has no width', () => {
  assert.equal(getTerminalSidePanelShellWidth({
    activeSidePanelTab: null,
    forceHideAiShell: true,
    isSidePanelOpenForCurrentTab: false,
    resizePreviewWidth: null,
    sidePanelWidth: 420,
  }), 0);
});

test('pointer and keyboard focus from portaled tool content focus the owning pane', () => {
  const host = new EventTarget();
  let focusCount = 0;
  const stopListening = listenForSidePanelPaneFocus(host, () => {
    focusCount += 1;
  });

  host.dispatchEvent(new Event('pointerdown'));
  assert.equal(focusCount, 1);
  host.dispatchEvent(new Event('focusin'));
  assert.equal(focusCount, 2);

  stopListening();
  host.dispatchEvent(new Event('pointerdown'));
  host.dispatchEvent(new Event('focusin'));
  assert.equal(focusCount, 2);
});

test('side panel tab order falls back to the default order', () => {
  assert.deepEqual(normalizeTerminalSidePanelTabOrder(null), TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER);
  // Partial / dirty lists keep known ids in order and append the rest of the defaults.
  assert.deepEqual(normalizeTerminalSidePanelTabOrder(['scripts', 'bad-tab']), [
    'scripts',
    'sftp',
    'browser',
    'history',
    'theme',
    'system',
    'notes',
    'ai',
  ]);
});

test('side panel tab order accepts a stored permutation', () => {
  const stored = ['scripts', 'sftp', 'browser', 'history', 'theme', 'system', 'notes', 'ai'];

  assert.deepEqual(normalizeTerminalSidePanelTabOrder(stored), stored);
});

test('side panel tab order moves the dragged tab before the target tab', () => {
  assert.deepEqual(
    reorderTerminalSidePanelTab(
      TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER,
      'notes',
      'scripts',
    ),
    ['sftp', 'browser', 'notes', 'scripts', 'history', 'theme', 'system', 'ai'],
  );
});

test('side panel tab order can move the dragged tab after the target tab', () => {
  assert.deepEqual(
    reorderTerminalSidePanelTab(
      TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER,
      'scripts',
      'ai',
      'after',
    ),
    ['sftp', 'browser', 'history', 'theme', 'system', 'notes', 'ai', 'scripts'],
  );
});

test('narrow side panels keep the active tool visible and move extra tools into overflow', () => {
  const fitted = fitTerminalSidePanelTabs({
    shown: [...TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER],
    collapsed: [],
    active: 'ai',
    maxShown: 2,
  });

  assert.deepEqual(fitted.shown, ['sftp', 'ai']);
  assert.deepEqual(fitted.collapsed, ['browser', 'scripts', 'history', 'theme', 'system', 'notes']);
});

test('a visible tool without a ready pane host stays in the hidden parking host', () => {
  const parkingHost = { id: 'parking' };
  const paneHost = { id: 'pane' };

  assert.equal(resolveSidePanelPortalTarget(true, paneHost, parkingHost), paneHost);
  assert.equal(resolveSidePanelPortalTarget(true, null, parkingHost), parkingHost);
  assert.equal(resolveSidePanelPortalTarget(false, paneHost, parkingHost), parkingHost);
  assert.equal(resolveSidePanelPortalTarget(true, null, null), null);
});

test('magnifying a side pane moves only its stable portal host into the overlay', () => {
  const scriptsHost = { id: 'scripts-host' };
  const sftpHost = { id: 'sftp-host' };
  const overlayHost = { id: 'overlay-host' };
  const paneHosts = new Map([
    ['scripts', scriptsHost],
    ['sftp', sftpHost],
  ]);

  const resolved = resolveMagnifiedSidePanelHosts(
    paneHosts,
    { id: 'pane-scripts', type: 'pane', tool: 'scripts' },
    overlayHost,
  );

  assert.equal(resolved.get('scripts'), overlayHost);
  assert.equal(resolved.get('sftp'), sftpHost);
  assert.equal(paneHosts.get('scripts'), scriptsHost);
});

test('moving a stable portal host restores focus to its active input', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="first"></div><div id="second"></div></body></html>');
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  try {
    const first = dom.window.document.getElementById('first') as HTMLElement;
    const second = dom.window.document.getElementById('second') as HTMLElement;
    const mountNode = dom.window.document.createElement('div');
    const input = dom.window.document.createElement('input');
    mountNode.appendChild(input);
    first.appendChild(mountNode);
    input.focus();

    const focusToRestore = getFocusedPortalDescendant(mountNode, dom.window.document.activeElement);
    mountNode.remove();
    assert.notEqual(dom.window.document.activeElement, input);

    movePersistentPortalNode(mountNode, second, focusToRestore);
    assert.equal(dom.window.document.activeElement, input);
  } finally {
    globalThis.document = previousDocument;
    globalThis.HTMLElement = previousHTMLElement;
    dom.window.close();
  }
});

test('closed side panel skips getBoundingClientRect on tab switches, resize, and DOM mutations until opened', async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="terminal-layer" data-section="terminal-layer"><div data-section="terminal-workspace-row"><div data-section="terminal-workspace-column"></div></div><div id="mount-root"></div></div></body></html>',
    { pretendToBeVisual: true, url: 'http://localhost' },
  );
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
    'HTMLInputElement',
    'Element',
    'SVGElement',
    'Node',
    'NodeFilter',
    'MutationObserver',
    'CustomEvent',
    'Event',
    'KeyboardEvent',
    'MouseEvent',
    'localStorage',
  ]) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  const resizeCallbacks: Array<() => void> = [];
  class MockResizeObserver {
    private callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      resizeCallbacks.push(() => this.callback([], this as unknown as ResizeObserver));
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  install('ResizeObserver', MockResizeObserver);
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0));
  install('cancelAnimationFrame', (id: number) => clearTimeout(id));
  install('IS_REACT_ACT_ENVIRONMENT', true);

  let rectReads = 0;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function mockGetBoundingClientRect() {
    rectReads += 1;
    return new dom.window.DOMRect(0, 0, 1200, 800);
  };

  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../../application/i18n/I18nProvider');
  const { TooltipProvider } = await import('../ui/tooltip');
  const { activeTabStore } = await import('../../application/state/activeTabStore');
  const { createSidePanelLayout } = await import('../../domain/sidePanelLayout');
  const { TerminalLayerSidePanelSection } = await import('./TerminalLayerSidePanelSection');

  const terminalLayer = dom.window.document.getElementById('terminal-layer')!;
  const mountRoot = dom.window.document.getElementById('mount-root')!;
  // Put TerminalLayerSidePanelSection directly inside terminalLayer so shell.parentElement === terminalLayer.
  mountRoot.remove();
  const root = createRoot(terminalLayer);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  const noop = () => {};
  const NullComponent = () => null;
  const terminalTheme = {
    id: 'test-dark',
    name: 'Test Dark',
    type: 'dark' as const,
    colors: {
      background: '#111111',
      foreground: '#eeeeee',
      cursor: '#ffffff',
      selection: '#333333',
      black: '#000000',
      red: '#ff0000',
      green: '#00ff00',
      yellow: '#ffff00',
      blue: '#0000ff',
      magenta: '#ff00ff',
      cyan: '#00ffff',
      white: '#ffffff',
      brightBlack: '#666666',
      brightRed: '#ff6666',
      brightGreen: '#66ff66',
      brightYellow: '#ffff66',
      brightBlue: '#6666ff',
      brightMagenta: '#ff66ff',
      brightCyan: '#66ffff',
      brightWhite: '#ffffff',
    },
  };
  const baseCtx = {
    Button: (props: Record<string, unknown>) => React.createElement('button', props),
    cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' '),
    t: (key: string) => key,
    followAppTerminalTheme: true,
    terminalTheme,
    terminalThemeId: 'test-dark',
    terminalFontFamilyId: 'jetbrains-mono',
    resolvedPreviewTheme: null,
    sidePanelPosition: 'right',
    sidePanelWidth: 380,
    sidePanelHeight: 320,
    setSidePanelPosition: noop,
    setSidePanelWidth: noop,
    persistSidePanelWidth: noop,
    setSidePanelHeight: noop,
    persistSidePanelHeight: noop,
    handleCloseSidePanel: noop,
    handleOpenAI: noop,
    handleOpenHistory: noop,
    handleOpenNotes: noop,
    handleSwitchSidePanelTab: noop,
    handleOpenBrowser: noop,
    handleOpenScripts: noop,
    handleOpenSystem: noop,
    handleOpenTheme: noop,
    handleFocusSidePanelPane: noop,
    handleMagnifySidePanelPane: noop,
    handleRestoreMagnifiedPane: noop,
    handleSplitSidePanelPane: noop,
    handleCloseSidePanelPane: noop,
    handleResizeSidePanelSplit: noop,
    handleToggleSftpFromBar: noop,
    getActiveTerminalSessionId: () => 'tab-a',
    handleWithdrawPluginSidebarPane: noop,
    hotkeyScheme: 'mac',
    keyBindings: [],
    magnifiedPane: null,
    isComposeBarOpen: false,
    sessions: [{ id: 'tab-a' }, { id: 'tab-b' }],
    workspaces: [],
    workspaceById: new Map(),
    validAIScopeTargetIds: new Set(['tab-a', 'tab-b']),
    browserMountedTabIds: [],
    mountedSftpTabIds: [],
    mountedAiTabIds: [],
    notesMountedTabIds: [],
    scriptsMountedTabIds: [],
    systemMountedTabIds: [],
    themeMountedTabIds: ['tab-a'],
    sftpPaneClosedTabIdsRef: { current: new Set<string>() },
    sftpRetainedAfterCloseTabIdsRef: { current: new Set<string>() },
    ThemeSidePanel: NullComponent,
    HistorySidePanel: NullComponent,
    AISidePanelStateRoot: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    AIChatPanelsHost: NullComponent,
    handleThemeChangeForFocusedSession: noop,
    handleThemeResetForFocusedSession: noop,
    handleFontFamilyChangeForFocusedSession: noop,
    handleFontFamilyResetForFocusedSession: noop,
    handleFontSizeChangeForFocusedSession: noop,
    handleFontSizeResetForFocusedSession: noop,
    handleFontWeightChangeForFocusedSession: noop,
    handleFontWeightResetForFocusedSession: noop,
    handleHistoryPaste: noop,
    handleHistoryDelete: noop,
    handleHistoryClear: noop,
    handleHistoryRun: noop,
  };

  const renderSection = (openTabs: Map<string, string>, layouts: Map<string, ReturnType<typeof createSidePanelLayout>>) =>
    React.createElement(
      I18nProvider,
      { locale: 'en' },
      React.createElement(
        TooltipProvider,
        {
          children: React.createElement(TerminalLayerSidePanelSection, {
            ctx: {
              ...baseCtx,
              sidePanelOpenTabs: openTabs,
              sidePanelLayouts: layouts,
            },
          }),
        },
      ),
    );

  try {
    activeTabStore.setActiveTabId('tab-a');
    rectReads = 0;
    await act(async () => {
      root.render(renderSection(new Map(), new Map()));
      await settle();
    });
    assert.equal(rectReads, 0, 'mounting with closed side panel must not call getBoundingClientRect');

    // Tab switches while closed must not call getBoundingClientRect.
    await act(async () => {
      activeTabStore.setActiveTabId('tab-b');
      await settle();
      activeTabStore.setActiveTabId('tab-a');
      await settle();
    });
    assert.equal(rectReads, 0, 'tab switches while side panel is closed must trigger 0 getBoundingClientRect calls');

    // ResizeObserver & MutationObserver events while closed must not call getBoundingClientRect.
    await act(async () => {
      for (const notify of resizeCallbacks) notify();
      const extra = dom.window.document.createElement('div');
      terminalLayer.appendChild(extra);
      await settle();
      extra.remove();
      await settle();
    });
    assert.equal(rectReads, 0, 'ResizeObserver and MutationObserver callbacks while closed must trigger 0 getBoundingClientRect calls');

    // Opening the side panel must measure synchronously pre-paint in useLayoutEffect.
    const openTabs = new Map([['tab-a', 'theme']]);
    const layouts = new Map([['tab-a', createSidePanelLayout('theme', 'pane-theme')]]);
    await act(async () => {
      root.render(renderSection(openTabs, layouts));
      await settle();
    });
    assert.ok(rectReads > 0, 'opening the side panel must measure available surface via getBoundingClientRect');
  } finally {
    await act(async () => {
      root.unmount();
      await settle();
    });
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});


