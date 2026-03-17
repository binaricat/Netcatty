import { useCallback, useEffect, useRef, useState } from 'react';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import {
  STORAGE_KEY_AI_PROVIDERS,
  STORAGE_KEY_AI_ACTIVE_PROVIDER,
  STORAGE_KEY_AI_ACTIVE_MODEL,
  STORAGE_KEY_AI_PERMISSION_MODE,
  STORAGE_KEY_AI_HOST_PERMISSIONS,
  STORAGE_KEY_AI_EXTERNAL_AGENTS,
  STORAGE_KEY_AI_DEFAULT_AGENT,
  STORAGE_KEY_AI_COMMAND_BLOCKLIST,
  STORAGE_KEY_AI_COMMAND_TIMEOUT,
  STORAGE_KEY_AI_MAX_ITERATIONS,
  STORAGE_KEY_AI_SESSIONS,
  STORAGE_KEY_AI_AGENT_MODEL_MAP,
  STORAGE_KEY_AI_WEB_SEARCH,
} from '../../infrastructure/config/storageKeys';
import type {
  AISession,
  AIPermissionMode,
  ProviderConfig,
  HostAIPermission,
  ExternalAgentConfig,
  ChatMessage,
  AISessionScope,
  WebSearchConfig,
} from '../../infrastructure/ai/types';
import { DEFAULT_COMMAND_BLOCKLIST } from '../../infrastructure/ai/types';

/** Typed accessor for the Electron IPC bridge exposed on `window.netcatty`. */
function getAIBridge() {
  return (window as unknown as { netcatty?: Record<string, (...args: unknown[]) => unknown> }).netcatty;
}

function cleanupAcpSessions(sessionIds: string[]) {
  const bridge = getAIBridge();
  if (!bridge?.aiAcpCleanup || sessionIds.length === 0) return;
  for (const sessionId of sessionIds) {
    void bridge.aiAcpCleanup(sessionId).catch(() => {});
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
  const [activeSessionIdMap, setActiveSessionIdMapRaw] = useState<Record<string, string | null>>({});

  // Per-agent model selection: remembers last selected model per agent
  const [agentModelMap, setAgentModelMapRaw] = useState<Record<string, string>>(() =>
    localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_AI_AGENT_MODEL_MAP) ?? {}
  );

  // ── Web Search Config ──
  const [webSearchConfig, setWebSearchConfigRaw] = useState<WebSearchConfig | null>(() =>
    localStorageAdapter.read<WebSearchConfig>(STORAGE_KEY_AI_WEB_SEARCH) ?? null
  );

  const setActiveSessionId = useCallback((scopeKey: string, id: string | null) => {
    setActiveSessionIdMapRaw(prev => ({ ...prev, [scopeKey]: id }));
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
          case STORAGE_KEY_AI_AGENT_MODEL_MAP:
            setAgentModelMapRaw(localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_AI_AGENT_MODEL_MAP) ?? {});
            break;
          case STORAGE_KEY_AI_WEB_SEARCH:
            setWebSearchConfigRaw(localStorageAdapter.read<WebSearchConfig>(STORAGE_KEY_AI_WEB_SEARCH) ?? null);
            break;
        }
      } catch (err) {
        console.warn('[useAIState] Cross-window sync: failed to process storage event for key', e.key, err);
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
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
    const initialPermMode = localStorageAdapter.readString(STORAGE_KEY_AI_PERMISSION_MODE) ?? 'confirm';
    bridge?.aiMcpSetPermissionMode?.(initialPermMode);
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
      persistSessions(next);
      return next;
    });
    if (scopeKey) {
      setActiveSessionIdMapRaw(prev => {
        if (prev[scopeKey] === sessionId) return { ...prev, [scopeKey]: null };
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
      persistSessions(next);
      return next;
    });
    const scopeKey = `${scopeType}:${targetId}`;
    setActiveSessionIdMapRaw(prev => {
      if (prev[scopeKey] != null) return { ...prev, [scopeKey]: null };
      return prev;
    });
  }, [persistSessions]);

  const updateSessionTitle = useCallback((sessionId: string, title: string) => {
    setSessionsRaw(prev => {
      const next = prev.map(s => s.id === sessionId ? { ...s, title, updatedAt: Date.now() } : s);
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
      debouncedPersistSessions();
      return next;
    });
  }, [debouncedPersistSessions]);

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
      persistSessions(next);
      return next;
    });
  }, [persistSessions]);

  const cleanupOrphanedSessions = useCallback((activeTargetIds: Set<string>) => {
    const removedSessionIds = sessionsRef.current
      .filter(s => s.scope.targetId && !activeTargetIds.has(s.scope.targetId))
      .map(s => s.id);
    cleanupAcpSessions(removedSessionIds);
    setSessionsRaw(prev => {
      const next = prev.filter(s => {
        // Keep sessions without a targetId (global scope)
        if (!s.scope.targetId) return true;
        // Keep sessions whose target still exists
        return activeTargetIds.has(s.scope.targetId);
      });
      if (next.length !== prev.length) {
        persistSessions(next);
      }
      return next;
    });
  }, [persistSessions]);

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
    addMessageToSession,
    updateLastMessage,
    updateMessageById,
    clearSessionMessages,
    cleanupOrphanedSessions,
  };
}
