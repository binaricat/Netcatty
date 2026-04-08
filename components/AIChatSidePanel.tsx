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
import { useFileUpload } from '../application/state/useFileUpload';
import type {
  AgentModelPreset,
  AIPermissionMode,
  AISession,
  AISessionScope,
  ChatMessage,
  DiscoveredAgent,
  ExternalAgentConfig,
  ProviderConfig,
  WebSearchConfig,
} from '../infrastructure/ai/types';
import { getAgentModelPresets } from '../infrastructure/ai/types';
import { useAgentDiscovery } from '../application/state/useAgentDiscovery';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import AgentSelector from './ai/AgentSelector';
import ChatInput from './ai/ChatInput';
import ChatMessageList from './ai/ChatMessageList';
import ConversationExport from './ai/ConversationExport';
import { useAIChatStreaming, getNetcattyBridge } from './ai/hooks/useAIChatStreaming';
import { clearAllPendingApprovals } from '../infrastructure/ai/shared/approvalGate';
import { useConversationExport } from './ai/hooks/useConversationExport';
import type { ExecutorContext } from '../infrastructure/ai/cattyAgent/executor';

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
  setActiveSessionId: (scopeKey: string, id: string | null) => void;
  createSession: (scope: AISessionScope, agentId?: string) => AISession;
  deleteSession: (sessionId: string, scopeKey?: string) => void;
  updateSessionTitle: (sessionId: string, title: string) => void;
  updateSessionExternalSessionId: (sessionId: string, externalSessionId: string | undefined) => void;
  retargetSessionScope: (sessionId: string, scope: AISessionScope) => void;
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

function buildAcpHistoryMessages(messages: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages.flatMap((message) => {
    if (message.role === 'system') return [];

    if (message.role === 'user') {
      return message.content ? [{ role: 'user' as const, content: message.content }] : [];
    }

    if (message.role === 'assistant') {
      const parts: string[] = [];
      if (message.content) parts.push(message.content);
      if (message.toolCalls?.length) {
        parts.push(...message.toolCalls.map((tc) => `Tool call: ${tc.name}(${JSON.stringify(tc.arguments ?? {})})`));
      }
      if (!parts.length) return [];
      return [{ role: 'assistant' as const, content: parts.join('\n\n') }];
    }

    if (message.role === 'tool' && message.toolResults?.length) {
      return message.toolResults.map((tr) => ({
        role: 'assistant' as const,
        content: `Tool result:\n${tr.content}`,
      }));
    }

    return [];
  });
}

function getSessionScopeMatchRank(
  session: AISession,
  scopeType: 'terminal' | 'workspace',
  scopeTargetId?: string,
  scopeHostIds?: string[],
  activeTerminalTargetIds?: Set<string>,
): number {
  if (session.scope.type !== scopeType) return 0;
  if (session.scope.targetId === scopeTargetId) return 2;

  if (scopeType !== 'terminal' || !scopeHostIds?.length || !session.scope.hostIds?.length) {
    return 0;
  }

  if (session.scope.targetId && activeTerminalTargetIds?.has(session.scope.targetId)) {
    return 0;
  }

  return session.scope.hostIds.some((hostId) => scopeHostIds.includes(hostId)) ? 1 : 0;
}

// -------------------------------------------------------------------
// Component
// -------------------------------------------------------------------

