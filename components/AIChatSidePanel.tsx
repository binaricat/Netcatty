

import React, { useCallback, useEffect, useDeferredValue, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useI18n } from '../application/i18n/I18nProvider';
import { useWindowControls } from '../application/state/useWindowControls';
import type {
  AIDraft,
  AIPanelView,
  AgentModelPreset,
  AISessionScope,
  DiscoveredAgent,
  ExternalAgentConfig,
} from '../infrastructure/ai/types';
import type { ExecutorContext } from '../infrastructure/ai/cattyAgent/executor';
import { getAgentModelPresets } from '../infrastructure/ai/types';
import { getExternalAgentSdkBackend, getManualAgentCommand, matchesManagedAgentConfig } from '../infrastructure/ai/managedAgents';
import { useAgentDiscovery } from '../application/state/useAgentDiscovery';
import {
  getReadyUserSkillOptions,
  getNextSelectedUserSkillSlugsMap,
  type UserSkillOption,
} from './ai/userSkillsState';
import { subscribeUserSkillsStatusChanged } from './ai/userSkillsStatusEvents';
import {
  applyDraftEntrySelection,
  applyHistorySessionSelection,
  panelViewsEqual,
  resolveDisplayedPanelView,
  resolveDisplayedSession,
} from './ai/aiPanelViewState';
import {
  endDraftSend,
  tryBeginDraftSend,
} from './ai/draftSendGate';
import { selectDraftForAgentSwitch } from '../application/state/aiDraftState';
import {
  buildPromptWithTerminalSelectionAttachments,
  isTerminalSelectionAttachment,
} from '../application/state/terminalSelectionAttachment';
import type { CodexIntegrationStatus } from './settings/tabs/ai/types';
import {
  useAIChatStreaming,
  getNetcattyBridge,
  isAIChatSessionStreaming,
  type DefaultTargetSessionHint,
} from './ai/hooks/useAIChatStreaming';
import { getScopedHistorySessions } from './ai/scopedHistorySessions';
import { buildExternalAgentHistoryMessagesForBridge } from './ai/externalAgentHistory';
import { canSendWithAgent, findEnabledExternalAgent } from './ai/agentSendEligibility';
import { registerGrantPersister } from '../infrastructure/ai/shared/approvalGate';
import { stopAgentTurn } from '../infrastructure/ai/harness/agentStop';
import { getAgentRuntime } from '../infrastructure/ai/harness/globalAgentRuntime';
import { useAIPermissionGrantsState } from '../application/state/useAIPermissionGrantsState';
import { useConversationExport } from './ai/hooks/useConversationExport';
import type { AIChatSidePanelProps } from './AIChatSidePanel.types';
import {
  buildSdkRuntimeModelCacheKey,
  sdkRuntimeModelCache,
  generateId,
  normalizeSdkRuntimeModelPresets,
  shouldAdoptSdkCurrentModel,
  shouldLoadSdkRuntimeModels,
  shouldUseStoredAgentModel,
  type SdkRuntimeModelCatalog,
} from './AIChatSidePanelHelpers';
import { AIChatPanelContent } from './AIChatPanelContent';
import {
  getAIPanelProfilerProps,
  profileAIPanelCalculation,
} from './ai/aiPanelDiagnostics';

type UserSkillsStatusResult = { ok: boolean; skills?: Array<{
  id: string;
  slug: string;
  name: string;
  description: string;
  status: 'ready' | 'warning';
}> } | null;
type UserSkillsStatusLoadResult = UserSkillsStatusResult | undefined;
type SdkRuntimeModelTarget = {
  agentId: string;
  cacheKey: string;
  sdkBackend: string;
  agentEnv?: Record<string, string>;
  agentCommand?: string;
};

const USER_SKILLS_STATUS_CACHE_TTL_MS = 60_000;
let userSkillsStatusCache: {
  version: number;
  result: UserSkillsStatusResult;
  updatedAt: number;
} | null = null;
let userSkillsStatusPromise: {
  version: number;
  promise: Promise<UserSkillsStatusLoadResult>;
} | null = null;
let userSkillsStatusCacheVersion = 0;

function invalidateUserSkillsStatusCache() {
  userSkillsStatusCacheVersion += 1;
  userSkillsStatusCache = null;
  userSkillsStatusPromise = null;
}

if (typeof window !== 'undefined') {
  subscribeUserSkillsStatusChanged(invalidateUserSkillsStatusCache);
}

function loadUserSkillsStatus(
  bridge: ReturnType<typeof getNetcattyBridge>,
): Promise<UserSkillsStatusLoadResult> {
  const requestVersion = userSkillsStatusCacheVersion;
  if (!bridge?.aiUserSkillsGetStatus) {
    userSkillsStatusCache = { version: requestVersion, result: null, updatedAt: Date.now() };
    return Promise.resolve(null);
  }

  if (
    userSkillsStatusCache
    && userSkillsStatusCache.version === requestVersion
    && Date.now() - userSkillsStatusCache.updatedAt < USER_SKILLS_STATUS_CACHE_TTL_MS
  ) {
    return Promise.resolve(userSkillsStatusCache.result);
  }

  if (!userSkillsStatusPromise || userSkillsStatusPromise.version !== requestVersion) {
    const promise = bridge.aiUserSkillsGetStatus()
      .then((result) => {
        if (userSkillsStatusCacheVersion !== requestVersion) return undefined;
        userSkillsStatusCache = { version: requestVersion, result, updatedAt: Date.now() };
        return result;
      })
      .catch(() => {
        if (userSkillsStatusCacheVersion !== requestVersion) return undefined;
        userSkillsStatusCache = { version: requestVersion, result: null, updatedAt: Date.now() };
        return null;
      })
      .finally(() => {
        if (userSkillsStatusPromise?.version === requestVersion) {
          userSkillsStatusPromise = null;
        }
      });
    userSkillsStatusPromise = { version: requestVersion, promise };
  }

  return userSkillsStatusPromise.promise;
}

export function hasAIChatSidePanelRetainedContent(props: Pick<
  AIChatSidePanelProps,
  'activeSessionIdMap' | 'draftsByScope' | 'sessions' | 'scopeTargetId' | 'scopeType'
>): boolean {
  const scopeKey = `${props.scopeType}:${props.scopeTargetId ?? ''}`;
  const sessionId = props.activeSessionIdMap[scopeKey] ?? null;
  const activeSession = sessionId
    ? props.sessions.find((session) => session.id === sessionId)
    : null;
  if (activeSession && activeSession.messages.length > 0) {
    return true;
  }
  const draft = props.draftsByScope[scopeKey] ?? null;
  return Boolean(
    draft
    && (
      draft.text.trim().length > 0
      || draft.attachments.length > 0
      || draft.selectedUserSkillSlugs.length > 0
    ),
  );
}

