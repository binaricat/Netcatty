import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeHotkeyActionImpl,
  getLogHostVisualSnapshot,
  handleEscapeKeyDownImpl,
  handleGlobalHotkeyKeyDownImpl,
  markForwardedNativeShortcutEvent,
} from './app/AppHandlers.ts';
import { matchesKeyBinding } from '../domain/models.ts';
import { DEFAULT_KEY_BINDINGS } from '../domain/models/keyBindings.ts';

class FakeInputHTMLElement {
  tagName = 'INPUT';
  isContentEditable = false;

  closest(): FakeInputHTMLElement | null {
    return null;
  }
}

class FakeHTMLElement {
  tagName = 'TEXTAREA';
  isContentEditable = false;
  classList = {
    contains: (className: string) => className === 'xterm-helper-textarea',
  };

  closest(selector: string): FakeHTMLElement | null {
    return selector.includes('xterm') ? this : null;
  }

  hasAttribute(name: string): boolean {
    return name === 'data-session-id';
  }
}

class FakeMonacoHTMLElement extends FakeHTMLElement {
  tagName = 'TEXTAREA';

  closest(selector: string): FakeMonacoHTMLElement | null {
    return selector.includes('monaco') ? this : null;
  }
}

const previousHTMLElement = globalThis.HTMLElement;
globalThis.HTMLElement = FakeHTMLElement as unknown as typeof HTMLElement;

test.after(() => {
  globalThis.HTMLElement = previousHTMLElement;
});

test('global hotkey handler lets terminal font size shortcuts reach xterm', () => {
  const target = new FakeHTMLElement();
  const handledActions: string[] = [];
  let prevented = false;
  let stopped = false;
  const event = {
    key: '=',
    code: 'Equal',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target,
    composedPath: () => [target],
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  } as unknown as KeyboardEvent;

  handleGlobalHotkeyKeyDownImpl(
    () => ({
      HOTKEY_DEBUG: false,
      closeTabKeyStr: 'Ctrl + W',
      executeHotkeyAction: (action: string) => {
        handledActions.push(action);
      },
      hotkeyScheme: 'pc',
      keyBindings: DEFAULT_KEY_BINDINGS,
      matchesKeyBinding,
    }),
    event,
  );

  assert.deepEqual(handledActions, []);
  assert.equal(prevented, false);
  assert.equal(stopped, false);
});

