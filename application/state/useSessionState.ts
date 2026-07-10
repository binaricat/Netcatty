import { MouseEvent,useCallback,useEffect,useMemo,useRef,useState } from 'react';
import { ConnectionLog,Host,SerialConfig,Snippet,TerminalSession,Workspace,WorkspaceViewMode } from '../../domain/models';
import { addLogView, getLogViewTabId, removeLogView, type LogView } from './logViewState';
import { createHostTerminalSession, createLocalTerminalSession, createSerialTerminalSession, type LocalTerminalOptions } from './sessionFactories';
import { isScriptSnippet } from '../../domain/snippetScript.ts';
import {
appendPaneToWorkspaceRoot,
collectSessionIds,
createWorkspaceFromSessions as createWorkspaceEntity,
createWorkspaceFromSessionIds,
FocusDirection,
getNextFocusSessionId,
insertPaneIntoWorkspace,
reorderWorkspaceFocusSessionOrder,
SplitDirection,
SplitHint,
updateWorkspaceSplitSizes,
} from '../../domain/workspace';
import { clearSessionFontSizeOverride as clearSessionFontSizeOverrideFields } from '../../domain/terminalAppearance';
import { buildOrderedWorkTabIds, reorderWorkTabIds } from '../app/workTabSurface';
import { activeTabStore } from './activeTabStore';
import {
  applyCloseSessionToSessions,
  closeSessionWorkspaceLayoutState,
  detachSessionFromWorkspaceState,
  replaceDissolvedWorkspaceTabOrder,
  resolveActiveTabAfterCloseSession,
} from './sessionWorkspaceDetach';
import {
  createCopiedTerminalSessionClone,
  createSplitTerminalSessionClone,
} from './terminalConnectionReuse';
import { STORAGE_KEY_RESTORE_PREVIOUS_SESSION } from '../../infrastructure/config/storageKeys';
import {
  LOCAL_STORAGE_ADAPTER_CHANGED_EVENT,
  localStorageAdapter,
} from '../../infrastructure/persistence/localStorageAdapter';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import { sessionRestoreStorage } from './sessionRestoreStorage';
import {
  buildAndWriteSessionRestorePayload,
  createInitialRestoredSessionState,
  shouldPersistSessionRestoreState,
  updateRestoredSessionStatusState,
} from './sessionRestoreState';
import { resolveRestorePreviousSessionSetting } from './sessionRestoreSettings';
import type { CodingCliProviderId } from '../../domain/codingCliProviders';
import { normalizeCodingCliDynamicTitleForStorage } from '../../domain/codingCliTitleParse';

export function addWorkspaceIfMissing(
  workspaces: Workspace[],
  workspace: Workspace,
): Workspace[] {
  return workspaces.some(ws => ws.id === workspace.id) ? workspaces : [...workspaces, workspace];
}

export function addTerminalSessionIfMissing(
  sessions: TerminalSession[],
  session: TerminalSession,
): TerminalSession[] {
  return sessions.some(candidate => candidate.id === session.id) ? sessions : [...sessions, session];
}

export function insertWorkspacePaneIfMissing(
  workspaces: Workspace[],
  workspaceId: string,
  sessionId: string,
  hint: SplitHint,
): Workspace[] {
  return workspaces.map(ws => {
    if (ws.id !== workspaceId) return ws;
    if (collectSessionIds(ws.root).includes(sessionId)) return ws;
    return { ...ws, root: insertPaneIntoWorkspace(ws.root, sessionId, hint) };
  });
}

export function appendWorkspaceRootPaneIfMissing(
  workspaces: Workspace[],
  workspaceId: string,
  sessionId: string,
  direction: SplitDirection = 'vertical',
): Workspace[] {
  return workspaces.map(ws => {
    if (ws.id !== workspaceId) return ws;
    if (collectSessionIds(ws.root).includes(sessionId)) {
      return ws.focusedSessionId === sessionId ? ws : { ...ws, focusedSessionId: sessionId };
    }
    return {
      ...ws,
      root: appendPaneToWorkspaceRoot(ws.root, sessionId, direction),
      focusedSessionId: sessionId,
    };
  });
}

