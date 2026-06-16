import { collectSessionIds } from '../workspace';
import type { TerminalSession, Workspace } from '../../types';

/** Resolve which terminal session the system sidebar should target (workspace focus-aware). */
export function resolveSystemSidebarSession(
  sessions: TerminalSession[],
  activeWorkspace: Workspace | undefined,
  focusedSessionId: string | undefined,
  activeSession: TerminalSession | undefined,
): TerminalSession | null {
  if (activeWorkspace) {
    const workspaceSessionIds = collectSessionIds(activeWorkspace.root);
    const idSet = new Set(workspaceSessionIds);
    const preferredId = focusedSessionId && idSet.has(focusedSessionId)
      ? focusedSessionId
      : workspaceSessionIds.find((id) => sessions.some((session) => session.id === id));
    if (!preferredId) return null;
    return sessions.find((session) => session.id === preferredId) ?? null;
  }
  return activeSession ?? null;
}
