import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { collectSessionIds } from '../../domain/workspace';
import { activeTabStore } from './activeTabStore';
import { useSessionState } from './useSessionState';

async function mount(t: import('node:test').TestContext) {
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
  t.after(async () => {
    await act(async () => root.unmount());
    activeTabStore.setActiveTabId('vault');
    await new Promise(resolve => setTimeout(resolve, 0));
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
  await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Probe))));
  return () => state!;
}

test('session groups keep their identity, selection and lifecycle outside workspaces', async (t) => {
  const state = await mount(t);
  await act(async () => state().connectToHost({ id: 'host', label: 'Production', hostname: 'example.test', username: 'root', port: 22, protocol: 'ssh', tags: [], os: 'linux' }));
  const first = state().sessions[0];
  const groupId = first.id;
  await act(async () => state().updateSessionStatus(first.id, 'connected'));
  await act(async () => state().addSessionTab(first.id, { inheritedCwd: '/srv/app' }));
  const second = state().sessions.find(s => s.id !== first.id)!;
  assert.equal(state().workspaces.length, 0);
  assert.equal(state().sessions.length, 2, 'StrictMode creates exactly one new session');
  assert.equal(second.sessionGroupId, groupId);
  assert.equal(second.workspaceId, undefined);
  assert.equal(second.reuseConnectionFromSessionId, first.id);
  assert.equal(second.pendingInitialCwd, undefined);
  assert.deepEqual(state().orderedTabs, [groupId]);
  assert.equal(second.sessionGroupFocused, true);
  await act(async () => state().submitSessionRename(second.id, 'Deploy'));
  assert.equal(state().sessions.find(s => s.id === second.id)?.customName, 'Deploy');
  await act(async () => state().selectSessionTab(first.id));
  assert.equal(state().sessions.find(s => s.id === first.id)?.sessionGroupFocused, true);
  assert.equal(state().sessions.find(s => s.id === second.id)?.sessionGroupFocused, false);
  await act(async () => activeTabStore.setActiveTabId(second.id));
  assert.equal(activeTabStore.getActiveTabId(), groupId, 'member activation from external entry points resolves to the stable group tab');
  assert.equal(state().sessions.find(s => s.id === second.id)?.sessionGroupFocused, true);
  await act(async () => state().closeSession(first.id));
  assert.equal(state().sessions.length, 1);
  assert.equal(state().sessions[0].sessionGroupId, groupId, 'closing the original member keeps the group id');
  assert.equal(state().sessions[0].sessionGroupFocused, true);
  assert.equal(activeTabStore.getActiveTabId(), groupId);
  assert.deepEqual(state().orderedTabs, [groupId]);
  await act(async () => state().addSessionTab(second.id));
  assert.equal(state().workspaces.length, 0);
  assert.deepEqual(state().orderedTabs, [groupId]);
  await act(async () => state().closeSessions(state().sessions.map(s => s.id)));
  assert.equal(state().sessions.length, 0);
  assert.deepEqual(state().orderedTabs, []);
  assert.equal(activeTabStore.getActiveTabId(), 'vault');
});

test('group additions preserve default and custom top-level order and isolate explicit splits', async (t) => {
  const state = await mount(t);
  for (const id of ['first', 'second', 'third']) {
    await act(async () => state().connectToHost({ id, label: id, hostname: id + '.test', username: 'root', port: 22, protocol: 'ssh', tags: [], os: 'linux' }));
  }
  const [first, second, third] = state().sessions;
  const initialOrder = state().orderedTabs;
  await act(async () => state().addSessionTab(first.id));
  assert.deepEqual(state().orderedTabs, initialOrder);
  const editor = 'editor:test';
  await act(async () => state().reorderTabs(editor, third.id, 'before', [editor]));
  await act(async () => state().reorderTabs(third.id, second.id, 'before', [editor]));
  const customOrder = state().getOrderedWorkTabs([editor]);
  await act(async () => state().addSessionTab(third.id));
  assert.deepEqual(state().getOrderedWorkTabs([editor]), customOrder);
  assert.equal(state().workspaces.length, 0);
  await act(async () => state().closeSession(first.id));
  assert.deepEqual(state().getOrderedWorkTabs([editor]), customOrder, 'closing the original member keeps the group slot among other tabs');
  await act(async () => state().splitSession(second.id, 'horizontal'));
  assert.equal(state().workspaces.length, 1);
  const workspace = state().workspaces[0];
  assert.equal(collectSessionIds(workspace.root).length, 2);
  assert.ok(state().sessions.filter(s => s.workspaceId === workspace.id).every(s => s.sessionGroupId === undefined));
  assert.equal(state().sessions.filter(s => s.sessionGroupId === first.id).length, 1);
  assert.equal(state().sessions.filter(s => s.sessionGroupId === third.id).length, 2);
  const before = state().sessions.length;
  await act(async () => state().addSessionTab(second.id));
  assert.equal(state().sessions.length, before, 'workspace panes cannot silently join a flat session group');
  const firstRemaining = state().sessions.find(s => s.sessionGroupId === first.id)!;
  const thirdGroupOrder = state().getOrderedWorkTabs([editor]).filter(id => id === third.id || id === editor);
  await act(async () => state().createWorkspaceFromSessions(firstRemaining.id, third.id, { direction: 'vertical', position: 'right' }));
  assert.equal(state().workspaces.length, 2);
  assert.deepEqual(state().getOrderedWorkTabs([editor]).filter(id => id === third.id || id === editor), thirdGroupOrder);
  assert.equal(state().sessions.filter(s => s.sessionGroupId === third.id).length, 1, 'explicit merging moves only the chosen member');
  assert.ok(state().sessions.filter(s => s.workspaceId).every(s => !s.sessionGroupId));
});