test('global hotkey handler routes quick switch through focused search inputs', () => {
  const target = new FakeInputHTMLElement();
  const handledActions: string[] = [];
  const event = {
    key: 'j',
    code: 'KeyJ',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target,
    composedPath: () => [target],
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyboardEvent;

  handleGlobalHotkeyKeyDownImpl(
    () => ({
      HOTKEY_DEBUG: false,
      closeTabKeyStr: 'Ctrl + W',
      executeHotkeyAction: (action: string) => {
        handledActions.push(action);
      },
      hotkeyScheme: 'pc',
      keyBindings: DEFAULT_KEY_BINDINGS,
      matchesKeyBinding,
    }),
    event,
  );

  assert.deepEqual(handledActions, ['quickSwitch']);
});

test('global hotkey handler magnifies panes from focused form inputs', () => {
  const target = new FakeInputHTMLElement();
  const handledActions: string[] = [];
  const event = {
    key: 'm',
    code: 'KeyM',
    ctrlKey: false,
    metaKey: false,
    altKey: true,
    shiftKey: false,
    target,
    composedPath: () => [target],
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyboardEvent;

  handleGlobalHotkeyKeyDownImpl(
    () => ({
      HOTKEY_DEBUG: false,
      closeTabKeyStr: 'Ctrl + W',
      executeHotkeyAction: (action: string) => {
        handledActions.push(action);
      },
      hotkeyScheme: 'pc',
      keyBindings: DEFAULT_KEY_BINDINGS,
      matchesKeyBinding,
    }),
    event,
  );

  assert.deepEqual(handledActions, ['togglePaneZoom']);
});

test('forwarded native shortcut can run a reassigned global action from Monaco', () => {
  const target = new FakeMonacoHTMLElement();
  const handledActions: string[] = [];
  let prevented = false;
  const event = markForwardedNativeShortcutEvent({
    key: 'w',
    code: 'KeyW',
    ctrlKey: false,
    metaKey: true,
    altKey: false,
    shiftKey: false,
    target,
    composedPath: () => [target],
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {},
  } as unknown as KeyboardEvent);
  const keyBindings = DEFAULT_KEY_BINDINGS.map((binding) => {
    if (binding.action === 'closeTab') return { ...binding, mac: 'Disabled' };
    if (binding.action === 'newTab') return { ...binding, mac: '⌘ + W' };
    return binding;
  });

  handleGlobalHotkeyKeyDownImpl(
    () => ({
      HOTKEY_DEBUG: false,
      closeTabKeyStr: 'Disabled',
      executeHotkeyAction: (action: string) => {
        handledActions.push(action);
      },
      hotkeyScheme: 'mac',
      keyBindings,
      matchesKeyBinding,
    }),
    event,
  );

  assert.deepEqual(handledActions, ['newTab']);
  assert.equal(prevented, true);
});

test('quick switch hotkey toggles the quick switcher open state', () => {
  let isQuickSwitcherOpen = false;
  const setIsQuickSwitcherOpen = (next: boolean) => {
    isQuickSwitcherOpen = next;
  };
  const noop = () => {};
  const baseCtx = {
    IS_DEV: false,
    MOVE_FOCUS_DEBOUNCE_MS: 0,
    activeTabStore: { getActiveTabId: () => 'vault' },
    addConnectionLogRef: { current: noop },
    closeSession: noop,
    closeTabInFlightRef: { current: false },
    closeWorkspace: noop,
    collectSessionIds: () => [],
    confirmIfBusyLocalTerminal: async () => true,
    createLocalTerminalWithCurrentShell: noop,
    editorTabs: [],
    fromEditorTabId: () => null,
    handleOpenSettingsRef: { current: noop },
    handleRequestCloseEditorTabRef: { current: noop },
    isEditorTabId: () => false,
    isQuickSwitcherOpen,
    lastMoveFocusTimeRef: { current: 0 },
    moveFocusInWorkspace: noop,
    orderedTabs: [],
    resolveCloseIntent: () => ({ kind: 'noop' }),
    resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
    sessions: [],
    setActiveTabId: noop,
    setAddToWorkspaceDialog: noop,
    setIsQuickSwitcherOpen,
    setNavigateToSection: noop,
    settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: false },
    splitSessionWithCurrentShell: noop,
    systemInfoRef: { current: { username: 'user', hostname: 'host' } },
    toEditorTabId: (id: string) => `editor:${id}`,
    toggleBroadcast: noop,
    toggleScriptsSidePanelRef: { current: noop },
    toggleSidePanelRef: { current: noop },
    workspaces: [],
  };

  const event = {
    key: 'j',
    code: 'KeyJ',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  } as KeyboardEvent;

  executeHotkeyActionImpl(() => baseCtx, 'quickSwitch', event);
  assert.equal(isQuickSwitcherOpen, true);

  executeHotkeyActionImpl(() => ({ ...baseCtx, isQuickSwitcherOpen: true }), 'quickSwitch', event);
  assert.equal(isQuickSwitcherOpen, false);
});

test('pane zoom hotkey delegates to the active in-app magnification surface', () => {
  let toggles = 0;
  const noop = () => {};
  const controller = {
    getState: () => 'focusable' as const,
    focus: () => false,
    restore: () => false,
    toggle: () => {
      toggles += 1;
      return true;
    },
  };

  executeHotkeyActionImpl(() => ({
    IS_DEV: false,
    MOVE_FOCUS_DEBOUNCE_MS: 0,
    activeTabStore: { getActiveTabId: () => 'workspace-1' },
    addConnectionLogRef: { current: noop },
    closeSession: noop,
    closeTabInFlightRef: { current: false },
    closeWorkspace: noop,
    collectSessionIds: () => [],
    confirmIfBusyLocalTerminal: async () => true,
    createLocalTerminalWithCurrentShell: noop,
    editorTabs: [],
    fromEditorTabId: () => null,
    handleOpenSettingsRef: { current: noop },
    handleRequestCloseEditorTabRef: { current: noop },
    isEditorTabId: () => false,
    isQuickSwitcherOpen: false,
    lastMoveFocusTimeRef: { current: 0 },
    moveFocusInWorkspace: noop,
    orderedTabs: [],
    resolveCloseIntent: () => ({ kind: 'noop' }),
    resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
    sessions: [],
    setActiveTabId: noop,
    setAddToWorkspaceDialog: noop,
    setIsQuickSwitcherOpen: noop,
    setNavigateToSection: noop,
    settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: false },
    sftpPaneMagnificationRef: { current: null },
    splitSessionWithCurrentShell: noop,
    systemInfoRef: { current: { username: 'user', hostname: 'host' } },
    terminalPaneMagnificationRef: { current: controller },
    toEditorTabId: (id: string) => `editor:${id}`,
    toggleBroadcast: noop,
    toggleScriptsSidePanelRef: { current: noop },
    toggleSidePanelRef: { current: noop },
    toggleWorkspaceViewMode: noop,
    workspaces: [],
  }), 'togglePaneZoom', {} as KeyboardEvent);

  assert.equal(toggles, 1);
});

