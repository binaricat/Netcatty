import { MouseEvent,useCallback,useMemo,useRef,useState } from 'react';
import { ConnectionLog,Host,SerialConfig,Snippet,TerminalSession,Workspace,WorkspaceViewMode } from '../../domain/models';
import { addLogView, getLogViewTabId, removeLogView, type LogView } from './logViewState';
import { createHostTerminalSession, createLocalTerminalSession, createSerialTerminalSession, type LocalTerminalOptions } from './sessionFactories';
import {
appendPaneToWorkspaceRoot,
collectSessionIds,
createWorkspaceFromSessions as createWorkspaceEntity,
createWorkspaceFromSessionIds,
FocusDirection,
getNextFocusSessionId,
insertPaneIntoWorkspace,
pruneWorkspaceNode,
reorderWorkspaceFocusSessionOrder,
SplitDirection,
SplitHint,
updateWorkspaceSplitSizes,
} from '../../domain/workspace';
import { activeTabStore } from './activeTabStore';


export const useSessionState = () => {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // Latest workspaces snapshot for synchronous existence checks outside
  // setWorkspaces updaters — React doesn't guarantee updaters run
  // synchronously, so relying on a flag flipped inside them to decide
  // whether to also call setSessions is racy and can leave orphan panes.
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
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

  const createLocalTerminal = useCallback((options?: LocalTerminalOptions) => {
    const sessionId = crypto.randomUUID();
    setSessions(prev => [...prev, createLocalTerminalSession(sessionId, options)]);
    setActiveTabId(sessionId);
    return sessionId;
  }, [setActiveTabId]);

  const createSerialSession = useCallback((config: SerialConfig, options?: { charset?: string }) => {
    const sessionId = crypto.randomUUID();
    setSessions(prev => [...prev, createSerialTerminalSession(sessionId, config, options)]);
    setActiveTabId(sessionId);
    return sessionId;
  }, [setActiveTabId]);

  const connectToHost = useCallback((host: Host) => {
    const newSession = createHostTerminalSession(crypto.randomUUID(), host);
    setSessions(prev => [...prev, newSession]);
    setActiveTabId(newSession.id);
    return newSession.id;
  }, [setActiveTabId]);

  const updateSessionStatus = useCallback((sessionId: string, status: TerminalSession['status']) => {
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, status } : s));
  }, []);

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

  const closeSession = useCallback((sessionId: string, e?: MouseEvent) => {
    e?.stopPropagation();

    // Pre-compute outside the setSessions updater so we don't depend on React
    // having run the updater by the time we queue the microtask. React 18+ does
    // not guarantee updater execution timing under concurrent scheduling.
    const sessionBeingClosed = sessions.find(s => s.id === sessionId);
    const workspaceIdToMaybeClose =
      sessionBeingClosed?.workspaceId &&
      sessions.every(s => s.id === sessionId || s.workspaceId !== sessionBeingClosed.workspaceId)
        ? sessionBeingClosed.workspaceId
        : undefined;

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

    if (workspaceIdToMaybeClose) {
      queueMicrotask(() => closeWorkspace(workspaceIdToMaybeClose!));
    }
  }, [sessions, workspaces, setActiveTabId, closeWorkspace]);

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
          charset: host.charset,
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
        charset: host.charset,
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

  // Like createWorkspaceWithHosts but supports mixed targets — each
  // entry is either an SSH host or a local terminal. Used by the
  // "New Workspace" flow in QuickSwitcher.
  type WorkspaceTarget =
    | { kind: 'local'; shellType?: TerminalSession['shellType']; shell?: string; shellArgs?: string[]; shellName?: string; shellIcon?: string }
    | { kind: 'host'; host: Host };

  const createWorkspaceFromTargets = useCallback((targets: WorkspaceTarget[], name: string = 'Workspace'): string | null => {
    if (targets.length === 0) return null;

    const newSessions: TerminalSession[] = targets.map((target) => {
      if (target.kind === 'local') {
        const sessionId = crypto.randomUUID();
        return {
          id: sessionId,
          hostId: `local-${sessionId}`,
          hostLabel: target.shellName || 'Local Terminal',
          hostname: 'localhost',
          username: 'local',
          status: 'connecting',
          protocol: 'local',
          shellType: target.shellType,
          localShell: target.shell,
          localShellArgs: target.shellArgs,
          localShellName: target.shellName,
          localShellIcon: target.shellIcon,
        };
      }
      const host = target.host;
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
          serialConfig,
          charset: host.charset,
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
        charset: host.charset,
      };
    });

    const sessionIds = newSessions.map((s) => s.id);
    // Default to focus-mode (sidebar layout) regardless of target
    // count — matches the intent behind the QuickSwitcher "New
    // Workspace" flow, which the user expects to land in focus view.
    const workspace = createWorkspaceFromSessionIds(sessionIds, {
      title: name,
      viewMode: 'focus',
    });
    const sessionsWithWorkspace = newSessions.map((s) => ({ ...s, workspaceId: workspace.id }));

    setSessions((prev) => [...prev, ...sessionsWithWorkspace]);
    setWorkspaces((prev) => [...prev, workspace]);
    setActiveTabId(workspace.id);
    return workspace.id;
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

  // Add a host into an existing workspace by creating a new session for
  // that host and appending it as the last pane at the workspace root.
  // Sibling sizes are rebalanced equally by appendPaneToWorkspaceRoot.
  // Unlike addSessionToWorkspace (which takes a pre-created orphan
  // session and a SplitHint), this is atomic — the new session is born
  // already bound to the target workspace and focused.
  const appendHostToWorkspace = useCallback((
    workspaceId: string,
    host: Host,
    direction: SplitDirection = 'vertical',
  ): string | null => {
    // Serial hosts use a different session constructor; they currently
    // only enter workspaces via createSerialSession + drag, so reject
    // them here to avoid a partially-constructed session.
    if (host.protocol === 'serial') return null;

    // Cheap early-exit using the ref when the workspace is clearly
    // absent. The authoritative check lives inside the setWorkspaces
    // updater below so we also cover the concurrent-close race.
    if (!workspacesRef.current.some(w => w.id === workspaceId)) return null;

    const newSessionId = crypto.randomUUID();
    const newSession: TerminalSession = {
      id: newSessionId,
      hostId: host.id,
      hostLabel: host.label,
      hostname: host.hostname,
      username: host.username,
      status: 'connecting',
      protocol: host.protocol,
      port: host.port,
      moshEnabled: host.moshEnabled,
      charset: host.charset,
      workspaceId,
    };

    // Nest setSessions + setActiveTabId inside the setWorkspaces updater
    // so we only commit the session when the workspace update actually
    // matched — otherwise a concurrent closeWorkspace between the ref
    // check and the updater firing would leave an orphan session with a
    // workspaceId pointing at nothing, and active tab would jump to a
    // closed id. The inner setSessions is idempotent (id dedupe) so
    // StrictMode's dev-time double-invoke does not duplicate the row.
    setWorkspaces(prev => {
      const target = prev.find(w => w.id === workspaceId);
      if (!target) return prev;
      setSessions(s => s.some(x => x.id === newSessionId) ? s : [...s, newSession]);
      setActiveTabId(workspaceId);
      return prev.map(ws => {
        if (ws.id !== workspaceId) return ws;
        return {
          ...ws,
          root: appendPaneToWorkspaceRoot(ws.root, newSessionId, direction),
          focusedSessionId: newSessionId,
        };
      });
    });
    return newSessionId;
  }, [setActiveTabId]);

  // Atomic "append a local terminal pane" — mirror of appendHostToWorkspace
  // but constructs a local-protocol session instead of an SSH one.
  const appendLocalTerminalToWorkspace = useCallback((
    workspaceId: string,
    options?: {
      shellType?: TerminalSession['shellType'];
      shell?: string;
      shellArgs?: string[];
      shellName?: string;
      shellIcon?: string;
    },
    direction: SplitDirection = 'vertical',
  ): string | null => {
    // Same pattern as appendHostToWorkspace — ref guard + authoritative
    // inside-updater match to cover concurrent closeWorkspace.
    if (!workspacesRef.current.some(w => w.id === workspaceId)) return null;

    const newSessionId = crypto.randomUUID();
    const localHostId = `local-${newSessionId}`;
    const newSession: TerminalSession = {
      id: newSessionId,
      hostId: localHostId,
      hostLabel: options?.shellName || 'Local Terminal',
      hostname: 'localhost',
      username: 'local',
      status: 'connecting',
      protocol: 'local',
      shellType: options?.shellType,
      localShell: options?.shell,
      localShellArgs: options?.shellArgs,
      localShellName: options?.shellName,
      localShellIcon: options?.shellIcon,
      workspaceId,
    };

    setWorkspaces(prev => {
      const target = prev.find(w => w.id === workspaceId);
      if (!target) return prev;
      setSessions(s => s.some(x => x.id === newSessionId) ? s : [...s, newSession]);
      setActiveTabId(workspaceId);
      return prev.map(ws => {
        if (ws.id !== workspaceId) return ws;
        return {
          ...ws,
          root: appendPaneToWorkspaceRoot(ws.root, newSessionId, direction),
          focusedSessionId: newSessionId,
        };
      });
    });
    return newSessionId;
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
    direction: SplitDirection,
    options?: {
      localShellType?: TerminalSession['shellType'];
    },
  ) => {
	    setSessions(prevSessions => {
      const session = prevSessions.find(s => s.id === sessionId);
      if (!session) return prevSessions;
      const nextShellType = session.protocol === 'local'
        ? options?.localShellType
        : session.shellType;
      
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
          shellType: nextShellType,
          charset: session.charset,
          localShell: session.localShell,
          localShellArgs: session.localShellArgs,
          localShellName: session.localShellName,
          localShellIcon: session.localShellIcon,
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
        shellType: nextShellType,
        charset: session.charset,
        localShell: session.localShell,
        localShellArgs: session.localShellArgs,
        localShellName: session.localShellName,
        localShellIcon: session.localShellIcon,
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

  const reorderWorkspaceSessions = useCallback((
    workspaceId: string,
    draggedSessionId: string,
    targetSessionId: string,
    position: 'before' | 'after' = 'before',
  ) => {
    setWorkspaces(prev => prev.map(ws => {
      if (ws.id !== workspaceId) return ws;
      return {
        ...ws,
        focusSessionOrder: reorderWorkspaceFocusSessionOrder(
          ws.root,
          ws.focusSessionOrder,
          draggedSessionId,
          targetSessionId,
          position,
        ),
      };
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
      charset: host.charset,
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
      noAutoRun: snippet.noAutoRun,
    }));

	    setSessions(prev => [...prev, ...sessionsWithWorkspace]);
	    setWorkspaces(prev => [...prev, workspace]);
	    setActiveTabId(workspace.id);
	  }, [setActiveTabId]);

  const orphanSessions = useMemo(() => sessions.filter(s => !s.workspaceId), [sessions]);

  const openLogView = useCallback((log: ConnectionLog) => {
    const tabId = getLogViewTabId(log);
    setLogViews(prev => addLogView(prev, log));
    setActiveTabId(tabId);
  }, [setActiveTabId]);

  const closeLogView = useCallback((logViewId: string) => {
    setLogViews(prev => {
      const updated = removeLogView(prev, logViewId);
      if (activeTabStore.getActiveTabId() === logViewId) {
        setActiveTabId(updated.length > 0 ? updated[updated.length - 1].id : 'vault');
      }
      return updated;
    });
  }, [setActiveTabId]);

  // Copy a session - creates a new session with the same host connection
  const copySession = useCallback((sessionId: string, options?: {
    localShellType?: TerminalSession['shellType'];
  }) => {
    // Pre-allocate the new id outside the updater so StrictMode's
    // double-invocation of the functional updater doesn't mint two ids.
    const newSessionId = crypto.randomUUID();

    setSessions(prevSessions => {
      const session = prevSessions.find(s => s.id === sessionId);
      // Source may have been closed between the user's action and this
      // update running; in that case skip entirely — do NOT switch the
      // active tab or insert into tabOrder, which would leave dangling ids.
      if (!session) return prevSessions;
      const nextShellType = session.protocol === 'local'
        ? options?.localShellType
        : session.shellType;

      const newSession: TerminalSession = {
        id: newSessionId,
        hostId: session.hostId,
        hostLabel: session.hostLabel,
        hostname: session.hostname,
        username: session.username,
        status: 'connecting',
        protocol: session.protocol,
        port: session.port,
        moshEnabled: session.moshEnabled,
        shellType: nextShellType,
        charset: session.charset,
        serialConfig: session.serialConfig,
        localShell: session.localShell,
        localShellArgs: session.localShellArgs,
        localShellName: session.localShellName,
        localShellIcon: session.localShellIcon,
      };

      // Schedule the activeTab + tabOrder updates only when creation
      // actually happens. These nested setStates are idempotent, so
      // StrictMode's double-invocation is harmless.
      setActiveTabId(newSessionId);
      setTabOrder(prevTabOrder => {
        // Fast path: source is already tracked in tabOrder — splice directly.
        const directIdx = prevTabOrder.indexOf(sessionId);
        if (directIdx !== -1) {
          const next = [...prevTabOrder];
          next.splice(directIdx + 1, 0, newSessionId);
          return next;
        }
        // Fallback: source is only in the derived tab collections. Rebuild the
        // effective order (same pattern as reorderTabs) to locate its position.
        const allTabIds = [
          ...orphanSessions.map(s => s.id),
          ...workspaces.map(w => w.id),
          ...logViews.map(lv => lv.id),
        ];
        const allTabIdSet = new Set(allTabIds);
        const orderedIds = prevTabOrder.filter(id => allTabIdSet.has(id));
        const orderedIdSet = new Set(orderedIds);
        const newIds = allTabIds.filter(id => !orderedIdSet.has(id));
        const currentOrder = [...orderedIds, ...newIds];
        const sourceIdx = currentOrder.indexOf(sessionId);
        if (sourceIdx === -1) return [...prevTabOrder, newSessionId];
        const next = [...currentOrder];
        next.splice(sourceIdx + 1, 0, newSessionId);
        return next;
      });

      return [...prevSessions, newSession];
    });
  }, [orphanSessions, workspaces, logViews, setActiveTabId]);

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
    const allTabIdSet = new Set(allTabIds);
    // Filter tabOrder to only include existing tabs, then add any new tabs at the end
    const orderedIds = tabOrder.filter(id => allTabIdSet.has(id));
    const orderedIdSet = new Set(orderedIds);
    const newIds = allTabIds.filter(id => !orderedIdSet.has(id));
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
      const allTabIdSet = new Set(allTabIds);
      
      // Build current effective order: existing order + new tabs at end
      const orderedIds = prevTabOrder.filter(id => allTabIdSet.has(id));
      const orderedIdSet = new Set(orderedIds);
      const newIds = allTabIds.filter(id => !orderedIdSet.has(id));
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
    createWorkspaceFromTargets,
    createWorkspaceFromSessions,
    addSessionToWorkspace,
    appendHostToWorkspace,
    appendLocalTerminalToWorkspace,
    updateSplitSizes,
    splitSession,
    toggleWorkspaceViewMode,
    setWorkspaceFocusedSession,
    reorderWorkspaceSessions,
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
