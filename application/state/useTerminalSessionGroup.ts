import { useMemo } from 'react';
import { getSessionGroups } from '../../domain/sessionGroup';
import { useActiveTabId } from './activeTabStore';
import { useSessionSnapshotActions, useSessionSnapshotField } from './sessionSnapshotStore';

export function useTerminalSessionGroup() {
  const tabId = useActiveTabId();
  const sessions = useSessionSnapshotField('sessions');
  const actions = useSessionSnapshotActions();
  const group = useMemo(() => getSessionGroups(sessions).find(candidate => (
    candidate.id === tabId || candidate.sessionIds.includes(tabId)
  )), [sessions, tabId]);
  const members = useMemo(() => group
    ? group.sessionIds.map(id => sessions.find(session => session.id === id)!)
    : [], [group, sessions]);
  const activeId = group?.sessionIds.includes(tabId) && tabId !== group.id ? tabId : group?.activeSessionId;
  const active = members.find(session => session.id === activeId);
  return {
    group,
    sessions: members,
    activeSessionId: activeId,
    select: (id: string) => actions?.selectSessionTab(id),
    add: () => active && actions?.addSessionTab(active.id, {
      localShellType: active.shellType,
      inheritedCwd: active.protocol === 'local' ? actions.getSessionRestoreCwd(active.id) : undefined,
    }),
    close: (id: string) => actions?.closeSession(id),
    rename: (id: string, name: string) => actions?.submitSessionRename(id, name),
  };
}
