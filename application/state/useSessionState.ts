import { MouseEvent, useMemo, useState } from 'react';
import { Host, TerminalSession, Workspace } from '../../domain/models';
import {
  createWorkspaceFromSessions as createWorkspaceEntity,
  insertPaneIntoWorkspace,
  pruneWorkspaceNode,
  SplitHint,
  updateWorkspaceSplitSizes,
} from '../../domain/workspace';

export const useSessionState = () => {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>('vault');
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [workspaceRenameTarget, setWorkspaceRenameTarget] = useState<Workspace | null>(null);
  const [workspaceRenameValue, setWorkspaceRenameValue] = useState('');

  const createLocalTerminal = () => {
    const sessionId = crypto.randomUUID();
    const localHostId = `local-${sessionId}`;
    const newSession: TerminalSession = {
      id: sessionId,
      hostId: localHostId,
      hostLabel: 'Local Terminal',
      hostname: 'localhost',
      username: 'local',
      status: 'connecting',
    };
    setSessions(prev => [...prev, newSession]);
    setActiveTabId(sessionId);
  };

  const connectToHost = (host: Host) => {
    const newSession: TerminalSession = {
      id: crypto.randomUUID(),
      hostId: host.id,
      hostLabel: host.label,
      hostname: host.hostname,
      username: host.username,
      status: 'connecting',
    };
    setSessions(prev => [...prev, newSession]);
    setActiveTabId(newSession.id);
  };

  const updateSessionStatus = (sessionId: string, status: TerminalSession['status']) => {
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, status } : s));
  };

  const closeSession = (sessionId: string, e?: MouseEvent) => {
    e?.stopPropagation();
    const targetSession = sessions.find(s => s.id === sessionId);
    const workspaceId = targetSession?.workspaceId;
    let removedWorkspaceId: string | null = null;

    let nextWorkspaces = workspaces;
    if (workspaceId) {
      nextWorkspaces = workspaces
        .map(ws => {
          if (ws.id !== workspaceId) return ws;
          const pruned = pruneWorkspaceNode(ws.root, sessionId);
          if (!pruned) {
            removedWorkspaceId = ws.id;
            return null;
          }
          return { ...ws, root: pruned };
        })
        .filter((ws): ws is Workspace => Boolean(ws));
    }

    const remainingSessions = sessions.filter(s => s.id !== sessionId);
    setWorkspaces(nextWorkspaces);
    setSessions(remainingSessions);

    const fallbackWorkspace = nextWorkspaces[nextWorkspaces.length - 1];
    const fallbackSolo = remainingSessions.filter(s => !s.workspaceId).slice(-1)[0];

    const setFallback = () => {
      if (fallbackWorkspace) setActiveTabId(fallbackWorkspace.id);
      else if (fallbackSolo) setActiveTabId(fallbackSolo.id);
      else setActiveTabId('vault');
    };

    if (activeTabId === sessionId) {
      if (fallbackSolo) setActiveTabId(fallbackSolo.id);
      else setFallback();
    } else if (removedWorkspaceId && activeTabId === removedWorkspaceId) {
      setFallback();
    } else if (workspaceId && activeTabId === workspaceId && !nextWorkspaces.find(w => w.id === workspaceId)) {
      setFallback();
    }
  };

  const closeWorkspace = (workspaceId: string) => {
    const remainingWorkspaces = workspaces.filter(w => w.id !== workspaceId);
    const remainingSessions = sessions.filter(s => s.workspaceId !== workspaceId);
    setWorkspaces(remainingWorkspaces);
    setSessions(remainingSessions);

    if (activeTabId === workspaceId) {
      const remainingOrphans = remainingSessions.filter(s => !s.workspaceId);
      if (remainingWorkspaces.length > 0) {
        setActiveTabId(remainingWorkspaces[remainingWorkspaces.length - 1].id);
      } else if (remainingOrphans.length > 0) {
        setActiveTabId(remainingOrphans[remainingOrphans.length - 1].id);
      } else {
        setActiveTabId('vault');
      }
    }
  };

  const startWorkspaceRename = (workspaceId: string) => {
    const target = workspaces.find(w => w.id === workspaceId);
    if (!target) return;
    setWorkspaceRenameTarget(target);
    setWorkspaceRenameValue(target.title);
  };

  const submitWorkspaceRename = () => {
    const name = workspaceRenameValue.trim();
    if (!name || !workspaceRenameTarget) return;
    setWorkspaces(prev => prev.map(w => w.id === workspaceRenameTarget.id ? { ...w, title: name } : w));
    setWorkspaceRenameTarget(null);
    setWorkspaceRenameValue('');
  };

  const resetWorkspaceRename = () => {
    setWorkspaceRenameTarget(null);
    setWorkspaceRenameValue('');
  };

  const createWorkspaceFromSessions = (
    baseSessionId: string,
    joiningSessionId: string,
    hint: SplitHint
  ) => {
    if (!hint || baseSessionId === joiningSessionId) return;
    const base = sessions.find(s => s.id === baseSessionId);
    const joining = sessions.find(s => s.id === joiningSessionId);
    if (!base || !joining || base.workspaceId || joining.workspaceId) return;

    const newWorkspace = createWorkspaceEntity(baseSessionId, joiningSessionId, hint);
    setWorkspaces(prev => [...prev, newWorkspace]);
    setSessions(prev => prev.map(s => {
      if (s.id === baseSessionId || s.id === joiningSessionId) {
        return { ...s, workspaceId: newWorkspace.id };
      }
      return s;
    }));
    setActiveTabId(newWorkspace.id);
  };

  const addSessionToWorkspace = (
    workspaceId: string,
    sessionId: string,
    hint: SplitHint
  ) => {
    const targetWorkspace = workspaces.find(w => w.id === workspaceId);
    if (!targetWorkspace || !hint) return;
    const session = sessions.find(s => s.id === sessionId);
    if (!session || session.workspaceId) return;

    setWorkspaces(prev => prev.map(ws => {
      if (ws.id !== workspaceId) return ws;
      return { ...ws, root: insertPaneIntoWorkspace(ws.root, sessionId, hint) };
    }));

    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, workspaceId } : s));
    setActiveTabId(workspaceId);
  };

  const updateSplitSizes = (workspaceId: string, splitId: string, sizes: number[]) => {
    setWorkspaces(prev => prev.map(ws => {
      if (ws.id !== workspaceId) return ws;
      return { ...ws, root: updateWorkspaceSplitSizes(ws.root, splitId, sizes) };
    }));
  };

  const orphanSessions = useMemo(() => sessions.filter(s => !s.workspaceId), [sessions]);

  return {
    sessions,
    workspaces,
    activeTabId,
    setActiveTabId,
    draggingSessionId,
    setDraggingSessionId,
    workspaceRenameTarget,
    workspaceRenameValue,
    setWorkspaceRenameValue,
    startWorkspaceRename,
    submitWorkspaceRename,
    resetWorkspaceRename,
    createLocalTerminal,
    connectToHost,
    closeSession,
    closeWorkspace,
    updateSessionStatus,
    createWorkspaceFromSessions,
    addSessionToWorkspace,
    updateSplitSizes,
    orphanSessions,
  };
};
