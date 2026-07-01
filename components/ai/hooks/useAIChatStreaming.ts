/**
 * useAIChatStreaming — React UI layer for AI chat streaming.
 *
 * Turn orchestration lives in AgentRuntime + TurnDrivers; this hook only
 * manages streaming state, abort controllers, and UI callbacks.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AIPermissionMode,
  AIToolIntegrationMode,
  AISession,
  ChatMessage,
  ChatMessageAttachment,
  ExternalAgentConfig,
  ProviderConfig,
  WebSearchConfig,
} from '../../../infrastructure/ai/types';
import type { ExecutorContext } from '../../../infrastructure/ai/cattyAgent/executor';
import { getAgentRuntime } from '../../../infrastructure/ai/harness/globalAgentRuntime';
import { classifyError } from '../../../infrastructure/ai/errorClassifier';
import { latestAISessionsSnapshot } from '../../../application/state/aiStateSnapshots';
import {
  generateId,
  getNetcattyBridge,
  type DefaultTargetSessionHint,
  type TerminalSessionInfo,
} from './aiChatStreamingSupport';
import { useAgentCompactionUi } from './useAgentCompactionUi';

export { getNetcattyBridge } from './aiChatStreamingSupport';
export type { ActiveCompactionUi } from './useAgentCompactionUi';
export type { DefaultTargetSessionHint } from './aiChatStreamingSupport';

const sharedStreamingSessionIds = new Set<string>();
const sharedAbortControllers = new Map<string, AbortController>();
const streamingSubscribers = new Set<() => void>();

/** Whether a chat session still has an active stream (used to keep panel mounted while hidden). */
export function isAIChatSessionStreaming(sessionId: string | null | undefined): boolean {
  return !!sessionId && sharedStreamingSessionIds.has(sessionId);
}

function emitStreamingStoreChange(): void {
  streamingSubscribers.forEach(listener => {
    try {
      listener();
    } catch (err) {
      console.error('[AIChatStreaming] Failed to notify streaming subscriber:', err);
    }
  });
}

