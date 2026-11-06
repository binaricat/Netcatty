import type { TerminalSession } from './models';

/** A flat session group is independent of workspace pane/split trees. */
export interface TerminalSessionGroup {
  id: string;
  sessionIds: string[];
  activeSessionId: string;
}

export function getSessionTabId(session: Pick<TerminalSession, 'id' | 'workspaceId' | 'sessionGroupId'>): string {
  return session.workspaceId ?? session.sessionGroupId ?? session.id;
}

export function getSessionGroups(sessions: readonly TerminalSession[]): TerminalSessionGroup[] {
  const groups = new Map<string, TerminalSessionGroup>();
  for (const session of sessions) {
    if (session.workspaceId || session.hiddenFromTabs) continue;
    const id = getSessionTabId(session);
    let group = groups.get(id);
    if (!group) {
      group = { id, sessionIds: [], activeSessionId: session.id };
      groups.set(id, group);
    }
    group.sessionIds.push(session.id);
    if (session.sessionGroupFocused) group.activeSessionId = session.id;
  }
  return [...groups.values()];
}

export function resolveSessionGroupSession(sessions: readonly TerminalSession[], tabId: string | null | undefined): TerminalSession | undefined {
  const group = getSessionGroups(sessions).find(candidate => candidate.id === tabId);
  return sessions.find(session => session.id === (group?.activeSessionId ?? tabId));
}

export function normalizeSessionGroups(sessions: TerminalSession[]): TerminalSession[] {
  const focused = new Set(getSessionGroups(sessions).map(group => group.activeSessionId));
  let changed = false;
  const next = sessions.map(session => {
    if (session.workspaceId || session.hiddenFromTabs) {
      if (!session.sessionGroupId && session.sessionGroupFocused === undefined) return session;
      const { sessionGroupId: _group, sessionGroupFocused: _focused, ...rest } = session;
      changed = true;
      return rest;
    }
    const id = getSessionTabId(session);
    const selected = focused.has(session.id);
    if (session.sessionGroupId === id && session.sessionGroupFocused === selected) return session;
    changed = true;
    return { ...session, sessionGroupId: id, sessionGroupFocused: selected };
  });
  return changed ? next : sessions;
}

export function selectSessionInGroup(sessions: TerminalSession[], sessionId: string): TerminalSession[] {
  const target = sessions.find(session => session.id === sessionId && !session.workspaceId && !session.hiddenFromTabs);
  if (!target) return sessions;
  const groupId = getSessionTabId(target);
  return sessions.map(session => getSessionTabId(session) === groupId
    ? { ...session, sessionGroupFocused: session.id === sessionId }
    : session);
}
