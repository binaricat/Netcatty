import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import React, { useCallback, useRef, useSyncExternalStore } from 'react';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';
import { resolveSystemSidebarSession } from '../../domain/systemManager/resolveSystemSession';
import { collectSessionIds } from '../../domain/workspace';
import { getSidePanelLiveSnapshot, subscribeSidePanelLiveSnapshot, sidePanelLiveStore, SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT, type SidePanelLiveSnapshot } from './sidePanelLiveStore';

// Exercise the production hook without importing the unrelated panel UI modules.
const source = readFileSync(new URL('../../components/terminalLayer/terminalLayerSidePanelSlots.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('slots.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const hook = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'useSidePanelLiveSnapshotForTab');
assert.ok(hook);
const code = ts.transpile(hook.getText(ast), { target: ts.ScriptTarget.ES2022 });
const useSnapshot = vm.runInNewContext(`${code}; useSidePanelLiveSnapshotForTab`, {
  useCallback, useRef, useSyncExternalStore, getSidePanelLiveSnapshot,
  subscribeSidePanelLiveSnapshot, SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT,
}) as (tabId: string, enabled: boolean) => SidePanelLiveSnapshot;

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

test('workspace browser follows focus without replacing the earlier terminal context', async () => {
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = true;
  const browserSlot = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'SidePanelBrowserSlot');
  assert.ok(browserSlot);
  const slotCode = ts.transpile(browserSlot.getText(ast), { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
  const Slot = vm.runInNewContext(`${slotCode}; SidePanelBrowserSlot`, {
    React, useRef, useSidePanelLiveSnapshotForTab: useSnapshot, resolveSystemSidebarSession, collectSessionIds,
    sidePanelHiddenPanelClassName: (hidden: boolean) => hidden ? 'hidden' : 'visible',
    HostBrowserSidePanel: (props: object) => React.createElement('div', { ...props, 'data-browser-context': true }),
  }) as React.ComponentType<{ tabId: string; ctx: object; isVisible: boolean }>;
  const sessionA = { id: 'session-a', hostId: 'host-a', protocol: 'ssh' };
  const sessionB = { id: 'session-b', hostId: 'host-b', protocol: 'ssh' };
  const workspace = { id: 'workspace', focusedSessionId: sessionA.id, root: {
    id: 'split', type: 'split', direction: 'vertical', sizes: [0.5, 0.5], children: [
      { id: 'a', type: 'pane', sessionId: sessionA.id }, { id: 'b', type: 'pane', sessionId: sessionB.id },
    ],
  } } as NonNullable<SidePanelLiveSnapshot['activeWorkspace']>;
  const ctx = { sessions: [sessionA, sessionB], workspaceById: new Map([['workspace', workspace]]),
    sessionHostsMap: new Map([['session-a', { id: 'host-a', hostname: 'a' }], ['session-b', { id: 'host-b', hostname: 'b' }]]),
    sftpAuthHostBySessionId: new Map(), effectiveHosts: [], keys: [], identities: [], knownHosts: [], terminalSettings: {}, t: (key: string) => key };
  const publish = (session: typeof sessionA) => sidePanelLiveStore.update({ ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT,
    activeWorkspace: workspace, focusedSessionId: session.id,
    activeTerminalSessionForSystem: session as SidePanelLiveSnapshot['activeTerminalSessionForSystem'] });
  let renderer: ReturnType<typeof create> | undefined;
  try {
    publish(sessionA);
    await act(async () => { renderer = create(React.createElement(Slot, { tabId: 'workspace', ctx, isVisible: true })); });
    const contexts = () => renderer!.root.findAll((node) => node.type === 'div' && node.props['data-browser-context'] === true);
    const first = contexts()[0];
    assert.equal(first.props.host.id, 'host-a');
    await act(async () => publish(sessionB));
    assert.equal(contexts().length, 2);
    assert.equal(contexts()[0], first, 'the first terminal keeps the same browser mount');
    assert.equal(first.props.isVisible, false);
    assert.equal(contexts()[1].props.host.id, 'host-b');
    assert.equal(contexts()[1].props.isVisible, true);
    await act(async () => publish(sessionA));
    assert.equal(first.props.isVisible, true);
    assert.equal(contexts()[1].props.isVisible, false);
    await act(async () => renderer!.update(React.createElement(Slot, { tabId: 'workspace', ctx, isVisible: false })));
    assert.ok(contexts().every((context) => !context.props.isVisible), 'hidden tabs hide every native browser context');
    ctx.workspaceById.set('workspace', { ...workspace, focusedSessionId: sessionB.id,
      root: { id: 'b', type: 'pane', sessionId: sessionB.id } });
    await act(async () => renderer!.update(React.createElement(Slot, { tabId: 'workspace', ctx, isVisible: false })));
    assert.equal(contexts().length, 1, 'a detached session must leave the old workspace even while it still exists globally');
    assert.equal(contexts()[0].props.host.id, 'host-b', 'the remaining workspace browser stays mounted');
  } finally {
    await act(async () => renderer?.unmount());
    sidePanelLiveStore.update(SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT);
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

test('returning to a tab never exposes the previous tab snapshot before its publisher catches up', async () => {
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = true;
  const own = { ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT, focusedSessionId: 'ssh-a', activeTerminalSessionIdForSftp: 'ssh-a', activeTerminalCwd: '/root', activeTerminalCwdTrusted: true };
  const other = { ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT, focusedSessionId: 'local-b' };
  let visible = true;
  let observed: SidePanelLiveSnapshot = SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT;
  function Probe() { observed = useSnapshot('ssh-a', visible); return null; }
  sidePanelLiveStore.update(own);
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    assert.equal(observed.focusedSessionId, 'ssh-a');
    visible = false;
    await act(async () => { renderer?.update(React.createElement(Probe)); });
    await act(async () => { sidePanelLiveStore.update(other); });
    visible = true;
    await act(async () => { renderer?.update(React.createElement(Probe)); });
    assert.equal(observed.focusedSessionId, 'ssh-a', 'stale local session must not enter the SSH panel');
    assert.equal(observed.activeTerminalCwd, '/root', 'unchanged cwd must survive the reveal gap');
    await act(async () => { sidePanelLiveStore.update({ ...own, activeTerminalCwd: '/srv/changed' }); });
    assert.equal(observed.activeTerminalCwd, '/srv/changed', 'real cwd changes must still arrive');
  } finally {
    await act(async () => renderer?.unmount());
    sidePanelLiveStore.update(SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT);
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

test('new panels wait for their own snapshot and workspace panes accept focus changes within the workspace', async () => {
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = true;
  let observed = SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT;
  const workspace = { id: 'workspace-a' } as NonNullable<SidePanelLiveSnapshot['activeWorkspace']>;
  const own = { ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT, activeWorkspace: workspace, focusedSessionId: 'pane-a' };
  let panelTabId = 'workspace-a';
  function Probe() { observed = useSnapshot(panelTabId, true); return null; }
  sidePanelLiveStore.update({ ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT, focusedSessionId: 'unrelated' });
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    assert.equal(observed, SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT);
    await act(async () => { sidePanelLiveStore.update(own); });
    assert.equal(observed.focusedSessionId, 'pane-a');
    await act(async () => { sidePanelLiveStore.update({ ...own, focusedSessionId: 'pane-b' }); });
    assert.equal(observed.focusedSessionId, 'pane-b');
    await act(async () => { sidePanelLiveStore.update({ ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT, focusedSessionId: 'unrelated' }); });
    assert.equal(observed.focusedSessionId, 'pane-b');
    panelTabId = 'new-owner';
    await act(async () => { renderer?.update(React.createElement(Probe)); });
    assert.equal(observed, SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT, 'a reused hook must not retain another owner');
  } finally {
    await act(async () => renderer?.unmount());
    sidePanelLiveStore.update(SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT);
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
