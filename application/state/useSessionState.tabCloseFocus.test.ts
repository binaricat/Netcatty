import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createLocalShellHost } from '../../domain/localShellHost';
import { activeTabStore } from './activeTabStore';
import { useSessionState } from './useSessionState';

async function mountSessionState(t: test.TestContext) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById('root')!);
  let latestState!: ReturnType<typeof useSessionState>;

  function Probe() {
    latestState = useSessionState({ persistSessionRestore: false });
    return null;
  }

  activeTabStore.setActiveTabId('vault', { recordPrevious: false });
  await act(async () => {
    root.render(React.createElement(React.StrictMode, null, React.createElement(Probe)));
  });

  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    activeTabStore.setActiveTabId('vault', { recordPrevious: false });
  });

  return () => latestState;
}

test('useSessionState issue #4249 scenario 1: repeated close focuses C -> B -> A -> vault', async (t) => {
  const getState = await mountSessionState(t);

  let a = '';
  let b = '';
  let c = '';
  await act(async () => { a = getState().createLocalTerminal(); });
  await act(async () => { b = getState().createLocalTerminal(); });
  await act(async () => { c = getState().createLocalTerminal(); });
  assert.equal(activeTabStore.getActiveTabId(), c);

  await act(async () => { getState().closeSession(c); });
  assert.equal(activeTabStore.getActiveTabId(), b);

  await act(async () => { getState().closeSession(b); });
  assert.equal(activeTabStore.getActiveTabId(), a);

  await act(async () => { getState().closeSession(a); });
  assert.equal(activeTabStore.getActiveTabId(), 'vault');
});

for (const rootView of ['vault', 'sftp'] as const) {
  test(`useSessionState issue #4249 scenario 2 (${rootView}): clicking ${rootView} then closing C -> B -> A stays on terminals until last tab`, async (t) => {
    const getState = await mountSessionState(t);

    let a = '';
    let b = '';
    let c = '';
    await act(async () => { a = getState().createLocalTerminal(); });
    await act(async () => { b = getState().createLocalTerminal(); });
    await act(async () => { c = getState().createLocalTerminal(); });

    // User clicks Vaults/SFTP once, then clicks back to rightmost terminal C.
    await act(async () => { getState().setActiveTabId(rootView); });
    await act(async () => { getState().setActiveTabId(c); });
    assert.equal(activeTabStore.getActiveTabId(), c);
    assert.equal(activeTabStore.getPreviousActiveTabId(), rootView);

    // Repeated Cmd/Ctrl+W closes C -> B -> A predictably before falling back.
    await act(async () => { getState().closeSession(c); });
    assert.equal(activeTabStore.getActiveTabId(), b);

    await act(async () => { getState().closeSession(b); });
    assert.equal(activeTabStore.getActiveTabId(), a);

    await act(async () => { getState().closeSession(a); });
    assert.equal(activeTabStore.getActiveTabId(), rootView);
  });
}

test('useSessionState closing a workspace tab moves to adjacent terminal tab instead of jumping to vault/sftp', async (t) => {
  const getState = await mountSessionState(t);

  let a = '';
  let c = '';
  await act(async () => { a = getState().createLocalTerminal(); });
  await act(async () => {
    getState().createWorkspaceWithHosts('WS', [createLocalShellHost({ id: 'ws-local-1' })]);
  });
  const wsId = getState().workspaces[0].id;
  await act(async () => { c = getState().createLocalTerminal(); });

  // Place workspace visually between A and C: [a, wsId, c].
  await act(async () => { getState().reorderTabs(wsId, a, 'after'); });
  assert.deepEqual(getState().orderedTabs, [a, wsId, c]);

  // Visit SFTP, return to C, then close C -> WS -> A.
  await act(async () => { getState().setActiveTabId('sftp'); });
  await act(async () => { getState().setActiveTabId(c); });

  await act(async () => { getState().closeSession(c); });
  assert.equal(activeTabStore.getActiveTabId(), wsId);

  await act(async () => { getState().closeWorkspace(wsId); });
  assert.equal(activeTabStore.getActiveTabId(), a);

  await act(async () => { getState().closeSession(a); });
  assert.equal(activeTabStore.getActiveTabId(), 'sftp');
});
