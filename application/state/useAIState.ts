import { useCallback, useEffect, useRef, useState } from 'react';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import {
  STORAGE_KEY_AI_PROVIDERS,
  STORAGE_KEY_AI_ACTIVE_PROVIDER,
  STORAGE_KEY_AI_ACTIVE_MODEL,
  STORAGE_KEY_AI_PERMISSION_MODE,
  STORAGE_KEY_AI_TOOL_INTEGRATION_MODE,
  STORAGE_KEY_AI_HOST_PERMISSIONS,
  STORAGE_KEY_AI_EXTERNAL_AGENTS,
  STORAGE_KEY_AI_DEFAULT_AGENT,
  STORAGE_KEY_AI_COMMAND_BLOCKLIST,
  STORAGE_KEY_AI_COMMAND_TIMEOUT,
  STORAGE_KEY_AI_MAX_ITERATIONS,
  STORAGE_KEY_AI_SESSIONS,
  STORAGE_KEY_AI_ACTIVE_SESSION_MAP,
  STORAGE_KEY_AI_AGENT_MODEL_MAP,
  STORAGE_KEY_AI_WEB_SEARCH,
} from '../../infrastructure/config/storageKeys';
import type {
  AISession,
  AIPermissionMode,
  AIToolIntegrationMode,
  ProviderConfig,
  HostAIPermission,
  ExternalAgentConfig,
  ChatMessage,
  AISessionScope,
  WebSearchConfig,
} from '../../infrastructure/ai/types';
import { DEFAULT_COMMAND_BLOCKLIST } from '../../infrastructure/ai/types';

/** Typed accessor for the Electron IPC bridge exposed on `window.netcatty`. */
interface AIBridge {
  aiAcpCleanup?: (chatSessionId: string) => Promise<{ ok: boolean }>;
  aiMcpSetPermissionMode?: (mode: AIPermissionMode) => Promise<unknown> | unknown;
  aiMcpSetToolIntegrationMode?: (mode: AIToolIntegrationMode) => Promise<unknown> | unknown;
  aiMcpSetCommandBlocklist?: (blocklist: string[]) => Promise<unknown> | unknown;
  aiMcpSetCommandTimeout?: (timeout: number) => Promise<unknown> | unknown;
  aiMcpSetMaxIterations?: (maxIterations: number) => Promise<unknown> | unknown;
}

function getAIBridge() {
  return (window as unknown as { netcatty?: AIBridge }).netcatty;
}

const AI_STATE_CHANGED_EVENT = 'netcatty:ai-state-changed';

function emitAIStateChanged(key: string) {
  window.dispatchEvent(new CustomEvent<{ key: string }>(AI_STATE_CHANGED_EVENT, { detail: { key } }));
}

function cleanupAcpSessions(sessionIds: string[]) {
  const bridge = getAIBridge();
  if (!bridge?.aiAcpCleanup || sessionIds.length === 0) return;
  for (const sessionId of sessionIds) {
    void bridge.aiAcpCleanup(sessionId).catch(() => {});
  }
}

function isScopeKeyActive(scopeKey: string, activeTargetIds: Set<string>) {
  const separatorIndex = scopeKey.indexOf(':');
  if (separatorIndex === -1) return true;

  const targetId = scopeKey.slice(separatorIndex + 1);
  if (!targetId) return true;

  return activeTargetIds.has(targetId);
}

