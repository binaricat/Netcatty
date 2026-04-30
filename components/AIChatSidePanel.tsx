/**
 * AIChatSidePanel - Main AI chat interface side panel
 *
 * Zed-style agent panel with agent selector, scoped chat sessions,
 * message list, input area, and session history drawer.
 *
 * Core logic is decomposed into focused hooks:
 * - useAIChatStreaming: stream processing, abort management, agent sub-flows
 * - useConversationExport: export formats & object URL lifecycle
 */

import {
  History,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import { useI18n } from '../application/i18n/I18nProvider';
import { useWindowControls } from '../application/state/useWindowControls';
import type {
  AIDraft,
  AIPanelView,
  AIPermissionMode,
  AIToolIntegrationMode,
  AgentModelPreset,
  AISession,
  AISessionScope,
  ChatMessage,
  DiscoveredAgent,
  ExternalAgentConfig,
  ProviderConfig,
  WebSearchConfig,
} from '../infrastructure/ai/types';
import { getAgentModelPresets } from '../infrastructure/ai/types';
import { matchesManagedAgentConfig } from '../infrastructure/ai/managedAgents';
import { useAgentDiscovery } from '../application/state/useAgentDiscovery';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import AgentSelector from './ai/AgentSelector';
import ChatInput from './ai/ChatInput';
import ChatMessageList from './ai/ChatMessageList';
import ConversationExport from './ai/ConversationExport';
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
import { SESSION_HISTORY_ROW_CLASSNAMES } from './ai/sessionHistoryLayout';
import { selectDraftForAgentSwitch } from '../application/state/aiDraftState';
import type { CodexIntegrationStatus } from './settings/tabs/ai/types';
import {
  useAIChatStreaming,
  getNetcattyBridge,
  type DefaultTargetSessionHint,
} from './ai/hooks/useAIChatStreaming';
import { buildAcpHistoryMessagesForBridge } from './ai/acpHistory';
import { clearAllPendingApprovals } from '../infrastructure/ai/shared/approvalGate';
import { useConversationExport } from './ai/hooks/useConversationExport';
import type { ExecutorContext } from '../infrastructure/ai/cattyAgent/executor';

function modelPresetMatchesId(preset: AgentModelPreset, modelId: string): boolean {
  if (preset.thinkingLevels?.length) {
    return preset.thinkingLevels.some((level) => `${preset.id}/${level}` === modelId);
  }
  return preset.id === modelId;
}

function modelPresetsContainId(presets: AgentModelPreset[], modelId: string): boolean {
  return presets.some((preset) => modelPresetMatchesId(preset, modelId));
}

function isCopilotAgentConfig(agent?: ExternalAgentConfig): boolean {
  if (!agent) return false;
  const tokens = [
    agent.id,
    agent.name,
    agent.icon,
    agent.command,
    agent.acpCommand,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => value.split('/').pop()?.toLowerCase() ?? value.toLowerCase());
  return tokens.some((token) => token.includes('copilot'));
}

// -------------------------------------------------------------------
// Props
// -------------------------------------------------------------------

interface AIChatSidePanelProps {
  // Session state (per-scope)
  sessions: AISession[];
  activeSessionIdMap: Record<string, string | null>;
  draftsByScope: Partial<Record<string, AIDraft>>;
  panelViewByScope: Partial<Record<string, AIPanelView>>;
  setActiveSessionId: (scopeKey: string, id: string | null) => void;
  ensureDraftForScope: (scopeKey: string, agentId: string) => void;
  updateDraft: (
    scopeKey: string,
    fallbackAgentId: string,
    updater: (draft: AIDraft) => AIDraft,
  ) => void;
  showDraftView: (scopeKey: string) => void;
  showSessionView: (scopeKey: string, sessionId: string) => void;
  clearDraftForScope: (scopeKey: string) => void;
  addDraftFiles: (scopeKey: string, fallbackAgentId: string, inputFiles: File[]) => Promise<void>;
  removeDraftFile: (scopeKey: string, fallbackAgentId: string, fileId: string) => void;
  createSession: (scope: AISessionScope, agentId?: string) => AISession;
  deleteSession: (sessionId: string, scopeKey?: string) => void;
  updateSessionTitle: (sessionId: string, title: string) => void;
  updateSessionExternalSessionId: (sessionId: string, externalSessionId: string | undefined) => void;
  addMessageToSession: (sessionId: string, message: ChatMessage) => void;
  updateLastMessage: (
    sessionId: string,
    updater: (msg: ChatMessage) => ChatMessage,
  ) => void;
  updateMessageById: (
    sessionId: string,
    messageId: string,
    updater: (msg: ChatMessage) => ChatMessage,
  ) => void;
  // Provider config
  providers: ProviderConfig[];
  activeProviderId: string;
  activeModelId: string;

  // Agent info
  defaultAgentId: string;
  toolIntegrationMode: AIToolIntegrationMode;
  externalAgents: ExternalAgentConfig[];
  setExternalAgents?: (value: ExternalAgentConfig[] | ((prev: ExternalAgentConfig[]) => ExternalAgentConfig[])) => void;
  agentModelMap: Record<string, string>;
  setAgentModel: (agentId: string, modelId: string) => void;

  // Safety
  globalPermissionMode: AIPermissionMode;
  setGlobalPermissionMode?: (mode: AIPermissionMode) => void;
  commandBlocklist?: string[];
  maxIterations?: number;

  // Web search
  webSearchConfig?: WebSearchConfig | null;

  // Context
  scopeType: 'terminal' | 'workspace';
  scopeTargetId?: string;
  scopeHostIds?: string[];
  scopeLabel?: string;

  // Terminal session context (from parent)
  terminalSessions?: Array<{
    sessionId: string;
    hostId: string;
    hostname: string;
    label: string;
    os?: string;
    username?: string;
    protocol?: string;
    shellType?: string;
    deviceType?: string;
    connected: boolean;
  }>;
  resolveExecutorContext?: (scope: {
    type: 'terminal' | 'workspace';
    targetId?: string;
    label?: string;
  }) => ExecutorContext;

  // Visibility
  isVisible?: boolean;
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// -------------------------------------------------------------------
// Component
// -------------------------------------------------------------------

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
  // ── Per-scope state ──
  // Derive scope key for per-scope isolation
  const scopeKey = `${scopeType}:${scopeTargetId ?? ''}`;

  const [showHistory, setShowHistory] = useState(false);
  const [runtimeAgentModelPresets, setRuntimeAgentModelPresets] = useState<Record<string, AgentModelPreset[]>>({});
  const [userSkillOptions, setUserSkillOptions] = useState<UserSkillOption[]>([]);
  const { openSettingsWindow } = useWindowControls();
  const terminalSessionsRef = useRef(terminalSessions);
  terminalSessionsRef.current = terminalSessions;
  const resolveExecutorContextRef = useRef(resolveExecutorContext);
  resolveExecutorContextRef.current = resolveExecutorContext;

  // ── Streaming hook ──
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

  // Proactively sync terminal session metadata to main process whenever scope or sessions change
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

  // When the resolved view is draft but activeSessionIdMap still points at a
  // previously-shown session, clear that stale entry. Otherwise
  // activeTerminalTargetIds keeps claiming ownership of the old session's
  // target and getSessionScopeMatchRank suppresses matching history from
  // other terminals until another action rewrites the map.
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

  // Sync provider configs to main process so it can decrypt API keys server-side.
  // Keys stay encrypted in transit; main process decrypts only when making HTTP requests.
  useEffect(() => {
    const bridge = getNetcattyBridge();
    if (bridge?.aiSyncProviders && providers.length > 0) {
      void bridge.aiSyncProviders(providers);
    }
  }, [providers]);

  // Sync web search config to main process (allowlist + encrypted API key for server-side decryption).
  // Note: This is fire-and-forget; if the first search fires before sync completes, it will fail
  // with a clear error and succeed on retry. Making this blocking would require async tool creation.
  useEffect(() => {
    const bridge = getNetcattyBridge();
    if (bridge?.aiSyncWebSearch) {
      void bridge.aiSyncWebSearch(webSearchConfig?.apiHost || null, webSearchConfig?.apiKey || null);
    }
  }, [webSearchConfig?.apiHost, webSearchConfig?.apiKey, webSearchConfig?.enabled]);

  // Preserve active streams across tab switches. The panel is conditionally
  // mounted per tab, so unmounting here should not cancel in-flight work.
  useEffect(() => {
    return () => {
      // no-op: stream lifecycle is managed by explicit stop/delete actions
    };
  }, []);

  // Agent discovery
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

  // ── Export hook ──
  const { handleExport } = useConversationExport(activeSession);

  // Active provider info
  const activeProvider = useMemo(
    () => providers.find((p) => p.id === activeProviderId),
    [providers, activeProviderId],
  );

  const providerDisplayName = activeProvider?.name ?? '';
  const modelDisplayName = activeModelId || activeProvider?.defaultModel || '';

  // Agent model presets for the current external agent
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

  // For Codex, pick up the model declared in ~/.codex/config.toml (if any)
  // so the picker can show just that model instead of the hardcoded ChatGPT
  // preset list. Probing codex-acp for its full catalog returns the stock
  // OpenAI models regardless of the active provider, which is misleading.
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
      // Only flip "resolved" to true when the probe confirms this is a
      // custom-config session; otherwise keep it false so we fall back to
      // the static CODEX_MODEL_PRESETS.
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
    // ACP agents can expose their runtime model catalog during session setup.
    // Codex also exposes model/reasoning selectors through ACP config options,
    // which keeps the picker aligned with the user's installed CLI version.
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
    ).then((result) => {
      if (cancelled || !result?.ok || !Array.isArray(result.models)) return;
      // If the probe came back empty, drop any stale cached catalog for this
      // agent so `agentModelPresets` falls back to the hardcoded presets via
      // the `?? getAgentModelPresets(...)` branch. Without this, a previously
      // successful probe would keep surfacing models the backend no longer
      // advertises.
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

  // When Codex is backed by a ~/.codex/config.toml custom provider, the
  // stock CODEX_MODEL_PRESETS catalog is invalid for that endpoint.
  // codexCustomConfigResolved (declared above alongside codexConfigModel)
  // stays false until the integration probe confirms this session is
  // custom-config, so we don't flash an empty picker while loading.
  const hasCodexCustomConfig = codexCustomConfigResolved && isCodexManagedAgent;

  const agentModelPresets = useMemo(() => {
    const runtimePresets = runtimeAgentModelPresets[currentAgentId];
    if (hasCodexCustomConfig) {
      if (runtimePresets) {
        return runtimePresets;
      }
      // Config.toml with a pinned model → show just that model.
      if (codexConfigModel) {
        return [{ id: codexConfigModel, name: codexConfigModel }];
      }
      // Config.toml custom provider without a pinned model → codex-acp
      // uses its provider default. Don't surface the OpenAI presets; they
      // wouldn't work. Empty list disables the picker.
      return [];
    }
    return runtimePresets ?? getAgentModelPresets(currentAgentConfig?.command);
  }, [currentAgentConfig?.command, currentAgentId, runtimeAgentModelPresets, hasCodexCustomConfig, codexConfigModel]);

  // Per-agent model: recall last selection or use first preset as default
  const selectedAgentModel = useMemo(() => {
    const stored = agentModelMap[currentAgentId];
    if (stored && modelPresetsContainId(agentModelPresets, stored)) {
      return stored;
    }
    // Default to first preset; for models with thinking levels, use the default level
    if (agentModelPresets.length > 0) {
      const first = agentModelPresets[0];
      if (first.thinkingLevels?.length) {
        return `${first.id}/${first.thinkingLevels[first.thinkingLevels.length - 1]}`;
      }
      return first.id;
    }
    return undefined;
  }, [currentAgentId, agentModelMap, agentModelPresets]);

  const handleAgentModelSelect = useCallback((modelId: string) => {
    setAgentModel(currentAgentId, modelId);
  }, [currentAgentId, setAgentModel]);

  // -------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------

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

  // -------------------------------------------------------------------
  // Shared helpers for handleSend sub-flows
  // -------------------------------------------------------------------

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

  // -------------------------------------------------------------------
  // Main send handler (thin orchestrator)
  // -------------------------------------------------------------------

  const handleSend = useCallback(async () => {
    const draft = currentDraftRef.current;
    const currentPanelView = panelViewRef.current;
    const currentSessionView = activeSessionRef.current;
    const trimmed = draft?.text.trim() ?? '';
    const sendScopeKey = scopeKey;
    // Double-submit protection currently relies on the draft being cleared
    // immediately after the first send path starts; `isStreaming` alone does
    // not protect the initial draft->session transition.
    if (!trimmed || isStreaming) return;
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
      const sendAgentId = currentSessionView?.agentId ?? draft?.agentId ?? currentAgentId;

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

      // No provider configured for built-in agent
      if (!isExternalAgent && !activeProvider) {
        addMessageToSession(sessionId, { id: generateId(), role: 'user', content: trimmed, timestamp: Date.now() });
        addMessageToSession(sessionId, { id: generateId(), role: 'assistant', content: t('ai.chat.noProvider'), timestamp: Date.now() });
        if (currentPanelView.mode === 'session') {
          clearScopeDraft();
          showScopeSessionView(sessionId);
        }
        return;
      }

      // Add user message
      addMessageToSession(sessionId, {
        id: generateId(), role: 'user', content: trimmed,
        ...(attachments.length > 0 ? { attachments } : {}),
        timestamp: Date.now(),
      });
      clearScopeDraft();
      showScopeSessionView(sessionId);
      setActiveSessionId(sessionId);
      setStreamingForScope(sessionId, true);

      // Create assistant message placeholder with a tracked ID
      const agentConfig = isExternalAgent ? externalAgents.find((agent) => agent.id === sendAgentId) : undefined;
      const assistantMsgId = generateId();
      addMessageToSession(sessionId, {
        id: assistantMsgId, role: 'assistant', content: '', timestamp: Date.now(),
        model: isExternalAgent
          ? (selectedAgentModel || agentConfig?.name || 'external')
          : (activeModelId || activeProvider?.defaultModel || ''),
        providerId: isExternalAgent ? undefined : activeProvider?.providerId,
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
          activeProvider,
          activeModelId,
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
    isStreaming, activeProvider, scopeKey, currentAgentId,
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
    // Clear statusText on the last message so stale status indicators disappear
    updateLastMessage(activeSessionId, msg => ({
      ...msg,
      statusText: '',
      executionStatus: msg.executionStatus === 'running' ? 'cancelled' : msg.executionStatus,
    }));
    // Clear pending approvals for this session (so tool execute functions don't hang)
    clearAllPendingApprovals(activeSessionId);
    // Cancel in-flight command executions (Catty Agent + ACP Agent)
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
      // Active session clearing is handled by deleteSession with scopeKey
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

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------

  if (!isVisible) return null;

  return (
    <div className="flex flex-col h-full bg-background" data-section="ai-chat-panel">
      {/* ── Header ── */}
      <div className="px-2.5 py-1.5 flex items-center justify-between border-b border-border/50 shrink-0">
        <AgentSelector
          currentAgentId={currentAgentId}
          externalAgents={externalAgents}
          discoveredAgents={discoveredAgents}
          isDiscovering={isDiscovering}
          onSelectAgent={handleAgentChange}
          onEnableDiscoveredAgent={handleEnableDiscoveredAgent}
          onRediscover={rediscover}
          onManageAgents={handleOpenSettings}
        />
        <div className="flex items-center gap-0.5">
          <ConversationExport
            session={activeSession}
            onExport={handleExport}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-md text-muted-foreground/62 hover:bg-white/[0.05] hover:text-foreground"
            onClick={() => setShowHistory(!showHistory)}
            title="Session history"
          >
            <History size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-md text-primary/82 hover:bg-primary/[0.10] hover:text-primary"
            onClick={handleNewChat}
            title="New chat"
          >
            <Plus size={15} />
          </Button>
        </div>
      </div>

      {/* ── Main content ── */}
      {showHistory ? (
        <SessionHistoryDrawer
          sessions={historySessions}
          activeSessionId={activeSessionId}
          onSelect={handleSelectSession}
          onDelete={handleDeleteSession}
          onClose={() => setShowHistory(false)}
        />
      ) : (
        <>
          {/* Chat messages */}
          <ChatMessageList
            messages={messages}
            isStreaming={isStreaming}
            activeSessionId={activeSessionId}
          />

          {/* Recent sessions (Zed-style, shown when no messages) */}
          {messages.length === 0 && historySessions.length > 0 && (
            <div className="shrink-0 px-4 pb-1">
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-[11px] text-muted-foreground/30 tracking-wide">{t('ai.chat.recent')}</span>
                <button
                  onClick={() => setShowHistory(true)}
                  className="text-[11px] text-muted-foreground/30 hover:text-muted-foreground/50 transition-colors cursor-pointer"
                >
                  {t('ai.chat.viewAll')}
                </button>
              </div>
              {historySessions.slice(0, 3).map((session) => (
                <button
                  key={session.id}
                  onClick={() => handleSelectSession(session.id)}
                  className="w-full flex items-baseline justify-between py-1.5 text-left hover:text-foreground transition-colors cursor-pointer"
                >
                  <span className="text-[13px] text-foreground/60 truncate pr-4">
                    {session.title || t('ai.chat.untitled')}
                  </span>
                  <span className="text-[11px] text-muted-foreground/25 shrink-0">
                    {formatRelativeTime(new Date(session.updatedAt), t)}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Input area */}
          <ChatInput
            value={inputValue}
            onChange={setInputValue}
            onSend={handleSend}
            onStop={handleStop}
            isStreaming={isStreaming}
            providerName={providerDisplayName}
            modelName={modelDisplayName}
            agentName={currentAgentId === 'catty' ? 'Catty Agent' : externalAgents.find(a => a.id === currentAgentId)?.name}
            modelPresets={agentModelPresets}
            selectedModelId={selectedAgentModel}
            onModelSelect={handleAgentModelSelect}
            files={files}
            onAddFiles={addFiles}
            onRemoveFile={removeFile}
            hosts={terminalSessions.map(s => ({ sessionId: s.sessionId, hostname: s.hostname, label: s.label, connected: s.connected }))}
            selectedUserSkills={selectedUserSkills}
            userSkills={userSkillOptions}
            onAddUserSkill={addSelectedUserSkill}
            onRemoveUserSkill={removeSelectedUserSkill}
            permissionMode={globalPermissionMode}
            onPermissionModeChange={setGlobalPermissionMode}
          />
        </>
      )}

    </div>
  );
};

// -------------------------------------------------------------------
// Session History Drawer
// -------------------------------------------------------------------

interface SessionHistoryDrawerProps {
  sessions: AISession[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onDelete: (e: React.MouseEvent, sessionId: string) => void;
  onClose: () => void;
}

const SessionHistoryDrawer: React.FC<SessionHistoryDrawerProps> = ({
  sessions,
  activeSessionId,
  onSelect,
  onDelete,
  onClose,
}) => {
  const { t } = useI18n();
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 py-2.5 flex items-center justify-between shrink-0 border-b border-border/30">
        <span className="text-[13px] font-medium text-foreground/80">{t('ai.chat.allSessions')}</span>
        <button
          onClick={onClose}
          className="text-[12px] text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-pointer"
        >
          <X size={14} />
        </button>
      </div>
      <ScrollArea className="flex-1">
        <div className="px-3">
          {sessions.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-[13px] text-muted-foreground/40">
                {t('ai.chat.noSessions')}
              </p>
            </div>
          ) : (
            sessions.map((session) => {
              const isActive = session.id === activeSessionId;
              const time = new Date(session.updatedAt);
              const timeStr = formatRelativeTime(time, t);

              return (
                <div
                  key={session.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(session.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(session.id); }}
                  className={cn(
                    SESSION_HISTORY_ROW_CLASSNAMES.row,
                    isActive ? 'text-foreground' : 'text-foreground/70 hover:text-foreground',
                  )}
                >
                  <span className={SESSION_HISTORY_ROW_CLASSNAMES.title}>
                    {session.title || t('ai.chat.untitled')}
                  </span>
                  <div className={SESSION_HISTORY_ROW_CLASSNAMES.meta}>
                    <span className={SESSION_HISTORY_ROW_CLASSNAMES.time}>
                      {timeStr}
                    </span>
                    <button
                      onClick={(e) => onDelete(e, session.id)}
                      className={SESSION_HISTORY_ROW_CLASSNAMES.deleteButton}
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function formatRelativeTime(date: Date, t: (key: string) => string): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (minutes < 1) return t('ai.chat.justNow');
  if (minutes < 60) return t('ai.chat.minutesAgo').replace('{n}', String(minutes));
  if (hours < 24) return t('ai.chat.hoursAgo').replace('{n}', String(hours));
  if (days < 7) return t('ai.chat.daysAgo').replace('{n}', String(days));
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// -------------------------------------------------------------------
// Export
// -------------------------------------------------------------------

const AIChatSidePanel = React.memo(AIChatSidePanelInner);
AIChatSidePanel.displayName = 'AIChatSidePanel';

export default AIChatSidePanel;
export { AIChatSidePanel };
export type { AIChatSidePanelProps };
