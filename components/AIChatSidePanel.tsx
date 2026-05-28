

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import { useWindowControls } from '../application/state/useWindowControls';
import type {
  AIDraft,
  AIPanelView,
  AgentModelPreset,
  AISessionScope,
  DiscoveredAgent,
} from '../infrastructure/ai/types';
import type { ExecutorContext } from '../infrastructure/ai/cattyAgent/executor';
import { getAgentModelPresets } from '../infrastructure/ai/types';
import { matchesManagedAgentConfig } from '../infrastructure/ai/managedAgents';
import { useAgentDiscovery } from '../application/state/useAgentDiscovery';
import {
  getReadyUserSkillOptions,
  getNextSelectedUserSkillSlugsMap,
  type UserSkillOption,
} from './ai/userSkillsState';
import {
  applyDraftEntrySelection,
  applyHistorySessionSelection,
  resolveDisplayedPanelView,
  resolveDisplayedSession,
} from './ai/aiPanelViewState';
import {
  endDraftSend,
  tryBeginDraftSend,
} from './ai/draftSendGate';
import { getSessionScopeMatchRank } from './ai/sessionScopeMatch';
import { selectDraftForAgentSwitch } from '../application/state/aiDraftState';
import type { CodexIntegrationStatus } from './settings/tabs/ai/types';
import {
  useAIChatStreaming,
  getNetcattyBridge,
  type DefaultTargetSessionHint,
} from './ai/hooks/useAIChatStreaming';
import { buildAcpHistoryMessagesForBridge } from './ai/acpHistory';
import { canSendWithAgent, findEnabledExternalAgent } from './ai/agentSendEligibility';
import { clearAllPendingApprovals } from '../infrastructure/ai/shared/approvalGate';
import { useConversationExport } from './ai/hooks/useConversationExport';
import type { AIChatSidePanelProps } from './AIChatSidePanel.types';
import { generateId, isCopilotAgentConfig, modelPresetsContainId } from './AIChatSidePanelHelpers';
import { AIChatPanelContent } from './AIChatPanelContent';