export interface UseAIChatStreamingParams {
  maxIterations: number;
  addMessageToSession: (sessionId: string, message: ChatMessage) => void;
  updateLastMessage: (sessionId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  updateMessageById: (sessionId: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
}

export interface UseAIChatStreamingReturn {
  streamingSessionIds: Set<string>;
  setStreamingForScope: (key: string, val: boolean) => void;
  abortControllersRef: React.MutableRefObject<Map<string, AbortController>>;
  sendToCattyAgent: (
    sessionId: string,
    sendScopeKey: string,
    trimmed: string,
    abortController: AbortController,
    currentSession: AISession | undefined,
    assistantMsgId: string,
    context: SendToCattyContext,
    attachments?: ChatMessageAttachment[],
  ) => Promise<void>;
  sendToExternalAgent: (
    sessionId: string,
    trimmed: string,
    agentConfig: ExternalAgentConfig,
    abortController: AbortController,
    attachedImages: Array<{ base64Data: string; mediaType: string; filename?: string; filePath?: string }>,
    context: SendToExternalContext,
  ) => Promise<void>;
  reportStreamError: (sessionId: string, abortSignal: AbortSignal, err: unknown) => void;
  activeCompaction: import('./useAgentCompactionUi').ActiveCompactionUi | null;
}

export interface SendToCattyContext {
  activeProvider: ProviderConfig | undefined;
  activeModelId: string;
  scopeType: 'terminal' | 'workspace';
  scopeTargetId?: string;
  scopeLabel?: string;
  globalPermissionMode: AIPermissionMode;
  commandBlocklist?: string[];
  commandTimeout?: number;
  terminalSessions: TerminalSessionInfo[];
  webSearchConfig?: WebSearchConfig | null;
  getExecutorContext?: () => ExecutorContext;
  autoTitleSession: (sessionId: string, text: string) => void;
  titleText?: string;
  selectedUserSkillSlugs?: string[];
  permissionMode?: AIPermissionMode;
}

export interface SendToExternalContext {
  existingSessionId?: string;
  updateExternalSessionId?: (sessionId: string, externalSessionId: string | undefined) => void;
  historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  terminalSessions: TerminalSessionInfo[];
  defaultTargetSession?: DefaultTargetSessionHint;
  providers: ProviderConfig[];
  selectedAgentModel?: string;
  toolIntegrationMode: AIToolIntegrationMode;
  selectedUserSkillSlugs?: string[];
}

export function useAIChatStreaming({
  maxIterations,
  addMessageToSession,
  updateLastMessage,
  updateMessageById,
}: UseAIChatStreamingParams): UseAIChatStreamingReturn {
  const [streamingSessionIds, setStreamingSessions] = useState<Set<string>>(
    () => new Set(sharedStreamingSessionIds),
  );

  useEffect(() => {
    const syncFromStore = () => {
      setStreamingSessions(new Set(sharedStreamingSessionIds));
    };
    streamingSubscribers.add(syncFromStore);
    syncFromStore();
    return () => {
      streamingSubscribers.delete(syncFromStore);
    };
  }, []);

  const setStreamingForScope = useCallback((key: string, val: boolean) => {
    const hadKey = sharedStreamingSessionIds.has(key);
    if (val) {
      sharedStreamingSessionIds.add(key);
    } else {
      sharedStreamingSessionIds.delete(key);
    }
    if (hadKey !== val) {
      emitStreamingStoreChange();
    }
  }, []);

  const abortControllersRef = useRef<Map<string, AbortController>>(sharedAbortControllers);

  const activeCompaction = useAgentCompactionUi();

  const reportStreamError = useCallback((
    sessionId: string,
    abortSignal: AbortSignal,
    err: unknown,
  ) => {
    if (abortSignal.aborted) return;
    console.error('[AIChatSidePanel] Stream error (full):', err);
    const errorInfo = classifyError(err);
    updateLastMessage(sessionId, msg => ({
      ...msg,
      statusText: '',
      executionStatus: msg.executionStatus === 'running' ? 'failed' : msg.executionStatus,
    }));
    addMessageToSession(sessionId, {
      id: generateId(),
      role: 'assistant',
      content: '',
      errorInfo,
      timestamp: Date.now(),
    });
  }, [updateLastMessage, addMessageToSession]);

  const uiCallbacks = useCallback(() => ({
    addMessageToSession,
    updateLastMessage,
    updateMessageById,
    reportStreamError,
    setStreamingForScope,
    getLatestSession: (sessionId: string) => latestAISessionsSnapshot?.find(s => s.id === sessionId),
  }), [addMessageToSession, updateLastMessage, updateMessageById, reportStreamError, setStreamingForScope]);

  const sendToExternalAgent = useCallback(async (
    sessionId: string,
    trimmed: string,
    agentConfig: ExternalAgentConfig,
    abortController: AbortController,
    attachedImages: Array<{ base64Data: string; mediaType: string; filename?: string; filePath?: string }>,
    context: SendToExternalContext,
  ) => {
    const bridge = getNetcattyBridge();
    await getAgentRuntime().runTurn({
      backend: 'external-sdk',
      chatSessionId: sessionId,
      userText: trimmed,
      signal: abortController.signal,
      agentConfig,
      attachedImages,
      context,
      bridge,
      ui: uiCallbacks(),
    });
  }, [uiCallbacks]);

  const sendToCattyAgent = useCallback(async (
    sessionId: string,
    sendScopeKey: string,
    trimmed: string,
    abortController: AbortController,
    currentSession: AISession | undefined,
    assistantMsgId: string,
    context: SendToCattyContext,
    attachments?: ChatMessageAttachment[],
  ) => {
    const bridge = getNetcattyBridge();
    try {
      await getAgentRuntime().runTurn({
        backend: 'catty',
        chatSessionId: sessionId,
        sendScopeKey,
        userText: trimmed,
        signal: abortController.signal,
        currentSession,
        assistantMsgId,
        context,
        attachments,
        maxIterations,
        bridge,
        ui: uiCallbacks(),
      });
    } finally {
      abortControllersRef.current.delete(sessionId);
    }
  }, [maxIterations, uiCallbacks]);

  return {
    streamingSessionIds,
    setStreamingForScope,
    abortControllersRef,
    sendToCattyAgent,
    sendToExternalAgent,
    reportStreamError,
    activeCompaction,
  };
}