test('broadcast hotkey toggles global mode for an active orphan tab', () => {
  let globalToggles = 0;
  let workspaceToggles = 0;

  executeHotkeyActionImpl(() => ({
    activeTabStore: { getActiveTabId: () => 'orphan-1' },
    editorTabs: [],
    orderedTabs: ['orphan-1', 'orphan-2'],
    settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: false },
    toEditorTabId: (id: string) => id,
    sessions: [
      { id: 'orphan-1' },
      { id: 'orphan-2' },
    ],
    workspaces: [],
    canUseGlobalBroadcast: true,
    toggleBroadcast: () => { workspaceToggles += 1; },
    toggleGlobalBroadcast: () => { globalToggles += 1; },
  }), 'broadcast', {} as KeyboardEvent);

  assert.equal(globalToggles, 1);
  assert.equal(workspaceToggles, 0);
});

test('move-focus shortcut cannot send input behind a magnified pane', () => {
  let moveCalls = 0;
  executeHotkeyActionImpl(() => ({
    IS_DEV: false,
    MOVE_FOCUS_DEBOUNCE_MS: 0,
    activeTabStore: { getActiveTabId: () => 'workspace-1' },
    editorTabs: [],
    lastMoveFocusTimeRef: { current: 0 },
    moveFocusInWorkspace: () => {
      moveCalls += 1;
      return true;
    },
    orderedTabs: [],
    settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: false },
    sftpPaneMagnificationRef: { current: null },
    terminalPaneMagnificationRef: {
      current: {
        getState: () => 'focused' as const,
        focus: () => false,
        restore: () => true,
        toggle: () => true,
      },
    },
    toEditorTabId: (id: string) => `editor:${id}`,
    workspaces: [{ id: 'workspace-1', title: 'Workspace' }],
  }), 'moveFocus', {
    key: 'ArrowRight',
  } as KeyboardEvent);

  assert.equal(moveCalls, 0);
});

