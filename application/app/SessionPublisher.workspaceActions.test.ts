import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  EMPTY_SESSION_SNAPSHOT,
  getSessionSnapshotActions,
  publishSessionSnapshot,
} from '../state/sessionSnapshotStore';
import { getAppShellPropsSnapshot } from './appShellPropsStore';
import { registerAppHandlers } from './appHandlersBridge';

// Keep both production publishers and the store between them real. Only the
// state owner and unrelated theme side effects are replaced with fixtures.
const sessionFixtureUrl = `data:text/javascript,${encodeURIComponent(`
  let session;
  export function setSession(value) { session = value; }
  export function useSessionState() { return session; }
`)}`;
const themeFixtureUrl = `data:text/javascript,${encodeURIComponent(`
  const noop = () => {};
  const theme = {};
  const runtime = {
    globalAppearance: theme, accentedGlobalAppearance: theme,
    clearIntent: noop, settleManualIntent: noop, pickTheme: noop,
    resolveFocusedAppearance: noop, currentTerminalTheme: theme,
  };
  export function useThemeRuntime() { return runtime; }
  export function useTerminalAppearanceInjection() {}
`)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '../../state/useSessionState' && context.parentURL?.endsWith('/SessionPublisher.tsx')) {
      return { url: sessionFixtureUrl, shortCircuit: true };
    }
    if (specifier === '../../state/useThemeRuntime' && context.parentURL?.endsWith('/TerminalHost.tsx')) {
      return { url: themeFixtureUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { setSession } = await import(sessionFixtureUrl);
const { SessionPublisher } = await import('./publishers/SessionPublisher');
const { TerminalHost } = await import('./hosts/TerminalHost');

test('workspace actions reach the terminal shell through SessionPublisher and TerminalHost', async (t) => {
  const previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  let renderer: ReactTestRenderer | undefined;
  t.after(async () => {
    await act(async () => renderer?.unmount());
    registerAppHandlers(null);
    publishSessionSnapshot(EMPTY_SESSION_SNAPSHOT);
    if (previousActEnvironment) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousActEnvironment);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });

  const calls: unknown[][] = [];
  const moveWorkspacePane = (...args: unknown[]) => calls.push(['move', ...args]);
  const setWorkspaceAnchorChat = (...args: unknown[]) => calls.push(['anchor', ...args]);
  setSession({ ...EMPTY_SESSION_SNAPSHOT, moveWorkspacePane, setWorkspaceAnchorChat });
  registerAppHandlers({});
  const renderTree = () => React.createElement(
    SessionPublisher,
    { persistSessionRestore: false },
    React.createElement(TerminalHost),
  );
  await act(async () => { renderer = create(renderTree()); });

  assert.equal(getSessionSnapshotActions()?.moveWorkspacePane, moveWorkspacePane);
  assert.equal(getSessionSnapshotActions()?.setWorkspaceAnchorChat, setWorkspaceAnchorChat);
  const terminal = getAppShellPropsSnapshot().domains?.terminal;
  assert.equal(terminal?.moveWorkspacePane, moveWorkspacePane);
  assert.equal(terminal?.setWorkspaceAnchorChat, setWorkspaceAnchorChat);
  const hint = { direction: 'horizontal', position: 'top', targetSessionId: 'pane-b' };
  (terminal?.moveWorkspacePane as typeof moveWorkspacePane)('workspace', 'pane-a', hint);
  (terminal?.setWorkspaceAnchorChat as typeof setWorkspaceAnchorChat)('workspace', 'chat');
  assert.deepEqual(calls, [
    ['move', 'workspace', 'pane-a', hint],
    ['anchor', 'workspace', 'chat'],
  ]);

  // A changed state-owner callback must not be trapped in a stale memoized
  // action bag even when all session/workspace snapshots stay identical.
  const replacementMove = (...args: unknown[]) => calls.push(['replacement-move', ...args]);
  const replacementAnchor = (...args: unknown[]) => calls.push(['replacement-anchor', ...args]);
  setSession({ ...EMPTY_SESSION_SNAPSHOT, moveWorkspacePane: replacementMove, setWorkspaceAnchorChat: replacementAnchor });
  await act(async () => renderer!.update(renderTree()));
  assert.equal(getAppShellPropsSnapshot().domains?.terminal.moveWorkspacePane, replacementMove);
  assert.equal(getAppShellPropsSnapshot().domains?.terminal.setWorkspaceAnchorChat, replacementAnchor);
});
