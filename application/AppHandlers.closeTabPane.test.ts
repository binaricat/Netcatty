import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { createLocalShellHost } from '../domain/localShellHost';
import { collectSessionIds } from '../domain/workspace';
import { executeHotkeyActionImpl, handleGlobalHotkeyKeyDownImpl } from './app/AppHandlers';
import { DEFAULT_KEY_BINDINGS, matchesKeyBinding } from '../domain/models/keyBindings';
import { activeTabStore } from './state/activeTabStore';
import { resolveCloseIntent } from './state/resolveCloseIntent';
import { useSessionState } from './state/useSessionState';

async function setup(t: test.TestContext, paneCount: number | 'standalone', terminalFocus = true) {
  const dom = new JSDOM(
    '<div id="root"></div><div data-session-id="focused"><textarea class="xterm-helper-textarea"></textarea></div><button>Outside terminal</button>',
    { url: 'http://localhost' },
  );
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  activeTabStore.setActiveTabId('vault');
  const root = createRoot(document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    activeTabStore.setActiveTabId('vault');
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  let state: ReturnType<typeof useSessionState>;
  function Probe() {
    state = useSessionState({ persistSessionRestore: false });
    return null;
  }
  await act(async () => root.render(React.createElement(Probe)));
  await act(async () => {
    if (paneCount === 'standalone') state.createLocalTerminal();
    else state.createWorkspaceWithHosts('Split tab', Array.from({ length: paneCount }, (_, index) => (
      createLocalShellHost({ id: `local-${index}` })
    )));
  });
  // Choose the second pane so closing an arbitrary first pane cannot pass.
  if (paneCount !== 'standalone' && paneCount > 1) {
    await act(async () => state.setWorkspaceFocusedSession(state.workspaces[0].id, state.sessions[1].id));
  }
  document.querySelector<HTMLElement>(terminalFocus ? 'textarea' : 'button')!.focus();
  const confirmations: string[][] = [];
  const closeTabInFlightRef = { current: false };
  const execute = (action: string, event: KeyboardEvent) => executeHotkeyActionImpl(() => ({
    activeTabStore,
    closeSession: state.closeSession,
    closeWorkspace: state.closeWorkspace,
    closeTabInFlightRef,
    collectSessionIds,
    confirmIfBusyLocalTerminal: async (ids: string[]) => { confirmations.push(ids); return true; },
    editorTabs: [],
    isEditorTabId: () => false,
    orderedTabs: [],
    resolveCloseIntent,
    sessions: state.sessions,
    settings: {},
    workspaces: state.workspaces,
  }), action, event);
  return {
    get state() { return state!; },
    confirmations,
    async press(shiftKey = false, scheme: 'mac' | 'pc' = 'mac') {
      const event = new dom.window.KeyboardEvent('keydown', {
        key: 'w', code: 'KeyW', metaKey: scheme === 'mac', ctrlKey: scheme === 'pc', shiftKey,
        bubbles: true, cancelable: true,
      });
      document.activeElement!.addEventListener('keydown', (e) => handleGlobalHotkeyKeyDownImpl(() => ({
        HOTKEY_DEBUG: false,
        closeTabKeyStr: scheme === 'mac' ? '\u2318 + W' : 'Ctrl + W',
        executeHotkeyAction: execute,
        hotkeyScheme: scheme,
        keyBindings: DEFAULT_KEY_BINDINGS,
        matchesKeyBinding,
      }), e as KeyboardEvent), { once: true });
      await act(async () => { document.activeElement!.dispatchEvent(event); });
      assert.equal(event.defaultPrevented, true);
      assert.equal(closeTabInFlightRef.current, false);
    },
  };
}

for (const scheme of ['mac', 'pc'] as const) {
  for (const terminalFocus of [true, false]) {
    test(`${scheme} close-tab closes every pane and the tab with terminal focus ${terminalFocus}`, async (t) => {
      const harness = await setup(t, 2, terminalFocus);
      const ids = harness.state.sessions.map((session) => session.id);
      await harness.press(false, scheme);
      assert.deepEqual(harness.state.sessions, []);
      assert.deepEqual(harness.state.workspaces, []);
      assert.equal(activeTabStore.getActiveTabId(), 'vault');
      assert.deepEqual(harness.confirmations, [ids]);
    });
  }

  test(`${scheme} close-pane closes only the focused pane in a split tab`, async (t) => {
    const harness = await setup(t, 2);
    const workspace = harness.state.workspaces[0];
    const focusedId = workspace.focusedSessionId;
    const survivorId = harness.state.sessions[0].id;
    await harness.press(true, scheme);
    assert.deepEqual(harness.state.sessions.map((session) => session.id), [survivorId]);
    assert.equal(harness.state.workspaces.length, 1);
    assert.deepEqual(collectSessionIds(harness.state.workspaces[0].root), [survivorId]);
    assert.equal(activeTabStore.getActiveTabId(), workspace.id);
    assert.deepEqual(harness.confirmations, [[focusedId]]);
  });

  for (const paneCount of [1, 'standalone'] as const) {
    test(`${scheme} close-pane closes a ${paneCount} pane tab`, async (t) => {
      const harness = await setup(t, paneCount);
      const id = harness.state.sessions[0].id;
      await harness.press(true, scheme);
      assert.deepEqual(harness.state.sessions, []);
      assert.deepEqual(harness.state.workspaces, []);
      assert.equal(activeTabStore.getActiveTabId(), 'vault');
      assert.deepEqual(harness.confirmations, [[id]]);
    });
  }
}
