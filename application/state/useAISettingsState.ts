import { useCallback, useEffect, useMemo, useState } from 'react';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import {
  STORAGE_KEY_AI_PROVIDERS,
  STORAGE_KEY_AI_ACTIVE_PROVIDER,
  STORAGE_KEY_AI_ACTIVE_MODEL,
  STORAGE_KEY_AI_PERMISSION_MODE,
  STORAGE_KEY_AI_TOOL_INTEGRATION_MODE,
  STORAGE_KEY_AI_EXTERNAL_AGENTS,
  STORAGE_KEY_AI_DEFAULT_AGENT,
  STORAGE_KEY_AI_COMMAND_BLOCKLIST,
  STORAGE_KEY_AI_COMMAND_TIMEOUT,
  STORAGE_KEY_AI_MAX_ITERATIONS,
  STORAGE_KEY_AI_AGENT_MODEL_MAP,
  STORAGE_KEY_AI_AGENT_PROVIDER_MAP,
  STORAGE_KEY_AI_WEB_SEARCH,
  STORAGE_KEY_AI_QUICK_MESSAGES,
  STORAGE_KEY_AI_SHOW_TERMINAL_SELECTION_ACTION,
} from '../../infrastructure/config/storageKeys';
import type { AIQuickMessage } from '../../infrastructure/ai/quickMessages';
import { sanitizeQuickMessages } from '../../infrastructure/ai/quickMessages';
import type {
  AIPermissionMode,
  AIToolIntegrationMode,
  ExternalAgentConfig,
  ProviderConfig,
  WebSearchConfig,
} from '../../infrastructure/ai/types';
import {
  DEFAULT_COMMAND_BLOCKLIST,
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  normalizeCommandTimeoutSeconds,
} from '../../infrastructure/ai/types';
import { removeProviderReferences } from './aiProviderCleanup';
import { AI_STATE_CHANGED_EVENT, emitAIStateChanged } from './aiStateEvents';
import { getAIBridge } from './aiStateSnapshots';
import { useStoredBoolean } from './useStoredBoolean';

function readPermissionMode(): AIPermissionMode {
  const stored = localStorageAdapter.readString(STORAGE_KEY_AI_PERMISSION_MODE);
  if (stored === 'observer' || stored === 'confirm' || stored === 'auto') return stored;
  return 'confirm';
}

function readToolIntegrationMode(): AIToolIntegrationMode {
  return localStorageAdapter.readString(STORAGE_KEY_AI_TOOL_INTEGRATION_MODE) === 'skills'
    ? 'skills'
    : 'mcp';
}