export function cleanupOrphanedAISessions(activeTargetIds: Set<string>) {
  const currentSessions = latestAISessionsSnapshot
    ?? localStorageAdapter.read<AISession[]>(STORAGE_KEY_AI_SESSIONS)
    ?? [];
  const orphanedSessionIds = currentSessions
    .filter((session) => session.scope.targetId && !activeTargetIds.has(session.scope.targetId))
    .map((session) => session.id);

  if (orphanedSessionIds.length > 0) {
    const orphanedSessionIdSet = new Set(orphanedSessionIds);

    // Determine which sessions can be restored via host-based matching
    const preservedIds = new Set<string>();
    for (const session of currentSessions) {
      if (!orphanedSessionIdSet.has(session.id)) continue;
      // Only preserve remote terminal sessions with real hostIds
      const isRestorable = session.scope.type === 'terminal'
        && session.scope.hostIds?.length
        && session.scope.hostIds.some((id) => !id.startsWith('local-') && !id.startsWith('serial-'));
      if (isRestorable) {
        preservedIds.add(session.id);
      }
    }

    // Cleanup ACP sessions for all orphans (both deleted and preserved).
    // Preserved sessions will get a new externalSessionId on next use,
    // so cleaning the old one is safe and prevents subprocess leaks.
    cleanupAcpSessions(orphanedSessionIds);

    const nextSessions = currentSessions
      .filter((session) => !orphanedSessionIdSet.has(session.id) || preservedIds.has(session.id))
      .map((session) => {
        if (!preservedIds.has(session.id) || !session.externalSessionId) {
          return session;
        }
        // Drop transient ACP session handles so the next turn starts cleanly.
        return { ...session, externalSessionId: undefined };
      });

    const sessionsChanged = nextSessions.length !== currentSessions.length
      || nextSessions.some((session, index) => session !== currentSessions[index]);
    if (sessionsChanged) {
      setLatestAISessionsSnapshot(nextSessions);
      localStorageAdapter.write(STORAGE_KEY_AI_SESSIONS, pruneSessionsForStorage(nextSessions));
      emitAIStateChanged(STORAGE_KEY_AI_SESSIONS);
    }
  }

  const activeSessionIdMap = latestAIActiveSessionMapSnapshot
    ?? localStorageAdapter.read<Record<string, string | null>>(STORAGE_KEY_AI_ACTIVE_SESSION_MAP)
    ?? {};
  let activeSessionMapChanged = false;
  const nextActiveSessionIdMap = { ...activeSessionIdMap };

  for (const scopeKey of Object.keys(activeSessionIdMap)) {
    if (isScopeKeyActive(scopeKey, activeTargetIds)) continue;
    delete nextActiveSessionIdMap[scopeKey];
    activeSessionMapChanged = true;
  }

  if (activeSessionMapChanged) {
    setLatestAIActiveSessionMapSnapshot(nextActiveSessionIdMap);
    localStorageAdapter.write(STORAGE_KEY_AI_ACTIVE_SESSION_MAP, nextActiveSessionIdMap);
    emitAIStateChanged(STORAGE_KEY_AI_ACTIVE_SESSION_MAP);
  }
}


/** Maximum number of sessions to keep in localStorage. */
const MAX_STORED_SESSIONS = 50;
/** Maximum number of messages per session when persisting to localStorage. */
const MAX_SESSION_MESSAGES = 200;

/**
 * Prune sessions before writing to localStorage to prevent hitting the
 * ~5-10 MB storage quota. Only affects what is persisted — the in-memory
 * state retains all messages until the session is reloaded.
 *
 * - Keeps only the MAX_STORED_SESSIONS most-recently-updated sessions.
 * - Trims each session's messages to the last MAX_SESSION_MESSAGES.
 */
function pruneSessionsForStorage(sessions: AISession[]): AISession[] {
  // Sort by updatedAt descending so we keep the newest
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const limited = sorted.slice(0, MAX_STORED_SESSIONS);
  return limited.map(s => {
    if (s.messages.length > MAX_SESSION_MESSAGES) {
      return { ...s, messages: s.messages.slice(-MAX_SESSION_MESSAGES) };
    }
    return s;
  });
}

let latestAISessionsSnapshot: AISession[] | null = null;
let latestAIActiveSessionMapSnapshot: Record<string, string | null> | null = null;

function setLatestAISessionsSnapshot(sessions: AISession[]) {
  latestAISessionsSnapshot = sessions;
}

function setLatestAIActiveSessionMapSnapshot(activeSessionIdMap: Record<string, string | null>) {
  latestAIActiveSessionMapSnapshot = activeSessionIdMap;
}

function buildScopeKey(scope: AISessionScope) {
  return `${scope.type}:${scope.targetId ?? ''}`;
}

function areHostIdsEqual(left?: string[], right?: string[]) {
  const leftIds = left ?? [];
  const rightIds = right ?? [];
  if (leftIds.length !== rightIds.length) return false;

  const rightSet = new Set(rightIds);
  return leftIds.every((hostId) => rightSet.has(hostId));
}

