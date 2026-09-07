import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  STORAGE_KEY_AI_RESPONSE_IDLE_TIMEOUT,
  STORAGE_KEY_AI_MAX_ITERATIONS,
  STORAGE_KEY_AI_SESSIONS,
  STORAGE_KEY_AI_ACTIVE_SESSION_MAP,
  STORAGE_KEY_AI_AGENT_MODEL_MAP,
  STORAGE_KEY_AI_AGENT_PROVIDER_MAP,
  STORAGE_KEY_AI_AGENT_THINKING_MAP,
  STORAGE_KEY_AI_WEB_SEARCH,
  STORAGE_KEY_AI_QUICK_MESSAGES,
} from '../../infrastructure/config/storageKeys';
import type { AIQuickMessage } from '../../infrastructure/ai/quickMessages';
import { sanitizeQuickMessages } from '../../infrastructure/ai/quickMessages';
import type {
  AIDraft,
  AISessionContextCompaction,
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
import {
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  DEFAULT_RESPONSE_IDLE_TIMEOUT_SECONDS,
  normalizeCommandTimeoutSeconds,
  normalizeResponseIdleTimeoutSeconds,
} from '../../infrastructure/ai/types';
import {
  activateDraftView,
  clearScopeDraftState,
  draftsByScopeEqualIgnoringAllComposerText,
  ensureDraftForScopeState,
  pruneStaleSessionPanelViews,
  setDraftView,
  setSessionView,
  updateDraftForScope,
} from './aiDraftState';
import { convertFilesToUploads } from './useFileUpload';
import { removeProviderReferences } from './aiProviderCleanup';
import { publishAISessionsSnapshot } from './aiSessionsStore';
import {
  AI_STATE_CHANGED_DRAFTS_BY_SCOPE,
  AI_STATE_CHANGED_PANEL_VIEW_BY_SCOPE,
  bumpDraftMutationVersion,
  bumpDraftUploadGeneration,
  cleanupDeletedAIChatSessions,
  cleanupOrphanedAISessions,
  getAIBridge,
  getDraftUploadGeneration,
  latestAIActiveSessionMapSnapshot,
  latestAIDraftsByScopeSnapshot,
  latestAIPanelViewByScopeSnapshot,
  latestAISessionsSnapshot,
  writeSessionsForStorage,
  setLatestAIActiveSessionMapSnapshot,
  setLatestAIDraftsByScopeSnapshot,
  setLatestAIPanelViewByScopeSnapshot,
  setLatestAISessionsSnapshot,
  type DraftsByScope,
  type PanelViewByScope,
} from './aiStateSnapshots';
import { AI_STATE_CHANGED_EVENT, emitAIStateChanged } from './aiStateEvents';
import {
  persistCommandBlocklistSetting,
  readCommandBlocklistSetting,
} from './commandBlocklistSettings';
import {
  handoffDissolvedWorkspaceAIScope,
  retargetWorkspaceActiveChatAfterMemberLoss,
  seedWorkspaceAIActiveSessionFromMembers,
} from '../../domain/workspaceAiScopeHandoff';

function providerPatchIsNoop(
  current: ProviderConfig,
  updates: Partial<ProviderConfig>,
): boolean {
  for (const key of Object.keys(updates) as Array<keyof ProviderConfig>) {
    const nextValue = updates[key];
    const prevValue = current[key];
    if (nextValue === prevValue) continue;
    if (key === 'modelContextWindows') {
      const prevWindows = (prevValue ?? {}) as Record<string, number>;
      const nextWindows = (nextValue ?? {}) as Record<string, number>;
      const nextKeys = Object.keys(nextWindows);
      if (nextKeys.length !== Object.keys(prevWindows).length) return false;
      if (nextKeys.some((modelId) => prevWindows[modelId] !== nextWindows[modelId])) return false;
      continue;
    }
    return false;
  }
  return true;
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
    if (stored === 'observer' || stored === 'confirm' || stored === 'auto') return stored;
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
  const [commandBlocklist, setCommandBlocklistRaw] = useState<string[]>(readCommandBlocklistSetting);
  const [commandTimeout, setCommandTimeoutRaw] = useState<number>(() =>
    normalizeCommandTimeoutSeconds(
      localStorageAdapter.readNumber(STORAGE_KEY_AI_COMMAND_TIMEOUT) ?? DEFAULT_COMMAND_TIMEOUT_SECONDS,
    )
  );
  const [responseIdleTimeout, setResponseIdleTimeoutRaw] = useState<number>(() =>
    normalizeResponseIdleTimeoutSeconds(
      localStorageAdapter.readNumber(STORAGE_KEY_AI_RESPONSE_IDLE_TIMEOUT)
        ?? DEFAULT_RESPONSE_IDLE_TIMEOUT_SECONDS,
    )
  );
  const [maxIterations, setMaxIterationsRaw] = useState<number>(() =>
    localStorageAdapter.readNumber(STORAGE_KEY_AI_MAX_ITERATIONS) ?? 20
  );

  // ── Sessions ──
  const [sessions, setSessionsRaw] = useState<AISession[]>(() =>
    latestAISessionsSnapshot
      ?? localStorageAdapter.read<AISession[]>(STORAGE_KEY_AI_SESSIONS)
      ?? []
  );
  // Ref that always holds the latest sessions for use inside debounced callbacks
  const sessionsRef = useRef(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  // Per-scope active session: keyed by `${scopeType}:${scopeTargetId}`
  const [activeSessionIdMap, setActiveSessionIdMapRaw] = useState<Record<string, string | null>>(() =>
    latestAIActiveSessionMapSnapshot
      ?? localStorageAdapter.read<Record<string, string | null>>(STORAGE_KEY_AI_ACTIVE_SESSION_MAP)
      ?? {}
  );
  // Per-scope draft/view state is intentionally memory-only so a relaunch
  // does not restore stale composer input or panel intent against new history.
  const [draftsByScope, setDraftsByScopeRaw] = useState<DraftsByScope>(() =>
    latestAIDraftsByScopeSnapshot ?? {}
  );
  const [panelViewByScope, setPanelViewByScopeRaw] = useState<PanelViewByScope>(() =>
    latestAIPanelViewByScopeSnapshot ?? {}
  );

  // Per-agent model selection: remembers last selected model per agent
  const [agentModelMap, setAgentModelMapRaw] = useState<Record<string, string>>(() =>
    localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_AI_AGENT_MODEL_MAP) ?? {}
  );
  const agentModelMapRef = useRef(agentModelMap);
  useEffect(() => {
    agentModelMapRef.current = agentModelMap;
  }, [agentModelMap]);
  // Per-agent provider override: remembers which provider config each agent
  // should bind to. Falls back to the global `activeProviderId` when an agent
  // has no entry. Used so that e.g. Catty Agent can stay on DeepSeek while
  // a Claude/Codex run continues on its existing provider.
  const [agentProviderMap, setAgentProviderMapRaw] = useState<Record<string, string>>(() =>
    localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_AI_AGENT_PROVIDER_MAP) ?? {}
  );
  // Mirror for non-functional reads inside removeProvider — needed to know
  // which agents were bound to the deleted provider so we can also drop
  // their saved model ids (those ids belonged to the now-missing provider).
  const agentProviderMapRef = useRef(agentProviderMap);
  useEffect(() => {
    agentProviderMapRef.current = agentProviderMap;
  }, [agentProviderMap]);
  const [agentThinkingMap, setAgentThinkingMapRaw] = useState<Record<string, string>>(() =>
    localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_AI_AGENT_THINKING_MAP) ?? {}
  );

  // ── Web Search Config ──
  const [webSearchConfig, setWebSearchConfigRaw] = useState<WebSearchConfig | null>(() =>
    localStorageAdapter.read<WebSearchConfig>(STORAGE_KEY_AI_WEB_SEARCH) ?? null
  );

  // ── Quick Messages (slash prompts) ──
  const [quickMessages, setQuickMessagesRaw] = useState<AIQuickMessage[]>(() =>
    sanitizeQuickMessages(localStorageAdapter.read<unknown>(STORAGE_KEY_AI_QUICK_MESSAGES)),
  );

  useEffect(() => {
    setLatestAISessionsSnapshot(sessions);
  }, [sessions]);

  useEffect(() => {
    setLatestAIActiveSessionMapSnapshot(activeSessionIdMap);
  }, [activeSessionIdMap]);

  useEffect(() => {
    setLatestAIDraftsByScopeSnapshot(draftsByScope);
  }, [draftsByScope]);

  useEffect(() => {
    setLatestAIPanelViewByScopeSnapshot(panelViewByScope);
  }, [panelViewByScope]);

  useEffect(() => {
    const validSessionIds = new Set<string>(sessions.map((session) => session.id));
    let changed = false;
    const nextActiveSessionIdMap: Record<string, string | null> = {};

    for (const [scopeKey, sessionId] of Object.entries(activeSessionIdMap) as Array<[string, string | null]>) {
      const nextSessionId = sessionId && validSessionIds.has(sessionId) ? sessionId : null;
      nextActiveSessionIdMap[scopeKey] = nextSessionId;
      if (nextSessionId !== sessionId) {
        changed = true;
      }
    }

    if (changed) {
      setLatestAIActiveSessionMapSnapshot(nextActiveSessionIdMap);
      localStorageAdapter.write(STORAGE_KEY_AI_ACTIVE_SESSION_MAP, nextActiveSessionIdMap);
      setActiveSessionIdMapRaw(nextActiveSessionIdMap);
      emitAIStateChanged(STORAGE_KEY_AI_ACTIVE_SESSION_MAP);
    }

    setPanelViewByScopeRaw((prev) => {
      const next = pruneStaleSessionPanelViews(prev, validSessionIds);
      if (next === prev) {
        return prev;
      }
      setLatestAIPanelViewByScopeSnapshot(next);
      emitAIStateChanged(AI_STATE_CHANGED_PANEL_VIEW_BY_SCOPE);
      return next;
    });
  }, [sessions, activeSessionIdMap]);

  const setActiveSessionId = useCallback((scopeKey: string, id: string | null) => {
    let nextActiveSessionIdMap: Record<string, string | null> | null = null;

    setActiveSessionIdMapRaw(prev => {
      if (prev[scopeKey] === id) {
        return prev;
      }

      const next = { ...prev, [scopeKey]: id };
      nextActiveSessionIdMap = next;
      return next;
    });

    if (!nextActiveSessionIdMap) return;

    setLatestAIActiveSessionMapSnapshot(nextActiveSessionIdMap);
    localStorageAdapter.write(STORAGE_KEY_AI_ACTIVE_SESSION_MAP, nextActiveSessionIdMap);
    emitAIStateChanged(STORAGE_KEY_AI_ACTIVE_SESSION_MAP);
  }, []);

  const setPanelViewByScope = useCallback((value: PanelViewByScope | ((prev: PanelViewByScope) => PanelViewByScope)) => {
    let nextPanelViewByScope: PanelViewByScope | null = null;

    setPanelViewByScopeRaw((prev) => {
      const next = typeof value === 'function' ? value(prev) : value;
      if (next === prev) return prev;
      nextPanelViewByScope = next;
      return next;
    });

    if (!nextPanelViewByScope) return;

    setLatestAIPanelViewByScopeSnapshot(nextPanelViewByScope);
    emitAIStateChanged(AI_STATE_CHANGED_PANEL_VIEW_BY_SCOPE);
  }, []);

  const setAgentModel = useCallback((agentId: string, modelId: string) => {
    setAgentModelMapRaw(prev => {
      if (prev[agentId] === modelId) return prev;
      const next = { ...prev, [agentId]: modelId };
      localStorageAdapter.write(STORAGE_KEY_AI_AGENT_MODEL_MAP, next);
      return next;
    });
  }, []);

  const setAgentProvider = useCallback((agentId: string, providerId: string) => {
    setAgentProviderMapRaw(prev => {
      // Empty string clears the per-agent override and lets the agent fall
      // back to the global `activeProviderId`.
      if (providerId) {
        if (prev[agentId] === providerId) return prev;
        const next = { ...prev, [agentId]: providerId };
        localStorageAdapter.write(STORAGE_KEY_AI_AGENT_PROVIDER_MAP, next);
        return next;
      }
      if (!(agentId in prev)) return prev;
      const next = { ...prev };
      delete next[agentId];
      localStorageAdapter.write(STORAGE_KEY_AI_AGENT_PROVIDER_MAP, next);
      return next;
    });
  }, []);

  const setAgentThinking = useCallback((agentId: string, thinkingLevel: string) => {
    setAgentThinkingMapRaw((prev) => {
      if (thinkingLevel) {
        if (prev[agentId] === thinkingLevel) return prev;
        const next = { ...prev, [agentId]: thinkingLevel };
        localStorageAdapter.write(STORAGE_KEY_AI_AGENT_THINKING_MAP, next);
        return next;
      }
      if (!(agentId in prev)) return prev;
      const next = { ...prev };
      delete next[agentId];
      localStorageAdapter.write(STORAGE_KEY_AI_AGENT_THINKING_MAP, next);
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

  const setQuickMessages = useCallback((value: AIQuickMessage[] | ((prev: AIQuickMessage[]) => AIQuickMessage[])) => {
    setQuickMessagesRaw((prev) => {
      const nextRaw = typeof value === 'function' ? value(prev) : value;
      const next = sanitizeQuickMessages(nextRaw);
      localStorageAdapter.write(STORAGE_KEY_AI_QUICK_MESSAGES, next);
      emitAIStateChanged(STORAGE_KEY_AI_QUICK_MESSAGES);
      return next;
    });
  }, []);

  // ── Persist helpers ──
  const setProviders = useCallback((value: ProviderConfig[] | ((prev: ProviderConfig[]) => ProviderConfig[])) => {
    setProvidersRaw(prev => {
      const next = typeof value === 'function' ? value(prev) : value;
      if (next === prev) return prev;
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
    persistCommandBlocklistSetting(value);
    // Sync to MCP Server bridge so SDK agents also respect the blocklist
    const bridge = getAIBridge();
    bridge?.aiMcpSetCommandBlocklist?.(value);
  }, []);

  const setCommandTimeout = useCallback((value: number) => {
    const normalizedValue = normalizeCommandTimeoutSeconds(value);
    setCommandTimeoutRaw(normalizedValue);
    localStorageAdapter.writeNumber(STORAGE_KEY_AI_COMMAND_TIMEOUT, normalizedValue);
    // Sync to MCP Server bridge
    const bridge = getAIBridge();
    bridge?.aiMcpSetCommandTimeout?.(normalizedValue);
  }, []);

  const setResponseIdleTimeout = useCallback((value: number) => {
    const normalizedValue = normalizeResponseIdleTimeoutSeconds(value);
    setResponseIdleTimeoutRaw(normalizedValue);
    localStorageAdapter.writeNumber(STORAGE_KEY_AI_RESPONSE_IDLE_TIMEOUT, normalizedValue);
  }, []);

  const setMaxIterations = useCallback((value: number) => {
    setMaxIterationsRaw(value);
    localStorageAdapter.writeNumber(STORAGE_KEY_AI_MAX_ITERATIONS, value);
    // Sync to MCP Server bridge (used by SDK agent path)
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
            if (mode === 'observer' || mode === 'confirm' || mode === 'auto') {
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
            const blocklist = readCommandBlocklistSetting();
            setCommandBlocklistRaw(blocklist);
            getAIBridge()?.aiMcpSetCommandBlocklist?.(blocklist);
            break;
          }
          case STORAGE_KEY_AI_COMMAND_TIMEOUT: {
            const timeout = localStorageAdapter.readNumber(STORAGE_KEY_AI_COMMAND_TIMEOUT) ?? DEFAULT_COMMAND_TIMEOUT_SECONDS;
            if (!Number.isFinite(timeout)) {
              console.warn('[useAIState] Cross-window sync: AI_COMMAND_TIMEOUT is not a finite number, skipping');
              break;
            }
            const normalizedTimeout = normalizeCommandTimeoutSeconds(timeout);
            setCommandTimeoutRaw(normalizedTimeout);
            getAIBridge()?.aiMcpSetCommandTimeout?.(normalizedTimeout);
            break;
          }
          case STORAGE_KEY_AI_RESPONSE_IDLE_TIMEOUT: {
            const timeout = localStorageAdapter.readNumber(STORAGE_KEY_AI_RESPONSE_IDLE_TIMEOUT)
              ?? DEFAULT_RESPONSE_IDLE_TIMEOUT_SECONDS;
            if (!Number.isFinite(timeout)) {
              console.warn('[useAIState] Cross-window sync: AI_RESPONSE_IDLE_TIMEOUT is not a finite number, skipping');
              break;
            }
            setResponseIdleTimeoutRaw(normalizeResponseIdleTimeoutSeconds(timeout));
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
          case STORAGE_KEY_AI_AGENT_PROVIDER_MAP:
            setAgentProviderMapRaw(localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_AI_AGENT_PROVIDER_MAP) ?? {});
            break;
          case STORAGE_KEY_AI_AGENT_THINKING_MAP:
            setAgentThinkingMapRaw(localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_AI_AGENT_THINKING_MAP) ?? {});
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
          case STORAGE_KEY_AI_QUICK_MESSAGES: {
            const messages = localStorageAdapter.read<unknown>(STORAGE_KEY_AI_QUICK_MESSAGES);
            setQuickMessagesRaw(sanitizeQuickMessages(messages));
            break;
          }
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
        case AI_STATE_CHANGED_DRAFTS_BY_SCOPE:
          setDraftsByScopeRaw(latestAIDraftsByScopeSnapshot ?? {});
          return;
        case AI_STATE_CHANGED_PANEL_VIEW_BY_SCOPE:
          setPanelViewByScopeRaw(latestAIPanelViewByScopeSnapshot ?? {});
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
    const initialBlocklist = readCommandBlocklistSetting();
    bridge?.aiMcpSetCommandBlocklist?.(initialBlocklist);
    const initialTimeout = normalizeCommandTimeoutSeconds(
      localStorageAdapter.readNumber(STORAGE_KEY_AI_COMMAND_TIMEOUT) ?? DEFAULT_COMMAND_TIMEOUT_SECONDS,
    );
    bridge?.aiMcpSetCommandTimeout?.(initialTimeout);
    const initialMaxIter = localStorageAdapter.readNumber(STORAGE_KEY_AI_MAX_ITERATIONS) ?? 20;
    bridge?.aiMcpSetMaxIterations?.(initialMaxIter);
    const storedPermMode = localStorageAdapter.readString(STORAGE_KEY_AI_PERMISSION_MODE);
    const initialPermMode: AIPermissionMode =
      storedPermMode === 'observer' || storedPermMode === 'confirm' || storedPermMode === 'auto'
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
    writeSessionsForStorage(next);
  }, []);

  // Debounced version of persistSessions for high-frequency updates (e.g. streaming)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const debouncedPersistSessions = useCallback(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return; // Skip writes after unmount
      writeSessionsForStorage(sessionsRef.current);
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
    cleanupDeletedAIChatSessions([sessionId]);
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
      setPanelViewByScopeRaw((prev) => {
        const currentPanelView = prev[scopeKey];
        if (currentPanelView?.mode !== 'session' || currentPanelView.sessionId !== sessionId) {
          return prev;
        }
        const next = setDraftView(prev, scopeKey);
        if (next === prev) {
          return prev;
        }
        setLatestAIPanelViewByScopeSnapshot(next);
        emitAIStateChanged(AI_STATE_CHANGED_PANEL_VIEW_BY_SCOPE);
        return next;
      });
    }
  }, [persistSessions]);

  const deleteSessionsByTarget = useCallback((scopeType: 'terminal' | 'workspace', targetId: string) => {
    const removedSessionIds = sessionsRef.current
      .filter(s => s.scope.type === scopeType && s.scope.targetId === targetId)
      .map(s => s.id);
    cleanupDeletedAIChatSessions(removedSessionIds);
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

  const persistContextCompaction = useCallback((
    sessionId: string,
    contextCompaction: AISessionContextCompaction,
  ) => {
    setSessionsRaw(prev => {
      const next = prev.map(s => s.id === sessionId
        ? { ...s, contextCompaction, updatedAt: Date.now() }
        : s);
      setLatestAISessionsSnapshot(next);
      persistSessions(next);
      return next;
    });
  }, [persistSessions]);

  const ensureDraftForScope = useCallback((scopeKey: string, agentId: string): void => {
    let nextDraftsByScope: DraftsByScope | null = null;
    let textOnly = false;

    setDraftsByScopeRaw((prev) => {
      const next = ensureDraftForScopeState(prev, scopeKey, agentId);
      if (next === prev) return prev;
      nextDraftsByScope = next;
      textOnly = draftsByScopeEqualIgnoringAllComposerText(prev, next);
      return next;
    });

    if (!nextDraftsByScope) return;

    setLatestAIDraftsByScopeSnapshot(nextDraftsByScope);
    if (textOnly) return;
    bumpDraftMutationVersion(scopeKey);
    emitAIStateChanged(AI_STATE_CHANGED_DRAFTS_BY_SCOPE);
  }, []);

  const updateDraft = useCallback((
    scopeKey: string,
    fallbackAgentId: string,
    updater: (draft: AIDraft) => AIDraft,
  ): void => {
    let nextDraftsByScope: DraftsByScope | null = null;
    let textOnly = false;

    setDraftsByScopeRaw((prev) => {
      const next = updateDraftForScope(
        prev,
        scopeKey,
        fallbackAgentId,
        (draft) => {
          const updated = updater(draft);
          if (updated === draft) return draft;
          return {
            ...updated,
            updatedAt: Date.now(),
          };
        },
      );
      if (next === prev) return prev;
      nextDraftsByScope = next;
      textOnly = draftsByScopeEqualIgnoringAllComposerText(prev, next);
      return next;
    });

    if (!nextDraftsByScope) return;
    setLatestAIDraftsByScopeSnapshot(nextDraftsByScope);
    if (textOnly) return;
    bumpDraftMutationVersion(scopeKey);
    emitAIStateChanged(AI_STATE_CHANGED_DRAFTS_BY_SCOPE);
  }, []);

  const updateDraftIfPresent = useCallback((
    scopeKey: string,
    updater: (draft: AIDraft) => AIDraft,
  ): void => {
    let nextDraftsByScope: DraftsByScope | null = null;
    let textOnly = false;

    setDraftsByScopeRaw((prev) => {
      const currentDraft = prev[scopeKey];
      if (!currentDraft) return prev;

      const updated = updater(currentDraft);
      const nextDraft = updated === currentDraft
        ? currentDraft
        : {
          ...updated,
          updatedAt: Date.now(),
        };
      if (nextDraft === currentDraft) return prev;
      const next = {
        ...prev,
        [scopeKey]: nextDraft,
      };
      nextDraftsByScope = next;
      textOnly = draftsByScopeEqualIgnoringAllComposerText(prev, next);
      return next;
    });

    if (!nextDraftsByScope) return;
    setLatestAIDraftsByScopeSnapshot(nextDraftsByScope);
    if (textOnly) return;
    bumpDraftMutationVersion(scopeKey);
    emitAIStateChanged(AI_STATE_CHANGED_DRAFTS_BY_SCOPE);
  }, []);

  const showDraftView = useCallback((scopeKey: string) => {
    const currentActiveSessionIdMap = latestAIActiveSessionMapSnapshot
      ?? localStorageAdapter.read<Record<string, string | null>>(STORAGE_KEY_AI_ACTIVE_SESSION_MAP)
      ?? {};
    const next = activateDraftView(
      currentActiveSessionIdMap,
      panelViewByScope,
      scopeKey,
    );

    if (next.activeSessionIdMap !== currentActiveSessionIdMap) {
      setLatestAIActiveSessionMapSnapshot(next.activeSessionIdMap);
      localStorageAdapter.write(STORAGE_KEY_AI_ACTIVE_SESSION_MAP, next.activeSessionIdMap);
      setActiveSessionIdMapRaw(next.activeSessionIdMap);
      emitAIStateChanged(STORAGE_KEY_AI_ACTIVE_SESSION_MAP);
    }

    if (next.panelViewByScope !== panelViewByScope) {
      setLatestAIPanelViewByScopeSnapshot(next.panelViewByScope);
      setPanelViewByScopeRaw(next.panelViewByScope);
      emitAIStateChanged(AI_STATE_CHANGED_PANEL_VIEW_BY_SCOPE);
    }
  }, [panelViewByScope]);

  const showSessionView = useCallback((scopeKey: string, sessionId: string) => {
    setPanelViewByScope((prev) => setSessionView(prev, scopeKey, sessionId));
  }, [setPanelViewByScope]);

  const clearDraftForScope = useCallback((scopeKey: string) => {
    const currentPanelViewByScope = panelViewByScope;
    let nextDraftsByScope: DraftsByScope | null = null;
    let nextPanelViewByScope: PanelViewByScope | null = null;
    let draftsChanged = false;
    let panelViewChanged = false;

    setDraftsByScopeRaw((prevDraftsByScope) => {
      const next = clearScopeDraftState(
        prevDraftsByScope,
        currentPanelViewByScope,
        scopeKey,
      );
      draftsChanged = next.draftsByScope !== prevDraftsByScope;
      panelViewChanged = next.panelViewByScope !== currentPanelViewByScope;
      nextDraftsByScope = next.draftsByScope;
      nextPanelViewByScope = next.panelViewByScope;
      return draftsChanged ? next.draftsByScope : prevDraftsByScope;
    });

    if (!draftsChanged && !panelViewChanged) return;

    bumpDraftMutationVersion(scopeKey);
    bumpDraftUploadGeneration(scopeKey);

    if (draftsChanged && nextDraftsByScope) {
      setLatestAIDraftsByScopeSnapshot(nextDraftsByScope);
      emitAIStateChanged(AI_STATE_CHANGED_DRAFTS_BY_SCOPE);
    }

    if (panelViewChanged && nextPanelViewByScope) {
      setLatestAIPanelViewByScopeSnapshot(nextPanelViewByScope);
      setPanelViewByScopeRaw(nextPanelViewByScope);
      emitAIStateChanged(AI_STATE_CHANGED_PANEL_VIEW_BY_SCOPE);
    }
  }, [panelViewByScope]);

  const addDraftFiles = useCallback(async (
    scopeKey: string,
    fallbackAgentId: string,
    inputFiles: File[],
  ) => {
    ensureDraftForScope(scopeKey, fallbackAgentId);
    const initialUploadGeneration = getDraftUploadGeneration(scopeKey);
    const uploads = await convertFilesToUploads(inputFiles);
    if (uploads.length === 0) return;

    if (getDraftUploadGeneration(scopeKey) !== initialUploadGeneration) {
      return;
    }

    updateDraftIfPresent(scopeKey, (draft) => ({
      ...draft,
      attachments: [...draft.attachments, ...uploads],
    }));
  }, [ensureDraftForScope, updateDraftIfPresent]);

  const removeDraftFile = useCallback((scopeKey: string, fallbackAgentId: string, fileId: string) => {
    updateDraft(scopeKey, fallbackAgentId, (draft) => ({
      ...draft,
      attachments: draft.attachments.filter((file) => file.id !== fileId),
    }));
  }, [updateDraft]);

  const cleanupOrphanedSessions = useCallback((activeTargetIds: Set<string>) => {
    cleanupOrphanedAISessions(activeTargetIds);

    const nextSessions =
      latestAISessionsSnapshot
      ?? localStorageAdapter.read<AISession[]>(STORAGE_KEY_AI_SESSIONS)
      ?? [];
    sessionsRef.current = nextSessions;
    setSessionsRaw(nextSessions);
    setActiveSessionIdMapRaw(
      latestAIActiveSessionMapSnapshot
        ?? localStorageAdapter.read<Record<string, string | null>>(STORAGE_KEY_AI_ACTIVE_SESSION_MAP)
        ?? {},
    );
    setDraftsByScopeRaw(latestAIDraftsByScopeSnapshot ?? {});
    setPanelViewByScopeRaw(latestAIPanelViewByScopeSnapshot ?? {});
  }, []);

  const seedWorkspaceActiveSessionFromMembers = useCallback((input: {
    workspaceId: string;
    memberTerminalIds: readonly string[];
    preferredTerminalId?: string | null;
  }) => {
    const currentMap =
      latestAIActiveSessionMapSnapshot
      ?? localStorageAdapter.read<Record<string, string | null>>(STORAGE_KEY_AI_ACTIVE_SESSION_MAP)
      ?? {};
    const currentPanelViewByScope = latestAIPanelViewByScopeSnapshot ?? {};
    const seeded = seedWorkspaceAIActiveSessionFromMembers({
      activeSessionIdMap: currentMap,
      panelViewByScope: currentPanelViewByScope,
      workspaceId: input.workspaceId,
      memberTerminalIds: input.memberTerminalIds,
      preferredTerminalId: input.preferredTerminalId,
    });
    if (!seeded) return;
    setLatestAIActiveSessionMapSnapshot(seeded.activeSessionIdMap);
    localStorageAdapter.write(STORAGE_KEY_AI_ACTIVE_SESSION_MAP, seeded.activeSessionIdMap);
    emitAIStateChanged(STORAGE_KEY_AI_ACTIVE_SESSION_MAP);
    setActiveSessionIdMapRaw(seeded.activeSessionIdMap);
    if (seeded.panelViewChanged) {
      setLatestAIPanelViewByScopeSnapshot(seeded.panelViewByScope);
      emitAIStateChanged(AI_STATE_CHANGED_PANEL_VIEW_BY_SCOPE);
      setPanelViewByScopeRaw(seeded.panelViewByScope);
    }
  }, []);

  const handoffDissolvedWorkspaceScope = useCallback((input: {
    workspaceId: string;
    terminalIds: readonly string[];
    preferredTerminalId?: string | null;
  }) => {
    const currentMap =
      latestAIActiveSessionMapSnapshot
      ?? localStorageAdapter.read<Record<string, string | null>>(STORAGE_KEY_AI_ACTIVE_SESSION_MAP)
      ?? {};
    const currentSessions =
      latestAISessionsSnapshot
      ?? localStorageAdapter.read<AISession[]>(STORAGE_KEY_AI_SESSIONS)
      ?? [];
    const currentPanelViewByScope = latestAIPanelViewByScopeSnapshot ?? {};
    const result = handoffDissolvedWorkspaceAIScope({
      activeSessionIdMap: currentMap,
      sessions: currentSessions,
      workspaceId: input.workspaceId,
      terminalIds: input.terminalIds,
      preferredTerminalId: input.preferredTerminalId,
      panelViewByScope: currentPanelViewByScope,
    });
    if (!result.changed) return;

    if (result.activeSessionIdMap !== currentMap) {
      setLatestAIActiveSessionMapSnapshot(result.activeSessionIdMap);
      localStorageAdapter.write(STORAGE_KEY_AI_ACTIVE_SESSION_MAP, result.activeSessionIdMap);
      emitAIStateChanged(STORAGE_KEY_AI_ACTIVE_SESSION_MAP);
      setActiveSessionIdMapRaw(result.activeSessionIdMap);
    }

    if (result.sessions !== currentSessions) {
      sessionsRef.current = result.sessions;
      setLatestAISessionsSnapshot(result.sessions);
      persistSessions(result.sessions);
      setSessionsRaw(result.sessions);
    }

    if (result.panelViewByScope !== currentPanelViewByScope) {
      setLatestAIPanelViewByScopeSnapshot(result.panelViewByScope);
      emitAIStateChanged(AI_STATE_CHANGED_PANEL_VIEW_BY_SCOPE);
      setPanelViewByScopeRaw(result.panelViewByScope);
    }
  }, [persistSessions]);

  const retargetWorkspaceActiveChatForMemberLoss = useCallback((input: {
    workspaceId: string;
    previousMemberTerminalIds: readonly string[];
    currentMemberTerminalIds: readonly string[];
    preferredTerminalId?: string | null;
  }) => {
    const currentMap =
      latestAIActiveSessionMapSnapshot
      ?? localStorageAdapter.read<Record<string, string | null>>(STORAGE_KEY_AI_ACTIVE_SESSION_MAP)
      ?? {};
    const currentSessions =
      latestAISessionsSnapshot
      ?? localStorageAdapter.read<AISession[]>(STORAGE_KEY_AI_SESSIONS)
      ?? [];
    const result = retargetWorkspaceActiveChatAfterMemberLoss({
      activeSessionIdMap: currentMap,
      sessions: currentSessions,
      workspaceId: input.workspaceId,
      previousMemberTerminalIds: input.previousMemberTerminalIds,
      currentMemberTerminalIds: input.currentMemberTerminalIds,
      preferredTerminalId: input.preferredTerminalId,
    });
    if (!result.changed) return;

    if (result.activeSessionIdMap !== currentMap) {
      setLatestAIActiveSessionMapSnapshot(result.activeSessionIdMap);
      localStorageAdapter.write(STORAGE_KEY_AI_ACTIVE_SESSION_MAP, result.activeSessionIdMap);
      emitAIStateChanged(STORAGE_KEY_AI_ACTIVE_SESSION_MAP);
      setActiveSessionIdMapRaw(result.activeSessionIdMap);
    }

    if (result.sessions !== currentSessions) {
      sessionsRef.current = result.sessions;
      setLatestAISessionsSnapshot(result.sessions);
      persistSessions(result.sessions);
      setSessionsRaw(result.sessions);
    }
  }, [persistSessions]);

  // ── Provider CRUD helpers ──
  const addProvider = useCallback((provider: ProviderConfig) => {
    setProviders(prev => [...prev, provider]);
  }, [setProviders]);

  const updateProvider = useCallback((id: string, updates: Partial<ProviderConfig>) => {
    setProviders((prev) => {
      const index = prev.findIndex((provider) => provider.id === id);
      if (index < 0) return prev;
      const current = prev[index];
      if (providerPatchIsNoop(current, updates)) return prev;
      const next = prev.slice();
      next[index] = { ...current, ...updates };
      return next;
    });
  }, [setProviders]);

  const removeProvider = useCallback((id: string) => {
    setProviders(prev => prev.filter(p => p.id !== id));
    setActiveProviderIdRaw(prevId => {
      if (prevId === id) {
        const next = '';
        localStorageAdapter.writeString(STORAGE_KEY_AI_ACTIVE_PROVIDER, next);
        return next;
      }
      return prevId;
    });
    const cleanup = removeProviderReferences(
      id,
      agentProviderMapRef.current,
      agentModelMapRef.current,
    );
    if (cleanup.providerMapChanged) {
      localStorageAdapter.write(STORAGE_KEY_AI_AGENT_PROVIDER_MAP, cleanup.agentProviderMap);
      setAgentProviderMapRaw(cleanup.agentProviderMap);
    }
    if (cleanup.modelMapChanged) {
      localStorageAdapter.write(STORAGE_KEY_AI_AGENT_MODEL_MAP, cleanup.agentModelMap);
      setAgentModelMapRaw(cleanup.agentModelMap);
    }
  }, [setProviders]);

  // ── Computed ──
  const activeProvider = providers.find(p => p.id === activeProviderId) ?? null;

  // Stream/message updates publish here so AIConfig Context consumers do not
  // re-render on every token. AIChatPanelsHost reads aiSessionsStore instead.
  useLayoutEffect(() => {
    publishAISessionsSnapshot({
      sessions,
      activeSessionIdMap,
      draftsByScope,
      panelViewByScope,
    });
  }, [sessions, activeSessionIdMap, draftsByScope, panelViewByScope]);

  return useMemo(() => ({
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
    globalPermissionMode,
    setGlobalPermissionMode,
    toolIntegrationMode,
    setToolIntegrationMode,
    hostPermissions,
    setHostPermissions,
    externalAgents,
    setExternalAgents,
    defaultAgentId,
    setDefaultAgentId,
    commandBlocklist,
    setCommandBlocklist,
    commandTimeout,
    setCommandTimeout,
    responseIdleTimeout,
    setResponseIdleTimeout,
    maxIterations,
    setMaxIterations,
    agentModelMap,
    setAgentModel,
    agentProviderMap,
    setAgentProvider,
    agentThinkingMap,
    setAgentThinking,
    webSearchConfig,
    setWebSearchConfig,
    quickMessages,
    setQuickMessages,
    // sessions / activeSessionIdMap / draftsByScope / panelViewByScope live in
    // aiSessionsStore so streaming updates do not rebuild this config object.
    setActiveSessionId,
    ensureDraftForScope,
    updateDraft,
    showDraftView,
    showSessionView,
    clearDraftForScope,
    addDraftFiles,
    removeDraftFile,
    createSession,
    deleteSession,
    deleteSessionsByTarget,
    updateSessionTitle,
    updateSessionExternalSessionId,
    addMessageToSession,
    updateLastMessage,
    updateMessageById,
    persistContextCompaction,
    cleanupOrphanedSessions,
    seedWorkspaceActiveSessionFromMembers,
    handoffDissolvedWorkspaceScope,
    retargetWorkspaceActiveChatForMemberLoss,
  }), [
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
    globalPermissionMode,
    setGlobalPermissionMode,
    toolIntegrationMode,
    setToolIntegrationMode,
    hostPermissions,
    setHostPermissions,
    externalAgents,
    setExternalAgents,
    defaultAgentId,
    setDefaultAgentId,
    commandBlocklist,
    setCommandBlocklist,
    commandTimeout,
    setCommandTimeout,
    responseIdleTimeout,
    setResponseIdleTimeout,
    maxIterations,
    setMaxIterations,
    agentModelMap,
    setAgentModel,
    agentProviderMap,
    setAgentProvider,
    agentThinkingMap,
    setAgentThinking,
    webSearchConfig,
    setWebSearchConfig,
    quickMessages,
    setQuickMessages,
    setActiveSessionId,
    ensureDraftForScope,
    updateDraft,
    showDraftView,
    showSessionView,
    clearDraftForScope,
    addDraftFiles,
    removeDraftFile,
    createSession,
    deleteSession,
    deleteSessionsByTarget,
    updateSessionTitle,
    updateSessionExternalSessionId,
    addMessageToSession,
    updateLastMessage,
    updateMessageById,
    persistContextCompaction,
    cleanupOrphanedSessions,
    seedWorkspaceActiveSessionFromMembers,
    handoffDissolvedWorkspaceScope,
    retargetWorkspaceActiveChatForMemberLoss,
  ]);
}
