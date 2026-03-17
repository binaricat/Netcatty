/**
 * useToolApproval — Encapsulates the tool approval workflow for the AI chat panel.
 *
 * Handles:
 * - Pending approval context management
 * - Approval timeout (auto-clear after 5 minutes)
 * - handleApprovalResponse (approve/reject from InlineApprovalCard)
 * - Resuming the Catty stream after approval
 */

import React, { useCallback, useRef } from 'react';
import type { ModelMessage } from 'ai';
import type {
  AIPermissionMode,
  ChatMessage,
  WebSearchConfig,
} from '../../../infrastructure/ai/types';
import { isWebSearchReady } from '../../../infrastructure/ai/types';
import { buildSystemPrompt } from '../../../infrastructure/ai/cattyAgent/systemPrompt';
import { createCattyTools } from '../../../infrastructure/ai/sdk/tools';
import { classifyError } from '../../../infrastructure/ai/errorClassifier';
import type {
  ApprovalInfo,
  PendingApprovalContext,
  TerminalSessionInfo,
} from './useAIChatStreaming';
import { getNetcattyBridge } from './useAIChatStreaming';
import type { createModelFromConfig } from '../../../infrastructure/ai/sdk/providers';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

let sharedPendingApprovalContext: PendingApprovalContext | null = null;
let sharedPendingApprovalTimeout: ReturnType<typeof setTimeout> | null = null;

// -------------------------------------------------------------------
// Hook parameters
// -------------------------------------------------------------------