test('Escape restores magnification after transient dialogs are closed', () => {
  let restores = 0;
  let prevented = false;
  let stopped = false;
  const event = {
    key: 'Escape',
    defaultPrevented: false,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  } as unknown as KeyboardEvent;

  handleEscapeKeyDownImpl(() => ({
    isQuickSwitcherOpen: false,
    setIsQuickSwitcherOpen: () => {},
    sftpPaneMagnificationRef: { current: null },
    terminalPaneMagnificationRef: {
      current: {
        getState: () => 'focused',
        focus: () => false,
        restore: () => {
          restores += 1;
          return true;
        },
        toggle: () => false,
      },
    },
  }), event);

  assert.equal(restores, 1);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});

test('consumed Escape does not restore magnification', () => {
  let restores = 0;
  handleEscapeKeyDownImpl(() => ({
    isQuickSwitcherOpen: false,
    setIsQuickSwitcherOpen: () => {},
    terminalPaneMagnificationRef: {
      current: {
        getState: () => 'focused',
        focus: () => false,
        restore: () => {
          restores += 1;
          return true;
        },
        toggle: () => false,
      },
    },
  }), { key: 'Escape', defaultPrevented: true } as KeyboardEvent);

  assert.equal(restores, 0);
});

test('close tab hotkey routes native plugin view tabs through their owner', () => {
  let closedTabId = '';
  const pluginTabId = 'plugin-view:com.example.view:com.example.view.panel';
  const noop = () => {};

  executeHotkeyActionImpl(() => ({
    IS_DEV: false,
    MOVE_FOCUS_DEBOUNCE_MS: 0,
    activeTabStore: { getActiveTabId: () => pluginTabId },
    addConnectionLogRef: { current: noop },
    closePluginViewTab: (tabId: string) => { closedTabId = tabId; },
    closeSession: noop,
    closeTabInFlightRef: { current: false },
    closeWorkspace: noop,
    collectSessionIds: () => [],
    confirmIfBusyLocalTerminal: async () => true,
    createLocalTerminalWithCurrentShell: noop,
    editorTabs: [],
    fromEditorTabId: () => null,
    handleOpenSettingsRef: { current: noop },
    handleRequestCloseEditorTabRef: { current: noop },
    isEditorTabId: () => false,
    isPluginViewTabId: (tabId: string) => tabId.startsWith('plugin-view:'),
    isQuickSwitcherOpen: false,
    lastMoveFocusTimeRef: { current: 0 },
    moveFocusInWorkspace: noop,
    orderedTabs: [pluginTabId],
    resolveCloseIntent: () => ({ kind: 'noop' }),
    resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
    sessions: [],
    setActiveTabId: noop,
    setAddToWorkspaceDialog: noop,
    setIsQuickSwitcherOpen: noop,
    setNavigateToSection: noop,
    settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: false },
    splitSessionWithCurrentShell: noop,
    systemInfoRef: { current: { username: 'user', hostname: 'host' } },
    toEditorTabId: (id: string) => `editor:${id}`,
    toggleBroadcast: noop,
    toggleScriptsSidePanelRef: { current: noop },
    toggleSidePanelRef: { current: noop },
    toggleWorkspaceViewMode: noop,
    workspaces: [],
  }), 'closeTab', { key: 'w', metaKey: true } as KeyboardEvent);

  assert.equal(closedTabId, pluginTabId);
});

