import { useSyncExternalStore } from 'react';

import type { TerminalSession, Workspace } from '../../domain/models';
import type { LogView } from './logViewState';
import type { useSessionState } from './useSessionState';

type SessionState = ReturnType<typeof useSessionState>;

type Listener = () => void;

/**
 * Session/workspace catalog for shell surfaces. `activeTabId` is intentionally
 * absent — it lives in `activeTabStore` so tab switches stay off this path.
 */
export type SessionSnapshot = {
  sessions: readonly TerminalSession[];
  /** Sessions with no workspace and not hidden from tabs; TopTabs renders these. */
  orphanSessions: readonly TerminalSession[];
  workspaces: readonly Workspace[];
  logViews: readonly LogView[];
  draggingSessionId: string | null;
  sessionRenameTarget: TerminalSession | null;
  workspaceRenameTarget: Workspace | null;
};

/**
 * Session mutators the shell needs. Derived from the hook return so the store
 * contract cannot drift from `useSessionState`.
 */
export type SessionSnapshotActions = Pick<
  SessionState,
  | 'setActiveTabId'
  | 'closeSession'
  | 'closeSessions'
  | 'closeWorkspace'
  | 'openLogView'
  | 'closeLogView'
  | 'setDraggingSessionId'
  | 'startSessionRename'
  | 'renameSessionInline'
  | 'submitSessionRename'
  | 'resetSessionRename'
  | 'startWorkspaceRename'
  | 'submitWorkspaceRename'
  | 'resetWorkspaceRename'
  | 'removeSessionFromWorkspace'
  | 'setWorkspaceFocusedSession'
  | 'toggleWorkspaceViewMode'
  // Terminal / chrome mutators previously read only via App session runtime.
  | 'createLocalTerminal'
  | 'createSerialSession'
  | 'connectToHost'
  | 'updateSessionStatus'
  | 'updateSessionFontSize'
  | 'clearSessionFontSizeOverride'
  | 'createWorkspaceWithHosts'
  | 'createWorkspaceFromSessions'
  | 'addSessionToWorkspace'
  | 'appendHostToWorkspace'
  | 'appendLocalTerminalToWorkspace'
  | 'createWorkspaceFromTargets'
  | 'updateSplitSizes'
  | 'splitSession'
  | 'reorderWorkspaceSessions'
  | 'moveFocusInWorkspace'
  | 'runSnippet'
  | 'getOrderedWorkTabs'
  | 'reorderTabs'
  | 'toggleBroadcast'
  | 'isBroadcastEnabled'
  | 'toggleGlobalBroadcast'
  | 'isGlobalBroadcastEnabled'
  | 'canUseGlobalBroadcast'
  | 'copySession'
  | 'copyWorkspace'
  | 'createSessionFromCloneSource'
  | 'updateSessionRestoreCwd'
  | 'getSessionRestoreCwd'
  | 'updateSessionDynamicTitle'
  | 'updateSessionCodingCliProvider'
>;

const EMPTY_SESSIONS: readonly TerminalSession[] = Object.freeze([]);
const EMPTY_WORKSPACES: readonly Workspace[] = Object.freeze([]);
const EMPTY_LOG_VIEWS: readonly LogView[] = Object.freeze([]);

export const EMPTY_SESSION_SNAPSHOT: SessionSnapshot = Object.freeze({
  sessions: EMPTY_SESSIONS,
  orphanSessions: EMPTY_SESSIONS,
  workspaces: EMPTY_WORKSPACES,
  logViews: EMPTY_LOG_VIEWS,
  draggingSessionId: null,
  sessionRenameTarget: null,
  workspaceRenameTarget: null,
});

const SNAPSHOT_KEYS = Object.keys(EMPTY_SESSION_SNAPSHOT) as (keyof SessionSnapshot)[];

export function sessionSnapshotsEqual(
  prev: SessionSnapshot,
  next: SessionSnapshot,
): boolean {
  return SNAPSHOT_KEYS.every((key) => prev[key] === next[key]);
}

/**
 * External store for the session catalog so TopTabs, the terminal layer and
 * the host tree can subscribe directly instead of receiving sessions through
 * the App domain bags.
 */
class SessionSnapshotStore {
  private snapshot: SessionSnapshot = EMPTY_SESSION_SNAPSHOT;
  private actions: SessionSnapshotActions | null = null;
  private listeners = new Set<Listener>();
  private actionListeners = new Set<Listener>();

  getSnapshot = (): SessionSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setSnapshot(next: SessionSnapshot): void {
    if (sessionSnapshotsEqual(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  getActions = (): SessionSnapshotActions | null => this.actions;

  subscribeActions = (listener: Listener): (() => void) => {
    this.actionListeners.add(listener);
    return () => {
      this.actionListeners.delete(listener);
    };
  };

  setActions(next: SessionSnapshotActions | null): void {
    if (this.actions === next) return;
    this.actions = next;
    for (const listener of this.actionListeners) {
      listener();
    }
  }
}

export const sessionSnapshotStore = new SessionSnapshotStore();

export function publishSessionSnapshot(snapshot: SessionSnapshot): void {
  sessionSnapshotStore.setSnapshot(snapshot);
}

export function getSessionSnapshot(): SessionSnapshot {
  return sessionSnapshotStore.getSnapshot();
}

export function subscribeSessionSnapshot(listener: Listener): () => void {
  return sessionSnapshotStore.subscribe(listener);
}

export function registerSessionSnapshotActions(
  actions: SessionSnapshotActions | null,
): void {
  sessionSnapshotStore.setActions(actions);
}

export function getSessionSnapshotActions(): SessionSnapshotActions | null {
  return sessionSnapshotStore.getActions();
}

export function subscribeSessionSnapshotActions(listener: Listener): () => void {
  return sessionSnapshotStore.subscribeActions(listener);
}

/** Subscribe to the whole session catalog. Prefer a narrower selector hook. */
export function useSessionSnapshot(): SessionSnapshot {
  return useSyncExternalStore(
    subscribeSessionSnapshot,
    getSessionSnapshot,
    getSessionSnapshot,
  );
}

/** Subscribe to one session field so unrelated session churn stays out. */
export function useSessionSnapshotField<K extends keyof SessionSnapshot>(
  field: K,
): SessionSnapshot[K] {
  const read = () => getSessionSnapshot()[field];
  return useSyncExternalStore(subscribeSessionSnapshot, read, read);
}

export function useSessionSnapshotActions(): SessionSnapshotActions | null {
  return useSyncExternalStore(
    subscribeSessionSnapshotActions,
    getSessionSnapshotActions,
    getSessionSnapshotActions,
  );
}