export function useAISettingsState() {
  const [providers, setProvidersRaw] = useState<ProviderConfig[]>(() =>
    localStorageAdapter.read<ProviderConfig[]>(STORAGE_KEY_AI_PROVIDERS) ?? []
  );
  const [activeProviderId, setActiveProviderIdRaw] = useState<string>(() =>
    localStorageAdapter.readString(STORAGE_KEY_AI_ACTIVE_PROVIDER) ?? ''
  );
  const [activeModelId, setActiveModelIdRaw] = useState<string>(() =>
    localStorageAdapter.readString(STORAGE_KEY_AI_ACTIVE_MODEL) ?? ''
  );
  const [globalPermissionMode, setGlobalPermissionModeRaw] = useState<AIPermissionMode>(readPermissionMode);
  const [toolIntegrationMode, setToolIntegrationModeRaw] = useState<AIToolIntegrationMode>(readToolIntegrationMode);
  const [externalAgents, setExternalAgentsRaw] = useState<ExternalAgentConfig[]>(() =>
    localStorageAdapter.read<ExternalAgentConfig[]>(STORAGE_KEY_AI_EXTERNAL_AGENTS) ?? []
  );
  const [defaultAgentId, setDefaultAgentIdRaw] = useState<string>(() =>
    localStorageAdapter.readString(STORAGE_KEY_AI_DEFAULT_AGENT) ?? 'catty'
  );
  const [commandBlocklist, setCommandBlocklistRaw] = useState<string[]>(() =>
    localStorageAdapter.read<string[]>(STORAGE_KEY_AI_COMMAND_BLOCKLIST) ?? [...DEFAULT_COMMAND_BLOCKLIST]
  );
  const [commandTimeout, setCommandTimeoutRaw] = useState<number>(() =>
    normalizeCommandTimeoutSeconds(
      localStorageAdapter.readNumber(STORAGE_KEY_AI_COMMAND_TIMEOUT) ?? DEFAULT_COMMAND_TIMEOUT_SECONDS,
    )
  );
  const [maxIterations, setMaxIterationsRaw] = useState<number>(() =>
    localStorageAdapter.readNumber(STORAGE_KEY_AI_MAX_ITERATIONS) ?? 20
  );
  const [webSearchConfig, setWebSearchConfigRaw] = useState<WebSearchConfig | null>(() =>
    localStorageAdapter.read<WebSearchConfig>(STORAGE_KEY_AI_WEB_SEARCH) ?? null
  );
  const [quickMessages, setQuickMessagesRaw] = useState<AIQuickMessage[]>(() =>
    sanitizeQuickMessages(localStorageAdapter.read<unknown>(STORAGE_KEY_AI_QUICK_MESSAGES)),
  );
  const [showTerminalSelectionAIAction, setShowTerminalSelectionAIAction] = useStoredBoolean(
    STORAGE_KEY_AI_SHOW_TERMINAL_SELECTION_ACTION,
    true,
  );

  const setProviders = useCallback((value: ProviderConfig[] | ((prev: ProviderConfig[]) => ProviderConfig[])) => {
    setProvidersRaw((prev) => {
      const next = typeof value === 'function' ? value(prev) : value;
      localStorageAdapter.write(STORAGE_KEY_AI_PROVIDERS, next);
      return next;
    });
  }, []);

  const addProvider = useCallback((provider: ProviderConfig) => {
    setProviders((prev) => [...prev, provider]);
  }, [setProviders]);

  const updateProvider = useCallback((id: string, updates: Partial<ProviderConfig>) => {
    setProviders((prev) => prev.map((provider) => (
      provider.id === id ? { ...provider, ...updates } : provider
    )));
  }, [setProviders]);

  const removeProvider = useCallback((id: string) => {
    setProviders((prev) => prev.filter((provider) => provider.id !== id));
    setActiveProviderIdRaw((prevId) => {
      if (prevId !== id) return prevId;
      localStorageAdapter.writeString(STORAGE_KEY_AI_ACTIVE_PROVIDER, '');
      return '';
    });

    const agentProviderMap =
      localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_AI_AGENT_PROVIDER_MAP) ?? {};
    const agentModelMap =
      localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_AI_AGENT_MODEL_MAP) ?? {};
    const cleanup = removeProviderReferences(id, agentProviderMap, agentModelMap);
    if (cleanup.providerMapChanged) {
      localStorageAdapter.write(STORAGE_KEY_AI_AGENT_PROVIDER_MAP, cleanup.agentProviderMap);
    }
    if (cleanup.modelMapChanged) {
      localStorageAdapter.write(STORAGE_KEY_AI_AGENT_MODEL_MAP, cleanup.agentModelMap);
    }
  }, [setProviders]);

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
    getAIBridge()?.aiMcpSetPermissionMode?.(mode);
  }, []);

  const setToolIntegrationMode = useCallback((mode: AIToolIntegrationMode) => {
    setToolIntegrationModeRaw(mode);
    localStorageAdapter.writeString(STORAGE_KEY_AI_TOOL_INTEGRATION_MODE, mode);
    getAIBridge()?.aiMcpSetToolIntegrationMode?.(mode);
  }, []);

  const setExternalAgents = useCallback((value: ExternalAgentConfig[] | ((prev: ExternalAgentConfig[]) => ExternalAgentConfig[])) => {
    setExternalAgentsRaw((prev) => {
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
    getAIBridge()?.aiMcpSetCommandBlocklist?.(value);
  }, []);

  const setCommandTimeout = useCallback((value: number) => {
    const normalizedValue = normalizeCommandTimeoutSeconds(value);
    setCommandTimeoutRaw(normalizedValue);
    localStorageAdapter.writeNumber(STORAGE_KEY_AI_COMMAND_TIMEOUT, normalizedValue);
    getAIBridge()?.aiMcpSetCommandTimeout?.(normalizedValue);
  }, []);

  const setMaxIterations = useCallback((value: number) => {
    setMaxIterationsRaw(value);
    localStorageAdapter.writeNumber(STORAGE_KEY_AI_MAX_ITERATIONS, value);
    getAIBridge()?.aiMcpSetMaxIterations?.(value);
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

  useEffect(() => {
    const syncFromStorageKey = (key: string | null) => {
      try {
        switch (key) {
          case STORAGE_KEY_AI_PROVIDERS: {
            const parsed = localStorageAdapter.read<ProviderConfig[]>(STORAGE_KEY_AI_PROVIDERS);
            if (parsed != null && !Array.isArray(parsed)) break;
            setProvidersRaw(parsed ?? []);
            break;
          }
          case STORAGE_KEY_AI_ACTIVE_PROVIDER:
            setActiveProviderIdRaw(localStorageAdapter.readString(STORAGE_KEY_AI_ACTIVE_PROVIDER) ?? '');
            break;
          case STORAGE_KEY_AI_ACTIVE_MODEL:
            setActiveModelIdRaw(localStorageAdapter.readString(STORAGE_KEY_AI_ACTIVE_MODEL) ?? '');
            break;
          case STORAGE_KEY_AI_PERMISSION_MODE:
            setGlobalPermissionModeRaw(readPermissionMode());
            getAIBridge()?.aiMcpSetPermissionMode?.(readPermissionMode());
            break;
          case STORAGE_KEY_AI_TOOL_INTEGRATION_MODE:
            setToolIntegrationModeRaw(readToolIntegrationMode());
            getAIBridge()?.aiMcpSetToolIntegrationMode?.(readToolIntegrationMode());
            break;
          case STORAGE_KEY_AI_EXTERNAL_AGENTS: {
            const agents = localStorageAdapter.read<ExternalAgentConfig[]>(STORAGE_KEY_AI_EXTERNAL_AGENTS);
            if (agents != null && !Array.isArray(agents)) break;
            setExternalAgentsRaw(agents ?? []);
            break;
          }
          case STORAGE_KEY_AI_DEFAULT_AGENT:
            setDefaultAgentIdRaw(localStorageAdapter.readString(STORAGE_KEY_AI_DEFAULT_AGENT) ?? 'catty');
            break;
          case STORAGE_KEY_AI_COMMAND_BLOCKLIST: {
            const list = localStorageAdapter.read<string[]>(STORAGE_KEY_AI_COMMAND_BLOCKLIST);
            if (list != null && !Array.isArray(list)) break;
            const blocklist = list ?? [...DEFAULT_COMMAND_BLOCKLIST];
            setCommandBlocklistRaw(blocklist);
            getAIBridge()?.aiMcpSetCommandBlocklist?.(blocklist);
            break;
          }
          case STORAGE_KEY_AI_COMMAND_TIMEOUT: {
            const timeout = localStorageAdapter.readNumber(STORAGE_KEY_AI_COMMAND_TIMEOUT) ?? DEFAULT_COMMAND_TIMEOUT_SECONDS;
            if (!Number.isFinite(timeout)) break;
            const normalizedTimeout = normalizeCommandTimeoutSeconds(timeout);
            setCommandTimeoutRaw(normalizedTimeout);
            getAIBridge()?.aiMcpSetCommandTimeout?.(normalizedTimeout);
            break;
          }
          case STORAGE_KEY_AI_MAX_ITERATIONS: {
            const iters = localStorageAdapter.readNumber(STORAGE_KEY_AI_MAX_ITERATIONS) ?? 20;
            if (!Number.isFinite(iters)) break;
            setMaxIterationsRaw(iters);
            getAIBridge()?.aiMcpSetMaxIterations?.(iters);
            break;
          }
          case STORAGE_KEY_AI_WEB_SEARCH:
            setWebSearchConfigRaw(localStorageAdapter.read<WebSearchConfig>(STORAGE_KEY_AI_WEB_SEARCH) ?? null);
            break;
          case STORAGE_KEY_AI_QUICK_MESSAGES:
            setQuickMessagesRaw(sanitizeQuickMessages(localStorageAdapter.read<unknown>(STORAGE_KEY_AI_QUICK_MESSAGES)));
            break;
        }
      } catch (err) {
        console.warn('[useAISettingsState] Failed to process AI settings storage change', key, err);
      }
    };

    const handleStorage = (event: StorageEvent) => syncFromStorageKey(event.key);
    const handleLocalStateChanged = (event: Event) => {
      syncFromStorageKey((event as CustomEvent<{ key?: string }>).detail?.key ?? null);
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(AI_STATE_CHANGED_EVENT, handleLocalStateChanged);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(AI_STATE_CHANGED_EVENT, handleLocalStateChanged);
    };
  }, []);

  useEffect(() => {
    const bridge = getAIBridge();
    bridge?.aiMcpSetCommandBlocklist?.(commandBlocklist);
    bridge?.aiMcpSetCommandTimeout?.(commandTimeout);
    bridge?.aiMcpSetMaxIterations?.(maxIterations);
    bridge?.aiMcpSetPermissionMode?.(globalPermissionMode);
    bridge?.aiMcpSetToolIntegrationMode?.(toolIntegrationMode);
  }, [commandBlocklist, commandTimeout, globalPermissionMode, maxIterations, toolIntegrationMode]);

  const activeProvider = providers.find((provider) => provider.id === activeProviderId) ?? null;

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
    externalAgents,
    setExternalAgents,
    defaultAgentId,
    setDefaultAgentId,
    commandBlocklist,
    setCommandBlocklist,
    commandTimeout,
    setCommandTimeout,
    maxIterations,
    setMaxIterations,
    webSearchConfig,
    setWebSearchConfig,
    quickMessages,
    setQuickMessages,
    showTerminalSelectionAIAction,
    setShowTerminalSelectionAIAction,
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
    externalAgents,
    setExternalAgents,
    defaultAgentId,
    setDefaultAgentId,
    commandBlocklist,
    setCommandBlocklist,
    commandTimeout,
    setCommandTimeout,
    maxIterations,
    setMaxIterations,
    webSearchConfig,
    setWebSearchConfig,
    quickMessages,
    setQuickMessages,
    showTerminalSelectionAIAction,
    setShowTerminalSelectionAIAction,
  ]);
}