test('next, previous, and number shortcuts include native plugin view tabs', () => {
  const pluginTabId = 'plugin-view:com.example.view:com.example.view.panel';
  let activeTabId = 'session-1';
  const selected: string[] = [];
  const noop = () => {};
  const context = {
    IS_DEV: false,
    MOVE_FOCUS_DEBOUNCE_MS: 0,
    activeTabStore: { getActiveTabId: () => activeTabId },
    addConnectionLogRef: { current: noop },
    closePluginViewTab: noop,
    closeSession: noop,
    closeTabInFlightRef: { current: false },
    closeWorkspace: noop,
    collectSessionIds: () => [],
    confirmIfBusyLocalTerminal: async () => true,
    createLocalTerminalWithCurrentShell: noop,
    editorTabs: [],
    fromEditorTabId: () => null,
    handleOpenSettingsRef: { current: noop },
    handleRequestCloseEditorTabRef: { current: noop },
    isEditorTabId: () => false,
    isPluginViewTabId: (tabId: string) => tabId.startsWith('plugin-view:'),
    isQuickSwitcherOpen: false,
    lastMoveFocusTimeRef: { current: 0 },
    moveFocusInWorkspace: noop,
    orderedTabs: ['session-1', pluginTabId, 'session-2'],
    resolveCloseIntent: () => ({ kind: 'noop' }),
    resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
    sessions: [],
    setActiveTabId: (id: string) => { activeTabId = id; selected.push(id); },
    setAddToWorkspaceDialog: noop,
    setIsQuickSwitcherOpen: noop,
    setNavigateToSection: noop,
    settings: { showSftpTab: false, shellOnlyTabNumberShortcuts: false },
    splitSessionWithCurrentShell: noop,
    systemInfoRef: { current: { username: 'user', hostname: 'host' } },
    toEditorTabId: (id: string) => `editor:${id}`,
    toggleBroadcast: noop,
    toggleScriptsSidePanelRef: { current: noop },
    toggleSidePanelRef: { current: noop },
    toggleWorkspaceViewMode: noop,
    workspaces: [],
  };

  executeHotkeyActionImpl(() => context, 'nextTab', { key: 'Tab', ctrlKey: true } as KeyboardEvent);
  assert.equal(activeTabId, pluginTabId);
  executeHotkeyActionImpl(() => context, 'prevTab', { key: 'Tab', ctrlKey: true, shiftKey: true } as KeyboardEvent);
  assert.equal(activeTabId, 'session-1');
  executeHotkeyActionImpl(() => context, 'switchToTab', { key: '3', metaKey: true } as KeyboardEvent);
  assert.equal(activeTabId, pluginTabId);
  assert.deepEqual(selected, [pluginTabId, 'session-1', pluginTabId]);
});

test('switchToTab uses physical Digit code when Shift remaps e.key', () => {
  let activeTabId = 'session-1';
  const noop = () => {};
  const context = {
    IS_DEV: false,
    MOVE_FOCUS_DEBOUNCE_MS: 0,
    activeTabStore: { getActiveTabId: () => activeTabId },
    addConnectionLogRef: { current: noop },
    closeSession: noop,
    closeTabInFlightRef: { current: false },
    closeWorkspace: noop,
    collectSessionIds: () => [],
    confirmIfBusyLocalTerminal: async () => true,
    createLocalTerminalWithCurrentShell: noop,
    editorTabs: [],
    fromEditorTabId: () => null,
    handleOpenSettingsRef: { current: noop },
    handleRequestCloseEditorTabRef: { current: noop },
    isEditorTabId: () => false,
    isQuickSwitcherOpen: false,
    lastMoveFocusTimeRef: { current: 0 },
    moveFocusInWorkspace: noop,
    orderedTabs: ['session-1', 'session-2', 'session-3'],
    resolveCloseIntent: () => ({ kind: 'noop' }),
    resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
    sessions: [],
    setActiveTabId: (id: string) => { activeTabId = id; },
    setAddToWorkspaceDialog: noop,
    setIsQuickSwitcherOpen: noop,
    setNavigateToSection: noop,
    settings: { showSftpTab: false, shellOnlyTabNumberShortcuts: false },
    splitSessionWithCurrentShell: noop,
    systemInfoRef: { current: { username: 'user', hostname: 'host' } },
    toEditorTabId: (id: string) => `editor:${id}`,
    toggleBroadcast: noop,
    toggleScriptsSidePanelRef: { current: noop },
    toggleSidePanelRef: { current: noop },
    toggleWorkspaceViewMode: noop,
    workspaces: [],
  };

  executeHotkeyActionImpl(
    () => context,
    'switchToTab',
    { key: '@', code: 'Digit3', ctrlKey: true, shiftKey: true } as KeyboardEvent,
  );
  assert.equal(activeTabId, 'session-2');
});

