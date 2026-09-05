import type { TerminalSession } from './models';

type BroadcastSession = Pick<TerminalSession, 'id' | 'workspaceId' | 'hiddenFromTabs'>;

export function resolveTerminalBroadcastTargetIds({
  sessions,
  sourceSessionId,
  globalBroadcastEnabled,
  directTargetSessionIds,
}: {
  sessions: readonly BroadcastSession[];
  sourceSessionId: string;
  globalBroadcastEnabled: boolean;
  directTargetSessionIds?: readonly string[];
}): string[] {
  if (directTargetSessionIds) {
    const directTargetIds = new Set(directTargetSessionIds);
    return sessions
      .filter((session) => directTargetIds.has(session.id))
      .map((session) => session.id);
  }

  const sourceSession = sessions.find((session) => session.id === sourceSessionId);
  if (!sourceSession) return [];

  if (sourceSession.workspaceId) {
    return sessions
      .filter((session) => (
        session.workspaceId === sourceSession.workspaceId
        && session.id !== sourceSessionId
      ))
      .map((session) => session.id);
  }

  if (!globalBroadcastEnabled || sourceSession.hiddenFromTabs) return [];

  return sessions
    .filter((session) => (
      !session.workspaceId
      && !session.hiddenFromTabs
      && session.id !== sourceSessionId
    ))
    .map((session) => session.id);
}