export function insertCopiedTabOrderIdOnce(
  prevTabOrder: string[],
  sourceTabId: string,
  copiedTabId: string,
  allTabIds: string[],
): string[] {
  if (prevTabOrder.includes(copiedTabId)) return prevTabOrder;

  const directIdx = prevTabOrder.indexOf(sourceTabId);
  if (directIdx !== -1) {
    const next = [...prevTabOrder];
    next.splice(directIdx + 1, 0, copiedTabId);
    return next;
  }

  const allTabIdSet = new Set(allTabIds);
  const orderedIds = prevTabOrder.filter(id => allTabIdSet.has(id));
  const orderedIdSet = new Set(orderedIds);
  const newIds = allTabIds.filter(id => !orderedIdSet.has(id));
  const currentOrder = [...orderedIds, ...newIds];
  const sourceIdx = currentOrder.indexOf(sourceTabId);
  if (sourceIdx === -1) return [...prevTabOrder, copiedTabId];
  const next = [...currentOrder];
  next.splice(sourceIdx + 1, 0, copiedTabId);
  return next;
}


export const useSessionState = ({
  persistSessionRestore = true,
}: {
  persistSessionRestore?: boolean;
} = {}) => {
  const initialRestoreState = useMemo(() => createInitialRestoredSessionState({
    restoreEnabled: persistSessionRestore && resolveRestorePreviousSessionSetting(
      localStorageAdapter.readBoolean(STORAGE_KEY_RESTORE_PREVIOUS_SESSION),
    ),
    payload: persistSessionRestore ? sessionRestoreStorage.read() : null,
  }), [persistSessionRestore]);
  const [sessions, setSessions] = useState<TerminalSession[]>(initialRestoreState.sessions);
  const [workspaces, setWorkspaces] = useState<Workspace[]>(initialRestoreState.workspaces);
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
  const [tabOrder, setTabOrder] = useState<string[]>(initialRestoreState.tabOrder);
  // Broadcast mode: stores workspace IDs that have broadcast enabled
  const [broadcastWorkspaceIds, setBroadcastWorkspaceIds] = useState<Set<string>>(new Set());
  // Log views: stores open log replay tabs
  const [logViews, setLogViews] = useState<LogView[]>([]);
  const [restorePreviousSessionRevision, setRestorePreviousSessionRevision] = useState(0);
  const sessionsRef = useRef(sessions);
  const tabOrderRef = useRef(tabOrder);
  const scheduleSessionRestorePersistRef = useRef<() => void>(() => {});
  const sessionRestoreCwdByIdRef = useRef(
    new Map(
      initialRestoreState.sessions
        .filter((session) => Boolean(session.lastCwd))
        .map((session) => [session.id, session.lastCwd as string]),
    ),
  );
  const hasSeenRestorableSessionRestoreStateRef = useRef(
    persistSessionRestore && shouldPersistSessionRestoreState(
      initialRestoreState.sessions,
      initialRestoreState.workspaces,
      initialRestoreState.tabOrder,
    ),
  );
  sessionsRef.current = sessions;
  tabOrderRef.current = tabOrder;
  if (persistSessionRestore && shouldPersistSessionRestoreState(sessions, workspaces, tabOrder)) {
    hasSeenRestorableSessionRestoreStateRef.current = true;
  }

  useEffect(() => {
    if (initialRestoreState.activeTabId !== 'vault') {
      activeTabStore.setActiveTabId(initialRestoreState.activeTabId);
    }
  }, [initialRestoreState.activeTabId]);

  useEffect(() => {
    const handleRestorePreviousSessionChanged = (key?: string) => {
      if (key !== STORAGE_KEY_RESTORE_PREVIOUS_SESSION) return;
      setRestorePreviousSessionRevision((revision) => revision + 1);
    };
    const handleLocalStorageAdapterChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string }>).detail;
      handleRestorePreviousSessionChanged(detail?.key);
    };

    window.addEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, handleLocalStorageAdapterChanged);
    const unsubscribeSettingsSync = netcattyBridge.get()?.onSettingsChanged?.((payload) => {
      handleRestorePreviousSessionChanged(payload?.key);
    });
    return () => {
      window.removeEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, handleLocalStorageAdapterChanged);
      unsubscribeSettingsSync?.();
    };
  }, []);

  useEffect(() => {
    if (!persistSessionRestore) return;

    const restoreEnabled = resolveRestorePreviousSessionSetting(
      localStorageAdapter.readBoolean(STORAGE_KEY_RESTORE_PREVIOUS_SESSION),
    );
    if (!restoreEnabled) {
      scheduleSessionRestorePersistRef.current = () => {};
      sessionRestoreStorage.clear();
      hasSeenRestorableSessionRestoreStateRef.current = false;
      return;
    }

    let timeout: number | undefined;

    const persistNow = () => {
      const sessionsForRestore = sessionsRef.current.map((session) => {
        const cwd = sessionRestoreCwdByIdRef.current.get(session.id);
        if (cwd) {
          return session.lastCwd === cwd ? session : { ...session, lastCwd: cwd };
        }
        if (session.lastCwd === undefined) return session;
        const { lastCwd: _lastCwd, ...rest } = session;
        return rest;
      });
      const hasRestorableState = shouldPersistSessionRestoreState(
        sessionsForRestore,
        workspacesRef.current,
        tabOrderRef.current,
      );
      const clearOnEmpty = hasSeenRestorableSessionRestoreStateRef.current && !hasRestorableState;
      buildAndWriteSessionRestorePayload({
        restoreEnabled: resolveRestorePreviousSessionSetting(
          localStorageAdapter.readBoolean(STORAGE_KEY_RESTORE_PREVIOUS_SESSION),
        ),
        clearOnEmpty,
        sessions: sessionsForRestore,
        workspaces: workspacesRef.current,
        tabOrder: tabOrderRef.current,
        activeTabId: activeTabStore.getActiveTabId(),
        storage: sessionRestoreStorage,
      });
    };

    const schedulePersist = () => {
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
      }
      timeout = window.setTimeout(() => {
        timeout = undefined;
        persistNow();
      }, 250);
    };

    schedulePersist();
    scheduleSessionRestorePersistRef.current = schedulePersist;
    const unsubscribeActiveTab = activeTabStore.subscribeSync(schedulePersist);

    const handlePageHide = () => {
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
        timeout = undefined;
      }
      persistNow();
    };

    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handlePageHide);

    return () => {
      scheduleSessionRestorePersistRef.current = () => {};
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
      }
      unsubscribeActiveTab();
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handlePageHide);
    };
  }, [sessions, workspaces, tabOrder, restorePreviousSessionRevision, persistSessionRestore]);

  const updateSessionRestoreCwd = useCallback((sessionId: string, cwd: string | null) => {
    const nextCwd = cwd && cwd.trim().length > 0 ? cwd : null;
    const currentCwd = sessionRestoreCwdByIdRef.current.get(sessionId) ?? null;
    if (currentCwd === nextCwd) return;
    if (nextCwd) {
      sessionRestoreCwdByIdRef.current.set(sessionId, nextCwd);
    } else {
      sessionRestoreCwdByIdRef.current.delete(sessionId);
    }
    scheduleSessionRestorePersistRef.current();
  }, []);

  const updateSessionDynamicTitle = useCallback((sessionId: string, title: string | null) => {
    const normalizedTitle = title ? normalizeCodingCliDynamicTitleForStorage(title) : '';
    const nextTitle = normalizedTitle.length > 0 ? normalizedTitle : null;
    setSessions((prev) => {
      const session = prev.find((candidate) => candidate.id === sessionId);
      if (!session) return prev;
      if ((session.dynamicTitle ?? null) === nextTitle) return prev;
      return prev.map((candidate) => {
        if (candidate.id !== sessionId) return candidate;
        if (!nextTitle) {
          const { dynamicTitle: _removed, ...rest } = candidate;
          return rest;
        }
        return { ...candidate, dynamicTitle: nextTitle };
      });
    });
  }, []);

  const updateSessionCodingCliProvider = useCallback((
    sessionId: string,
    providerId: CodingCliProviderId | null,
  ) => {
    setSessions((prev) => {
      const session = prev.find((candidate) => candidate.id === sessionId);
      if (!session) return prev;
      if ((session.codingCliProviderId ?? null) === providerId) return prev;
      return prev.map((candidate) => {
        if (candidate.id !== sessionId) return candidate;
        if (!providerId) {
          const { codingCliProviderId: _removed, ...rest } = candidate;
          return rest;
        }
        return { ...candidate, codingCliProviderId: providerId };
      });
    });
  }, []);

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
    setSessions(prev => updateRestoredSessionStatusState(prev, sessionId, status));
  }, []);

  const updateSessionFontSize = useCallback((sessionId: string, fontSize: number) => {
    setSessions(prev => prev.map(s => (
      s.id === sessionId ? { ...s, fontSize, fontSizeOverride: true } : s
    )));
  }, []);

  const clearSessionFontSizeOverride = useCallback((sessionId: string) => {
    setSessions(prev => prev.map(s => (
      s.id === sessionId ? clearSessionFontSizeOverrideFields(s) : s
    )));
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

    // Compute layout from the latest refs so dissolve/remove cannot desync from
    // a stale workspaces/sessions render snapshot. Empty workspaces are already
    // removed by closeSessionWorkspaceLayoutState — do NOT follow up with
    // closeWorkspace(), which would race and delete remaining terminals that
    // still briefly carry the old workspaceId.
    const targetSession = sessionsRef.current.find((session) => session.id === sessionId);
    const wsId = targetSession?.workspaceId;
    const layoutResult = closeSessionWorkspaceLayoutState(
      workspacesRef.current,
      wsId,
      sessionId,
    );
    const nextSessions = applyCloseSessionToSessions(
      sessionsRef.current,
      sessionId,
      layoutResult,
    );

    setWorkspaces(layoutResult.workspaces);
    setSessions(nextSessions);

    if (layoutResult.dissolvedWorkspaceId && layoutResult.lastRemainingSessionId) {
      setTabOrder((prevTabOrder) => replaceDissolvedWorkspaceTabOrder(
        prevTabOrder,
        layoutResult.dissolvedWorkspaceId,
        [layoutResult.lastRemainingSessionId!],
      ));
    }

    const nextActiveTabId = resolveActiveTabAfterCloseSession({
      currentActiveTabId: activeTabStore.getActiveTabId(),
      closedSessionId: sessionId,
      workspaceId: wsId,
      layoutResult,
      remainingSessions: nextSessions,
    });
    if (nextActiveTabId) {
      setActiveTabId(nextActiveTabId);
    }
  }, [setActiveTabId]);

  const startSessionRename = useCallback((sessionId: string) => {
    setSessions(prevSessions => {
      const target = prevSessions.find(s => s.id === sessionId);
      if (target) {
        setSessionRenameTarget(target);
        setSessionRenameValue(target.customName || target.hostLabel);
      }
      return prevSessions;
    });
  }, []);

  const renameSessionInline = useCallback((sessionId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSessions(prev => prev.map(s => (
      s.id === sessionId ? { ...s, customName: trimmed, hostLabel: trimmed } : s
    )));
  }, []);

  const submitSessionRename = useCallback((sessionId?: string, name?: string) => {
    if (sessionId !== undefined && name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) return;
      setSessions(prev => prev.map(s => (
        s.id === sessionId ? { ...s, customName: trimmed, hostLabel: trimmed } : s
      )));
      return;
    }

    setSessionRenameValue(prevValue => {
      const trimmed = prevValue.trim();
      if (!trimmed) return prevValue;

      setSessionRenameTarget(prevTarget => {
        if (!prevTarget) return prevTarget;
        setSessions(prev => prev.map(s => (
          s.id === prevTarget.id ? { ...s, customName: trimmed, hostLabel: trimmed } : s
        )));
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
        etEnabled: host.etEnabled,
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
        return createLocalTerminalSession(sessionId, {
          shellType: target.shellType,
          shell: target.shell,
          shellArgs: target.shellArgs,
          shellName: target.shellName,
          shellIcon: target.shellIcon,
        });
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
        etEnabled: host.etEnabled,
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
    const newWorkspace = createWorkspaceEntity(baseSessionId, joiningSessionId, hint);

    setSessions((prevSessions) => {
      const base = prevSessions.find((s) => s.id === baseSessionId);
      const joining = prevSessions.find((s) => s.id === joiningSessionId);
      if (!base || !joining || base.workspaceId || joining.workspaceId) return prevSessions;

      setWorkspaces((prev) => addWorkspaceIfMissing(prev, newWorkspace));
      // Collapse the two session tab slots into the workspace tab so later
      // detach/close can replace `ws-*` with session ids again.
      setTabOrder((prevTabOrder) => {
        const withoutSessions = prevTabOrder.filter(
          (id) => id !== baseSessionId && id !== joiningSessionId,
        );
        if (withoutSessions.includes(newWorkspace.id)) return withoutSessions;
        const indexes = [baseSessionId, joiningSessionId]
          .map((id) => prevTabOrder.indexOf(id))
          .filter((index) => index >= 0);
        const insertAt = indexes.length > 0 ? Math.min(...indexes) : withoutSessions.length;
        const next = [...withoutSessions];
        next.splice(Math.min(insertAt, next.length), 0, newWorkspace.id);
        return next;
      });
      setActiveTabId(newWorkspace.id);

      return prevSessions.map((s) => {
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
        
        return insertWorkspacePaneIfMissing(prevWorkspaces, workspaceId, sessionId, hint);
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
      etEnabled: host.etEnabled,
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
      setSessions(s => addTerminalSessionIfMissing(s, newSession));
      setActiveTabId(workspaceId);
      return appendWorkspaceRootPaneIfMissing(prev, workspaceId, newSessionId, direction);
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
    const newSession: TerminalSession = {
      ...createLocalTerminalSession(newSessionId, {
        shellType: options?.shellType,
        shell: options?.shell,
        shellArgs: options?.shellArgs,
        shellName: options?.shellName,
        shellIcon: options?.shellIcon,
      }),
      workspaceId,
    };

    setWorkspaces(prev => {
      const target = prev.find(w => w.id === workspaceId);
      if (!target) return prev;
      setSessions(s => addTerminalSessionIfMissing(s, newSession));
      setActiveTabId(workspaceId);
      return appendWorkspaceRootPaneIfMissing(prev, workspaceId, newSessionId, direction);
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
    const newSessionId = crypto.randomUUID();
    const standaloneHint: SplitHint = {
      direction,
      position: direction === 'horizontal' ? 'bottom' : 'right',
    };
    const standaloneWorkspace = createWorkspaceEntity(sessionId, newSessionId, standaloneHint);

	    setSessions(prevSessions => {
      const session = prevSessions.find(s => s.id === sessionId);
      if (!session) return prevSessions;
      
      // If session is already in a workspace, split within that workspace
      if (session.workspaceId) {
        // Create a new session with the same host
        const newSession = createSplitTerminalSessionClone(session, {
          id: newSessionId,
          localShellType: options?.localShellType,
          workspaceId: session.workspaceId,
        });

        // Add pane to existing workspace
        const hint: SplitHint = {
          direction,
          position: direction === 'horizontal' ? 'bottom' : 'right',
          targetSessionId: sessionId,
        };
        
        setWorkspaces(prevWorkspaces => {
          return insertWorkspacePaneIfMissing(prevWorkspaces, session.workspaceId, newSession.id, hint);
        });
        
        return addTerminalSessionIfMissing(prevSessions, newSession);
      }
      
      // Session is standalone - create a new workspace
      const newSession = createSplitTerminalSessionClone(session, {
        id: newSessionId,
        localShellType: options?.localShellType,
      });

      setWorkspaces(prev => addWorkspaceIfMissing(prev, standaloneWorkspace));
      setActiveTabId(standaloneWorkspace.id);
      
      return prevSessions.map(s => {
        if (s.id === sessionId) {
          return { ...s, workspaceId: standaloneWorkspace.id };
        }
        return s;
      }).concat({ ...newSession, workspaceId: standaloneWorkspace.id });
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
  const runSnippet = useCallback((snippet: Snippet, targetHosts: Host[], commandOverride?: string) => {
    if (targetHosts.length === 0) return;
    const resolvedCommand = commandOverride ?? snippet.command;

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
      ...(isScriptSnippet(snippet)
        ? { pendingScriptId: snippet.id, pendingScript: snippet }
        : {
          startupCommand: resolvedCommand,
          noAutoRun: snippet.noAutoRun,
          multiLineRunMode: snippet.multiLineRunMode ?? 'paste',
        }),
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
      const newSession = createCopiedTerminalSessionClone(session, {
        id: newSessionId,
        localShellType: options?.localShellType,
      });

      // Schedule the activeTab + tabOrder updates only when creation
      // actually happens. These nested setStates are idempotent, so
      // StrictMode's double-invocation is harmless.
      setActiveTabId(newSessionId);
      setTabOrder(prevTabOrder => {
        const allTabIds = [
          ...orphanSessions.map(s => s.id),
          ...workspaces.map(w => w.id),
          ...logViews.map(lv => lv.id),
        ];
        return insertCopiedTabOrderIdOnce(prevTabOrder, sessionId, newSessionId, allTabIds);
      });

      return [...prevSessions, newSession];
    });
  }, [orphanSessions, workspaces, logViews, setActiveTabId]);

  const createSessionFromCloneSource = useCallback((sourceSession: TerminalSession, options?: {
    localShellType?: TerminalSession['shellType'];
  }) => {
    const newSessionId = crypto.randomUUID();
    const newSession = createCopiedTerminalSessionClone(sourceSession, {
      id: newSessionId,
      localShellType: options?.localShellType,
    });
    delete newSession.workspaceId;

    setSessions(prevSessions => {
      if (prevSessions.some(session => session.id === newSessionId)) return prevSessions;
      return [...prevSessions, newSession];
    });
    setTabOrder(prevTabOrder => [...prevTabOrder, newSessionId]);
    setActiveTabId(newSessionId);
    return newSessionId;
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

  const baseWorkTabIds = useMemo(() => [
    ...orphanSessions.map(s => s.id),
    ...workspaces.map(w => w.id),
    ...logViews.map(lv => lv.id),
  ], [orphanSessions, workspaces, logViews]);

  const getOrderedWorkTabs = useCallback((additionalTabIds: readonly string[] = []) => {
    const allTabIds = [...baseWorkTabIds, ...additionalTabIds];
    return buildOrderedWorkTabIds(tabOrder, allTabIds);
  }, [baseWorkTabIds, tabOrder]);

  // Get ordered tabs: combines orphan sessions, workspaces, and log views in the custom order
  const orderedTabs = useMemo(
    () => getOrderedWorkTabs(),
    [getOrderedWorkTabs],
  );

  const removeSessionFromWorkspace = useCallback((
    sessionId: string,
    tabInsertionTarget?: {
      tabId: string;
      position: 'before' | 'after';
      additionalTabIds?: readonly string[];
    },
  ) => {
    // Detach from latest refs so continuous-render / memoized panes cannot
    // act on a stale workspace snapshot and drop the terminal instead of
    // restoring it as a standalone tab.
    const result = detachSessionFromWorkspaceState({
      sessions: sessionsRef.current,
      workspaces: workspacesRef.current,
      sessionId,
    });
    if (!result.changed) return;

    setWorkspaces(result.workspaces);
    setSessions(result.sessions);
    setTabOrder((prevTabOrder) => {
      const replacedOrder = replaceDissolvedWorkspaceTabOrder(
        prevTabOrder,
        result.dissolvedWorkspaceId,
        result.replacementTabIds,
      );
      if (!tabInsertionTarget) return replacedOrder;

      const allTabIds = [
        ...result.sessions.filter((s) => !s.workspaceId).map((s) => s.id),
        ...result.workspaces.map((w) => w.id),
        ...logViews.map((lv) => lv.id),
        ...(tabInsertionTarget.additionalTabIds ?? []),
      ];
      return reorderWorkTabIds(
        replacedOrder,
        allTabIds,
        sessionId,
        tabInsertionTarget.tabId,
        tabInsertionTarget.position,
      );
    });
    if (result.activeTabId) setActiveTabId(result.activeTabId);
  }, [logViews, setActiveTabId]);

  const reorderTabs = useCallback((
    draggedId: string,
    targetId: string,
    position: 'before' | 'after' = 'before',
    additionalTabIds: readonly string[] = [],
  ) => {
    if (draggedId === targetId) return;
    
    setTabOrder(prevTabOrder => reorderWorkTabIds(
      prevTabOrder,
      [...baseWorkTabIds, ...additionalTabIds],
      draggedId,
      targetId,
      position,
    ));
  }, [baseWorkTabIds]);

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
    renameSessionInline,
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
    updateSessionFontSize,
    clearSessionFontSizeOverride,
    createWorkspaceWithHosts,
    createWorkspaceFromTargets,
    createWorkspaceFromSessions,
    addSessionToWorkspace,
    removeSessionFromWorkspace,
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
    getOrderedWorkTabs,
    reorderTabs,
    // Log views
    logViews,
    openLogView,
    closeLogView,
    // Copy session
    copySession,
    createSessionFromCloneSource,
    updateSessionRestoreCwd,
    updateSessionDynamicTitle,
    updateSessionCodingCliProvider,
  };
};