test('next tab includes pinned tabs when shell-only shortcut mode is disabled', () => {
  let activeTabId = '';
  const noop = () => {};

  executeHotkeyActionImpl(
    () => ({
      IS_DEV: false,
      MOVE_FOCUS_DEBOUNCE_MS: 0,
      activeTabStore: { getActiveTabId: () => 'vault' },
      addConnectionLogRef: { current: noop },
      closeSession: noop,
      closeTabInFlightRef: { current: false },
      closeWorkspace: noop,
      collectSessionIds: () => [],
      confirmIfBusyLocalTerminal: async () => true,
      createLocalTerminalWithCurrentShell: noop,
      editorTabs: [{ id: 'editor-1' }],
      fromEditorTabId: () => null,
      handleOpenSettingsRef: { current: noop },
      handleRequestCloseEditorTabRef: { current: noop },
      isEditorTabId: () => false,
      isQuickSwitcherOpen: false,
      lastMoveFocusTimeRef: { current: 0 },
      moveFocusInWorkspace: noop,
      orderedTabs: ['session-1'],
      resolveCloseIntent: () => ({ kind: 'noop' }),
      resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
      sessions: [],
      setActiveTabId: (id: string) => { activeTabId = id; },
      setAddToWorkspaceDialog: noop,
      setIsQuickSwitcherOpen: noop,
      setNavigateToSection: noop,
      settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: false },
      splitSessionWithCurrentShell: noop,
      systemInfoRef: { current: { username: 'user', hostname: 'host' } },
      toEditorTabId: (id: string) => `editor:${id}`,
      toggleBroadcast: noop,
      toggleScriptsSidePanelRef: { current: noop },
      toggleSidePanelRef: { current: noop },
      toggleWorkspaceViewMode: noop,
      workspaces: [],
    }),
    'nextTab',
    { key: 'Tab', ctrlKey: true } as KeyboardEvent,
  );

  assert.equal(activeTabId, 'sftp');
});

test('next tab skips pinned tabs when shell-only shortcut mode is enabled', () => {
  let activeTabId = '';
  const noop = () => {};

  executeHotkeyActionImpl(
    () => ({
      IS_DEV: false,
      MOVE_FOCUS_DEBOUNCE_MS: 0,
      activeTabStore: { getActiveTabId: () => 'vault' },
      addConnectionLogRef: { current: noop },
      closeSession: noop,
      closeTabInFlightRef: { current: false },
      closeWorkspace: noop,
      collectSessionIds: () => [],
      confirmIfBusyLocalTerminal: async () => true,
      createLocalTerminalWithCurrentShell: noop,
      editorTabs: [{ id: 'editor-1' }],
      fromEditorTabId: () => null,
      handleOpenSettingsRef: { current: noop },
      handleRequestCloseEditorTabRef: { current: noop },
      isEditorTabId: () => false,
      isQuickSwitcherOpen: false,
      lastMoveFocusTimeRef: { current: 0 },
      moveFocusInWorkspace: noop,
      orderedTabs: ['session-1'],
      resolveCloseIntent: () => ({ kind: 'noop' }),
      resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
      sessions: [],
      setActiveTabId: (id: string) => { activeTabId = id; },
      setAddToWorkspaceDialog: noop,
      setIsQuickSwitcherOpen: noop,
      setNavigateToSection: noop,
      settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: true },
      splitSessionWithCurrentShell: noop,
      systemInfoRef: { current: { username: 'user', hostname: 'host' } },
      toEditorTabId: (id: string) => `editor:${id}`,
      toggleBroadcast: noop,
      toggleScriptsSidePanelRef: { current: noop },
      toggleSidePanelRef: { current: noop },
      toggleWorkspaceViewMode: noop,
      workspaces: [],
    }),
    'nextTab',
    { key: 'Tab', ctrlKey: true } as KeyboardEvent,
  );

  assert.equal(activeTabId, 'session-1');
});

