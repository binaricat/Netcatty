import { useLayoutEffect, useMemo } from 'react';

import {
  AppSessionRuntimeContext,
  registerAppSessionRuntime,
} from '../../state/appRuntimeBridge';
import {
  publishSessionSnapshot,
  registerSessionSnapshotActions,
} from '../../state/sessionSnapshotStore';
import { useSessionState } from '../../state/useSessionState';
import type { ReactNode } from 'react';

export type SessionPublisherProps = {
  /** Peer session windows must not write the main window's restore record. */
  persistSessionRestore: boolean;
  children?: ReactNode;
};

/**
 * Owns `useSessionState` and publishes it the same three ways `VaultPublisher`
 * publishes the vault: catalog into `sessionSnapshotStore`, mutators into its
 * action slot, and the whole runtime onto `appRuntimeBridge` for App.
 */
export function SessionPublisher({ persistSessionRestore, children }: SessionPublisherProps) {
  const session = useSessionState({ persistSessionRestore });
  const {
    sessions,
    orphanSessions,
    workspaces,
    logViews,
    draggingSessionId,
    sessionRenameTarget,
    workspaceRenameTarget,
    setActiveTabId,
    closeSession,
    closeSessions,
    closeWorkspace,
    openLogView,
    closeLogView,
    setDraggingSessionId,
    startSessionRename,
    renameSessionInline,
    submitSessionRename,
    resetSessionRename,
    startWorkspaceRename,
    submitWorkspaceRename,
    resetWorkspaceRename,
    removeSessionFromWorkspace,
    setWorkspaceFocusedSession,
    toggleWorkspaceViewMode,
    createLocalTerminal,
    createSerialSession,
    connectToHost,
    updateSessionStatus,
    updateSessionFontSize,
    clearSessionFontSizeOverride,
    createWorkspaceWithHosts,
    createWorkspaceFromSessions,
    addSessionToWorkspace,
    appendHostToWorkspace,
    appendLocalTerminalToWorkspace,
    createWorkspaceFromTargets,
    updateSplitSizes,
    splitSession,
    reorderWorkspaceSessions,
    moveFocusInWorkspace,
    runSnippet,
    getOrderedWorkTabs,
    reorderTabs,
    toggleBroadcast,
    isBroadcastEnabled,
    toggleGlobalBroadcast,
    isGlobalBroadcastEnabled,
    canUseGlobalBroadcast,
    copySession,
    copyWorkspace,
    createSessionFromCloneSource,
    updateSessionRestoreCwd,
    getSessionRestoreCwd,
    updateSessionDynamicTitle,
    updateSessionCodingCliProvider,
  } = session;

  useLayoutEffect(() => {
    registerAppSessionRuntime(session);
  }, [session]);

  // Only a real unmount clears the slot; see VaultPublisher for why.
  useLayoutEffect(() => () => {
    registerAppSessionRuntime(null);
  }, []);

  useLayoutEffect(() => {
    publishSessionSnapshot({
      sessions,
      orphanSessions,
      workspaces,
      logViews,
      draggingSessionId,
      sessionRenameTarget,
      workspaceRenameTarget,
    });
  }, [
    draggingSessionId,
    logViews,
    orphanSessions,
    sessionRenameTarget,
    sessions,
    workspaceRenameTarget,
    workspaces,
  ]);

  const sessionActions = useMemo(() => ({
    setActiveTabId,
    closeSession,
    closeSessions,
    closeWorkspace,
    openLogView,
    closeLogView,
    setDraggingSessionId,
    startSessionRename,
    renameSessionInline,
    submitSessionRename,
    resetSessionRename,
    startWorkspaceRename,
    submitWorkspaceRename,
    resetWorkspaceRename,
    removeSessionFromWorkspace,
    setWorkspaceFocusedSession,
    toggleWorkspaceViewMode,
    createLocalTerminal,
    createSerialSession,
    connectToHost,
    updateSessionStatus,
    updateSessionFontSize,
    clearSessionFontSizeOverride,
    createWorkspaceWithHosts,
    createWorkspaceFromSessions,
    addSessionToWorkspace,
    appendHostToWorkspace,
    appendLocalTerminalToWorkspace,
    createWorkspaceFromTargets,
    updateSplitSizes,
    splitSession,
    reorderWorkspaceSessions,
    moveFocusInWorkspace,
    runSnippet,
    getOrderedWorkTabs,
    reorderTabs,
    toggleBroadcast,
    isBroadcastEnabled,
    toggleGlobalBroadcast,
    isGlobalBroadcastEnabled,
    canUseGlobalBroadcast,
    copySession,
    copyWorkspace,
    createSessionFromCloneSource,
    updateSessionRestoreCwd,
    getSessionRestoreCwd,
    updateSessionDynamicTitle,
    updateSessionCodingCliProvider,
  }), [
    addSessionToWorkspace,
    appendHostToWorkspace,
    appendLocalTerminalToWorkspace,
    clearSessionFontSizeOverride,
    closeLogView,
    closeSession,
    closeSessions,
    closeWorkspace,
    connectToHost,
    copySession,
    copyWorkspace,
    createLocalTerminal,
    createSerialSession,
    createSessionFromCloneSource,
    createWorkspaceFromSessions,
    createWorkspaceFromTargets,
    createWorkspaceWithHosts,
    getOrderedWorkTabs,
    getSessionRestoreCwd,
    isBroadcastEnabled,
    isGlobalBroadcastEnabled,
    moveFocusInWorkspace,
    openLogView,
    canUseGlobalBroadcast,
    removeSessionFromWorkspace,
    renameSessionInline,
    reorderTabs,
    reorderWorkspaceSessions,
    resetSessionRename,
    resetWorkspaceRename,
    runSnippet,
    setActiveTabId,
    setDraggingSessionId,
    setWorkspaceFocusedSession,
    splitSession,
    startSessionRename,
    startWorkspaceRename,
    submitSessionRename,
    submitWorkspaceRename,
    toggleBroadcast,
    toggleGlobalBroadcast,
    toggleWorkspaceViewMode,
    updateSessionCodingCliProvider,
    updateSessionDynamicTitle,
    updateSessionFontSize,
    updateSessionRestoreCwd,
    updateSessionStatus,
    updateSplitSizes,
  ]);

  useLayoutEffect(() => {
    registerSessionSnapshotActions(sessionActions);
    return () => {
      registerSessionSnapshotActions(null);
    };
  }, [sessionActions]);

  return (
    <AppSessionRuntimeContext.Provider value={session}>
      {children}
    </AppSessionRuntimeContext.Provider>
  );
}
