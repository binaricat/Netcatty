import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import React, { useCallback, useRef, useSyncExternalStore } from 'react';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';
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