export function useAIState() {
  // ── Provider Config ──
  const [providers, setProvidersRaw] = useState<ProviderConfig[]>(() =>
    localStorageAdapter.read<ProviderConfig[]>(STORAGE_KEY_AI_PROVIDERS) ?? []
  );
  const [activeProviderId, setActiveProviderIdRaw] = useState<string>(() =>
    localStorageAdapter.readString(STORAGE_KEY_AI_ACTIVE_PROVIDER) ?? ''
  );
  const [activeModelId, setActiveModelIdRaw] = useState<string>(() =>
    localStorageAdapter.readString(STORAGE_KEY_AI_ACTIVE_MODEL) ?? ''
  );

  // ── Permission Model ──
  const [globalPermissionMode, setGlobalPermissionModeRaw] = useState<AIPermissionMode>(() => {
    const stored = localStorageAdapter.readString(STORAGE_KEY_AI_PERMISSION_MODE);
    if (stored === 'observer' || stored === 'confirm' || stored === 'autonomous') return stored;
    return 'confirm';
  });
  const [toolIntegrationMode, setToolIntegrationModeRaw] = useState<AIToolIntegrationMode>(() => {
    const stored = localStorageAdapter.readString(STORAGE_KEY_AI_TOOL_INTEGRATION_MODE);
    return stored === 'skills' ? 'skills' : 'mcp';
  });
  const [hostPermissions, setHostPermissionsRaw] = useState<HostAIPermission[]>(() =>
    localStorageAdapter.read<HostAIPermission[]>(STORAGE_KEY_AI_HOST_PERMISSIONS) ?? []
  );

  // ── External Agents ──
  const [externalAgents, setExternalAgentsRaw] = useState<ExternalAgentConfig[]>(() =>
    localStorageAdapter.read<ExternalAgentConfig[]>(STORAGE_KEY_AI_EXTERNAL_AGENTS) ?? []
  );
  const [defaultAgentId, setDefaultAgentIdRaw] = useState<string>(() =>
    localStorageAdapter.readString(STORAGE_KEY_AI_DEFAULT_AGENT) ?? 'catty'
  );

  // ── Safety Settings ──
  const [commandBlocklist, setCommandBlocklistRaw] = useState<string[]>(() =>
    localStorageAdapter.read<string[]>(STORAGE_KEY_AI_COMMAND_BLOCKLIST) ?? [...DEFAULT_COMMAND_BLOCKLIST]
  );
  const [commandTimeout, setCommandTimeoutRaw] = useState<number>(() =>
    localStorageAdapter.readNumber(STORAGE_KEY_AI_COMMAND_TIMEOUT) ?? 60
  );
  const [maxIterations, setMaxIterationsRaw] = useState<number>(() =>
    localStorageAdapter.readNumber(STORAGE_KEY_AI_MAX_ITERATIONS) ?? 20
  );

  // ── Sessions ──
  const [sessions, setSessionsRaw] = useState<AISession[]>(() =>
    localStorageAdapter.read<AISession[]>(STORAGE_KEY_AI_SESSIONS) ?? []
  );
  // Ref that always holds the latest sessions for use inside debounced callbacks
  const sessionsRef = useRef(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  // Per-scope active session: keyed by `${scopeType}:${scopeTargetId}`
  const [activeSessionIdMap, setActiveSessionIdMapRaw] = useState<Record<string, string | null>>(() =>
    localStorageAdapter.read<Record<string, string | null>>(STORAGE_KEY_AI_ACTIVE_SESSION_MAP) ?? {}
  );

  // Per-agent model selection: remembers last selected model per agent
  const [agentModelMap, setAgentModelMapRaw] = useState<Record<string, string>>(() =>
    localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_AI_AGENT_MODEL_MAP) ?? {}
  );

  // ── Web Search Config ──
  const [webSearchConfig, setWebSearchConfigRaw] = useState<WebSearchConfig | null>(() =>
    localStorageAdapter.read<WebSearchConfig>(STORAGE_KEY_AI_WEB_SEARCH) ?? null
  );

  useEffect(() => {
    setLatestAISessionsSnapshot(sessions);
  }, [sessions]);

  useEffect(() => {
    setLatestAIActiveSessionMapSnapshot(activeSessionIdMap);
  }, [activeSessionIdMap]);

  useEffect(() => {
    const validSessionIds = new Set(sessions.map((session) => session.id));
    let changed = false;
    const nextActiveSessionIdMap: Record<string, string | null> = {};

    for (const [scopeKey, sessionId] of Object.entries(activeSessionIdMap) as Array<[string, string | null]>) {
      const nextSessionId = sessionId && validSessionIds.has(sessionId) ? sessionId : null;
      nextActiveSessionIdMap[scopeKey] = nextSessionId;
      if (nextSessionId !== sessionId) {
        changed = true;
      }
    }

    if (!changed) return;

    setLatestAIActiveSessionMapSnapshot(nextActiveSessionIdMap);
    localStorageAdapter.write(STORAGE_KEY_AI_ACTIVE_SESSION_MAP, nextActiveSessionIdMap);
    setActiveSessionIdMapRaw(nextActiveSessionIdMap);
    emitAIStateChanged(STORAGE_KEY_AI_ACTIVE_SESSION_MAP);
  }, [sessions, activeSessionIdMap]);

  const setActiveSessionId = useCallback((scopeKey: string, id: string | null) => {
    setActiveSessionIdMapRaw(prev => {
      const next = { ...prev, [scopeKey]: id };
      setLatestAIActiveSessionMapSnapshot(next);
      localStorageAdapter.write(STORAGE_KEY_AI_ACTIVE_SESSION_MAP, next);
      emitAIStateChanged(STORAGE_KEY_AI_ACTIVE_SESSION_MAP);
      return next;
    });
  }, []);

  const setAgentModel = useCallback((agentId: string, modelId: string) => {
    setAgentModelMapRaw(prev => {
      const next = { ...prev, [agentId]: modelId };
      localStorageAdapter.write(STORAGE_KEY_AI_AGENT_MODEL_MAP, next);
      return next;
    });
  }, []);

  const setWebSearchConfig = useCallback((config: WebSearchConfig | null) => {
    setWebSearchConfigRaw(config);
    if (config) {
      localStorageAdapter.write(STORAGE_KEY_AI_WEB_SEARCH, config);
    } else {
      localStorageAdapter.remove(STORAGE_KEY_AI_WEB_SEARCH);
    }
  }, []);

  // ── Persist helpers ──
  const setProviders = useCallback((value: ProviderConfig[] | ((prev: ProviderConfig[]) => ProviderConfig[])) => {
    setProvidersRaw(prev => {
      const next = typeof value === 'function' ? value(prev) : value;
      localStorageAdapter.write(STORAGE_KEY_AI_PROVIDERS, next);
      return next;
    });
  }, []);

  const setActiveProviderId = useCallback((id: string) => {
    setActiveProviderIdRaw(id);
    localStorageAdapter.writeString(STORAGE_KEY_AI_ACTIVE_PROVIDER, id);
  }, []);

  const setActiveModelId = useCallback((id: string) => {
    setActiveModelIdRaw(id);
    localStorageAdapter.writeString(STORAGE_KEY_AI_ACTIVE_MODEL, id);
  }, []);

  const setGlobalPermissionMode = useCallback((mode: AIPermissionMode) => {
    setGlobalPermissionModeRaw(mode);
    localStorageAdapter.writeString(STORAGE_KEY_AI_PERMISSION_MODE, mode);
    // Sync to MCP Server bridge (observer mode blocks write operations)
    const bridge = getAIBridge();
    bridge?.aiMcpSetPermissionMode?.(mode);
  }, []);

  const setHostPermissions = useCallback((value: HostAIPermission[] | ((prev: HostAIPermission[]) => HostAIPermission[])) => {
    setHostPermissionsRaw(prev => {
      const next = typeof value === 'function' ? value(prev) : value;
      localStorageAdapter.write(STORAGE_KEY_AI_HOST_PERMISSIONS, next);
      return next;
    });
  }, []);

  const setToolIntegrationMode = useCallback((mode: AIToolIntegrationMode) => {
    setToolIntegrationModeRaw(mode);
    localStorageAdapter.writeString(STORAGE_KEY_AI_TOOL_INTEGRATION_MODE, mode);
    const bridge = getAIBridge();
    bridge?.aiMcpSetToolIntegrationMode?.(mode);
  }, []);

  const setExternalAgents = useCallback((value: ExternalAgentConfig[] | ((prev: ExternalAgentConfig[]) => ExternalAgentConfig[])) => {
    setExternalAgentsRaw(prev => {
      const next = typeof value === 'function' ? value(prev) : value;
      localStorageAdapter.write(STORAGE_KEY_AI_EXTERNAL_AGENTS, next);
      return next;
    });
  }, []);

  const setDefaultAgentId = useCallback((id: string) => {
    setDefaultAgentIdRaw(id);
    localStorageAdapter.writeString(STORAGE_KEY_AI_DEFAULT_AGENT, id);
  }, []);

  const setCommandBlocklist = useCallback((value: string[]) => {
    setCommandBlocklistRaw(value);
    localStorageAdapter.write(STORAGE_KEY_AI_COMMAND_BLOCKLIST, value);
    // Sync to MCP Server bridge so ACP agents also respect the blocklist
    const bridge = getAIBridge();
    bridge?.aiMcpSetCommandBlocklist?.(value);
  }, []);

  const setCommandTimeout = useCallback((value: number) => {
    setCommandTimeoutRaw(value);
    localStorageAdapter.writeNumber(STORAGE_KEY_AI_COMMAND_TIMEOUT, value);
    // Sync to MCP Server bridge
    const bridge = getAIBridge();
    bridge?.aiMcpSetCommandTimeout?.(value);
  }, []);

  const setMaxIterations = useCallback((value: number) => {
    setMaxIterationsRaw(value);
    localStorageAdapter.writeNumber(STORAGE_KEY_AI_MAX_ITERATIONS, value);
    // Sync to MCP Server bridge (used by ACP agent path)
    const bridge = getAIBridge();
    bridge?.aiMcpSetMaxIterations?.(value);
  }, []);

  // ── Cross-window sync via storage events ──
  // When the settings window updates localStorage, the main window picks up changes.
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      try {
        switch (e.key) {
          case STORAGE_KEY_AI_PROVIDERS: {
            const parsed = localStorageAdapter.read<ProviderConfig[]>(STORAGE_KEY_AI_PROVIDERS);
            if (parsed != null && !Array.isArray(parsed)) {
              console.warn('[useAIState] Cross-window sync: AI_PROVIDERS is not an array, skipping');
              break;
            }
            setProvidersRaw(parsed ?? []);
            break;
          }
          case STORAGE_KEY_AI_ACTIVE_PROVIDER:
            setActiveProviderIdRaw(localStorageAdapter.readString(STORAGE_KEY_AI_ACTIVE_PROVIDER) ?? '');
            break;
          case STORAGE_KEY_AI_ACTIVE_MODEL:
            setActiveModelIdRaw(localStorageAdapter.readString(STORAGE_KEY_AI_ACTIVE_MODEL) ?? '');
            break;
          case STORAGE_KEY_AI_PERMISSION_MODE: {
            const mode = localStorageAdapter.readString(STORAGE_KEY_AI_PERMISSION_MODE);
            if (mode === 'observer' || mode === 'confirm' || mode === 'autonomous') {
              setGlobalPermissionModeRaw(mode);
              getAIBridge()?.aiMcpSetPermissionMode?.(mode);
            }
            break;
          }
          case STORAGE_KEY_AI_TOOL_INTEGRATION_MODE:
            {
              const mode = localStorageAdapter.readString(STORAGE_KEY_AI_TOOL_INTEGRATION_MODE) === 'skills'
                ? 'skills'
                : 'mcp';
              setToolIntegrationModeRaw(mode);
              getAIBridge()?.aiMcpSetToolIntegrationMode?.(mode);
            }
            break;
          case STORAGE_KEY_AI_EXTERNAL_AGENTS: {
            const agents = localStorageAdapter.read<ExternalAgentConfig[]>(STORAGE_KEY_AI_EXTERNAL_AGENTS);
            if (agents != null && !Array.isArray(agents)) {
              console.warn('[useAIState] Cross-window sync: AI_EXTERNAL_AGENTS is not an array, skipping');
              break;
            }
            setExternalAgentsRaw(agents ?? []);
            break;
          }
          case STORAGE_KEY_AI_DEFAULT_AGENT:
            setDefaultAgentIdRaw(localStorageAdapter.readString(STORAGE_KEY_AI_DEFAULT_AGENT) ?? 'catty');
            break;
          case STORAGE_KEY_AI_COMMAND_BLOCKLIST: {
            const list = localStorageAdapter.read<string[]>(STORAGE_KEY_AI_COMMAND_BLOCKLIST);
            if (list != null && !Array.isArray(list)) {
              console.warn('[useAIState] Cross-window sync: AI_COMMAND_BLOCKLIST is not an array, skipping');
              break;
            }
            const blocklist = list ?? [...DEFAULT_COMMAND_BLOCKLIST];
            setCommandBlocklistRaw(blocklist);
            getAIBridge()?.aiMcpSetCommandBlocklist?.(blocklist);
            break;
          }
          case STORAGE_KEY_AI_COMMAND_TIMEOUT: {
            const timeout = localStorageAdapter.readNumber(STORAGE_KEY_AI_COMMAND_TIMEOUT) ?? 60;
            if (!Number.isFinite(timeout)) {
              console.warn('[useAIState] Cross-window sync: AI_COMMAND_TIMEOUT is not a finite number, skipping');
              break;
            }
            setCommandTimeoutRaw(timeout);
            getAIBridge()?.aiMcpSetCommandTimeout?.(timeout);
            break;
          }
          case STORAGE_KEY_AI_MAX_ITERATIONS: {
            const iters = localStorageAdapter.readNumber(STORAGE_KEY_AI_MAX_ITERATIONS) ?? 20;
            if (!Number.isFinite(iters)) {
              console.warn('[useAIState] Cross-window sync: AI_MAX_ITERATIONS is not a finite number, skipping');
              break;
            }
            setMaxIterationsRaw(iters);
            getAIBridge()?.aiMcpSetMaxIterations?.(iters);
            break;
          }
          case STORAGE_KEY_AI_HOST_PERMISSIONS: {
            const perms = localStorageAdapter.read<HostAIPermission[]>(STORAGE_KEY_AI_HOST_PERMISSIONS);
            if (perms != null && !Array.isArray(perms)) {
              console.warn('[useAIState] Cross-window sync: AI_HOST_PERMISSIONS is not an array, skipping');
              break;
            }
            setHostPermissionsRaw(perms ?? []);
            break;
          }
          case STORAGE_KEY_AI_SESSIONS: {
            const nextSessions = localStorageAdapter.read<AISession[]>(STORAGE_KEY_AI_SESSIONS) ?? [];
            setLatestAISessionsSnapshot(nextSessions);
            setSessionsRaw(nextSessions);
            break;
          }
          case STORAGE_KEY_AI_AGENT_MODEL_MAP:
            setAgentModelMapRaw(localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_AI_AGENT_MODEL_MAP) ?? {});
            break;
          case STORAGE_KEY_AI_ACTIVE_SESSION_MAP: {
            const nextActiveSessionIdMap =
              localStorageAdapter.read<Record<string, string | null>>(STORAGE_KEY_AI_ACTIVE_SESSION_MAP) ?? {};
            setLatestAIActiveSessionMapSnapshot(nextActiveSessionIdMap);
            setActiveSessionIdMapRaw(nextActiveSessionIdMap);
            break;
          }
          case STORAGE_KEY_AI_WEB_SEARCH:
            setWebSearchConfigRaw(localStorageAdapter.read<WebSearchConfig>(STORAGE_KEY_AI_WEB_SEARCH) ?? null);
            break;
        }
      } catch (err) {
        console.warn('[useAIState] Cross-window sync: failed to process storage event for key', e.key, err);
      }
    };
    window.addEventListener('storage', handleStorage);
    const handleLocalStateChanged = (event: Event) => {
      const key = (event as CustomEvent<{ key?: string }>).detail?.key;
      if (!key) return;
      switch (key) {
        case STORAGE_KEY_AI_SESSIONS:
          setSessionsRaw(
            latestAISessionsSnapshot
              ?? localStorageAdapter.read<AISession[]>(STORAGE_KEY_AI_SESSIONS)
              ?? [],
          );
          return;
        case STORAGE_KEY_AI_ACTIVE_SESSION_MAP:
          setActiveSessionIdMapRaw(
            latestAIActiveSessionMapSnapshot
              ?? localStorageAdapter.read<Record<string, string | null>>(STORAGE_KEY_AI_ACTIVE_SESSION_MAP)
              ?? {},
          );
          return;
        default:
          handleStorage({ key } as StorageEvent);
      }
    };
    window.addEventListener(AI_STATE_CHANGED_EVENT, handleLocalStateChanged);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(AI_STATE_CHANGED_EVENT, handleLocalStateChanged);
    };
  }, []);

  // ── Sync initial safety settings to MCP Server on mount ──
  useEffect(() => {
    const bridge = getAIBridge();
    const initialBlocklist = localStorageAdapter.read<string[]>(STORAGE_KEY_AI_COMMAND_BLOCKLIST) ?? [...DEFAULT_COMMAND_BLOCKLIST];
    bridge?.aiMcpSetCommandBlocklist?.(initialBlocklist);
    const initialTimeout = localStorageAdapter.readNumber(STORAGE_KEY_AI_COMMAND_TIMEOUT) ?? 60;
    bridge?.aiMcpSetCommandTimeout?.(initialTimeout);
    const initialMaxIter = localStorageAdapter.readNumber(STORAGE_KEY_AI_MAX_ITERATIONS) ?? 20;
    bridge?.aiMcpSetMaxIterations?.(initialMaxIter);
    const storedPermMode = localStorageAdapter.readString(STORAGE_KEY_AI_PERMISSION_MODE);
    const initialPermMode: AIPermissionMode =
      storedPermMode === 'observer' || storedPermMode === 'confirm' || storedPermMode === 'autonomous'
        ? storedPermMode
        : 'confirm';
    bridge?.aiMcpSetPermissionMode?.(initialPermMode);
    const initialToolMode: AIToolIntegrationMode =
      localStorageAdapter.readString(STORAGE_KEY_AI_TOOL_INTEGRATION_MODE) === 'skills'
        ? 'skills'
        : 'mcp';
    bridge?.aiMcpSetToolIntegrationMode?.(initialToolMode);
  }, []);

  // ── Session CRUD ──
  const persistSessions = useCallback((next: AISession[]) => {
    localStorageAdapter.write(STORAGE_KEY_AI_SESSIONS, pruneSessionsForStorage(next));
  }, []);

  // Debounced version of persistSessions for high-frequency updates (e.g. streaming)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const debouncedPersistSessions = useCallback(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return; // Skip writes after unmount
      localStorageAdapter.write(STORAGE_KEY_AI_SESSIONS, pruneSessionsForStorage(sessionsRef.current));
      persistTimerRef.current = null;
    }, 500);
  }, []);

  // Flush pending debounced writes on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
        persistSessions(sessionsRef.current);
      }
    };
  }, [persistSessions]);

  const createSession = useCallback((scope: AISessionScope, agentId?: string): AISession => {
    const now = Date.now();
    const session: AISession = {
      id: `ai_${now}_${Math.random().toString(36).slice(2, 8)}`,
      title: 'New Chat',
      agentId: agentId || defaultAgentId,
      scope,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    setSessionsRaw(prev => {
      const next = [session, ...prev];
      setLatestAISessionsSnapshot(next);
      persistSessions(next);
      return next;
    });
    const scopeKey = `${scope.type}:${scope.targetId ?? ''}`;
    setActiveSessionId(scopeKey, session.id);
    return session;
  }, [defaultAgentId, persistSessions, setActiveSessionId]);

  const deleteSession = useCallback((sessionId: string, scopeKey?: string) => {
    cleanupAcpSessions([sessionId]);
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    setSessionsRaw(prev => {
      const next = prev.filter(s => s.id !== sessionId);
      setLatestAISessionsSnapshot(next);
      persistSessions(next);
      return next;
    });
    if (scopeKey) {
      setActiveSessionIdMapRaw(prev => {
        if (prev[scopeKey] === sessionId) {
          const next = { ...prev, [scopeKey]: null };
          setLatestAIActiveSessionMapSnapshot(next);
          localStorageAdapter.write(STORAGE_KEY_AI_ACTIVE_SESSION_MAP, next);
          emitAIStateChanged(STORAGE_KEY_AI_ACTIVE_SESSION_MAP);
          return next;
        }
        return prev;
      });
    }
  }, [persistSessions]);

  const deleteSessionsByTarget = useCallback((scopeType: 'terminal' | 'workspace', targetId: string) => {
    const removedSessionIds = sessionsRef.current
      .filter(s => s.scope.type === scopeType && s.scope.targetId === targetId)
      .map(s => s.id);
    cleanupAcpSessions(removedSessionIds);
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    setSessionsRaw(prev => {
      const next = prev.filter(s => {
        return !(s.scope.type === scopeType && s.scope.targetId === targetId);
      });
      setLatestAISessionsSnapshot(next);
      persistSessions(next);
      return next;
    });
    const scopeKey = `${scopeType}:${targetId}`;
    setActiveSessionIdMapRaw(prev => {
      if (prev[scopeKey] != null) {
        const next = { ...prev, [scopeKey]: null };
        setLatestAIActiveSessionMapSnapshot(next);
        localStorageAdapter.write(STORAGE_KEY_AI_ACTIVE_SESSION_MAP, next);
        emitAIStateChanged(STORAGE_KEY_AI_ACTIVE_SESSION_MAP);
        return next;
      }
      return prev;
    });
  }, [persistSessions]);

  const updateSessionTitle = useCallback((sessionId: string, title: string) => {
    setSessionsRaw(prev => {
      const next = prev.map(s => s.id === sessionId ? { ...s, title, updatedAt: Date.now() } : s);
      setLatestAISessionsSnapshot(next);
      persistSessions(next);
      return next;
    });
  }, [persistSessions]);

  const updateSessionExternalSessionId = useCallback((sessionId: string, externalSessionId: string | undefined) => {
    setSessionsRaw(prev => {
      const next = prev.map(s => (
        s.id === sessionId
          ? { ...s, externalSessionId, updatedAt: Date.now() }
          : s
      ));
      setLatestAISessionsSnapshot(next);
      debouncedPersistSessions();
      return next;
    });
  }, [debouncedPersistSessions]);

  const retargetSessionScope = useCallback((sessionId: string, scope: AISessionScope) => {
    const currentSession = sessionsRef.current.find((session) => session.id === sessionId);
    if (!currentSession) return;

    const currentScope = currentSession.scope;
    const scopeChanged =
      currentScope.type !== scope.type
      || currentScope.targetId !== scope.targetId
      || !areHostIdsEqual(currentScope.hostIds, scope.hostIds);

    const nextScopeKey = buildScopeKey(scope);
    const currentScopeKey = buildScopeKey(currentScope);

    if (scopeChanged) {
      setSessionsRaw((prev) => {
        let changed = false;
        const next = prev.map((session) => {
          if (session.id !== sessionId) return session;
          changed = true;
          // Clear stale ACP handle — retarget may run before orphan cleanup
          return { ...session, scope, externalSessionId: undefined };
        });

        if (!changed) return prev;

        sessionsRef.current = next;
        setLatestAISessionsSnapshot(next);
        persistSessions(next);
        return next;
      });
    }

    setActiveSessionIdMapRaw((prev) => {
      let changed = false;
      const next = { ...prev };

      if (currentScopeKey !== nextScopeKey && next[currentScopeKey] === sessionId) {
        delete next[currentScopeKey];
        changed = true;
      }

      if (next[nextScopeKey] !== sessionId) {
        next[nextScopeKey] = sessionId;
        changed = true;
      }

      if (!changed) return prev;

      setLatestAIActiveSessionMapSnapshot(next);
      localStorageAdapter.write(STORAGE_KEY_AI_ACTIVE_SESSION_MAP, next);
      emitAIStateChanged(STORAGE_KEY_AI_ACTIVE_SESSION_MAP);
      return next;
    });
  }, [persistSessions]);

  // Maximum messages per session to prevent unbounded memory growth
  const MAX_MESSAGES_PER_SESSION = 500;

  const addMessageToSession = useCallback((sessionId: string, message: ChatMessage) => {
    setSessionsRaw(prev => {
      const next = prev.map(s => {
        if (s.id !== sessionId) return s;
        let msgs = [...s.messages, message];
        // Trim oldest messages if exceeding limit (keep system messages)
        if (msgs.length > MAX_MESSAGES_PER_SESSION) {
          const systemMsgs = msgs.filter(m => m.role === 'system');
          const nonSystemMsgs = msgs.filter(m => m.role !== 'system');
          const dropped = nonSystemMsgs.length - (MAX_MESSAGES_PER_SESSION - systemMsgs.length);
          console.warn(`[useAIState] Session ${sessionId}: trimmed ${dropped} oldest non-system message(s) to stay within ${MAX_MESSAGES_PER_SESSION} limit`);
          msgs = [...systemMsgs, ...nonSystemMsgs.slice(-MAX_MESSAGES_PER_SESSION + systemMsgs.length)];
        }
        return { ...s, messages: msgs, updatedAt: Date.now() };
      });
      setLatestAISessionsSnapshot(next);
      debouncedPersistSessions();
      return next;
    });
  }, [debouncedPersistSessions]);

  const updateLastMessage = useCallback((sessionId: string, updater: (msg: ChatMessage) => ChatMessage) => {
    setSessionsRaw(prev => {
      const next = prev.map(s => {
        if (s.id !== sessionId || s.messages.length === 0) return s;
        const msgs = [...s.messages];
        msgs[msgs.length - 1] = updater(msgs[msgs.length - 1]);
        return { ...s, messages: msgs, updatedAt: Date.now() };
      });
      setLatestAISessionsSnapshot(next);
      debouncedPersistSessions();
      return next;
    });
  }, [debouncedPersistSessions]);

  const updateMessageById = useCallback((sessionId: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => {
    setSessionsRaw(prev => {
      const next = prev.map(s => {
        if (s.id !== sessionId) return s;
        const idx = s.messages.findIndex(m => m.id === messageId);
        if (idx === -1) return s;
        const msgs = [...s.messages];
        msgs[idx] = updater(msgs[idx]);
        return { ...s, messages: msgs, updatedAt: Date.now() };
      });
      setLatestAISessionsSnapshot(next);
      debouncedPersistSessions();
      return next;
    });
  }, [debouncedPersistSessions]);

  const clearSessionMessages = useCallback((sessionId: string) => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    setSessionsRaw(prev => {
      const next = prev.map(s => s.id === sessionId ? { ...s, messages: [], updatedAt: Date.now() } : s);
      setLatestAISessionsSnapshot(next);
      persistSessions(next);
      return next;
    });
  }, [persistSessions]);

  const cleanupOrphanedSessions = useCallback((activeTargetIds: Set<string>) => {
    cleanupOrphanedAISessions(activeTargetIds);
    setSessionsRaw(latestAISessionsSnapshot ?? localStorageAdapter.read<AISession[]>(STORAGE_KEY_AI_SESSIONS) ?? []);
    setActiveSessionIdMapRaw(
      latestAIActiveSessionMapSnapshot
        ?? localStorageAdapter.read<Record<string, string | null>>(STORAGE_KEY_AI_ACTIVE_SESSION_MAP)
        ?? {},
    );
  }, []);

  // ── Provider CRUD helpers ──
  const addProvider = useCallback((provider: ProviderConfig) => {
    setProviders(prev => [...prev, provider]);
  }, [setProviders]);

  const updateProvider = useCallback((id: string, updates: Partial<ProviderConfig>) => {
    setProviders(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p));
  }, [setProviders]);

  const removeProvider = useCallback((id: string) => {
    setProviders(prev => prev.filter(p => p.id !== id));
    // Use the raw setter to avoid stale closure over setActiveProviderId
    setActiveProviderIdRaw(prevId => {
      if (prevId === id) {
        const next = '';
        localStorageAdapter.writeString(STORAGE_KEY_AI_ACTIVE_PROVIDER, next);
        return next;
      }
      return prevId;
    });
  }, [setProviders]);

  // ── Computed ──
  const activeProvider = providers.find(p => p.id === activeProviderId) ?? null;

  return {
    // Provider config
    providers,
    setProviders,
    addProvider,
    updateProvider,
    removeProvider,
    activeProviderId,
    setActiveProviderId,
    activeModelId,
    setActiveModelId,
    activeProvider,

    // Permission model
    globalPermissionMode,
    setGlobalPermissionMode,
    toolIntegrationMode,
    setToolIntegrationMode,
    hostPermissions,
    setHostPermissions,

    // External agents
    externalAgents,
    setExternalAgents,
    defaultAgentId,
    setDefaultAgentId,

    // Safety
    commandBlocklist,
    setCommandBlocklist,
    commandTimeout,
    setCommandTimeout,
    maxIterations,
    setMaxIterations,

    // Per-agent model memory
    agentModelMap,
    setAgentModel,

    // Web search
    webSearchConfig,
    setWebSearchConfig,

    // Sessions (per-scope active session)
    sessions,
    activeSessionIdMap,
    setActiveSessionId,
    createSession,
    deleteSession,
    deleteSessionsByTarget,
    updateSessionTitle,
    updateSessionExternalSessionId,
    retargetSessionScope,
    addMessageToSession,
    updateLastMessage,
    updateMessageById,
    clearSessionMessages,
    cleanupOrphanedSessions,
  };
}
