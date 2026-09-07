

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useI18n } from '../application/i18n/I18nProvider';
import { useWindowControls } from '../application/state/useWindowControls';
import type {
  AIDraft,
  AIPanelView,
  AgentModelPreset,
  AISessionScope,
  UploadedFile,
  DiscoveredAgent,
  ExternalAgentConfig,
} from '../infrastructure/ai/types';
import type { VaultNote } from '../domain/models';
import type { ExecutorContext } from '../infrastructure/ai/cattyAgent/executor';
import {
  filterAgentModelPresetsForCliVersion,
  getAgentModelPresets,
  resolveAgentCliVersion,
  resolveAgentModelSelection,
} from '../infrastructure/ai/types';
import { getExternalAgentSdkBackend, getManualAgentCommand, matchesManagedAgentConfig } from '../infrastructure/ai/managedAgents';
import { toast } from './ui/toast';
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
  resolveDisplayedPanelView,
  resolveDisplayedSession,
  shouldForceDraftViewSync,
} from './ai/aiPanelViewState';
import {
  endSendForKey,
  tryBeginSendForKey,
} from './ai/draftSendGate';
import { draftsByScopeEqualIgnoringComposerText, selectDraftForAgentSwitch } from '../application/state/aiDraftState';
import { sanitizeContextWindow } from '../infrastructure/ai/contextCompaction';
import {
  buildPromptWithTerminalSelectionAttachments,
  isInlineTextAttachment,
} from '../application/state/terminalSelectionAttachment';
import { createVaultNoteAttachment, isVaultNoteAttachment, vaultNoteReferencesFit } from '../application/state/vaultNoteAttachment';
import type { CodexIntegrationStatus } from './settings/tabs/ai/types';
import {
  useAIChatStreaming,
  getNetcattyBridge,
  isAIChatSessionStreaming,
  type DefaultTargetSessionHint,
} from '../application/state/useAIChatStreaming';
import { getScopedHistorySessions } from './ai/scopedHistorySessions';
import { resolveInheritedAIActiveSessionId } from '../domain/aiWorkspaceScopeInherit';
import { aiSessionIdSetEqual, exactScopeAISessionsEqual } from '../domain/aiSessionsForScope';
import { buildExternalAgentHistoryMessagesForBridge } from './ai/externalAgentHistory';
import { canSendWithAgent, findEnabledExternalAgent } from './ai/agentSendEligibility';
import { registerGrantPersister } from '../infrastructure/ai/shared/approvalGate';
import { stopAgentTurn } from '../infrastructure/ai/harness/agentStop';
import { getAgentRuntime } from '../infrastructure/ai/harness/globalAgentRuntime';
import { useAIPermissionGrantsState } from '../application/state/useAIPermissionGrantsState';
import { useConversationExport } from './ai/hooks/useConversationExport';
import { useAgentContextUsage } from '../application/state/useAgentCompactionUi';
import type { AIChatSidePanelProps } from './AIChatSidePanel.types';
import {
  buildCursorListModelsAgentEnv,
  buildSdkRuntimeModelCacheKey,
  sdkRuntimeModelCache,
  generateId,
  agentModelPresetsShallowEqual,
  mergeFallbackThinkingLevels,
  normalizeStoredAgentModelSelection,
  normalizeSdkRuntimeModelPresets,
  shouldAdoptSdkCurrentModel,
  shouldLoadSdkRuntimeModels,
  shouldUseStoredAgentModel,
  type SdkRuntimeModelCatalog,
} from './AIChatSidePanelHelpers';
import { AIChatPanelContent } from './AIChatPanelContent';
import { TERMINAL_SIDE_PANEL_INNER_HEADER_CLASS } from './terminalLayer/terminalSidePanelChrome';
import {
  getAIPanelProfilerProps,
  profileAIPanelCalculation,
} from './ai/aiPanelDiagnostics';
import { scheduleWhenAiComposerIdle, warmAiMarkdownRenderer } from './ai/aiMarkdownWarmup';

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
  codexRuntime?: 'sdk' | 'app-server';
};
type SteerWarning = {
  reason: 'not-steerable' | 'busy' | 'inactive' | 'unsupported' | 'cancelled' | 'failed';
  turnKind?: 'review' | 'compact';
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

function shouldDelayAIChatSidePanelActivation(_props: AIChatSidePanelProps): boolean {
  // Empty-panel activation delay used to land in the expand → first-type window.
  return false;
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
      <div className={`${TERMINAL_SIDE_PANEL_INNER_HEADER_CLASS} border-b border-border/50 px-2 flex items-center`}>
        <div className="h-6 w-32 rounded-md bg-muted/45" />
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
  persistContextCompaction,
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
  agentThinkingMap,
  setAgentThinking,
  updateProvider,
  globalPermissionMode,
  setGlobalPermissionMode,
  commandBlocklist,
  commandTimeout,
  responseIdleTimeout,
  maxIterations = 20,
  webSearchConfig,
  quickMessages = [],
  scopeType,
  scopeTargetId,
  scopeHostIds,
  scopeLabel,
  focusedSessionId,
  terminalSessions = [],
  resolveExecutorContext,
  isVisible = true,
  notes = [],
  hosts = [],
  snippets = [],
  onOpenVaultNote,
  onOpenVaultHost,
  onOpenVaultSnippet,
  onOpenVaultSection,
}) => {
  const { t } = useI18n();
  const scopeKey = `${scopeType}:${scopeTargetId ?? ''}`;

  const [showHistory, setShowHistory] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [runtimeAgentModelPresets, setRuntimeAgentModelPresets] = useState<Record<string, AgentModelPreset[]>>({});
  const [runtimeModelWarnings, setRuntimeModelWarnings] = useState<Record<string, string>>({});
  const [steerWarnings, setSteerWarnings] = useState<Record<string, SteerWarning>>({});
  const [steeringSessionId, setSteeringSessionId] = useState<string | null>(null);
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
    steerExternalAgent,
    reportStreamError,
    activeCompaction,
  } = useAIChatStreaming({
    maxIterations,
    addMessageToSession,
    updateLastMessage,
    updateMessageById,
    persistContextCompaction,
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

  const workspaceMemberTerminalIds = useMemo(() => {
    if (scopeType !== 'workspace') return undefined;
    return new Set(
      terminalSessions
        .map((session) => session.sessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    );
  }, [scopeType, terminalSessions]);

  // Use live sessions for history + view resolution. Deferring the list used to
  // lag one paint behind createSession, so normalizePanelView treated the new
  // chat as missing and the draft-sync effect forced showDraftView — which
  // parked the just-sent session into history under StrictMode.
  const historySessions = useMemo(
    () => profileAIPanelCalculation(
      'AIChatSidePanel.historySessions',
      () => getScopedHistorySessions(
        sessions,
        scopeType,
        scopeTargetId,
        scopeHostIds,
        activeTerminalSessionIds,
        workspaceMemberTerminalIds,
        activeSessionIdMap,
      ),
    ),
    [sessions, scopeType, scopeTargetId, scopeHostIds, activeTerminalSessionIds, workspaceMemberTerminalIds, activeSessionIdMap],
  );

  const explicitPanelView = panelViewByScope[scopeKey];
  const currentDraft = draftsByScope[scopeKey] ?? null;
  const pendingComposerTextRef = useRef<string | null>(null);
  const visibleHistorySessionIds = useMemo(
    () => new Set(historySessions.map((session) => session.id)),
    [historySessions],
  );
  const persistedSessionId = resolveInheritedAIActiveSessionId({
    scopeType,
    scopeTargetId,
    activeSessionIdMap,
    memberTerminalIds: terminalSessions.map((session) => session.sessionId).filter(Boolean),
    preferredTerminalId: focusedSessionId,
    visibleSessionIds: visibleHistorySessionIds,
  });
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
  const isSteering = activeSessionId != null && steeringSessionId === activeSessionId;
  const currentAgentId = activeSession?.agentId ?? currentDraft?.agentId ?? defaultAgentId;
  const observedContextUsage = useAgentContextUsage(activeSessionId);
  const inputValue = pendingComposerTextRef.current ?? currentDraft?.text ?? '';
  const files = currentDraft?.attachments ?? [];
  const panelViewRef = useRef(normalizedPanelView);
  panelViewRef.current = normalizedPanelView;
  const permissionModeRef = useRef(globalPermissionMode);
  permissionModeRef.current = globalPermissionMode;
  const sendEpochRef = useRef(0);
  useEffect(() => () => {
    sendEpochRef.current += 1;
  }, [scopeKey]);
  const currentDraftRef = useRef(currentDraft);
  if (pendingComposerTextRef.current != null) {
    const pending = pendingComposerTextRef.current;
    if (currentDraft && currentDraft.text === pending) {
      pendingComposerTextRef.current = null;
      currentDraftRef.current = currentDraft;
    } else if (currentDraftRef.current?.text === pending) {
      if (currentDraft && currentDraftRef.current) {
        currentDraftRef.current.attachments = currentDraft.attachments;
        currentDraftRef.current.selectedUserSkillSlugs = currentDraft.selectedUserSkillSlugs;
        currentDraftRef.current.agentId = currentDraft.agentId;
      }
    } else {
      const base = currentDraft ?? currentDraftRef.current ?? {
        text: '',
        agentId: currentAgentId,
        attachments: [],
        selectedUserSkillSlugs: [],
        updatedAt: Date.now(),
      };
      currentDraftRef.current = { ...base, text: pending };
    }
  } else {
    currentDraftRef.current = currentDraft;
  }
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;

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

    return scheduleWhenAiComposerIdle(() => {
      void bridge.aiMcpUpdateSessions(terminalSessions, activeSessionId ?? undefined);
    }, { initialDelayMs: 250 });
  }, [isVisible, terminalSessions, activeSessionId]);

  useEffect(() => {
    if (!isVisible) return;
    // Predicate must match normalizePanelView's list (scoped history), not the
    // global store — out-of-scope sessions must still demote to draft.
    if (!shouldForceDraftViewSync(
      explicitPanelView,
      normalizedPanelView,
      (sessionId) => historySessions.some((session) => session.id === sessionId),
    )) {
      return;
    }
    showDraftView(scopeKey);
  }, [isVisible, normalizedPanelView, explicitPanelView, scopeKey, historySessions, showDraftView]);

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
    // Keep ownership while an explicit session is still displayable in this
    // scope (normalize has not demoted it). Out-of-scope / missing ids clear.
    if (
      explicitPanelView?.mode === 'session'
      && historySessions.some((session) => session.id === explicitPanelView.sessionId)
    ) {
      return;
    }
    if (persistedSessionId == null) return;
    setActiveSessionId(null);
  }, [
    isVisible,
    normalizedPanelView.mode,
    explicitPanelView,
    historySessions,
    persistedSessionId,
    setActiveSessionId,
  ]);

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

  const discardPendingComposerText = useCallback(() => {
    pendingComposerTextRef.current = null;
  }, []);

  const clearScopeDraft = useCallback((options?: { keepPendingText?: boolean }) => {
    if (!options?.keepPendingText) discardPendingComposerText();
    clearDraftForScope(scopeKey);
  }, [clearDraftForScope, discardPendingComposerText, scopeKey]);

  const enterScopeDraftMode = useCallback((agentId: string, preserveSessionView = false) => {
    applyDraftEntrySelection({
      ensureDraft: () => ensureScopeDraft(agentId),
      showDraftView: showScopeDraftView,
      preserveSessionView,
    });
  }, [ensureScopeDraft, showScopeDraftView]);

  const flushDraftText = useCallback(() => {
    const pending = pendingComposerTextRef.current;
    if (pending == null) return;
    if (panelViewRef.current.mode !== 'draft') {
      enterScopeDraftMode(currentAgentId, panelViewRef.current.mode === 'session');
    }
    updateScopeDraft(currentAgentId, (current) => (
      current.text === pending ? current : { ...current, text: pending }
    ));
  }, [currentAgentId, enterScopeDraftMode, updateScopeDraft]);

  const setInputValue = useCallback((value: string) => {
    const base = currentDraftRef.current ?? {
      text: '',
      agentId: currentAgentId,
      attachments: [],
      selectedUserSkillSlugs: [],
      updatedAt: Date.now(),
    };
    pendingComposerTextRef.current = value;
    currentDraftRef.current = { ...base, text: value, updatedAt: Date.now() };
  }, [currentAgentId]);

  const addFiles = useCallback(async (inputFiles: File[]) => {
    enterScopeDraftMode(currentAgentId, panelViewRef.current.mode === 'session');
    await addDraftFiles(scopeKey, currentAgentId, inputFiles);
  }, [addDraftFiles, currentAgentId, enterScopeDraftMode, scopeKey]);

  const removeFile = useCallback((fileId: string) => {
    removeDraftFile(scopeKey, currentAgentId, fileId);
  }, [removeDraftFile, scopeKey, currentAgentId]);

  // External turns keep the tools from launch; changed settings cannot enable note reads mid-turn.
  const canMentionNotes = currentAgentId === 'catty' || (toolIntegrationMode === 'mcp' && !isStreaming);
  const validateNoteMentions = useCallback((attachments: UploadedFile[]) => {
    if (!canMentionNotes && attachments.some(isVaultNoteAttachment)) {
      toast.warning(t('ai.chat.mentionNoteUnavailable'));
      return false;
    }
    if (!vaultNoteReferencesFit(attachments)) {
      toast.warning(t('ai.chat.mentionNoteTooMany'));
      return false;
    }
    return true;
  }, [canMentionNotes, t]);

  /** Mention Note: attach a Vault → Notes entry as inline context for the next send. */
  const mentionNote = useCallback((note: VaultNote) => {
    if (!canMentionNotes) return;
    const upload = createVaultNoteAttachment({ id: note.id, title: note.title.trim() || t('ai.chat.untitledNote') });
    if (!upload) {
      toast.error(t('ai.chat.mentionNoteInvalid', {
        title: String(note.title || '').trim() || t('ai.chat.untitledNote'),
      }));
      return;
    }
    const existing = currentDraftRef.current?.attachments ?? [];
    if (!validateNoteMentions([...existing.filter((file) => file.vaultNoteId !== upload.vaultNoteId), upload])) return;
    enterScopeDraftMode(currentAgentId, panelViewRef.current.mode === 'session');
    updateDraft(scopeKey, currentAgentId, (current) => ({
      ...current,
      attachments: [
        ...current.attachments.filter((file) => file.vaultNoteId !== upload.vaultNoteId),
        upload,
      ],
    }));
  }, [canMentionNotes, validateNoteMentions, updateDraft, currentAgentId, enterScopeDraftMode, scopeKey, t]);

  useEffect(() => {
    if (isVisible) return undefined;
    flushDraftText();
    return undefined;
  }, [flushDraftText, isVisible]);

  useEffect(() => () => {
    flushDraftText();
  }, [flushDraftText, scopeKey]);

  useEffect(() => {
    flushDraftText();
  }, [activeSessionId, flushDraftText]);

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
    const cancelIdle = scheduleWhenAiComposerIdle(() => {
      void loadUserSkillsStatus(bridge)
        .then((result) => {
          if (cancelled) return;
          if (result === undefined) return;
          applyUserSkillsStatus(result);
        })
        .catch(() => {});
    });

    return () => {
      cancelled = true;
      cancelIdle();
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
    if (!bridge?.aiSyncProviders || providers.length === 0) return;
    void bridge.aiSyncProviders(providers);
  }, [isVisible, providers]);

  useEffect(() => {
    if (!isVisible) return;
    const bridge = getNetcattyBridge();
    if (!bridge?.aiSyncWebSearch) return;
    void bridge.aiSyncWebSearch(webSearchConfig?.apiHost || null, webSearchConfig?.apiKey || null);
  }, [isVisible, webSearchConfig?.apiHost, webSearchConfig?.apiKey, webSearchConfig?.enabled]);

  const {
    discoveredAgents,
    isDiscovering,
    rediscover,
    enableAgent,
  } = useAgentDiscovery(externalAgents, setExternalAgents, {
    enabled: isVisible,
    schedule: scheduleWhenAiComposerIdle,
  });

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

  // Hide the ring until a real context_snapshot arrives. A synthetic 0% fallback
  // misleads users when reopening long sessions (looks empty until the next turn).
  const contextUsage = currentAgentId === 'catty' ? observedContextUsage : null;

  // Catty-only manual compact. External agents own their own compaction.
  // No minimum message count: short sessions may still run /compact (even if
  // there is little to summarize).
  const canCompact = currentAgentId === 'catty'
    && Boolean(activeSessionId)
    && !isStreaming
    && Boolean(effectiveActiveProvider)
    && Boolean(effectiveActiveModelId.trim());

  const providersRef = useRef(providers);
  providersRef.current = providers;

  const handleAgentProviderModelSelect = useCallback(
    (providerId: string, modelId: string, contextWindow?: number) => {
      setAgentProvider(currentAgentId, providerId);
      setAgentModel(currentAgentId, modelId);
      const sanitized = sanitizeContextWindow(contextWindow);
      if (!updateProvider || sanitized == null) return;
      const provider = providersRef.current.find((item) => item.id === providerId);
      if (!provider) return;
      if (provider.modelContextWindows?.[modelId] === sanitized) return;
      updateProvider(providerId, {
        modelContextWindows: {
          ...(provider.modelContextWindows ?? {}),
          [modelId]: sanitized,
        },
      });
    },
    [currentAgentId, setAgentProvider, setAgentModel, updateProvider],
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
    return () => {
      cancelled = true;
    };
  }, [isVisible, isCodexManagedAgent, currentAgentId, currentAgentConfig]);

  const agentModelMapRef = useRef(agentModelMap);
  agentModelMapRef.current = agentModelMap;

  const buildExternalAgentRuntimeModelTarget = useCallback((agent: ExternalAgentConfig | undefined): SdkRuntimeModelTarget | null => {
    if (!agent) return null;
    const sdkBackend = getExternalAgentSdkBackend(agent);
    if (!sdkBackend) return null;
    // Cursor: re-inject auth mode for list-models (same as run-turn). Persisted
    // agent.env strips NETCATTY_CURSOR_*; without this, main defaults to api-key
    // and the UI falls back to curated CURSOR_MODEL_PRESETS (#2562).
    const agentEnv = sdkBackend === 'cursor'
      ? buildCursorListModelsAgentEnv(agent)
      : agent.env;
    return {
      agentId: agent.id,
      cacheKey: buildSdkRuntimeModelCacheKey({ ...agent, env: agentEnv }),
      sdkBackend,
      agentEnv,
      agentCommand: getManualAgentCommand(agent),
      codexRuntime: sdkBackend === 'codex' ? (agent.codexRuntime ?? 'sdk') : undefined,
    };
  }, []);

  const externalAgentsRef = useRef(externalAgents);
  externalAgentsRef.current = externalAgents;

  const applySdkRuntimeModelCatalog = useCallback((
    agentId: string,
    catalog: SdkRuntimeModelCatalog,
    options: { adoptCurrentModel?: boolean } = {},
  ) => {
    const agent = externalAgentsRef.current.find((item) => item.id === agentId);
    const runtimePresets = mergeFallbackThinkingLevels(
      normalizeSdkRuntimeModelPresets(catalog.models, catalog.currentModelId),
      getAgentModelPresets(agent?.command, getExternalAgentSdkBackend(agent)),
    );
    const storedModelId = agentModelMapRef.current[agentId];
    if (runtimePresets.length === 0) {
      setRuntimeAgentModelPresets((prev) => {
        if (!(agentId in prev)) return prev;
        const { [agentId]: _removed, ...rest } = prev;
        return rest;
      });
    } else {
      setRuntimeAgentModelPresets((prev) => (
        agentModelPresetsShallowEqual(prev[agentId], runtimePresets)
          ? prev
          : { ...prev, [agentId]: runtimePresets }
      ));
    }

    const normalizedStoredModelId = normalizeStoredAgentModelSelection(
      storedModelId,
      runtimePresets,
    );
    if (normalizedStoredModelId && normalizedStoredModelId !== storedModelId) {
      setAgentModel(agentId, normalizedStoredModelId);
      return;
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
          target.codexRuntime,
        );
        if (!result?.ok || !Array.isArray(result.models)) {
          throw new Error(result?.error || 'Failed to load SDK agent models');
        }
        setRuntimeModelWarnings((current) => {
          const next = { ...current };
          if (result.warning && target.codexRuntime === 'app-server') {
            next[target.agentId] = t('ai.codex.appServer.modelCatalogWarning');
            console.warn('[AIChatSidePanel] Codex App Server model catalog unavailable:', result.warning);
          } else {
            delete next[target.agentId];
          }
          return next;
        });
        return {
          currentModelId: result.currentModelId ?? null,
          models: result.models,
        };
      },
      { force: options.force },
    ).catch((err) => {
      if (target.codexRuntime === 'app-server') {
        setRuntimeModelWarnings((current) => ({
          ...current,
          [target.agentId]: t('ai.codex.appServer.modelCatalogWarning'),
        }));
      }
      if (options.logErrors !== false) {
        console.warn('[AIChatSidePanel] Failed to load SDK agent models:', err);
      }
      return null;
    });
  }, [t]);

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

    // Respect renderer TTL / in-flight coalescing for all SDK agents including
    // OpenCode. Forced refresh used to re-spawn opencode on every effect re-run
    // even when the user never selected OpenCode (#2184). Manual refresh still
    // passes force via the model selector path. Defer the network refresh so
    // expand → first type does not wait on CLI model listing.
    let cancelled = false;
    const cancelIdle = scheduleWhenAiComposerIdle(() => {
      void loadSdkRuntimeModelCatalog(target).then((catalog) => {
        if (cancelled || !catalog) return;
        applySdkRuntimeModelCatalog(target.agentId, catalog, { adoptCurrentModel: true });
      });
    });

    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [
    isVisible,
    currentAgentConfig,
    isCodexManagedAgent,
    buildExternalAgentRuntimeModelTarget,
    loadSdkRuntimeModelCatalog,
    applySdkRuntimeModelCatalog,
  ]);

  const isCodexAppServer = isCodexManagedAgent && currentAgentConfig?.codexRuntime === 'app-server';
  const canSteerCurrentTurn = Boolean(activeSessionId && isStreaming && isCodexAppServer);
  const hasCodexCustomConfig = codexCustomConfigResolved && isCodexManagedAgent && !isCodexAppServer;

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
    if (runtimePresets) return runtimePresets;
    const presets = getAgentModelPresets(
      currentAgentConfig?.command,
      getExternalAgentSdkBackend(currentAgentConfig),
    );
    // BYO Codex CLI: hide GPT-5.6 when CLI < 0.144.0 (stored probe or discovery).
    const cliVersion = resolveAgentCliVersion(currentAgentConfig, discoveredAgents);
    return filterAgentModelPresetsForCliVersion(presets, cliVersion);
  }, [
    currentAgentConfig,
    currentAgentId,
    runtimeAgentModelPresets,
    hasCodexCustomConfig,
    codexConfigModel,
    discoveredAgents,
  ]);

  const selectedAgentModel = useMemo(() => {
    const stored = agentModelMap[currentAgentId];
    if (shouldUseStoredAgentModel(stored, agentModelPresets, currentAgentConfig)) {
      return normalizeStoredAgentModelSelection(stored, agentModelPresets) ?? stored;
    }
    if (agentModelPresets.length > 0) {
      // Cursor CLI login defaults to `auto` (subscription quota routing).
      if (currentAgentConfig?.cursorAuthMode === 'cli-login') {
        const autoPreset = agentModelPresets.find((preset) => preset.id === 'auto');
        if (autoPreset) return resolveAgentModelSelection(autoPreset);
      }
      // Use catalog defaultThinkingLevel — do not pick last array entry
      // (that made GPT-5.6 Sol default to ultra).
      return resolveAgentModelSelection(agentModelPresets[0]);
    }
    return undefined;
  }, [currentAgentConfig, currentAgentId, agentModelMap, agentModelPresets]);

  const inputAgentId = activeSession?.agentId ?? currentDraft?.agentId ?? currentAgentId;
  const canSendCurrentAgent = useMemo(
    () => !isSending && canSendWithAgent(inputAgentId, externalAgents),
    [inputAgentId, externalAgents, isSending],
  );

  const handleAgentModelSelect = useCallback((modelId: string) => {
    setAgentModel(currentAgentId, modelId);
  }, [currentAgentId, setAgentModel]);

  const selectedCattyThinking = agentThinkingMap.catty;
  const handleCattyThinkingSelect = useCallback((level: string) => {
    setAgentThinking('catty', level);
  }, [setAgentThinking]);


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
    if (!validateNoteMentions(draft?.attachments ?? [])) return;
    const trimmed = draft?.text.trim() ?? '';
    const sendScopeKey = scopeKey;
    const attachments = (draft?.attachments ?? []).map((file) => ({
      base64Data: file.base64Data,
      mediaType: file.mediaType,
      filename: file.filename,
      filePath: file.filePath,
      terminalSelection: file.terminalSelection,
      vaultNoteId: file.vaultNoteId,
      vaultNoteTitle: file.vaultNoteTitle,
      previewText: file.previewText,
      lineCount: file.lineCount,
    }));
    const hasInlineTextAttachments = attachments.some(isInlineTextAttachment);
    if ((!trimmed && !hasInlineTextAttachments) || isStreaming) return;
    // Note-only sends (empty text + a mentioned note) still need a usable
    // session title: fall back to the first mentioned note's title so these
    // conversations don't all show up as "Untitled" in history.
    const noteOnlyTitle = attachments.find(
      (attachment) => isVaultNoteAttachment(attachment) && attachment.vaultNoteTitle,
    )?.vaultNoteTitle ?? '';
    const titleText = trimmed || noteOnlyTitle.trim();
    const sendAgentId = currentSessionView?.agentId ?? draft?.agentId ?? currentAgentId;
    const agentConfig = sendAgentId !== 'catty' ? findEnabledExternalAgent(externalAgents, sendAgentId) : undefined;
    if (sendAgentId !== 'catty' && !agentConfig) return;

    const selectedSkillSlugs = draft?.selectedUserSkillSlugs ?? [];
    const modelPrompt = buildPromptWithTerminalSelectionAttachments(trimmed, attachments);
    const modelAttachments = attachments.filter((attachment) => !isInlineTextAttachment(attachment));
    const isDraftMode = currentPanelView.mode === 'draft';

    flushDraftText();
    const submittedText = draft?.text ?? '';
    const keepPendingAfterSend = () => {
      const pending = pendingComposerTextRef.current;
      return pending != null && pending !== submittedText;
    };
    const sendGateKey = currentSessionView?.id ?? `draft:${scopeKey}`;
    if (!tryBeginSendForKey(sendGateKey)) {
      return;
    }
    let sessionSendGateKey: string | null = null;
    const sendEpoch = sendEpochRef.current;
    const isSendStale = () => sendEpochRef.current !== sendEpoch;
    setIsSending(true);

    try {
      const sendBridge = getNetcattyBridge();
      if (sendBridge?.aiSyncProviders && providers.length > 0) {
        await sendBridge.aiSyncProviders(providers);
      }
      if (sendBridge?.aiSyncWebSearch) {
        await sendBridge.aiSyncWebSearch(webSearchConfig?.apiHost || null, webSearchConfig?.apiKey || null);
      }
      let sendSelectedAgentModel = selectedAgentModel;
      if (currentAgentConfig && shouldLoadSdkRuntimeModels(currentAgentConfig)) {
        const runtimeTarget = buildExternalAgentRuntimeModelTarget(currentAgentConfig);
        if (runtimeTarget) {
          const catalog = await loadSdkRuntimeModelCatalog(runtimeTarget);
          if (catalog) {
            applySdkRuntimeModelCatalog(runtimeTarget.agentId, catalog, { adoptCurrentModel: true });
            const runtimePresets = mergeFallbackThinkingLevels(
              normalizeSdkRuntimeModelPresets(catalog.models, catalog.currentModelId),
              getAgentModelPresets(
                currentAgentConfig.command,
                getExternalAgentSdkBackend(currentAgentConfig),
              ),
            );
            const storedModelId = agentModelMapRef.current[sendAgentId];
            if (
              catalog.currentModelId
              && shouldAdoptSdkCurrentModel(catalog.currentModelId, storedModelId, runtimePresets)
            ) {
              sendSelectedAgentModel = catalog.currentModelId;
            } else if (shouldUseStoredAgentModel(storedModelId, runtimePresets)) {
              sendSelectedAgentModel = normalizeStoredAgentModelSelection(
                storedModelId,
                runtimePresets,
              ) ?? storedModelId ?? sendSelectedAgentModel;
            } else if (runtimePresets[0]) {
              sendSelectedAgentModel = resolveAgentModelSelection(runtimePresets[0]);
            }
          }
        }
      }
      setIsSending(false);
      const sendPermissionMode = permissionModeRef.current;
      if (isSendStale()) return;
      if (currentAgentId !== sendAgentId) return;
      const liveView = panelViewRef.current;
      if (liveView.mode !== currentPanelView.mode) return;
      if (
        currentPanelView.mode === 'session'
        && liveView.mode === 'session'
        && liveView.sessionId !== currentPanelView.sessionId
      ) {
        return;
      }
      void warmAiMarkdownRenderer();
      let sessionId = currentSessionView?.id ?? null;
      let currentSession = currentSessionView ?? null;
      if (isDraftMode) {
        const scope: AISessionScope = { type: scopeType, targetId: scopeTargetId, hostIds: scopeHostIds };
        const createdSession = createSession(scope, sendAgentId);
        sessionId = createdSession.id;
        currentSession = createdSession;
        clearScopeDraft({ keepPendingText: keepPendingAfterSend() });
        showScopeSessionView(createdSession.id);
        setActiveSessionId(createdSession.id);
        sessionSendGateKey = sessionId;
        if (!tryBeginSendForKey(sessionSendGateKey)) {
          return;
        }
      }

      if (!sessionId) {
        return;
      }

      if (isAIChatSessionStreaming(sessionId)) {
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
          clearScopeDraft({ keepPendingText: keepPendingAfterSend() });
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
          clearScopeDraft({ keepPendingText: keepPendingAfterSend() });
          showScopeSessionView(sessionId);
        }
        return;
      }

      addMessageToSession(sessionId, {
        id: generateId(), role: 'user', content: trimmed,
        ...(attachments.length > 0 ? { attachments } : {}),
        timestamp: Date.now(),
      });
      clearScopeDraft({ keepPendingText: keepPendingAfterSend() });
      showScopeSessionView(sessionId);
      setActiveSessionId(sessionId);
      setStreamingForScope(sessionId, true);

      const assistantMsgId = generateId();
      addMessageToSession(sessionId, {
        id: assistantMsgId, role: 'assistant', content: '', timestamp: Date.now(),
        model: isExternalAgent
          ? (sendSelectedAgentModel || agentConfig?.name || 'external')
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
          await sendToExternalAgent(sessionId, assistantMsgId, modelPrompt, agentConfig, abortController, modelAttachments, {
            existingSessionId: existingExternalSessionId,
            updateExternalSessionId: updateSessionExternalSessionId,
            historyMessages: buildExternalAgentHistoryMessagesForBridge(currentSession?.messages ?? [], existingExternalSessionId),
            terminalSessions,
            defaultTargetSession,
            providers,
            selectedAgentModel: sendSelectedAgentModel,
            toolIntegrationMode,
            selectedUserSkillSlugs: selectedSkillSlugs,
            permissionMode: sendPermissionMode,
          });
        } catch (err) {
          reportStreamError(sessionId, abortController.signal, err);
        }
        updateLastMessage(sessionId, msg => msg.statusText ? { ...msg, statusText: '' } : msg);
        setStreamingForScope(sessionId, false);
        abortControllersRef.current.delete(sessionId);
        autoTitleSession(sessionId, titleText);
      } else {
        const toolScope = {
          type: scopeType,
          targetId: scopeTargetId,
          label: scopeLabel,
        } as const;
        await sendToCattyAgent(sessionId, sendScopeKey, modelPrompt, abortController, currentSession ?? undefined, assistantMsgId, {
          activeProvider: sendActiveProvider,
          activeModelId: sendActiveModelId,
          reasoningEffort: selectedCattyThinking,
          scopeType,
          scopeTargetId,
          scopeLabel,
          globalPermissionMode: sendPermissionMode,
          commandBlocklist,
          commandTimeout,
          responseIdleTimeout,
          terminalSessions,
          webSearchConfig,
          getExecutorContext: () => buildExecutorContextForScope(toolScope),
          autoTitleSession,
          selectedUserSkillSlugs: selectedSkillSlugs,
          titleText,
        }, modelAttachments.length > 0 ? modelAttachments : undefined);
      }
    } finally {
      setIsSending(false);
      endSendForKey(sendGateKey);
      if (sessionSendGateKey && sessionSendGateKey !== sendGateKey) {
        endSendForKey(sessionSendGateKey);
      }
    }
  }, [
    validateNoteMentions,
    isStreaming, activeProvider, effectiveActiveProvider, effectiveActiveModelId, selectedCattyThinking, scopeKey, currentAgentId,
    activeModelId, externalAgents,
    createSession, addMessageToSession, updateMessageById, updateLastMessage,
    setStreamingForScope,
    sendToExternalAgent, sendToCattyAgent, reportStreamError, autoTitleSession, t,
    abortControllersRef, terminalSessions, defaultTargetSession, providers, selectedAgentModel, updateSessionExternalSessionId,
    scopeType, scopeTargetId, scopeHostIds, scopeLabel, commandBlocklist, commandTimeout, responseIdleTimeout, webSearchConfig, buildExecutorContextForScope,
    toolIntegrationMode,
    clearScopeDraft, showScopeSessionView, setActiveSessionId,
    flushDraftText, currentAgentConfig, buildExternalAgentRuntimeModelTarget,
    loadSdkRuntimeModelCatalog, applySdkRuntimeModelCatalog,
  ]);

  const handleCompact = useCallback(async () => {
    const session = activeSessionRef.current;
    if (
      currentAgentId !== 'catty'
      || !session
      || isStreaming
      || isAIChatSessionStreaming(session.id)
      || !effectiveActiveProvider
      || !effectiveActiveModelId.trim()
    ) {
      return;
    }

    if (!tryBeginSendForKey(session.id)) return;

    const controller = new AbortController();
    abortControllersRef.current.set(session.id, controller);
    setStreamingForScope(session.id, true);
    try {
      await sendToCattyAgent(
        session.id,
        scopeKey,
        '',
        controller,
        session,
        '',
        {
          activeProvider: effectiveActiveProvider,
          activeModelId: effectiveActiveModelId,
          reasoningEffort: selectedCattyThinking,
          scopeType,
          scopeTargetId,
          scopeLabel,
          globalPermissionMode,
          commandBlocklist,
          commandTimeout,
          responseIdleTimeout,
          terminalSessions,
          webSearchConfig,
          getExecutorContext: () => buildExecutorContextForScope({
            type: scopeType,
            targetId: scopeTargetId,
            label: scopeLabel,
          }),
          autoTitleSession: () => {},
          selectedUserSkillSlugs: [],
          forceCompaction: true,
        },
      );
    } finally {
      setStreamingForScope(session.id, false);
      if (abortControllersRef.current.get(session.id) === controller) {
        abortControllersRef.current.delete(session.id);
      }
      endSendForKey(session.id);
    }
  }, [
    abortControllersRef,
    buildExecutorContextForScope,
    commandBlocklist,
    commandTimeout,
    responseIdleTimeout,
    currentAgentId,
    effectiveActiveModelId,
    effectiveActiveProvider,
    selectedCattyThinking,
    globalPermissionMode,
    isStreaming,
    scopeKey,
    scopeLabel,
    scopeTargetId,
    scopeType,
    sendToCattyAgent,
    setStreamingForScope,
    terminalSessions,
    webSearchConfig,
  ]);

  const handleSteer = useCallback(async () => {
    const sessionId = activeSessionRef.current?.id;
    const draft = currentDraftRef.current;
    if (!sessionId || !draft || steeringSessionId || !canSteerCurrentTurn) return;

    if (!validateNoteMentions(draft.attachments)) return;
    const trimmed = draft.text.trim();
    const attachments = draft.attachments.map((file) => ({
      base64Data: file.base64Data,
      mediaType: file.mediaType,
      filename: file.filename,
      filePath: file.filePath,
      terminalSelection: file.terminalSelection,
      vaultNoteId: file.vaultNoteId,
      vaultNoteTitle: file.vaultNoteTitle,
      previewText: file.previewText,
      lineCount: file.lineCount,
    }));
    const hasInlineTextAttachments = attachments.some(isInlineTextAttachment);
    if (!trimmed && !hasInlineTextAttachments) return;

    const userMessageId = generateId();
    const modelPrompt = buildPromptWithTerminalSelectionAttachments(trimmed, attachments);
    const modelAttachments = attachments.filter((attachment) => !isInlineTextAttachment(attachment));
    setSteerWarnings(current => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    setSteeringSessionId(sessionId);
    try {
      const result = await steerExternalAgent({
        chatSessionId: sessionId,
        userMessageId,
        userText: trimmed,
        prompt: modelPrompt,
        attachments,
        attachedImages: modelAttachments,
      });
      if (result.status === 'accepted') {
        if (currentDraftRef.current === draft) clearScopeDraft();
        return;
      }
      if (result.status !== 'cancelled') {
        setSteerWarnings(current => ({
          ...current,
          [sessionId]: { reason: result.status, turnKind: result.turnKind },
        }));
      }
    } finally {
      setSteeringSessionId(current => current === sessionId ? null : current);
    }
  }, [
    validateNoteMentions, canSteerCurrentTurn, clearScopeDraft, steerExternalAgent, steeringSessionId]);

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
    setSteeringSessionId(current => current === activeSessionId ? null : current);
    setSteerWarnings(current => {
      const next = { ...current };
      delete next[activeSessionId];
      return next;
    });
    stopStreamingForSession(activeSessionId);
  }, [activeSessionId, stopStreamingForSession]);

  useEffect(() => {
    if (!activeSessionId || isStreaming) return;
    setSteeringSessionId(current => current === activeSessionId ? null : current);
    setSteerWarnings(current => {
      if (!current[activeSessionId]) return current;
      const next = { ...current };
      delete next[activeSessionId];
      return next;
    });
  }, [activeSessionId, isStreaming]);

  const steerWarning = useMemo(() => {
    if (!activeSessionId) return undefined;
    const warning = steerWarnings[activeSessionId];
    if (!warning) return undefined;
    if (warning.reason === 'not-steerable' && warning.turnKind === 'review') {
      return t('ai.codex.steer.notSteerableReview');
    }
    if (warning.reason === 'not-steerable' && warning.turnKind === 'compact') {
      return t('ai.codex.steer.notSteerableCompact');
    }
    if (warning.reason === 'busy') return t('ai.codex.steer.busy');
    if (warning.reason === 'inactive') return t('ai.codex.steer.inactive');
    if (warning.reason === 'unsupported') return t('ai.codex.steer.unsupported');
    return t('ai.codex.steer.failed');
  }, [activeSessionId, steerWarnings, t]);

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

  // Hidden retained panels keep the composer mounted (parent is `hidden` +
  // inert) so reopen does not remount ChatInput. Skip the message list.
  return (
    <React.Profiler {...getAIPanelProfilerProps('AIChatSidePanel.Active')}>
      <div
        className="h-full min-h-0"
        data-section={isVisible ? undefined : 'ai-chat-panel-retained'}
        aria-hidden={isVisible ? undefined : true}
        inert={isVisible ? undefined : true}
      >
      <AIChatPanelContent
        parked={!isVisible}
        sending={isSending}
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
        contextUsage={contextUsage}
        canCompact={canCompact}
        inputValue={inputValue}
        setInputValue={setInputValue}
        handleSend={handleSend}
        handleCompact={handleCompact}
        handleSteer={handleSteer}
        handleStop={handleStop}
        canSteer={canSteerCurrentTurn}
        isSteering={isSteering}
        steerWarning={steerWarning}
        lockTurnConfiguration={Boolean(isSending || (isStreaming && isCodexAppServer))}
        canSendCurrentAgent={canSendCurrentAgent}
        providerDisplayName={providerDisplayName}
        modelDisplayName={modelDisplayName}
        modelCatalogWarning={runtimeModelWarnings[currentAgentId]}
        agentModelPresets={agentModelPresets}
        selectedAgentModel={selectedAgentModel}
        handleAgentModelSelect={handleAgentModelSelect}
        cattyConfiguredProviders={cattyConfiguredProviders}
        effectiveActiveProvider={effectiveActiveProvider}
        effectiveActiveModelId={effectiveActiveModelId}
        handleAgentProviderModelSelect={handleAgentProviderModelSelect}
        selectedCattyThinking={selectedCattyThinking}
        handleCattyThinkingSelect={handleCattyThinkingSelect}
        files={files}
        addFiles={addFiles}
        removeFile={removeFile}
        onMentionNote={canMentionNotes ? mentionNote : undefined}
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
        snippets={snippets}
        onOpenVaultNote={onOpenVaultNote}
        onOpenVaultHost={onOpenVaultHost}
        onOpenVaultSnippet={onOpenVaultSnippet}
        onOpenVaultSection={onOpenVaultSection}
      />
      </div>
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
  'persistContextCompaction',
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
  'agentThinkingMap',
  'setAgentThinking',
  'updateProvider',
  'globalPermissionMode',
  'setGlobalPermissionMode',
  'commandBlocklist',
  'commandTimeout',
  'responseIdleTimeout',
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
  if ((prev.focusedSessionId ?? '') !== (next.focusedSessionId ?? '')) return false;
  if ((prev.isVisible ?? true) !== (next.isVisible ?? true)) return false;
  if (prev.scopeHostIds !== next.scopeHostIds) return false;
  if (prev.terminalSessions !== next.terminalSessions) return false;
  if (prev.resolveExecutorContext !== next.resolveExecutorContext) return false;
  if (prev.notes !== next.notes) return false;
  if (prev.hosts !== next.hosts) return false;
  if (prev.snippets !== next.snippets) return false;
  if (prev.onOpenVaultNote !== next.onOpenVaultNote) return false;
  if (prev.onOpenVaultHost !== next.onOpenVaultHost) return false;
  if (prev.onOpenVaultSnippet !== next.onOpenVaultSnippet) return false;
  if (prev.onOpenVaultSection !== next.onOpenVaultSection) return false;

  const scopeKey = `${prev.scopeType}:${prev.scopeTargetId ?? ''}`;
  if (
    prev.sessions === next.sessions
    && draftsByScopeEqualIgnoringComposerText(prev.draftsByScope, next.draftsByScope, scopeKey)
  ) {
    let restEqual = true;
    for (const key of AI_CHAT_SIDE_PANEL_AI_STATE_KEYS) {
      if (key === 'sessions' || key === 'draftsByScope') continue;
      if (prev[key] !== next[key]) {
        restEqual = false;
        break;
      }
    }
    if (restEqual) return true;
  }

  // Sibling stream thrash: full sessions array identity always changes. Only
  // exact-scope session object refs matter for this panel's active chat —
  // plus the currently selected session, which may be a host-matched history
  // resume whose stored scope.targetId is an older terminal.
  // Fuzzy history still receives the full list; drawer open forces re-render
  // via isVisible / other prop paths when the user actually needs it.
  // Keep visibleSessionIds in sync with the live panel so inheritance that
  // skips non-history chats does not leave memo pinned to a different id.
  const resolveSelectedSessionId = (
    props: AIChatSidePanelProps,
  ): string | null => {
    const scopeKey = `${props.scopeType}:${props.scopeTargetId ?? ''}`;
    const memberTerminalIds = (props.terminalSessions ?? [])
      .map((session) => session.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId));
    const workspaceMemberTerminalIds = props.scopeType === 'workspace'
      ? new Set(memberTerminalIds)
      : undefined;
    const activeTerminalSessionIds = new Set<string>();
    for (const [sessionScopeKey, sessionId] of Object.entries(props.activeSessionIdMap) as Array<[string, string | null]>) {
      if (!sessionScopeKey.startsWith('terminal:') || !sessionId) continue;
      if (sessionScopeKey === scopeKey) continue;
      activeTerminalSessionIds.add(sessionId);
    }
    const visibleSessionIds = new Set(
      getScopedHistorySessions(
        props.sessions,
        props.scopeType,
        props.scopeTargetId,
        props.scopeHostIds,
        activeTerminalSessionIds,
        workspaceMemberTerminalIds,
        props.activeSessionIdMap,
      ).map((session) => session.id),
    );
    return resolveInheritedAIActiveSessionId({
      scopeType: props.scopeType,
      scopeTargetId: props.scopeTargetId,
      activeSessionIdMap: props.activeSessionIdMap,
      memberTerminalIds,
      preferredTerminalId: props.focusedSessionId,
      visibleSessionIds,
    });
  };
  const selectedSessionId = resolveSelectedSessionId(prev)
    ?? resolveSelectedSessionId(next);
  if (!exactScopeAISessionsEqual(
    prev.sessions,
    next.sessions,
    prev.scopeType,
    prev.scopeTargetId,
    selectedSessionId,
  )) {
    return false;
  }
  // History drawer / recent list need create/delete/title/updatedAt chrome.
  // Only when the panel is (or becomes) visible so hidden retained panels do
  // not re-render on every sibling stream that bumps updatedAt.
  const prevVisible = prev.isVisible ?? true;
  const nextVisible = next.isVisible ?? true;
  if ((prevVisible || nextVisible) && !aiSessionIdSetEqual(prev.sessions, next.sessions)) {
    return false;
  }

  for (const key of AI_CHAT_SIDE_PANEL_AI_STATE_KEYS) {
    if (key === 'sessions') continue;
    if (key === 'draftsByScope') {
      if (!draftsByScopeEqualIgnoringComposerText(prev.draftsByScope, next.draftsByScope, scopeKey)) {
        return false;
      }
      continue;
    }
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
