import { TerminalSession } from '../../types';

type SessionActivityMap = Record<string, boolean>;

export const getValidSessionActivityIds = (sessions: TerminalSession[]): Set<string> => {
  return new Set(sessions.map((session) => session.id));
};

export const shouldMarkSessionActivity = (
  activeTabId: string | null,
  session: Pick<TerminalSession, 'id' | 'workspaceId'>,
): boolean => {
  return activeTabId !== session.id && activeTabId !== session.workspaceId;
};

export const getSessionActivityIdsToClear = (
  activeTabId: string | null,
  sessions: TerminalSession[],
): string[] => {
  if (!activeTabId || activeTabId === 'vault' || activeTabId === 'sftp') {
    return [];
  }

  const activeSession = sessions.find((session) => session.id === activeTabId);
  if (activeSession) {
    return [activeSession.id];
  }

  return sessions
    .filter((session) => session.workspaceId === activeTabId)
    .map((session) => session.id);
};

export const buildWorkspaceActivityMap = (
  sessions: TerminalSession[],
  sessionActivityMap: SessionActivityMap,
): Map<string, boolean> => {
  const workspaceActivityMap = new Map<string, boolean>();

  for (const session of sessions) {
    if (!session.workspaceId || !sessionActivityMap[session.id]) continue;
    workspaceActivityMap.set(session.workspaceId, true);
  }

  return workspaceActivityMap;
};
