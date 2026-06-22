import assert from 'node:assert/strict';
import test from 'node:test';

import { executeHotkeyActionImpl, getLogHostVisualSnapshot, handleGlobalHotkeyKeyDownImpl } from './app/AppHandlers.ts';
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
