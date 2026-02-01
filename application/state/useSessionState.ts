import { MouseEvent,useCallback,useMemo,useState } from 'react';
import { ConnectionLog,Host,SerialConfig,Snippet,TerminalSession,Workspace,WorkspaceViewMode } from '../../domain/models';
import {
collectSessionIds,
createWorkspaceFromSessions as createWorkspaceEntity,
createWorkspaceFromSessionIds,
FocusDirection,
getNextFocusSessionId,
insertPaneIntoWorkspace,
pruneWorkspaceNode,
SplitDirection,
SplitHint,
updateWorkspaceSplitSizes,
} from '../../domain/workspace';
import { activeTabStore } from './activeTabStore';

// LogView represents an open log replay tab
export interface LogView {
  id: string; // Tab ID (log-${connectionLogId})
  connectionLogId: string;
  log: ConnectionLog;
}

export const useSessionState = () => {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // activeTabId is now managed by external store - components subscribe directly
  const setActiveTabId = activeTabStore.setActiveTabId;
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [sessionRenameTarget, setSessionRenameTarget] = useState<TerminalSession | null>(null);
  const [sessionRenameValue, setSessionRenameValue] = useState('');
  const [workspaceRenameTarget, setWorkspaceRenameTarget] = useState<Workspace | null>(null);
  const [workspaceRenameValue, setWorkspaceRenameValue] = useState('');
  // Tab order: stores ordered list of tab IDs (orphan session IDs and workspace IDs)
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  // Broadcast mode: stores workspace IDs that have broadcast enabled
  const [broadcastWorkspaceIds, setBroadcastWorkspaceIds] = useState<Set<string>>(new Set());
  // Log views: stores open log replay tabs
  const [logViews, setLogViews] = useState<LogView[]>([]);

  const createLocalTerminal = useCallback(() => {
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
	  }, [setActiveTabId]);

  const createSerialSession = useCallback((config: SerialConfig) => {
    const sessionId = crypto.randomUUID();
    const serialHostId = `serial-${sessionId}`;
    const portName = config.path.split('/').pop() || config.path;
    const newSession: TerminalSession = {
      id: sessionId,
      hostId: serialHostId,
      hostLabel: `Serial: ${portName}`,
      hostname: config.path,
      username: '',
      status: 'connecting',
      protocol: 'serial',
      serialConfig: config,
    };
    setSessions(prev => [...prev, newSession]);
    setActiveTabId(sessionId);
  }, [setActiveTabId]);

  const connectToHost = useCallback((host: Host) => {
    // Handle serial hosts specially - use createSerialSession for them
    if (host.protocol === 'serial') {
      // Use stored serialConfig or construct from host data
      const serialConfig: SerialConfig = host.serialConfig || {
        path: host.hostname,
        baudRate: host.port || 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        localEcho: false,
        lineMode: false,
      };
      
      const sessionId = crypto.randomUUID();
      const portName = serialConfig.path.split('/').pop() || serialConfig.path;
      const newSession: TerminalSession = {
        id: sessionId,
        hostId: host.id,
        hostLabel: host.label || `Serial: ${portName}`,
        hostname: serialConfig.path,
        username: '',
        status: 'connecting',
        protocol: 'serial',
        serialConfig: serialConfig,
      };
      setSessions(prev => [...prev, newSession]);
      setActiveTabId(sessionId);
      return;
    }

    const newSession: TerminalSession = {
      id: crypto.randomUUID(),
      hostId: host.id,
      hostLabel: host.label,
      hostname: host.hostname,
      username: host.username,
      status: 'connecting',
      // Store connection-time protocol settings from the host object
      protocol: host.protocol,
      port: host.port,
      moshEnabled: host.moshEnabled,
    };
	    setSessions(prev => [...prev, newSession]);
	    setActiveTabId(newSession.id);
	  }, [setActiveTabId]);

  const updateSessionStatus = useCallback((sessionId: string, status: TerminalSession['status']) => {
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, status } : s));
  }, []);

  const closeSession = useCallback((sessionId: string, e?: MouseEvent) => {
    e?.stopPropagation();
    
    setSessions(prevSessions => {
      const targetSession = prevSessions.find(s => s.id === sessionId);
      const wsId = targetSession?.workspaceId;
      
      setWorkspaces(prevWorkspaces => {
        let removedWorkspaceId: string | null = null;
        let nextWorkspaces = prevWorkspaces;
        let dissolvedWorkspaceId: string | null = null;
        let lastRemainingSessionId: string | null = null;
        
        if (wsId) {
          nextWorkspaces = prevWorkspaces
            .map(ws => {
              if (ws.id !== wsId) return ws;
              const pruned = pruneWorkspaceNode(ws.root, sessionId);
              if (!pruned) {
                removedWorkspaceId = ws.id;
                return null;
              }
              
              // Check if only 1 session remains - dissolve workspace
              const remainingSessionIds = collectSessionIds(pruned);
              if (remainingSessionIds.length === 1) {
                dissolvedWorkspaceId = ws.id;
                lastRemainingSessionId = remainingSessionIds[0];
                return null;
              }
              
              return { ...ws, root: pruned };
            })
            .filter((ws): ws is Workspace => Boolean(ws));
        }
        
        const remainingSessions = prevSessions.filter(s => s.id !== sessionId);
        const fallbackWorkspace = nextWorkspaces[nextWorkspaces.length - 1];
        const fallbackSolo = remainingSessions.filter(s => !s.workspaceId).slice(-1)[0];

        const currentActiveTabId = activeTabStore.getActiveTabId();
        const getFallback = () => {
          if (lastRemainingSessionId) return lastRemainingSessionId;
          if (fallbackWorkspace) return fallbackWorkspace.id;
          if (fallbackSolo) return fallbackSolo.id;
          return 'vault';
        };

        if (dissolvedWorkspaceId && currentActiveTabId === dissolvedWorkspaceId) {
          setActiveTabId(getFallback());
        } else if (currentActiveTabId === sessionId) {
          setActiveTabId(getFallback());
        } else if (removedWorkspaceId && currentActiveTabId === removedWorkspaceId) {
          setActiveTabId(getFallback());
        } else if (wsId && currentActiveTabId === wsId && !nextWorkspaces.find(w => w.id === wsId)) {
          setActiveTabId(getFallback());
        }
        
        return nextWorkspaces;
      });
      
      // Check if we need to dissolve a workspace (convert remaining session to orphan)
      if (targetSession?.workspaceId) {
        const ws = workspaces.find(w => w.id === targetSession.workspaceId);
        if (ws) {
          const pruned = pruneWorkspaceNode(ws.root, sessionId);
          if (pruned) {
            const remainingSessionIds = collectSessionIds(pruned);
            if (remainingSessionIds.length === 1) {
              // Dissolve: remove workspaceId from the remaining session
              return prevSessions
                .filter(s => s.id !== sessionId)
                .map(s => remainingSessionIds.includes(s.id) ? { ...s, workspaceId: undefined } : s);
            }
          }
        }
      }
	      
	      return prevSessions.filter(s => s.id !== sessionId);
	    });
	  }, [workspaces, setActiveTabId]);

  const closeWorkspace = useCallback((workspaceId: string) => {
    setWorkspaces(prevWorkspaces => {
      const remainingWorkspaces = prevWorkspaces.filter(w => w.id !== workspaceId);
      
      setSessions(prevSessions => prevSessions.filter(s => s.workspaceId !== workspaceId));
      
      const currentActiveTabId = activeTabStore.getActiveTabId();
      if (currentActiveTabId === workspaceId) {
        if (remainingWorkspaces.length > 0) {
          setActiveTabId(remainingWorkspaces[remainingWorkspaces.length - 1].id);
        } else {
          setActiveTabId('vault');
        }
      }
      
	      return remainingWorkspaces;
	    });
	  }, [setActiveTabId]);

  const startSessionRename = useCallback((sessionId: string) => {
    setSessions(prevSessions => {
      const target = prevSessions.find(s => s.id === sessionId);
      if (target) {
        setSessionRenameTarget(target);
        setSessionRenameValue(target.hostLabel);
      }
      return prevSessions;
    });
  }, []);

  const submitSessionRename = useCallback(() => {
    setSessionRenameValue(prevValue => {
      const name = prevValue.trim();
      if (!name) return prevValue;

      setSessionRenameTarget(prevTarget => {
        if (!prevTarget) return prevTarget;
        setSessions(prev => prev.map(s => s.id === prevTarget.id ? { ...s, hostLabel: name } : s));
        return null;
      });

      return '';
    });
  }, []);

  const resetSessionRename = useCallback(() => {
    setSessionRenameTarget(null);
    setSessionRenameValue('');
  }, []);

  const startWorkspaceRename = useCallback((workspaceId: string) => {
    setWorkspaces(prevWorkspaces => {
      const target = prevWorkspaces.find(w => w.id === workspaceId);
      if (target) {
        setWorkspaceRenameTarget(target);
        setWorkspaceRenameValue(target.title);
      }
      return prevWorkspaces;
    });
  }, []);

  const submitWorkspaceRename = useCallback(() => {
    setWorkspaceRenameValue(prevValue => {
      const name = prevValue.trim();
      if (!name) return prevValue;
      
      setWorkspaceRenameTarget(prevTarget => {
        if (!prevTarget) return prevTarget;
        setWorkspaces(prev => prev.map(w => w.id === prevTarget.id ? { ...w, title: name } : w));
        return null;
      });
      
      return '';
    });
  }, []);

  const resetWorkspaceRename = useCallback(() => {
    setWorkspaceRenameTarget(null);
    setWorkspaceRenameValue('');
  }, []);

  const createWorkspaceWithHosts = useCallback((name: string, hosts: Host[]) => {
    if (hosts.length === 0) return;

    // Create sessions for each host
    const newSessions: TerminalSession[] = hosts.map(host => {
      // Handle serial hosts specially
      if (host.protocol === 'serial') {
        const serialConfig: SerialConfig = host.serialConfig || {
          path: host.hostname,
          baudRate: host.port || 115200,
          dataBits: 8,
          stopBits: 1,
          parity: 'none',
          flowControl: 'none',
          localEcho: false,
          lineMode: false,
        };

        const portName = serialConfig.path.split('/').pop() || serialConfig.path;
        return {
          id: crypto.randomUUID(),
          hostId: host.id,
          hostLabel: host.label || `Serial: ${portName}`,
          hostname: serialConfig.path,
          username: '',
          status: 'connecting',
          protocol: 'serial',
          serialConfig: serialConfig,
        };
      }

      return {
        id: crypto.randomUUID(),
        hostId: host.id,
        hostLabel: host.label,
        hostname: host.hostname,
        username: host.username,
        status: 'connecting',
        protocol: host.protocol,
        port: host.port,
        moshEnabled: host.moshEnabled,
      };
    });

    const sessionIds = newSessions.map(s => s.id);

    // Create workspace
    const workspace = createWorkspaceFromSessionIds(sessionIds, {
      title: name,
      viewMode: 'split',
    });

    // Assign workspaceId to sessions
    const sessionsWithWorkspace = newSessions.map(s => ({
      ...s,
      workspaceId: workspace.id
    }));

    setSessions(prev => [...prev, ...sessionsWithWorkspace]);
    setWorkspaces(prev => [...prev, workspace]);
    setActiveTabId(workspace.id);
  }, [setActiveTabId]);

  const createWorkspaceFromSessions = useCallback((
    baseSessionId: string,
    joiningSessionId: string,
    hint: SplitHint
  ) => {
    if (!hint || baseSessionId === joiningSessionId) return;
    
	    setSessions(prevSessions => {
      const base = prevSessions.find(s => s.id === baseSessionId);
      const joining = prevSessions.find(s => s.id === joiningSessionId);
      if (!base || !joining || base.workspaceId || joining.workspaceId) return prevSessions;

      const newWorkspace = createWorkspaceEntity(baseSessionId, joiningSessionId, hint);
      setWorkspaces(prev => [...prev, newWorkspace]);
      setActiveTabId(newWorkspace.id);
      
      return prevSessions.map(s => {
        if (s.id === baseSessionId || s.id === joiningSessionId) {
          return { ...s, workspaceId: newWorkspace.id };
        }
        return s;
      });
	    });
	  }, [setActiveTabId]);

  const addSessionToWorkspace = useCallback((
    workspaceId: string,
    sessionId: string,
    hint: SplitHint
  ) => {
    if (!hint) return;
    
	    setSessions(prevSessions => {
      const session = prevSessions.find(s => s.id === sessionId);
      if (!session || session.workspaceId) return prevSessions;
      
      setWorkspaces(prevWorkspaces => {
        const targetWorkspace = prevWorkspaces.find(w => w.id === workspaceId);
        if (!targetWorkspace) return prevWorkspaces;
        
        return prevWorkspaces.map(ws => {
          if (ws.id !== workspaceId) return ws;
          return { ...ws, root: insertPaneIntoWorkspace(ws.root, sessionId, hint) };
        });
      });
      
      setActiveTabId(workspaceId);
      return prevSessions.map(s => s.id === sessionId ? { ...s, workspaceId } : s);
	    });
	  }, [setActiveTabId]);

  const updateSplitSizes = useCallback((workspaceId: string, splitId: string, sizes: number[]) => {
    setWorkspaces(prev => prev.map(ws => {
      if (ws.id !== workspaceId) return ws;
      return { ...ws, root: updateWorkspaceSplitSizes(ws.root, splitId, sizes) };
    }));
  }, []);

  // Split a session to create a workspace with the same host connection
  // direction: 'horizontal' = split top/bottom, 'vertical' = split left/right
  const splitSession = useCallback((
    sessionId: string,
    direction: SplitDirection
  ) => {
	    setSessions(prevSessions => {
      const session = prevSessions.find(s => s.id === sessionId);
      if (!session) return prevSessions;
      
      // If session is already in a workspace, split within that workspace
      if (session.workspaceId) {
        // Create a new session with the same host
        const newSession: TerminalSession = {
          id: crypto.randomUUID(),
          hostId: session.hostId,
          hostLabel: session.hostLabel,
          hostname: session.hostname,
          username: session.username,
          status: 'connecting',
          workspaceId: session.workspaceId,
          protocol: session.protocol,
          port: session.port,
          moshEnabled: session.moshEnabled,
        };
        
        // Add pane to existing workspace
        const hint: SplitHint = {
          direction,
          position: direction === 'horizontal' ? 'bottom' : 'right',
          targetSessionId: sessionId,
        };
        
        setWorkspaces(prevWorkspaces => {
          return prevWorkspaces.map(ws => {
            if (ws.id !== session.workspaceId) return ws;
            return { ...ws, root: insertPaneIntoWorkspace(ws.root, newSession.id, hint) };
          });
        });
        
        return [...prevSessions, newSession];
      }
      
      // Session is standalone - create a new workspace
      const newSession: TerminalSession = {
        id: crypto.randomUUID(),
        hostId: session.hostId,
        hostLabel: session.hostLabel,
        hostname: session.hostname,
        username: session.username,
        status: 'connecting',
        protocol: session.protocol,
        port: session.port,
        moshEnabled: session.moshEnabled,
      };
      
      const hint: SplitHint = {
        direction,
        position: direction === 'horizontal' ? 'bottom' : 'right',
      };
      
      const newWorkspace = createWorkspaceEntity(sessionId, newSession.id, hint);
      setWorkspaces(prev => [...prev, newWorkspace]);
      setActiveTabId(newWorkspace.id);
      
      return prevSessions.map(s => {
        if (s.id === sessionId) {
          return { ...s, workspaceId: newWorkspace.id };
        }
        return s;
      }).concat({ ...newSession, workspaceId: newWorkspace.id });
	    });
	  }, [setActiveTabId]);

  // Toggle workspace view mode between split and focus
  const toggleWorkspaceViewMode = useCallback((workspaceId: string) => {
    setWorkspaces(prev => prev.map(ws => {
      if (ws.id !== workspaceId) return ws;
      const currentMode = ws.viewMode || 'split';
      const newMode: WorkspaceViewMode = currentMode === 'split' ? 'focus' : 'split';
      // If switching to focus mode and no focused session, pick the first one
      let focusedSessionId = ws.focusedSessionId;
      if (newMode === 'focus' && !focusedSessionId) {
        const sessionIds = collectSessionIds(ws.root);
        focusedSessionId = sessionIds[0];
      }
      return { ...ws, viewMode: newMode, focusedSessionId };
    }));
  }, []);

  // Set the focused session in a workspace (for focus mode)
  const setWorkspaceFocusedSession = useCallback((workspaceId: string, sessionId: string) => {
    setWorkspaces(prev => prev.map(ws => {
      if (ws.id !== workspaceId) return ws;
      return { ...ws, focusedSessionId: sessionId };
    }));
  }, []);

  // Move focus between panes in a workspace
  const moveFocusInWorkspace = useCallback((workspaceId: string, direction: FocusDirection): boolean => {
    const workspace = workspaces.find(w => w.id === workspaceId);
    if (!workspace) {
      return false;
    }
    
    // Get current focused session, or first session if none focused
    const sessionIds = collectSessionIds(workspace.root);
    
    const currentFocused = workspace.focusedSessionId || sessionIds[0];
    if (!currentFocused) {
      return false;
    }
    
    // Find the next session in the given direction
    const nextSessionId = getNextFocusSessionId(workspace.root, currentFocused, direction);
    
    if (!nextSessionId) {
      return false;
    }
    
    // Update focused session
    setWorkspaces(prev => prev.map(ws => {
      if (ws.id !== workspaceId) return ws;
      return { ...ws, focusedSessionId: nextSessionId };
    }));
    
    return true;
  }, [workspaces]);

  // Run a snippet on multiple target hosts - creates a focus mode workspace
  const runSnippet = useCallback((snippet: Snippet, targetHosts: Host[]) => {
    if (targetHosts.length === 0) return;

    // Create sessions for each target host
    const newSessions: TerminalSession[] = targetHosts.map(host => ({
      id: crypto.randomUUID(),
      hostId: host.id,
      hostLabel: host.label,
      hostname: host.hostname,
      username: host.username,
      status: 'connecting' as const,
      // workspaceId will be set after workspace is created
    }));

    const sessionIds = newSessions.map(s => s.id);
    
    // Create a focus mode workspace
    const workspace = createWorkspaceFromSessionIds(sessionIds, {
      title: snippet.label,
      viewMode: 'focus',
      snippetId: snippet.id,
    });

    // Update sessions with workspaceId
    const sessionsWithWorkspace = newSessions.map(s => ({
      ...s,
      workspaceId: workspace.id,
      // Store the command to run after connection
      startupCommand: snippet.command,
    }));

	    setSessions(prev => [...prev, ...sessionsWithWorkspace]);
	    setWorkspaces(prev => [...prev, workspace]);
	    setActiveTabId(workspace.id);
	  }, [setActiveTabId]);

  const orphanSessions = useMemo(() => sessions.filter(s => !s.workspaceId), [sessions]);

  // Open a log view tab
  const openLogView = useCallback((log: ConnectionLog) => {
    const tabId = `log-${log.id}`;
    // Check if already open
    setLogViews(prev => {
      if (prev.some(lv => lv.connectionLogId === log.id)) {
        // Already open, just switch to it
        setActiveTabId(tabId);
        return prev;
      }
      // Open new log view
      const newLogView: LogView = {
        id: tabId,
        connectionLogId: log.id,
        log,
      };
      setActiveTabId(tabId);
      return [...prev, newLogView];
    });
  }, [setActiveTabId]);

  // Close a log view tab
  const closeLogView = useCallback((logViewId: string) => {
    setLogViews(prev => {
      const updated = prev.filter(lv => lv.id !== logViewId);
      // If this was the active tab, switch to vault
      const currentActiveTabId = activeTabStore.getActiveTabId();
      if (currentActiveTabId === logViewId) {
        const fallback = updated.length > 0 ? updated[updated.length - 1].id : 'vault';
        setActiveTabId(fallback);
      }
      return updated;
    });
  }, [setActiveTabId]);

  // Copy a session - creates a new session with the same host connection
  const copySession = useCallback((sessionId: string) => {
    setSessions(prevSessions => {
      const session = prevSessions.find(s => s.id === sessionId);
      if (!session) return prevSessions;

      // Create a new session with the same connection info
      const newSession: TerminalSession = {
        id: crypto.randomUUID(),
        hostId: session.hostId,
        hostLabel: session.hostLabel,
        hostname: session.hostname,
        username: session.username,
        status: 'connecting',
        protocol: session.protocol,
        port: session.port,
        moshEnabled: session.moshEnabled,
        serialConfig: session.serialConfig,
      };

      setActiveTabId(newSession.id);
      return [...prevSessions, newSession];
    });
  }, [setActiveTabId]);

  // Toggle broadcast mode for a workspace
  const toggleBroadcast = useCallback((workspaceId: string) => {
    setBroadcastWorkspaceIds(prev => {
      const next = new Set(prev);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
  }, []);

  // Check if a workspace has broadcast enabled
  const isBroadcastEnabled = useCallback((workspaceId: string) => {
    return broadcastWorkspaceIds.has(workspaceId);
  }, [broadcastWorkspaceIds]);

  // Get ordered tabs: combines orphan sessions, workspaces, and log views in the custom order
  const orderedTabs = useMemo(() => {
    const allTabIds = [
      ...orphanSessions.map(s => s.id),
      ...workspaces.map(w => w.id),
      ...logViews.map(lv => lv.id),
    ];
    // Filter tabOrder to only include existing tabs, then add any new tabs at the end
    const orderedIds = tabOrder.filter(id => allTabIds.includes(id));
    const newIds = allTabIds.filter(id => !orderedIds.includes(id));
    return [...orderedIds, ...newIds];
  }, [orphanSessions, workspaces, logViews, tabOrder]);

  const reorderTabs = useCallback((draggedId: string, targetId: string, position: 'before' | 'after' = 'before') => {
    if (draggedId === targetId) return;
    
    setTabOrder(prevTabOrder => {
      // Get all current tab IDs (orphan sessions + workspaces + log views)
      const allTabIds = [
        ...orphanSessions.map(s => s.id),
        ...workspaces.map(w => w.id),
        ...logViews.map(lv => lv.id),
      ];
      
      // Build current effective order: existing order + new tabs at end
      const orderedIds = prevTabOrder.filter(id => allTabIds.includes(id));
      const newIds = allTabIds.filter(id => !orderedIds.includes(id));
      const currentOrder = [...orderedIds, ...newIds];
      
      const draggedIndex = currentOrder.indexOf(draggedId);
      const targetIndex = currentOrder.indexOf(targetId);
      
      if (draggedIndex === -1 || targetIndex === -1) return prevTabOrder;
      
      // Remove dragged item first
      currentOrder.splice(draggedIndex, 1);
      
      // Calculate new target index (adjusted after removal)
      let newTargetIndex = targetIndex;
      if (draggedIndex < targetIndex) {
        newTargetIndex -= 1;
      }
      
      // Insert at the correct position
      if (position === 'after') {
        newTargetIndex += 1;
      }
      
      currentOrder.splice(newTargetIndex, 0, draggedId);
      
      return currentOrder;
    });
  }, [orphanSessions, workspaces, logViews]);

  return {
    sessions,
    workspaces,
    // activeTabId removed - components should subscribe via useActiveTabId() from activeTabStore
    setActiveTabId,
    draggingSessionId,
    setDraggingSessionId,
    sessionRenameTarget,
    sessionRenameValue,
    setSessionRenameValue,
    startSessionRename,
    submitSessionRename,
    resetSessionRename,
    workspaceRenameTarget,
    workspaceRenameValue,
    setWorkspaceRenameValue,
    startWorkspaceRename,
    submitWorkspaceRename,
    resetWorkspaceRename,
    createLocalTerminal,
    createSerialSession,
    connectToHost,
    closeSession,
    closeWorkspace,
    updateSessionStatus,
    createWorkspaceWithHosts,
    createWorkspaceFromSessions,
    addSessionToWorkspace,
    updateSplitSizes,
    splitSession,
    toggleWorkspaceViewMode,
    setWorkspaceFocusedSession,
    moveFocusInWorkspace,
    runSnippet,
    orphanSessions,
    // Broadcast mode
    toggleBroadcast,
    isBroadcastEnabled,
    orderedTabs,
    reorderTabs,
    // Log views
    logViews,
    openLogView,
    closeLogView,
    // Copy session
    copySession,
  };
};