export interface UseToolApprovalParams {
  addMessageToSession: (sessionId: string, message: ChatMessage) => void;
  updateLastMessage: (sessionId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  updateMessageById: (sessionId: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  setStreamingForScope: (key: string, val: boolean) => void;
  abortControllersRef: React.MutableRefObject<Map<string, AbortController>>;
  processCattyStream: (
    streamSessionId: string,
    model: ReturnType<typeof createModelFromConfig>,
    systemPrompt: string,
    tools: ReturnType<typeof createCattyTools>,
    sdkMessages: Array<ModelMessage>,
    signal: AbortSignal,
    currentAssistantMsgId: string,
  ) => Promise<ApprovalInfo | null>;
  t: (key: string) => string;
}

// -------------------------------------------------------------------
// Hook return type
// -------------------------------------------------------------------

export interface UseToolApprovalReturn {
  /** Ref to the current pending approval context (null when none). */
  pendingApprovalContextRef: React.MutableRefObject<PendingApprovalContext | null>;
  /** Set or clear the pending approval context (manages timeout). */
  setPendingApproval: (ctx: PendingApprovalContext | null) => void;
  /** Handle a user's approve/reject response from InlineApprovalCard. */
  handleApprovalResponse: (
    messageId: string,
    approved: boolean,
    approvalContext: ToolApprovalContext,
  ) => Promise<void>;
}

/** Context values needed by handleApprovalResponse that change frequently. */
export interface ToolApprovalContext {
  terminalSessions: TerminalSessionInfo[];
  scopeType: 'terminal' | 'workspace';
  scopeTargetId?: string;
  scopeLabel?: string;
  globalPermissionMode: AIPermissionMode;
  commandBlocklist?: string[];
  webSearchConfig?: WebSearchConfig | null;
}

// -------------------------------------------------------------------
// Hook implementation
// -------------------------------------------------------------------

export function useToolApproval({
  addMessageToSession,
  updateLastMessage,
  updateMessageById,
  setStreamingForScope,
  abortControllersRef,
  processCattyStream,
  t,
}: UseToolApprovalParams): UseToolApprovalReturn {
  // Pending approval context — stores SDK state needed to resume after user approves/rejects
  const pendingApprovalContextRef = useRef<PendingApprovalContext | null>(sharedPendingApprovalContext);
  pendingApprovalContextRef.current = sharedPendingApprovalContext;

  /** Set pending approval context with a 5-minute auto-clear timeout. */
  const setPendingApproval = useCallback((ctx: PendingApprovalContext | null) => {
    // Clear any existing timeout
    if (sharedPendingApprovalTimeout) {
      clearTimeout(sharedPendingApprovalTimeout);
      sharedPendingApprovalTimeout = null;
    }
    sharedPendingApprovalContext = ctx;
    pendingApprovalContextRef.current = ctx;
    if (ctx) {
      sharedPendingApprovalTimeout = setTimeout(() => {
        // Auto-clear after 5 minutes if user never responds
        if (sharedPendingApprovalContext?.sessionId === ctx.sessionId) {
          sharedPendingApprovalContext = null;
          pendingApprovalContextRef.current = null;
          setStreamingForScope(ctx.sessionId, false);
          abortControllersRef.current.get(ctx.sessionId)?.abort();
          abortControllersRef.current.delete(ctx.sessionId);
          // Notify the user that the approval timed out
          updateLastMessage(ctx.sessionId, msg => ({
            ...msg,
            statusText: '',
            executionStatus: msg.executionStatus === 'running' ? 'failed' : msg.executionStatus,
          }));
          addMessageToSession(ctx.sessionId, {
            id: generateId(),
            role: 'assistant',
            content: t('ai.chat.approvalTimeout'),
            timestamp: Date.now(),
          });
        }
        sharedPendingApprovalTimeout = null;
      }, 5 * 60 * 1000); // 5 minutes
    }
  }, [setStreamingForScope, abortControllersRef, updateLastMessage, addMessageToSession, t]);

  // Handle inline approval response (approve/reject from InlineApprovalCard)
  const handleApprovalResponse = useCallback(async (
    messageId: string,
    approved: boolean,
    approvalContext: ToolApprovalContext,
  ) => {
    const ctx = pendingApprovalContextRef.current;
    if (!ctx) return;
    // Destructure all needed values BEFORE clearing the ref to avoid race conditions
    const { sessionId: sid, scopeKey: sk, sdkMessages, approvalInfo, model: ctxModel } = ctx;
    // Clear pending approval (and its timeout) via setPendingApproval
    setPendingApproval(null);

    // Update the message's pendingApproval status using message ID
    updateMessageById(sid, messageId, msg => ({
      ...msg,
      pendingApproval: msg.pendingApproval
        ? { ...msg.pendingApproval, status: approved ? 'approved' as const : 'denied' as const }
        : undefined,
    }));

    if (!approved) {
      // User rejected — add denial text and stop
      updateMessageById(sid, messageId, msg => ({
        ...msg,
        content: msg.content + (msg.content ? '\n\n' : '') + t('ai.chat.toolDenied'),
        statusText: '',
        executionStatus: 'completed',
      }));
      setStreamingForScope(sid, false);
      abortControllersRef.current.delete(sid);
      return;
    }

    // User approved — construct SDK messages with approval response and resume
    const resumeMessages: Array<Record<string, unknown>> = [
      ...sdkMessages,
      // The assistant message that contained the tool call + approval request
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: approvalInfo.toolCallId,
            toolName: approvalInfo.toolName,
            input: approvalInfo.toolArgs,
          },
          {
            type: 'tool-approval-request',
            approvalId: approvalInfo.approvalId,
            toolCallId: approvalInfo.toolCallId,
          },
        ],
      },
      // The user's approval response
      {
        role: 'tool',
        content: [
          {
            type: 'tool-approval-response',
            approvalId: approvalInfo.approvalId,
            approved: true,
          },
        ],
      },
    ];

    // Create a new assistant message placeholder for the continuation
    const newAssistantMsgId = generateId();
    addMessageToSession(sid, {
      id: newAssistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    });

    const abortController = new AbortController();
    abortControllersRef.current.set(sid, abortController);

    try {
      // Rebuild tools and system prompt with the latest permission mode to prevent
      // stale closure issues (e.g. user changed permission mode during approval wait)
      const bridge = getNetcattyBridge();
      const freshTools = createCattyTools(bridge, {
        sessions: approvalContext.terminalSessions,
        workspaceId: approvalContext.scopeType === 'workspace' ? approvalContext.scopeTargetId : undefined,
        workspaceName: approvalContext.scopeType === 'workspace' ? approvalContext.scopeLabel : undefined,
      }, approvalContext.commandBlocklist, approvalContext.globalPermissionMode, approvalContext.webSearchConfig ?? undefined);
      const freshSystemPrompt = buildSystemPrompt({
        scopeType: approvalContext.scopeType, scopeLabel: approvalContext.scopeLabel,
        hosts: approvalContext.terminalSessions.map(s => ({
          sessionId: s.sessionId, hostname: s.hostname, label: s.label,
          os: s.os, username: s.username, connected: s.connected,
        })),
        permissionMode: approvalContext.globalPermissionMode,
        webSearchEnabled: isWebSearchReady(approvalContext.webSearchConfig),
      });
      const newApprovalInfo = await processCattyStream(sid, ctxModel, freshSystemPrompt, freshTools, resumeMessages as unknown as ModelMessage[], abortController.signal, newAssistantMsgId);

      if (newApprovalInfo) {
        // Another approval needed — save context for the next round (with timeout)
        setPendingApproval({
          sessionId: sid,
          scopeKey: sk,
          sdkMessages: resumeMessages,
          approvalInfo: newApprovalInfo,
          model: ctxModel,
          systemPrompt: freshSystemPrompt,
          tools: freshTools,
        });
        return;
      }
    } catch (err) {
      console.error('[Catty resume] streamText error:', err);
      if (!abortController.signal.aborted) {
        const errorStr = err instanceof Error ? err.message : String(err);
        updateMessageById(sid, newAssistantMsgId, msg => ({
          ...msg,
          statusText: '',
          executionStatus: msg.executionStatus === 'running' ? 'failed' : msg.executionStatus,
        }));
        addMessageToSession(sid, {
          id: generateId(),
          role: 'assistant',
          content: '',
          errorInfo: classifyError(errorStr),
          timestamp: Date.now(),
        });
      }
    } finally {
      if (!pendingApprovalContextRef.current || pendingApprovalContextRef.current.sessionId !== sid) {
        // Clear any lingering statusText when the resumed stream finishes
        updateLastMessage(sid, msg => msg.statusText ? { ...msg, statusText: '' } : msg);
        setStreamingForScope(sid, false);
        abortControllersRef.current.delete(sid);
      }
    }
  }, [
    processCattyStream, addMessageToSession, updateMessageById, updateLastMessage,
    setStreamingForScope, abortControllersRef, t, setPendingApproval,
  ]);

  return {
    pendingApprovalContextRef,
    setPendingApproval,
    handleApprovalResponse,
  };
}
