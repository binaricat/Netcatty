import assert from 'node:assert/strict';
import test from 'node:test';

import type { TerminalSession } from '../../domain/models.ts';
import {
  EMPTY_SESSION_SNAPSHOT,
  getSessionSnapshot,
  getSessionSnapshotActions,
  publishSessionSnapshot,
  registerSessionSnapshotActions,
  sessionSnapshotsEqual,
  subscribeSessionSnapshot,
} from './sessionSnapshotStore.ts';

function makeSession(id: string): TerminalSession {
  return { id, hostLabel: id, status: 'connected' } as TerminalSession;
}

test('sessionSnapshotStore notifies only when a field identity changes', () => {
  const seen: number[] = [];
  const unsubscribe = subscribeSessionSnapshot(() => {
    seen.push(getSessionSnapshot().sessions.length);
  });

  const sessions = [makeSession('s1')];
  const snapshot = { ...EMPTY_SESSION_SNAPSHOT, sessions, orphanSessions: sessions };
  publishSessionSnapshot(snapshot);
  assert.deepEqual(seen, [1]);
  assert.equal(getSessionSnapshot().sessions, sessions);

  publishSessionSnapshot({ ...snapshot });
  assert.deepEqual(seen, [1]);

  // Presentation-only fields still count: rename targets drive dialog state.
  publishSessionSnapshot({ ...snapshot, sessionRenameTarget: sessions[0] });
  assert.deepEqual(seen, [1, 1]);
  assert.equal(getSessionSnapshot().sessionRenameTarget, sessions[0]);

  unsubscribe();
  publishSessionSnapshot(EMPTY_SESSION_SNAPSHOT);
  assert.deepEqual(seen, [1, 1]);
});

test('sessionSnapshotsEqual compares every published field', () => {
  assert.equal(
    sessionSnapshotsEqual(EMPTY_SESSION_SNAPSHOT, { ...EMPTY_SESSION_SNAPSHOT }),
    true,
  );
  assert.equal(
    sessionSnapshotsEqual(EMPTY_SESSION_SNAPSHOT, {
      ...EMPTY_SESSION_SNAPSHOT,
      draggingSessionId: 's1',
    }),
    false,
  );
  assert.equal(
    sessionSnapshotsEqual(EMPTY_SESSION_SNAPSHOT, { ...EMPTY_SESSION_SNAPSHOT, logViews: [] }),
    false,
  );
});

test('session actions register and unregister', () => {
  assert.equal(getSessionSnapshotActions(), null);
  const calls: string[] = [];
  const noop = (() => {}) as never;
  registerSessionSnapshotActions({
    setActiveTabId: ((id: string) => calls.push(id)) as never,
    closeSession: noop,
    closeSessions: noop,
    closeWorkspace: noop,
    openLogView: noop,
    closeLogView: noop,
    setDraggingSessionId: noop,
    startSessionRename: noop,
    renameSessionInline: noop,
    submitSessionRename: noop,
    resetSessionRename: noop,
    startWorkspaceRename: noop,
    submitWorkspaceRename: noop,
    resetWorkspaceRename: noop,
    removeSessionFromWorkspace: noop,
    setWorkspaceFocusedSession: noop,
    toggleWorkspaceViewMode: noop,
    createLocalTerminal: noop,
    createSerialSession: noop,
    connectToHost: noop,
    updateSessionStatus: noop,
    updateSessionFontSize: noop,
    clearSessionFontSizeOverride: noop,
    createWorkspaceWithHosts: noop,
    createWorkspaceFromSessions: noop,
    addSessionToWorkspace: noop,
    appendHostToWorkspace: noop,
    appendHostToWorkspaceConfirmed: noop,
    appendLocalTerminalToWorkspace: noop,
    createWorkspaceFromTargets: noop,
    updateSplitSizes: noop,
    splitSession: noop,
    addSessionTab: noop,
    selectSessionTab: noop,
    canUseGlobalBroadcast: false,
    toggleGlobalBroadcast: noop,
    isGlobalBroadcastEnabled: false,
    reorderWorkspaceSessions: noop,
    moveFocusInWorkspace: noop,
    runSnippet: noop,
    getOrderedWorkTabs: noop,
    reorderTabs: noop,
    toggleBroadcast: noop,
    isBroadcastEnabled: noop,
    toggleComposeSendTarget: noop,
    isComposeSendToAll: noop,
    toggleGlobalComposeSendTarget: noop,
    isGlobalComposeSendToAll: false,
    copySession: noop,
    copyWorkspace: noop,
    createSessionFromCloneSource: noop,
    updateSessionRestoreCwd: noop,
    getSessionRestoreCwd: noop,
    updateSessionDynamicTitle: noop,
    updateSessionCodingCliProvider: noop,
  });
  getSessionSnapshotActions()?.setActiveTabId('vault');
  assert.deepEqual(calls, ['vault']);

  registerSessionSnapshotActions(null);
  assert.equal(getSessionSnapshotActions(), null);
});