const AIChatSidePanelInner: React.FC<AIChatSidePanelProps> = ({
  sessions,
  activeSessionIdMap,
  setActiveSessionId: setActiveSessionIdForScope,
  createSession,
  deleteSession,
  updateSessionTitle,
  updateSessionExternalSessionId,
  retargetSessionScope,
  addMessageToSession,
  updateLastMessage,
  updateMessageById,
  providers,
  activeProviderId,
  activeModelId,
  defaultAgentId,
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

  // Per-scope input values
  const [inputValueMap, setInputValueMap] = useState<Record<string, string>>({});
  const inputValue = inputValueMap[scopeKey] ?? '';
  const setInputValue = useCallback((val: string) => {
    setInputValueMap(prev => ({ ...prev, [scopeKey]: val }));
  }, [scopeKey]);

  const [showHistory, setShowHistory] = useState(false);
  const [currentAgentId, setCurrentAgentId] = useState(defaultAgentId);

  const { files, addFiles, removeFile, clearFiles } = useFileUpload();
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


  // Per-scope active session ID
  const activeSessionIdForScope = activeSessionIdMap[scopeKey] ?? null;
  const setActiveSessionId = useCallback((id: string | null) => {
    setActiveSessionIdForScope(scopeKey, id);
  }, [scopeKey, setActiveSessionIdForScope]);

  const activeTerminalTargetIds = useMemo(() => {
    const targetIds = new Set<string>();
    for (const [sessionScopeKey, sessionId] of Object.entries(activeSessionIdMap)) {
      if (!sessionScopeKey.startsWith('terminal:') || !sessionId) continue;
      const targetId = sessionScopeKey.slice('terminal:'.length);
      if (!targetId || targetId === scopeTargetId) continue;
      targetIds.add(targetId);
    }
    return targetIds;
  }, [activeSessionIdMap, scopeTargetId]);

  const historySessions = useMemo(
    () =>
      sessions
        .map((session) => ({
          session,
          matchRank: getSessionScopeMatchRank(session, scopeType, scopeTargetId, scopeHostIds, activeTerminalTargetIds),
        }))
        .filter(({ matchRank }) => matchRank > 0)
        .sort((a, b) => b.matchRank - a.matchRank || b.session.updatedAt - a.session.updatedAt)
        .map(({ session }) => session),
    [sessions, scopeType, scopeTargetId, scopeHostIds, activeTerminalTargetIds],
  );

  const activeSession = useMemo(() => {
    if (activeSessionIdForScope) {
      const session = sessions.find((s) => s.id === activeSessionIdForScope);
      if (session && getSessionScopeMatchRank(session, scopeType, scopeTargetId, scopeHostIds, activeTerminalTargetIds) > 0) {
        return session;
      }
    }
    return historySessions[0] ?? null;
  }, [sessions, activeSessionIdForScope, historySessions, scopeType, scopeTargetId, scopeHostIds, activeTerminalTargetIds]);

  const activeSessionId = activeSession?.id ?? activeSessionIdForScope;
  const isStreaming = activeSessionId ? streamingSessionIds.has(activeSessionId) : false;

  const shouldRetargetActiveSession = useMemo(() => {
    if (!activeSession || scopeType !== 'terminal' || !scopeTargetId || !scopeHostIds?.length) {
      return false;
    }

    if (activeSession.scope.type !== scopeType || activeSession.scope.targetId === scopeTargetId) {
      return false;
    }

    // Don't retarget sessions that are actively owned by another terminal
    if (activeSession.scope.targetId && activeTerminalTargetIds.has(activeSession.scope.targetId)) {
      return false;
    }

    return activeSession.scope.hostIds?.some((hostId) => scopeHostIds.includes(hostId)) ?? false;
  }, [activeSession, scopeType, scopeTargetId, scopeHostIds, activeTerminalTargetIds]);

  useEffect(() => {
    if (!activeSession) return;

    if (shouldRetargetActiveSession && isVisible) {
      // Full cleanup of any in-flight work — the session came from a disconnected
      // terminal, so any active response, pending approvals, or exec is dead.
      if (streamingSessionIds.has(activeSession.id)) {
        const controller = abortControllersRef.current.get(activeSession.id);
        if (controller) {
          controller.abort();
          abortControllersRef.current.delete(activeSession.id);
        }
        setStreamingForScope(activeSession.id, false);
        clearAllPendingApprovals(activeSession.id);
        const bridge = getNetcattyBridge();
        bridge?.aiCattyCancelExec?.(activeSession.id);
        bridge?.aiAcpCancel?.('', activeSession.id);
      }
      retargetSessionScope(activeSession.id, {
        type: scopeType,
        targetId: scopeTargetId,
        hostIds: scopeHostIds,
      });
      return;
    }

    if (isVisible && activeSessionIdForScope !== activeSession.id) {
      setActiveSessionId(activeSession.id);
    }
  }, [
    activeSession,
    activeSessionIdForScope,
    retargetSessionScope,
    isVisible,
    scopeHostIds,
    scopeTargetId,
    scopeType,
    setActiveSessionId,
    setStreamingForScope,
    shouldRetargetActiveSession,
    streamingSessionIds,
    abortControllersRef,
  ]);

  // Restore agent selector from active session when scope changes
  useEffect(() => {
    if (activeSession) {
      setCurrentAgentId(activeSession.agentId);
    }
  }, [scopeKey, activeSession]);

  // Proactively sync terminal session metadata to main process whenever scope or sessions change
  useEffect(() => {
    const bridge = getNetcattyBridge();
    if (bridge?.aiMcpUpdateSessions) {
      void bridge.aiMcpUpdateSessions(terminalSessions, activeSessionId ?? undefined);
    }
  }, [terminalSessions, scopeKey, activeSessionId]);

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

  // ── Export hook ──
  const { handleExport } = useConversationExport(activeSession);

  // Active provider info
  const activeProvider = useMemo(
    () => providers.find((p) => p.id === activeProviderId),
    [providers, activeProviderId],
  );

  const providerDisplayName = activeProvider?.name ?? '';
  const modelDisplayName = activeModelId || activeProvider?.defaultModel || '';
  const [runtimeAgentModelPresets, setRuntimeAgentModelPresets] = useState<Record<string, AgentModelPreset[]>>({});

  // Agent model presets for the current external agent
  const currentAgentConfig = useMemo(
    () => currentAgentId !== 'catty' ? externalAgents.find(a => a.id === currentAgentId) : undefined,
    [currentAgentId, externalAgents],
  );
  const isCopilotExternalAgent = useMemo(
    () => isCopilotAgentConfig(currentAgentConfig),
    [currentAgentConfig],
  );

  // Ref to read agentModelMap inside the effect without re-triggering it
  // when setAgentModel updates the map (avoids double ACP spawn).
  const agentModelMapRef = useRef(agentModelMap);
  agentModelMapRef.current = agentModelMap;

  useEffect(() => {
    if (!currentAgentConfig?.acpCommand) return;
    if (!isCopilotExternalAgent) return;

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
      const knownModelIds = new Set(result.models.map((model) => model.id));
      setRuntimeAgentModelPresets((prev) => ({
        ...prev,
        [currentAgentId]: result.models ?? [],
      }));
      const storedModelId = agentModelMapRef.current[currentAgentId];
      if (result.currentModelId && (!storedModelId || !knownModelIds.has(storedModelId))) {
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
  }, [currentAgentConfig, currentAgentId, isCopilotExternalAgent, setAgentModel]);

  const agentModelPresets = useMemo(
    () => runtimeAgentModelPresets[currentAgentId] ?? getAgentModelPresets(currentAgentConfig?.command),
    [currentAgentId, currentAgentConfig?.command, runtimeAgentModelPresets],
  );

  // Per-agent model: recall last selection or use first preset as default
  const selectedAgentModel = useMemo(() => {
    const stored = agentModelMap[currentAgentId];
    if (stored && agentModelPresets.some(p => stored === p.id || stored.startsWith(p.id + '/'))) {
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
    const scope: AISessionScope = {
      type: scopeType,
      targetId: scopeTargetId,
      hostIds: scopeHostIds,
    };
    const session = createSession(scope, currentAgentId);
    setActiveSessionId(session.id);
    setShowHistory(false);
    setInputValue('');
  }, [
    scopeType,
    scopeTargetId,
    scopeHostIds,
    currentAgentId,
    createSession,
    setActiveSessionId,
    setInputValue,
  ]);

  const handleOpenSettings = useCallback(() => {
    void openSettingsWindow();
  }, [openSettingsWindow]);

  // -------------------------------------------------------------------
  // Shared helpers for handleSend sub-flows
  // -------------------------------------------------------------------

  /** Ref to always access latest sessions (avoids stale closure in autoTitleSession). */
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  /** Refs to avoid re-creating handleSend on every keystroke / image change. */
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;
  const filesRef = useRef(files);
  filesRef.current = files;

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

  /** Ensure a session exists for the current scope and return its ID. */
  const ensureSession = useCallback((): string => {
    if (activeSession && sessionsRef.current.some((session) => session.id === activeSession.id)) {
      if (shouldRetargetActiveSession) {
        retargetSessionScope(activeSession.id, {
          type: scopeType,
          targetId: scopeTargetId,
          hostIds: scopeHostIds,
        });
      } else if (activeSessionIdForScope !== activeSession.id) {
        setActiveSessionId(activeSession.id);
      }
      return activeSession.id;
    }
    const scope: AISessionScope = { type: scopeType, targetId: scopeTargetId, hostIds: scopeHostIds };
    const session = createSession(scope, currentAgentId);
    setActiveSessionId(session.id);
    return session.id;
  }, [
    activeSession,
    activeSessionIdForScope,
    createSession,
    currentAgentId,
    retargetSessionScope,
    scopeHostIds,
    scopeTargetId,
    scopeType,
    setActiveSessionId,
    shouldRetargetActiveSession,
  ]);

  // -------------------------------------------------------------------
  // Main send handler (thin orchestrator)
  // -------------------------------------------------------------------

  const handleSend = useCallback(async () => {
    const trimmed = inputValueRef.current.trim();
    const sendScopeKey = scopeKey;
    if (!trimmed || isStreaming) return;

    const isExternalAgent = currentAgentId !== 'catty';

    // No provider configured for built-in agent
    if (!isExternalAgent && !activeProvider) {
      const errSessionId = ensureSession();
      addMessageToSession(errSessionId, { id: generateId(), role: 'user', content: trimmed, timestamp: Date.now() });
      addMessageToSession(errSessionId, { id: generateId(), role: 'assistant', content: t('ai.chat.noProvider'), timestamp: Date.now() });
      setInputValue('');
      return;
    }

    // Ensure session exists
    const sessionId = ensureSession();

    // Capture images before clearing
    const attachments = filesRef.current.map(f => ({ base64Data: f.base64Data, mediaType: f.mediaType, filename: f.filename, filePath: f.filePath }));

    // Add user message
    addMessageToSession(sessionId, {
      id: generateId(), role: 'user', content: trimmed,
      ...(attachments.length > 0 ? { attachments } : {}),
      timestamp: Date.now(),
    });
    setInputValue('');
    clearFiles();
    setStreamingForScope(sessionId, true);

    // Create assistant message placeholder with a tracked ID
    const agentConfig = isExternalAgent ? externalAgents.find(a => a.id === currentAgentId) : undefined;
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
    const currentSession = sessionsRef.current.find(s => s.id === sessionId);

    if (isExternalAgent) {
      if (!agentConfig) {
        updateMessageById(sessionId, assistantMsgId, msg => ({ ...msg, content: 'External agent not found. Please check settings.', executionStatus: 'failed' }));
        setStreamingForScope(sessionId, false);
        return;
      }
      try {
        await sendToExternalAgent(sessionId, trimmed, agentConfig, abortController, attachments, {
          existingSessionId: currentSession?.externalSessionId,
          updateExternalSessionId: updateSessionExternalSessionId,
          historyMessages: buildAcpHistoryMessages(currentSession?.messages ?? []),
          terminalSessions,
          providers,
          selectedAgentModel,
        });
      } catch (err) {
        reportStreamError(sessionId, abortController.signal, err);
      }
      // Clear any lingering statusText when the external agent stream finishes
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
      }, attachments.length > 0 ? attachments : undefined);
    }
  }, [
    isStreaming, activeProvider, scopeKey, currentAgentId,
    activeModelId, externalAgents,
    ensureSession, addMessageToSession, updateMessageById, updateLastMessage,
    setStreamingForScope, setInputValue, clearFiles,
    sendToExternalAgent, sendToCattyAgent, reportStreamError, autoTitleSession, t,
    abortControllersRef, terminalSessions, providers, selectedAgentModel, updateSessionExternalSessionId,
    scopeType, scopeTargetId, scopeLabel, globalPermissionMode, commandBlocklist, webSearchConfig, buildExecutorContextForScope,
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
      setActiveSessionId(sessionId);
      // Restore agent selector to match the session's bound agent
      const session = sessions.find((s) => s.id === sessionId);
      if (session) {
        setCurrentAgentId(session.agentId);
      }
      setShowHistory(false);
    },
    [setActiveSessionId, sessions],
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
    setCurrentAgentId(agentId);
    // Preserve the current session in history and start a new one with the selected agent
    const scope: AISessionScope = { type: scopeType, targetId: scopeTargetId, hostIds: scopeHostIds };
    const session = createSession(scope, agentId);
    setActiveSessionId(session.id);
  }, [scopeType, scopeTargetId, scopeHostIds, createSession, setActiveSessionId]);

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
                    'w-full flex items-center justify-between py-2.5 border-b border-border/20 text-left transition-colors cursor-pointer group',
                    isActive ? 'text-foreground' : 'text-foreground/70 hover:text-foreground',
                  )}
                >
                  <span className="text-[13px] truncate pr-3 flex-1 min-w-0">
                    {session.title || t('ai.chat.untitled')}
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[12px] text-muted-foreground/50">
                      {timeStr}
                    </span>
                    <button
                      onClick={(e) => onDelete(e, session.id)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-destructive transition-all cursor-pointer"
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
