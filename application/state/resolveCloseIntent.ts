export type CloseIntent =
  | { kind: 'closeTerminal'; sessionId: string }
  | { kind: 'closeSidePanel' }
  | { kind: 'closeWorkspace'; workspaceId: string }
  | { kind: 'closeSingleTab'; sessionId: string }
  | { kind: 'noop' };

export interface ResolveCloseInput {
  activeTabId: string | null;
  workspace: { id: string; focusedSessionId?: string } | null;
  sessionForTab: { id: string } | null;
  activeSidePanelTab: string | null;
  focusIsInsideTerminal: boolean;
}

export function resolveCloseIntent(input: ResolveCloseInput): CloseIntent {
  const { activeTabId, workspace, sessionForTab, activeSidePanelTab, focusIsInsideTerminal } = input;

  if (!activeTabId) return { kind: 'noop' };

  if (sessionForTab && !workspace) {
    return { kind: 'closeSingleTab', sessionId: sessionForTab.id };
  }

  if (!workspace) {
    // e.g. 'vault', 'sftp', or any non-closable pinned tab
    return { kind: 'noop' };
  }

  const focusedSessionId = workspace.focusedSessionId;
  if (focusedSessionId && focusIsInsideTerminal) {
    return { kind: 'closeTerminal', sessionId: focusedSessionId };
  }

  if (activeSidePanelTab !== null) {
    return { kind: 'closeSidePanel' };
  }

  return { kind: 'closeWorkspace', workspaceId: workspace.id };
}