test('connection log host snapshot includes custom host icon fields', () => {
  assert.deepEqual(
    getLogHostVisualSnapshot({
      id: 'host-1',
      label: 'Database',
      hostname: 'db.example.com',
      username: 'root',
      tags: [],
      os: 'linux',
      distro: 'ubuntu',
      iconMode: 'custom',
      iconId: 'database',
      iconColor: 'blue',
    }),
    {
      hostOs: 'linux',
      hostDistro: 'ubuntu',
      hostIconMode: 'custom',
      hostIconId: 'database',
      hostIconColorMode: 'manual',
      hostIconColor: 'blue',
    },
  );
});

for (const scenario of [
  { name: 'single orphan', active: 'one', sessions: [{ id: 'one' }], available: false, expected: null },
  { name: 'two orphans', active: 'one', sessions: [{ id: 'one' }, { id: 'two' }], available: true, expected: 'global' },
  { name: 'hidden active session', active: 'hidden', sessions: [{ id: 'one' }, { id: 'two' }, { id: 'hidden', hiddenFromTabs: true }], available: true, expected: null },
  { name: 'non-terminal tab', active: 'vault', sessions: [{ id: 'one' }, { id: 'two' }], available: true, expected: null },
  { name: 'workspace', active: 'workspace', sessions: [{ id: 'one', workspaceId: 'workspace' }, { id: 'two', workspaceId: 'workspace' }], available: false, expected: 'workspace' },
]) {
  for (const scheme of ['pc', 'mac'] as const) {
    test(`broadcast shortcut ${scheme}: ${scenario.name} only consumes an executed toggle`, () => {
      const target = new FakeHTMLElement();
      let prevented = 0;
      let stopped = 0;
      let globalEnabled = false;
      let workspaceEnabled = false;
      const toggles: string[] = [];
      const event = {
        key: 'b', code: 'KeyB', ctrlKey: scheme === 'pc', metaKey: scheme === 'mac',
        altKey: false, shiftKey: false, target, composedPath: () => [target],
        preventDefault: () => { prevented += 1; },
        stopPropagation: () => { stopped += 1; },
      } as unknown as KeyboardEvent;
      const actionCtx = {
        activeTabStore: { getActiveTabId: () => scenario.active },
        editorTabs: [], orderedTabs: [], settings: {}, toEditorTabId: (id: string) => id,
        sessions: scenario.sessions,
        workspaces: scenario.active === 'workspace' ? [{ id: 'workspace' }] : [],
        canUseGlobalBroadcast: scenario.available,
        toggleGlobalBroadcast: () => { globalEnabled = !globalEnabled; toggles.push('global'); },
        toggleBroadcast: (id: string) => { assert.equal(id, 'workspace'); workspaceEnabled = !workspaceEnabled; toggles.push('workspace'); },
      };
      const invoke = () => handleGlobalHotkeyKeyDownImpl(() => ({
        HOTKEY_DEBUG: false, closeTabKeyStr: '', hotkeyScheme: scheme,
        keyBindings: DEFAULT_KEY_BINDINGS, matchesKeyBinding,
        executeHotkeyAction: (action: string, e: KeyboardEvent) => executeHotkeyActionImpl(() => actionCtx, action, e),
      }), event);
      invoke();
      assert.equal(globalEnabled, scenario.expected === 'global');
      assert.equal(workspaceEnabled, scenario.expected === 'workspace');
      invoke();
      assert.equal(globalEnabled, false);
      assert.equal(workspaceEnabled, false);
      assert.deepEqual(toggles, scenario.expected ? [scenario.expected, scenario.expected] : []);
      assert.equal(prevented, scenario.expected ? 2 : 0);
      assert.equal(stopped, scenario.expected ? 2 : 0);
    });
  }
}