export function shouldKeepAIChatSidePanelMounted(props: AIChatSidePanelProps): boolean {
  if (props.isVisible ?? true) {
    return true;
  }
  const scopeKey = `${props.scopeType}:${props.scopeTargetId ?? ''}`;
  const sessionId = props.activeSessionIdMap[scopeKey] ?? null;
  if (hasAIChatSidePanelRetainedContent(props)) {
    return true;
  }
  return isAIChatSessionStreaming(sessionId);
}

function shouldDelayAIChatSidePanelActivation(props: AIChatSidePanelProps): boolean {
  if (!(props.isVisible ?? true)) return false;
  const scopeKey = `${props.scopeType}:${props.scopeTargetId ?? ''}`;
  if (props.draftsByScope[scopeKey] || props.panelViewByScope[scopeKey]?.mode === 'draft') {
    return false;
  }
  const sessionId = props.activeSessionIdMap[scopeKey] ?? null;
  if (isAIChatSessionStreaming(sessionId)) return false;
  return !hasAIChatSidePanelRetainedContent(props);
}

function schedulePanelActivation(callback: () => void): () => void {
  let timeoutId: number | null = null;
  if (typeof requestAnimationFrame === 'function') {
    const rafId = requestAnimationFrame(() => {
      timeoutId = window.setTimeout(callback, 0);
    });
    return () => {
      cancelAnimationFrame(rafId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }

  timeoutId = window.setTimeout(callback, 0);
  return () => {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  };
}

const AIChatSidePanelPreparing = React.memo(function AIChatSidePanelPreparing() {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col bg-background" data-section="ai-chat-panel-preparing">
      <div className="shrink-0 border-b border-border/50 px-2.5 py-1.5">
        <div className="h-8 w-36 rounded-md bg-muted/45" />
      </div>
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" />
          {t('ai.chat.preparing')}
        </div>
      </div>
    </div>
  );
});

const AIChatSidePanelActive: React.FC<AIChatSidePanelProps> = ({
  sessions,
  activeSessionIdMap,
  draftsByScope,
  panelViewByScope,
  setActiveSessionId: setActiveSessionIdForScope,
  ensureDraftForScope,
  updateDraft,
  showDraftView,
  showSessionView,
  clearDraftForScope,
  addDraftFiles,
  removeDraftFile,
  createSession,
  deleteSession,
  updateSessionTitle,
  updateSessionExternalSessionId,
  addMessageToSession,
  updateLastMessage,
  updateMessageById,
  providers,
  activeProviderId,
  activeModelId,
  defaultAgentId,
  toolIntegrationMode,
  externalAgents,
  setExternalAgents,
  agentModelMap,
  setAgentModel,
  agentProviderMap,
  setAgentProvider,
  globalPermissionMode,
  setGlobalPermissionMode,
  commandBlocklist,
  commandTimeout,
  maxIterations = 20,
  webSearchConfig,
  quickMessages = [],
  scopeType,
  scopeTargetId,
  scopeHostIds,
  scopeLabel,
  terminalSessions = [],
  resolveExecutorContext,
  isVisible = true,
  notes = [],
  hosts = [],
  onOpenVaultNote,
  onOpenVaultHost,
  onOpenVaultSection,
}) => {
  const { t } = useI18n();
  const scopeKey = `${scopeType}:${scopeTargetId ?? ''}`;

  const [showHistory, setShowHistory] = useState(false);
  const [runtimeAgentModelPresets, setRuntimeAgentModelPresets] = useState<Record<string, AgentModelPreset[]>>({});
  const [userSkillOptions, setUserSkillOptions] = useState<UserSkillOption[]>([]);
  const [userSkillsStatusVersion, setUserSkillsStatusVersion] = useState(0);
  const { openSettingsWindow } = useWindowControls();
  const terminalSessionsRef = useRef(terminalSessions);
  terminalSessionsRef.current = terminalSessions;
  const resolveExecutorContextRef = useRef(resolveExecutorContext);
  resolveExecutorContextRef.current = resolveExecutorContext;

  const {
    streamingSessionIds,
    setStreamingForScope,
    abortControllersRef,
    sendToCattyAgent,
    sendToExternalAgent,
    reportStreamError,
    activeCompaction,
  } = useAIChatStreaming({
    maxIterations,
    addMessageToSession,
    updateLastMessage,
    updateMessageById,
  });

  const setActiveSessionId = useCallback((id: string | null) => {
    setActiveSessionIdForScope(scopeKey, id);
  }, [scopeKey, setActiveSessionIdForScope]);

  const activeTerminalSessionIds = useMemo(() => {
    const sessionIds = new Set<string>();
    const entries = Object.entries(activeSessionIdMap) as Array<[string, string | null]>;
    for (const [sessionScopeKey, sessionId] of entries) {
      if (!sessionScopeKey.startsWith('terminal:') || !sessionId) continue;
      if (sessionScopeKey === scopeKey) continue;
      sessionIds.add(sessionId);
    }
    return sessionIds;
  }, [activeSessionIdMap, scopeKey]);

  const deferredSessions = useDeferredValue(sessions);
  const historySessions = useMemo(
    () => profileAIPanelCalculation(
      'AIChatSidePanel.historySessions',
      () => getScopedHistorySessions(
        deferredSessions,
        scopeType,
        scopeTargetId,
        scopeHostIds,
        activeTerminalSessionIds,
      ),
    ),
    [deferredSessions, scopeType, scopeTargetId, scopeHostIds, activeTerminalSessionIds],
  );

  const explicitPanelView = panelViewByScope[scopeKey];
  const currentDraft = draftsByScope[scopeKey] ?? null;
  const persistedSessionId = activeSessionIdMap[scopeKey] ?? null;
  const normalizedPanelView = useMemo<AIPanelView>(
    () => resolveDisplayedPanelView(explicitPanelView, currentDraft != null, historySessions, persistedSessionId, scopeType),
    [explicitPanelView, currentDraft, historySessions, persistedSessionId, scopeType],
  );
  const activeSession = useMemo(
    () => resolveDisplayedSession(normalizedPanelView, historySessions),
    [normalizedPanelView, historySessions],
  );
  const activeSessionId = normalizedPanelView.mode === 'session' ? normalizedPanelView.sessionId : null;
  const isStreaming = activeSessionId ? streamingSessionIds.has(activeSessionId) : false;
  const currentAgentId = activeSession?.agentId ?? currentDraft?.agentId ?? defaultAgentId;
  const inputValue = currentDraft?.text ?? '';
  const files = currentDraft?.attachments ?? [];
  const panelViewRef = useRef(normalizedPanelView);
  panelViewRef.current = normalizedPanelView;
  const currentDraftRef = useRef(currentDraft);
  currentDraftRef.current = currentDraft;
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  const draftSendInFlightRef = useRef(false);

  const defaultTargetSession = useMemo<DefaultTargetSessionHint | undefined>(() => {
    const connectedSessions = terminalSessions.filter((session) => session.connected !== false);

    if (scopeType === 'terminal' && scopeTargetId) {
      const target = terminalSessions.find((session) => session.sessionId === scopeTargetId);
      if (target) {
        return {
          ...target,
          source: 'scope-target',
        };
      }
    }

    if (connectedSessions.length === 1) {
      return {
        ...connectedSessions[0],
        source: 'only-connected-in-scope',
      };
    }

    return undefined;
  }, [terminalSessions, scopeType, scopeTargetId]);

  useEffect(() => {
    if (!isVisible) return;
    const bridge = getNetcattyBridge();
    if (!bridge?.aiMcpUpdateSessions) return;

    const timeoutId = window.setTimeout(() => {
      void bridge.aiMcpUpdateSessions(terminalSessions, activeSessionId ?? undefined);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isVisible, terminalSessions, activeSessionId]);

  useEffect(() => {
    if (!isVisible) return;
    if (!explicitPanelView || panelViewsEqual(normalizedPanelView, explicitPanelView)) return;
    showDraftView(scopeKey);
  }, [isVisible, normalizedPanelView, explicitPanelView, scopeKey, showDraftView]);

  useEffect(() => {
    if (!activeSession) return;

    if (isVisible && activeSessionIdMap[scopeKey] !== activeSession.id) {
      setActiveSessionId(activeSession.id);
    }
  }, [
    activeSession,
    activeSessionIdMap,
    scopeKey,
    isVisible,
    setActiveSessionId,
  ]);

  useEffect(() => {
    if (!isVisible) return;
    if (normalizedPanelView.mode !== 'draft') return;
    if (persistedSessionId == null) return;
    setActiveSessionId(null);
  }, [isVisible, normalizedPanelView.mode, persistedSessionId, setActiveSessionId]);

  const ensureScopeDraft = useCallback((agentId: string) => {
    ensureDraftForScope(scopeKey, agentId);
  }, [ensureDraftForScope, scopeKey]);

  const updateScopeDraft = useCallback((
    fallbackAgentId: string,
    updater: (draft: AIDraft) => AIDraft,
  ) => {
    updateDraft(scopeKey, fallbackAgentId, updater);
  }, [scopeKey, updateDraft]);

  const showScopeDraftView = useCallback(() => {
    showDraftView(scopeKey);
  }, [scopeKey, showDraftView]);

  const showScopeSessionView = useCallback((sessionId: string) => {
    showSessionView(scopeKey, sessionId);
  }, [scopeKey, showSessionView]);

  const clearScopeDraft = useCallback(() => {
    clearDraftForScope(scopeKey);
  }, [clearDraftForScope, scopeKey]);

  const enterScopeDraftMode = useCallback((agentId: string, preserveSessionView = false) => {
    applyDraftEntrySelection({
      ensureDraft: () => ensureScopeDraft(agentId),
      showDraftView: showScopeDraftView,
      preserveSessionView,
    });
  }, [ensureScopeDraft, showScopeDraftView]);

  const setInputValue = useCallback((value: string) => {
    enterScopeDraftMode(currentAgentId, panelViewRef.current.mode === 'session');
    updateScopeDraft(currentAgentId, (draft) => ({
      ...draft,
      text: value,
    }));
  }, [currentAgentId, enterScopeDraftMode, updateScopeDraft]);

  const addFiles = useCallback(async (inputFiles: File[]) => {
    enterScopeDraftMode(currentAgentId, panelViewRef.current.mode === 'session');
    await addDraftFiles(scopeKey, currentAgentId, inputFiles);
  }, [addDraftFiles, currentAgentId, enterScopeDraftMode, scopeKey]);

  const removeFile = useCallback((fileId: string) => {
    removeDraftFile(scopeKey, currentAgentId, fileId);
  }, [removeDraftFile, scopeKey, currentAgentId]);

  useEffect(() => {
    if (!isVisible) return;

    let cancelled = false;
    const applyUserSkillsStatus = (result: { ok: boolean; skills?: Array<{
      id: string;
      slug: string;
      name: string;
      description: string;
      status: 'ready' | 'warning';
    }> } | null | undefined) => {
      const nextOptions = getReadyUserSkillOptions(result);
      setUserSkillOptions(nextOptions);

      const draft = currentDraftRef.current;
      if (!draft) {
        return;
      }

      const nextSelectedUserSkillSlugs =
        getNextSelectedUserSkillSlugsMap(
          { [scopeKey]: draft.selectedUserSkillSlugs },
          result,
        )[scopeKey] ?? [];

      const selectedUserSkillsChanged =
        nextSelectedUserSkillSlugs.length !== draft.selectedUserSkillSlugs.length
        || nextSelectedUserSkillSlugs.some((slug, index) => slug !== draft.selectedUserSkillSlugs[index]);

      if (!selectedUserSkillsChanged) {
        return;
      }

      updateScopeDraft(draft.agentId, (currentScopeDraft) => ({
        ...currentScopeDraft,
        selectedUserSkillSlugs: nextSelectedUserSkillSlugs,
      }));
    };

    const bridge = getNetcattyBridge();
    void loadUserSkillsStatus(bridge)
      .then((result) => {
        if (cancelled) return;
        if (result === undefined) return;
        applyUserSkillsStatus(result);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [isVisible, scopeKey, toolIntegrationMode, updateScopeDraft, userSkillsStatusVersion]);

  useEffect(() => {
    const handleUserSkillsChanged = () => {
      setUserSkillsStatusVersion((version) => version + 1);
    };
    return subscribeUserSkillsStatusChanged(handleUserSkillsChanged);
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    const bridge = getNetcattyBridge();
    if (bridge?.aiSyncProviders && providers.length > 0) {
      void bridge.aiSyncProviders(providers);
    }
  }, [isVisible, providers]);

  useEffect(() => {
    if (!isVisible) return;
    const bridge = getNetcattyBridge();
    if (bridge?.aiSyncWebSearch) {
      void bridge.aiSyncWebSearch(webSearchConfig?.apiHost || null, webSearchConfig?.apiKey || null);
    }
  }, [isVisible, webSearchConfig?.apiHost, webSearchConfig?.apiKey, webSearchConfig?.enabled]);

  const {
    discoveredAgents,
    isDiscovering,
    rediscover,
    enableAgent,
  } = useAgentDiscovery(externalAgents, setExternalAgents, { enabled: isVisible });

  const handleEnableDiscoveredAgent = useCallback(
    (agent: DiscoveredAgent) => {
      const config = enableAgent(agent);
      setExternalAgents?.((prev) => [...prev, config]);
    },
    [enableAgent, setExternalAgents],
  );

  const messages = activeSession?.messages ?? [];
  const selectedUserSkillSlugs = useMemo(
    () => currentDraft?.selectedUserSkillSlugs ?? [],
    [currentDraft],
  );
  const selectedUserSkills = useMemo(
    () =>
      selectedUserSkillSlugs.map((slug) => {
        const option = userSkillOptions.find((skill) => skill.slug === slug);
        return option ?? { id: slug, slug, name: slug, description: '' };
      }),
    [selectedUserSkillSlugs, userSkillOptions],
  );

  const { handleExport } = useConversationExport(activeSession);

  const activeProvider = useMemo(
    () => providers.find((p) => p.id === activeProviderId),
    [providers, activeProviderId],
  );

  const cattyAgentProvider = useMemo(() => {
    const overrideId = agentProviderMap['catty'];
    if (overrideId) {
      const p = providers.find((cfg) => cfg.id === overrideId);
      if (p) return p;
    }
    return activeProvider;
  }, [agentProviderMap, providers, activeProvider]);

  const cattyAgentModelId = useMemo(() => {
    const trim = (s: string | undefined | null): string => (s ?? '').trim();
    const overrideId = agentProviderMap['catty'];
    const overrideProvider = overrideId
      ? providers.find((cfg) => cfg.id === overrideId)
      : undefined;
    if (overrideProvider) {
      return trim(agentModelMap['catty']) || trim(overrideProvider.defaultModel);
    }
    return trim(cattyAgentProvider?.defaultModel) || trim(activeModelId);
  }, [agentModelMap, agentProviderMap, providers, cattyAgentProvider, activeModelId]);

  const effectiveActiveProvider = currentAgentId === 'catty' ? cattyAgentProvider : activeProvider;
  const effectiveActiveModelId = currentAgentId === 'catty' ? cattyAgentModelId : activeModelId;

  const cattyConfiguredProviders = useMemo(
    () => (currentAgentId === 'catty' ? providers : []),
    [currentAgentId, providers],
  );

  const handleAgentProviderModelSelect = useCallback(
    (providerId: string, modelId: string) => {
      setAgentProvider(currentAgentId, providerId);
      setAgentModel(currentAgentId, modelId);
    },
    [currentAgentId, setAgentProvider, setAgentModel],
  );

  const providerDisplayName = effectiveActiveProvider?.name ?? '';
  const modelDisplayName = effectiveActiveModelId || effectiveActiveProvider?.defaultModel || '';

  const currentAgentConfig = useMemo(
    () => currentAgentId !== 'catty' ? externalAgents.find(a => a.id === currentAgentId) : undefined,
    [currentAgentId, externalAgents],
  );
  const isCodexManagedAgent = useMemo(
    () => currentAgentConfig ? matchesManagedAgentConfig(currentAgentConfig, 'codex') : false,
    [currentAgentConfig],
  );

  const [codexConfigModel, setCodexConfigModel] = useState<string | null>(null);
  const [codexCustomConfigResolved, setCodexCustomConfigResolved] = useState(false);
  useEffect(() => {
    if (!isVisible) return;
    setCodexCustomConfigResolved(false);
    if (!isCodexManagedAgent) {
      setCodexConfigModel(null);
      return;
    }
    const bridge = getNetcattyBridge();
    if (!bridge?.aiCodexGetIntegration) return;
    let cancelled = false;
    void Promise.resolve(
      bridge.aiCodexGetIntegration({ codexPath: getManualAgentCommand(currentAgentConfig) }) as Promise<CodexIntegrationStatus>,
    ).then((info) => {
      if (cancelled) return;
      const hasCustom = info?.state === 'connected_custom_config';
      setCodexConfigModel(info?.customConfig?.model ?? null);
      setCodexCustomConfigResolved(hasCustom);
    }).catch(() => {
      if (!cancelled) {
        setCodexConfigModel(null);
        setCodexCustomConfigResolved(false);
      }
    });
    return () => { cancelled = true; };
  }, [isVisible, isCodexManagedAgent, currentAgentId, currentAgentConfig]);

  const agentModelMapRef = useRef(agentModelMap);
  agentModelMapRef.current = agentModelMap;

  const buildExternalAgentRuntimeModelTarget = useCallback((agent: ExternalAgentConfig | undefined): SdkRuntimeModelTarget | null => {
    if (!agent) return null;
    const sdkBackend = getExternalAgentSdkBackend(agent);
    if (!sdkBackend) return null;
    return {
      agentId: agent.id,
      cacheKey: buildSdkRuntimeModelCacheKey(agent),
      sdkBackend,
      agentEnv: agent.env,
      agentCommand: getManualAgentCommand(agent),
    };
  }, []);

  const buildDiscoveredAgentRuntimeModelTarget = useCallback((agent: DiscoveredAgent): SdkRuntimeModelTarget | null => {
    const sdkBackend = agent.sdkBackend ?? agent.command;
    if (sdkBackend !== 'opencode') return null;
    const command = agent.binPath || agent.path || agent.command;
    const agentId = `discovered_${agent.command}`;
    return {
      agentId,
      cacheKey: buildSdkRuntimeModelCacheKey({
        id: agentId,
        command,
        sdkBackend,
        env: command ? { OPENCODE_BIN: command } : undefined,
      }),
      sdkBackend,
      agentCommand: command,
    };
  }, []);

  const applySdkRuntimeModelCatalog = useCallback((
    agentId: string,
    catalog: SdkRuntimeModelCatalog,
    options: { adoptCurrentModel?: boolean } = {},
  ) => {
    const runtimePresets = normalizeSdkRuntimeModelPresets(catalog.models, catalog.currentModelId);
    const storedModelId = agentModelMapRef.current[agentId];
    if (runtimePresets.length === 0) {
      setRuntimeAgentModelPresets((prev) => {
        if (!(agentId in prev)) return prev;
        const { [agentId]: _removed, ...rest } = prev;
        return rest;
      });
    } else {
      setRuntimeAgentModelPresets((prev) => ({
        ...prev,
        [agentId]: runtimePresets,
      }));
    }

    if (
      options.adoptCurrentModel
      && catalog.currentModelId
      && shouldAdoptSdkCurrentModel(catalog.currentModelId, storedModelId, runtimePresets)
    ) {
      setAgentModel(agentId, catalog.currentModelId);
    }
  }, [setAgentModel]);

  const loadSdkRuntimeModelCatalog = useCallback((
    target: SdkRuntimeModelTarget,
    options: { force?: boolean; logErrors?: boolean } = {},
  ): Promise<SdkRuntimeModelCatalog | null> => {
    const bridge = getNetcattyBridge();
    if (!bridge?.aiSdkAgentListModels) return Promise.resolve(null);

    return sdkRuntimeModelCache.refresh(
      target.cacheKey,
      async () => {
        const result = await bridge.aiSdkAgentListModels!(
          target.sdkBackend,
          undefined,
          undefined,
          `models_${target.agentId}`,
          target.agentEnv,
          target.agentCommand,
        );
        if (!result?.ok || !Array.isArray(result.models)) {
          throw new Error(result?.error || 'Failed to load SDK agent models');
        }
        return {
          currentModelId: result.currentModelId ?? null,
          models: result.models,
        };
      },
      { force: options.force },
    ).catch((err) => {
      if (options.logErrors !== false) {
        console.warn('[AIChatSidePanel] Failed to load SDK agent models:', err);
      }
      return null;
    });
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    if (!currentAgentConfig) return;
    if (!shouldLoadSdkRuntimeModels(currentAgentConfig) && !isCodexManagedAgent) return;

    const target = buildExternalAgentRuntimeModelTarget(currentAgentConfig);
    if (!target) return;

    const cached = sdkRuntimeModelCache.read(target.cacheKey);
    if (cached) {
      applySdkRuntimeModelCatalog(target.agentId, cached);
    }

    let cancelled = false;
    void loadSdkRuntimeModelCatalog(target, {
      force: target.sdkBackend === 'opencode',
    }).then((catalog) => {
      if (cancelled || !catalog) return;
      applySdkRuntimeModelCatalog(target.agentId, catalog, { adoptCurrentModel: true });
    });

    return () => {
      cancelled = true;
    };
  }, [
    isVisible,
    currentAgentConfig,
    isCodexManagedAgent,
    buildExternalAgentRuntimeModelTarget,
    loadSdkRuntimeModelCatalog,
    applySdkRuntimeModelCatalog,
  ]);

  useEffect(() => {
    if (!isVisible) return;
    const targets = new Map<string, SdkRuntimeModelTarget>();
    const configuredTargetCacheKeys = new Set<string>();

    for (const agent of externalAgents) {
      if (!agent.enabled || getExternalAgentSdkBackend(agent) !== 'opencode') continue;
      const target = buildExternalAgentRuntimeModelTarget(agent);
      if (target) {
        targets.set(target.cacheKey, target);
        configuredTargetCacheKeys.add(target.cacheKey);
      }
    }

    for (const agent of discoveredAgents) {
      const target = buildDiscoveredAgentRuntimeModelTarget(agent);
      if (target) targets.set(target.cacheKey, target);
    }

    if (targets.size === 0) return;

    let cancelled = false;
    for (const target of targets.values()) {
      void loadSdkRuntimeModelCatalog(target, { logErrors: false })
        .then((catalog) => {
          if (cancelled || !catalog) return;
          if (configuredTargetCacheKeys.has(target.cacheKey)) {
            applySdkRuntimeModelCatalog(target.agentId, catalog);
          }
        });
    }

    return () => {
      cancelled = true;
    };
  }, [
    isVisible,
    externalAgents,
    discoveredAgents,
    buildExternalAgentRuntimeModelTarget,
    buildDiscoveredAgentRuntimeModelTarget,
    loadSdkRuntimeModelCatalog,
    applySdkRuntimeModelCatalog,
  ]);

  const hasCodexCustomConfig = codexCustomConfigResolved && isCodexManagedAgent;

  const agentModelPresets = useMemo(() => {
    const runtimePresets = runtimeAgentModelPresets[currentAgentId];
    if (hasCodexCustomConfig) {
      if (runtimePresets) {
        return runtimePresets;
      }
      if (codexConfigModel) {
        return [{ id: codexConfigModel, name: codexConfigModel }];
      }
      return [];
    }
    return runtimePresets ?? getAgentModelPresets(currentAgentConfig?.command);
  }, [currentAgentConfig?.command, currentAgentId, runtimeAgentModelPresets, hasCodexCustomConfig, codexConfigModel]);

  const selectedAgentModel = useMemo(() => {
    const stored = agentModelMap[currentAgentId];
    if (shouldUseStoredAgentModel(stored, agentModelPresets, currentAgentConfig)) {
      return stored;
    }
    if (agentModelPresets.length > 0) {
      const first = agentModelPresets[0];
      if (first.thinkingLevels?.length) {
        return `${first.id}/${first.thinkingLevels[first.thinkingLevels.length - 1]}`;
      }
      return first.id;
    }
    return undefined;
  }, [currentAgentConfig, currentAgentId, agentModelMap, agentModelPresets]);

  const inputAgentId = activeSession?.agentId ?? currentDraft?.agentId ?? currentAgentId;
  const canSendCurrentAgent = useMemo(
    () => canSendWithAgent(inputAgentId, externalAgents),
    [inputAgentId, externalAgents],
  );

  const handleAgentModelSelect = useCallback((modelId: string) => {
    setAgentModel(currentAgentId, modelId);
  }, [currentAgentId, setAgentModel]);


  const handleNewChat = useCallback(() => {
    clearScopeDraft();
    updateScopeDraft(currentAgentId, () => ({
      text: '',
      agentId: currentAgentId,
      attachments: [],
      selectedUserSkillSlugs: [],
      updatedAt: Date.now(),
    }));
    showScopeDraftView();
    setShowHistory(false);
  }, [clearScopeDraft, currentAgentId, showScopeDraftView, updateScopeDraft]);

  const handleOpenSettings = useCallback(() => {
    void openSettingsWindow();
  }, [openSettingsWindow]);


  /** Ref to always access latest sessions (avoids stale closure in autoTitleSession). */
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  /** Auto-title a session from the first user message if untitled. */
  const autoTitleSession = useCallback((sessionId: string, text: string) => {
    const s = sessionsRef.current.find(x => x.id === sessionId);
    if (s && (!s.title || s.title === 'New Chat')) {
      updateSessionTitle(sessionId, text.length > 50 ? text.slice(0, 50) + '...' : text);
    }
  }, [updateSessionTitle]);

  const buildExecutorContextForScope = useCallback((scope: {
    type: 'terminal' | 'workspace';
    targetId?: string;
    label?: string;
  }): ExecutorContext => {
    const resolved = resolveExecutorContextRef.current?.(scope);
    if (resolved) return resolved;
    return {
      sessions: terminalSessionsRef.current,
      workspaceId: scope.type === 'workspace' ? scope.targetId : undefined,
      workspaceName: scope.type === 'workspace' ? scope.label : undefined,
    };
  }, []);

  const addSelectedUserSkill = useCallback((slug: string) => {
    const normalizedSlug = String(slug || '').trim().toLowerCase();
    if (!normalizedSlug) return;
    enterScopeDraftMode(currentAgentId, panelViewRef.current.mode === 'session');
    updateScopeDraft(currentAgentId, (draft) => {
      if (draft.selectedUserSkillSlugs.includes(normalizedSlug)) {
        return draft;
      }
      return {
        ...draft,
        selectedUserSkillSlugs: [...draft.selectedUserSkillSlugs, normalizedSlug],
      };
    });
  }, [currentAgentId, enterScopeDraftMode, updateScopeDraft]);

  const removeSelectedUserSkill = useCallback((slug: string) => {
    const normalizedSlug = String(slug || '').trim().toLowerCase();
    if (!normalizedSlug) return;
    enterScopeDraftMode(currentAgentId, panelViewRef.current.mode === 'session');
    updateScopeDraft(currentAgentId, (draft) => {
      const nextSelectedUserSkillSlugs = draft.selectedUserSkillSlugs.filter(
        (entry) => entry !== normalizedSlug,
      );
      if (nextSelectedUserSkillSlugs.length === draft.selectedUserSkillSlugs.length) {
        return draft;
      }
      return {
        ...draft,
        selectedUserSkillSlugs: nextSelectedUserSkillSlugs,
      };
    });
  }, [currentAgentId, enterScopeDraftMode, updateScopeDraft]);


  const handleSend = useCallback(async () => {
    const draft = currentDraftRef.current;
    const currentPanelView = panelViewRef.current;
    const currentSessionView = activeSessionRef.current;
    const trimmed = draft?.text.trim() ?? '';
    const sendScopeKey = scopeKey;
    const attachments = (draft?.attachments ?? []).map((file) => ({
      base64Data: file.base64Data,
      mediaType: file.mediaType,
      filename: file.filename,
      filePath: file.filePath,
      terminalSelection: file.terminalSelection,
      previewText: file.previewText,
      lineCount: file.lineCount,
    }));
    const hasTerminalSelectionAttachments = attachments.some(isTerminalSelectionAttachment);
    if ((!trimmed && !hasTerminalSelectionAttachments) || isStreaming) return;
    const sendAgentId = currentSessionView?.agentId ?? draft?.agentId ?? currentAgentId;
    const agentConfig = sendAgentId !== 'catty' ? findEnabledExternalAgent(externalAgents, sendAgentId) : undefined;
    if (sendAgentId !== 'catty' && !agentConfig) return;

    const selectedSkillSlugs = draft?.selectedUserSkillSlugs ?? [];
    const modelPrompt = buildPromptWithTerminalSelectionAttachments(trimmed, attachments);
    const modelAttachments = attachments.filter((attachment) => !isTerminalSelectionAttachment(attachment));
    const isDraftMode = currentPanelView.mode === 'draft';

    if (isDraftMode && !tryBeginDraftSend(draftSendInFlightRef)) {
      return;
    }

    try {
      let sessionId = currentSessionView?.id ?? null;
      let currentSession = currentSessionView ?? null;
      if (isDraftMode) {
        const scope: AISessionScope = { type: scopeType, targetId: scopeTargetId, hostIds: scopeHostIds };
        const createdSession = createSession(scope, sendAgentId);
        sessionId = createdSession.id;
        currentSession = createdSession;
        clearScopeDraft();
        showScopeSessionView(createdSession.id);
        setActiveSessionId(createdSession.id);
      }

      if (!sessionId) {
        return;
      }

      const isExternalAgent = sendAgentId !== 'catty';

      const sendActiveProvider = isExternalAgent ? activeProvider : effectiveActiveProvider;
      const sendActiveModelId = isExternalAgent ? activeModelId : effectiveActiveModelId;

      if (!isExternalAgent && !sendActiveProvider) {
        addMessageToSession(sessionId, {
          id: generateId(), role: 'user', content: trimmed,
          ...(attachments.length > 0 ? { attachments } : {}),
          timestamp: Date.now(),
        });
        addMessageToSession(sessionId, { id: generateId(), role: 'assistant', content: t('ai.chat.noProvider'), timestamp: Date.now() });
        if (currentPanelView.mode === 'session') {
          clearScopeDraft();
          showScopeSessionView(sessionId);
        }
        return;
      }

      if (!isExternalAgent && !sendActiveModelId.trim()) {
        addMessageToSession(sessionId, {
          id: generateId(), role: 'user', content: trimmed,
          ...(attachments.length > 0 ? { attachments } : {}),
          timestamp: Date.now(),
        });
        addMessageToSession(sessionId, { id: generateId(), role: 'assistant', content: t('ai.chat.noProviderModel'), timestamp: Date.now() });
        if (currentPanelView.mode === 'session') {
          clearScopeDraft();
          showScopeSessionView(sessionId);
        }
        return;
      }

      addMessageToSession(sessionId, {
        id: generateId(), role: 'user', content: trimmed,
        ...(attachments.length > 0 ? { attachments } : {}),
        timestamp: Date.now(),
      });
      clearScopeDraft();
      showScopeSessionView(sessionId);
      setActiveSessionId(sessionId);
      setStreamingForScope(sessionId, true);

      const assistantMsgId = generateId();
      addMessageToSession(sessionId, {
        id: assistantMsgId, role: 'assistant', content: '', timestamp: Date.now(),
        model: isExternalAgent
          ? (selectedAgentModel || agentConfig?.name || 'external')
          : (sendActiveModelId || sendActiveProvider?.defaultModel || ''),
        providerId: isExternalAgent ? undefined : sendActiveProvider?.providerId,
      });

      const abortController = new AbortController();
      abortControllersRef.current.set(sessionId, abortController);
      currentSession = currentSession ?? sessionsRef.current.find((session) => session.id === sessionId) ?? null;

      if (isExternalAgent) {
        if (!agentConfig) {
          updateMessageById(sessionId, assistantMsgId, msg => ({ ...msg, content: 'External agent not found. Please check settings.', executionStatus: 'failed' }));
          setStreamingForScope(sessionId, false);
          return;
        }
        try {
          const existingExternalSessionId = currentSession?.externalSessionId;
          await sendToExternalAgent(sessionId, modelPrompt, agentConfig, abortController, modelAttachments, {
            existingSessionId: existingExternalSessionId,
            updateExternalSessionId: updateSessionExternalSessionId,
            historyMessages: buildExternalAgentHistoryMessagesForBridge(currentSession?.messages ?? [], existingExternalSessionId),
            terminalSessions,
            defaultTargetSession,
            providers,
            selectedAgentModel,
            toolIntegrationMode,
            selectedUserSkillSlugs: selectedSkillSlugs,
          });
        } catch (err) {
          reportStreamError(sessionId, abortController.signal, err);
        }
        updateLastMessage(sessionId, msg => msg.statusText ? { ...msg, statusText: '' } : msg);
        setStreamingForScope(sessionId, false);
        abortControllersRef.current.delete(sessionId);
        autoTitleSession(sessionId, trimmed);
      } else {
        const toolScope = {
          type: scopeType,
          targetId: scopeTargetId,
          label: scopeLabel,
        } as const;
        await sendToCattyAgent(sessionId, sendScopeKey, modelPrompt, abortController, currentSession ?? undefined, assistantMsgId, {
          activeProvider: sendActiveProvider,
          activeModelId: sendActiveModelId,
          scopeType,
          scopeTargetId,
          scopeLabel,
          globalPermissionMode,
          commandBlocklist,
          commandTimeout,
          terminalSessions,
          webSearchConfig,
          getExecutorContext: () => buildExecutorContextForScope(toolScope),
          autoTitleSession,
          selectedUserSkillSlugs: selectedSkillSlugs,
          titleText: trimmed,
        }, modelAttachments.length > 0 ? modelAttachments : undefined);
      }
    } finally {
      if (isDraftMode) {
        endDraftSend(draftSendInFlightRef);
      }
    }
  }, [
    isStreaming, activeProvider, effectiveActiveProvider, effectiveActiveModelId, scopeKey, currentAgentId,
    activeModelId, externalAgents,
    createSession, addMessageToSession, updateMessageById, updateLastMessage,
    setStreamingForScope,
    sendToExternalAgent, sendToCattyAgent, reportStreamError, autoTitleSession, t,
    abortControllersRef, terminalSessions, defaultTargetSession, providers, selectedAgentModel, updateSessionExternalSessionId,
    scopeType, scopeTargetId, scopeHostIds, scopeLabel, globalPermissionMode, commandBlocklist, commandTimeout, webSearchConfig, buildExecutorContextForScope,
    toolIntegrationMode,
    clearScopeDraft, showScopeSessionView, setActiveSessionId,
  ]);

  const stopStreamingForSession = useCallback(async (sessionId: string) => {
    const controller = abortControllersRef.current.get(sessionId);
    setStreamingForScope(sessionId, false);
    updateLastMessage(sessionId, (msg) => ({
      ...msg,
      statusText: '',
      executionStatus: msg.executionStatus === 'running' ? 'cancelled' : msg.executionStatus,
    }));
    await stopAgentTurn({
      chatSessionId: sessionId,
      abortController: controller,
      bridge: getNetcattyBridge(),
      reason: 'user',
    });
    await getAgentRuntime().waitForActiveTurn(sessionId);
    if (controller && abortControllersRef.current.get(sessionId) === controller) {
      abortControllersRef.current.delete(sessionId);
    }
  }, [setStreamingForScope, updateLastMessage, abortControllersRef]);

  const { addGrant } = useAIPermissionGrantsState();

  useEffect(() => {
    return registerGrantPersister((rule) => { addGrant(rule); });
  }, [addGrant]);

  const handleStop = useCallback(() => {
    if (!activeSessionId) return;
    stopStreamingForSession(activeSessionId);
  }, [activeSessionId, stopStreamingForSession]);

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      applyHistorySessionSelection(sessionId, {
        showSessionView: showScopeSessionView,
        setActiveSessionId,
        closeHistory: () => setShowHistory(false),
      });
    },
    [setActiveSessionId, showScopeSessionView],
  );

  const handleDeleteSession = useCallback(
    async (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      const deletingActiveSession =
        activeSessionId === sessionId
        || persistedSessionId === sessionId
        || (
          explicitPanelView?.mode === 'session'
          && explicitPanelView.sessionId === sessionId
        );
      const deletingLastScopedSession =
        historySessions.length === 1 && historySessions[0]?.id === sessionId;
      const deletedSessionAgentId =
        historySessions.find((session) => session.id === sessionId)?.agentId
        ?? currentAgentId;

      if (abortControllersRef.current.has(sessionId) || streamingSessionIds.has(sessionId)) {
        await stopStreamingForSession(sessionId);
      }

      deleteSession(sessionId, scopeKey);
      getAgentRuntime().clearChatSession(sessionId);

      if (deletingActiveSession || deletingLastScopedSession) {
        setShowHistory(false);
        ensureScopeDraft(deletedSessionAgentId);
      }
    },
    [
      activeSessionId,
      abortControllersRef,
      currentAgentId,
      deleteSession,
      ensureScopeDraft,
      explicitPanelView,
      historySessions,
      persistedSessionId,
      scopeKey,
      stopStreamingForSession,
      streamingSessionIds,
    ],
  );

  const handleAgentChange = useCallback((agentId: string) => {
    showScopeDraftView();
    ensureScopeDraft(agentId);
    updateScopeDraft(agentId, (draft) => ({
      ...selectDraftForAgentSwitch(
        draft,
        agentId,
        Boolean(activeSessionRef.current?.messages.length),
      ),
    }));
    setShowHistory(false);
  }, [ensureScopeDraft, showScopeDraftView, updateScopeDraft]);


  return (
    <React.Profiler {...getAIPanelProfilerProps('AIChatSidePanel.Active')}>
      <AIChatPanelContent
        t={t}
        currentAgentId={currentAgentId}
        externalAgents={externalAgents}
        discoveredAgents={discoveredAgents}
        isDiscovering={isDiscovering}
        handleAgentChange={handleAgentChange}
        handleEnableDiscoveredAgent={handleEnableDiscoveredAgent}
        rediscover={rediscover}
        handleOpenSettings={handleOpenSettings}
        activeSession={activeSession}
        handleExport={handleExport}
        showHistory={showHistory}
        setShowHistory={setShowHistory}
        handleNewChat={handleNewChat}
        historySessions={historySessions}
        activeSessionId={activeSessionId}
        handleSelectSession={handleSelectSession}
        handleDeleteSession={handleDeleteSession}
        messages={messages}
        isStreaming={isStreaming}
        activeCompaction={
          activeCompaction?.sessionId === activeSessionId ? activeCompaction : null
        }
        inputValue={inputValue}
        setInputValue={setInputValue}
        handleSend={handleSend}
        handleStop={handleStop}
        canSendCurrentAgent={canSendCurrentAgent}
        providerDisplayName={providerDisplayName}
        modelDisplayName={modelDisplayName}
        agentModelPresets={agentModelPresets}
        selectedAgentModel={selectedAgentModel}
        handleAgentModelSelect={handleAgentModelSelect}
        cattyConfiguredProviders={cattyConfiguredProviders}
        effectiveActiveProvider={effectiveActiveProvider}
        effectiveActiveModelId={effectiveActiveModelId}
        handleAgentProviderModelSelect={handleAgentProviderModelSelect}
        files={files}
        addFiles={addFiles}
        removeFile={removeFile}
        terminalSessions={terminalSessions}
        selectedUserSkills={selectedUserSkills}
        userSkillOptions={userSkillOptions}
        quickMessages={quickMessages}
        addSelectedUserSkill={addSelectedUserSkill}
        removeSelectedUserSkill={removeSelectedUserSkill}
        globalPermissionMode={globalPermissionMode}
        setGlobalPermissionMode={setGlobalPermissionMode}
        notes={notes}
        hosts={hosts}
        onOpenVaultNote={onOpenVaultNote}
        onOpenVaultHost={onOpenVaultHost}
        onOpenVaultSection={onOpenVaultSection}
      />
    </React.Profiler>
  );
};


const AI_CHAT_SIDE_PANEL_AI_STATE_KEYS = [
  'sessions',
  'activeSessionIdMap',
  'draftsByScope',
  'panelViewByScope',
  'setActiveSessionId',
  'ensureDraftForScope',
  'updateDraft',
  'showDraftView',
  'showSessionView',
  'clearDraftForScope',
  'addDraftFiles',
  'removeDraftFile',
  'createSession',
  'deleteSession',
  'updateSessionTitle',
  'updateSessionExternalSessionId',
  'addMessageToSession',
  'updateLastMessage',
  'updateMessageById',
  'providers',
  'activeProviderId',
  'activeModelId',
  'defaultAgentId',
  'toolIntegrationMode',
  'externalAgents',
  'setExternalAgents',
  'agentModelMap',
  'setAgentModel',
  'agentProviderMap',
  'setAgentProvider',
  'globalPermissionMode',
  'setGlobalPermissionMode',
  'commandBlocklist',
  'commandTimeout',
  'maxIterations',
  'webSearchConfig',
  'quickMessages',
] as const satisfies readonly (keyof AIChatSidePanelProps)[];

export function aiChatSidePanelPropsAreEqual(
  prev: AIChatSidePanelProps,
  next: AIChatSidePanelProps,
): boolean {
  const prevKeep = shouldKeepAIChatSidePanelMounted(prev);
  const nextKeep = shouldKeepAIChatSidePanelMounted(next);
  if (!prevKeep && !nextKeep) {
    return true;
  }
  if (prevKeep !== nextKeep) {
    return false;
  }

  if (prev.scopeType !== next.scopeType) return false;
  if (prev.scopeTargetId !== next.scopeTargetId) return false;
  if (prev.scopeLabel !== next.scopeLabel) return false;
  if ((prev.isVisible ?? true) !== (next.isVisible ?? true)) return false;
  if (prev.scopeHostIds !== next.scopeHostIds) return false;
  if (prev.terminalSessions !== next.terminalSessions) return false;
  if (prev.resolveExecutorContext !== next.resolveExecutorContext) return false;
  if (prev.notes !== next.notes) return false;
  if (prev.hosts !== next.hosts) return false;
  if (prev.onOpenVaultNote !== next.onOpenVaultNote) return false;
  if (prev.onOpenVaultHost !== next.onOpenVaultHost) return false;
  if (prev.onOpenVaultSection !== next.onOpenVaultSection) return false;

  for (const key of AI_CHAT_SIDE_PANEL_AI_STATE_KEYS) {
    if (prev[key] !== next[key]) return false;
  }
  return true;
}

const AIChatSidePanel = React.memo(function AIChatSidePanel(props: AIChatSidePanelProps) {
  const shouldKeepMounted = shouldKeepAIChatSidePanelMounted(props);
  const shouldDelayActivation = shouldKeepMounted && shouldDelayAIChatSidePanelActivation(props);
  const activationKey = `${props.scopeType}:${props.scopeTargetId ?? ''}`;
  const [activationReady, setActivationReady] = useState(!shouldDelayActivation);

  useEffect(() => {
    if (!shouldDelayActivation) {
      setActivationReady(true);
      return undefined;
    }

    setActivationReady(false);
    return schedulePanelActivation(() => setActivationReady(true));
  }, [activationKey, shouldDelayActivation]);

  if (!shouldKeepMounted) return null;
  if (shouldDelayActivation && !activationReady) {
    return <AIChatSidePanelPreparing />;
  }
  // Keep hidden panels alive only when they contain real work (messages, draft
  // content, or an active stream). Empty hidden panels can drop their heavy
  // input/agent-picker subtree and remount cheaply when shown again.
  return <AIChatSidePanelActive {...props} />;
}, aiChatSidePanelPropsAreEqual);
AIChatSidePanel.displayName = 'AIChatSidePanel';

export default AIChatSidePanel;
export { AIChatSidePanel };
export type { AIChatSidePanelProps };