const AIChatSidePanelInner: React.FC<AIChatSidePanelProps> = ({
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
  maxIterations = 20,
  webSearchConfig,
  scopeType,
  scopeTargetId,
  scopeHostIds,
  scopeLabel,
  terminalSessions = [],
  resolveExecutorContext,
  isVisible = true,
}) => {
  const { t } = useI18n();
  const scopeKey = `${scopeType}:${scopeTargetId ?? ''}`;

  const [showHistory, setShowHistory] = useState(false);
  const [runtimeAgentModelPresets, setRuntimeAgentModelPresets] = useState<Record<string, AgentModelPreset[]>>({});
  const [userSkillOptions, setUserSkillOptions] = useState<UserSkillOption[]>([]);
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

  const historySessions = useMemo(
    () =>
      sessions
        .map((session) => ({
          session,
          matchRank: getSessionScopeMatchRank(
            session,
            scopeType,
            scopeTargetId,
            scopeHostIds,
            activeTerminalSessionIds,
          ),
        }))
        .filter(({ matchRank }) => matchRank > 0)
        .sort((a, b) => b.matchRank - a.matchRank || b.session.updatedAt - a.session.updatedAt)
        .map(({ session }) => session),
    [sessions, scopeType, scopeTargetId, scopeHostIds, activeTerminalSessionIds],
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
    const bridge = getNetcattyBridge();
    if (bridge?.aiMcpUpdateSessions) {
      void bridge.aiMcpUpdateSessions(terminalSessions, activeSessionId ?? undefined);
    }
  }, [terminalSessions, scopeKey, activeSessionId]);

  useEffect(() => {
    if (!explicitPanelView || normalizedPanelView === explicitPanelView) return;
    showDraftView(scopeKey);
  }, [normalizedPanelView, explicitPanelView, scopeKey, showDraftView]);

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
    if (!bridge?.aiUserSkillsGetStatus) {
      applyUserSkillsStatus(null);
      return;
    }

    void bridge.aiUserSkillsGetStatus()
      .then((result) => {
        if (cancelled) return;
        applyUserSkillsStatus(result);
      })
      .catch(() => {
        if (cancelled) return;
        applyUserSkillsStatus(null);
      });

    return () => {
      cancelled = true;
    };
  }, [isVisible, scopeKey, toolIntegrationMode, updateScopeDraft]);

  useEffect(() => {
    const bridge = getNetcattyBridge();
    if (bridge?.aiSyncProviders && providers.length > 0) {
      void bridge.aiSyncProviders(providers);
    }
  }, [providers]);

  useEffect(() => {
    const bridge = getNetcattyBridge();
    if (bridge?.aiSyncWebSearch) {
      void bridge.aiSyncWebSearch(webSearchConfig?.apiHost || null, webSearchConfig?.apiKey || null);
    }
  }, [webSearchConfig?.apiHost, webSearchConfig?.apiKey, webSearchConfig?.enabled]);

  useEffect(() => {
    return () => {
    };
  }, []);

  const {
    discoveredAgents,
    isDiscovering,
    rediscover,
    enableAgent,
  } = useAgentDiscovery(externalAgents, setExternalAgents);

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
  const isCopilotExternalAgent = useMemo(
    () => isCopilotAgentConfig(currentAgentConfig),
    [currentAgentConfig],
  );
  const isCodexManagedAgent = useMemo(
    () => currentAgentConfig ? matchesManagedAgentConfig(currentAgentConfig, 'codex') : false,
    [currentAgentConfig],
  );
  const isClaudeManagedAgent = useMemo(
    () => currentAgentConfig ? matchesManagedAgentConfig(currentAgentConfig, 'claude') : false,
    [currentAgentConfig],
  );

  const [codexConfigModel, setCodexConfigModel] = useState<string | null>(null);
  const [codexCustomConfigResolved, setCodexCustomConfigResolved] = useState(false);
  useEffect(() => {
    setCodexCustomConfigResolved(false);
    if (!isCodexManagedAgent) {
      setCodexConfigModel(null);
      return;
    }
    const bridge = getNetcattyBridge();
    if (!bridge?.aiCodexGetIntegration) return;
    let cancelled = false;
    void Promise.resolve(
      bridge.aiCodexGetIntegration() as Promise<CodexIntegrationStatus>,
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
  }, [isCodexManagedAgent, currentAgentId]);

  const agentModelMapRef = useRef(agentModelMap);
  agentModelMapRef.current = agentModelMap;

  useEffect(() => {
    if (!currentAgentConfig?.acpCommand) return;
    if (!isCopilotExternalAgent && !isClaudeManagedAgent && !isCodexManagedAgent) return;

    const bridge = getNetcattyBridge();
    if (!bridge?.aiAcpListModels) return;

    let cancelled = false;
    void bridge.aiAcpListModels(
      currentAgentConfig.acpCommand,
      currentAgentConfig.acpArgs || [],
      undefined,
      undefined,
      `models_${currentAgentId}`,
      currentAgentConfig.env,
    ).then((result) => {
      if (cancelled || !result?.ok || !Array.isArray(result.models)) return;
      if (result.models.length === 0) {
        setRuntimeAgentModelPresets((prev) => {
          if (!(currentAgentId in prev)) return prev;
          const { [currentAgentId]: _removed, ...rest } = prev;
          return rest;
        });
        return;
      }
      const runtimePresets = result.models ?? [];
      setRuntimeAgentModelPresets((prev) => ({
        ...prev,
        [currentAgentId]: runtimePresets,
      }));
      const storedModelId = agentModelMapRef.current[currentAgentId];
      if (result.currentModelId && (!storedModelId || !modelPresetsContainId(runtimePresets, storedModelId))) {
        setAgentModel(currentAgentId, result.currentModelId);
      }
    }).catch((err) => {
      if (!cancelled) {
        console.warn('[AIChatSidePanel] Failed to load ACP agent models:', err);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [currentAgentConfig, currentAgentId, isCopilotExternalAgent, isClaudeManagedAgent, isCodexManagedAgent, setAgentModel]);

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
    if (stored && modelPresetsContainId(agentModelPresets, stored)) {
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
  }, [currentAgentId, agentModelMap, agentModelPresets]);

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
    if (!trimmed || isStreaming) return;
    const sendAgentId = currentSessionView?.agentId ?? draft?.agentId ?? currentAgentId;
    const agentConfig = sendAgentId !== 'catty' ? findEnabledExternalAgent(externalAgents, sendAgentId) : undefined;
    if (sendAgentId !== 'catty' && !agentConfig) return;

    const selectedSkillSlugs = draft?.selectedUserSkillSlugs ?? [];
    const attachments = (draft?.attachments ?? []).map((file) => ({
      base64Data: file.base64Data,
      mediaType: file.mediaType,
      filename: file.filename,
      filePath: file.filePath,
    }));
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
        addMessageToSession(sessionId, { id: generateId(), role: 'user', content: trimmed, timestamp: Date.now() });
        addMessageToSession(sessionId, { id: generateId(), role: 'assistant', content: t('ai.chat.noProvider'), timestamp: Date.now() });
        if (currentPanelView.mode === 'session') {
          clearScopeDraft();
          showScopeSessionView(sessionId);
        }
        return;
      }

      if (!isExternalAgent && !sendActiveModelId.trim()) {
        addMessageToSession(sessionId, { id: generateId(), role: 'user', content: trimmed, timestamp: Date.now() });
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
          await sendToExternalAgent(sessionId, trimmed, agentConfig, abortController, attachments, {
            existingSessionId: existingExternalSessionId,
            updateExternalSessionId: updateSessionExternalSessionId,
            historyMessages: buildAcpHistoryMessagesForBridge(currentSession?.messages ?? [], existingExternalSessionId),
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
        await sendToCattyAgent(sessionId, sendScopeKey, trimmed, abortController, currentSession ?? undefined, assistantMsgId, {
          activeProvider: sendActiveProvider,
          activeModelId: sendActiveModelId,
          scopeType,
          scopeTargetId,
          scopeLabel,
          globalPermissionMode,
          commandBlocklist,
          terminalSessions,
          webSearchConfig,
          getExecutorContext: () => buildExecutorContextForScope(toolScope),
          autoTitleSession,
          selectedUserSkillSlugs: selectedSkillSlugs,
        }, attachments.length > 0 ? attachments : undefined);
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
    scopeType, scopeTargetId, scopeHostIds, scopeLabel, globalPermissionMode, commandBlocklist, webSearchConfig, buildExecutorContextForScope,
    toolIntegrationMode,
    clearScopeDraft, showScopeSessionView, setActiveSessionId,
  ]);

  const handleStop = useCallback(() => {
    if (!activeSessionId) return;
    const controller = abortControllersRef.current.get(activeSessionId);
    controller?.abort();
    abortControllersRef.current.delete(activeSessionId);
    setStreamingForScope(activeSessionId, false);
    updateLastMessage(activeSessionId, msg => ({
      ...msg,
      statusText: '',
      executionStatus: msg.executionStatus === 'running' ? 'cancelled' : msg.executionStatus,
    }));
    clearAllPendingApprovals(activeSessionId);
    const bridge = getNetcattyBridge();
    bridge?.aiCattyCancelExec?.(activeSessionId);
    bridge?.aiAcpCancel?.('', activeSessionId);
  }, [activeSessionId, setStreamingForScope, updateLastMessage, abortControllersRef]);

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
    (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      deleteSession(sessionId, scopeKey);
    },
    [deleteSession, scopeKey],
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


  if (!isVisible) return null;

  return (
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
      addSelectedUserSkill={addSelectedUserSkill}
      removeSelectedUserSkill={removeSelectedUserSkill}
      globalPermissionMode={globalPermissionMode}
      setGlobalPermissionMode={setGlobalPermissionMode}
    />
  );
};


const AIChatSidePanel = React.memo(AIChatSidePanelInner);
AIChatSidePanel.displayName = 'AIChatSidePanel';

export default AIChatSidePanel;
export { AIChatSidePanel };
export type { AIChatSidePanelProps };
