/**
 * useAIChatStreaming — Encapsulates all streaming logic for the AI chat panel.
 *
 * Handles:
 * - Catty agent streaming via Vercel AI SDK `streamText`
 * - External agent streaming (ACP and raw process)
 * - Text-delta batching via requestAnimationFrame
 * - Abort controller management
 * - Stream state tracking (per-session)
 * - Error reporting
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { streamText, stepCountIs, type ModelMessage } from 'ai';
import type {
  AIPermissionMode,
  AISession,
  ChatMessage,
  ExternalAgentConfig,
  ProviderConfig,
  WebSearchConfig,
} from '../../../infrastructure/ai/types';
import { isWebSearchReady } from '../../../infrastructure/ai/types';
import { buildSystemPrompt } from '../../../infrastructure/ai/cattyAgent/systemPrompt';
import { createModelFromConfig } from '../../../infrastructure/ai/sdk/providers';
import { createCattyTools } from '../../../infrastructure/ai/sdk/tools';
import type { NetcattyBridge, ExecutorContext } from '../../../infrastructure/ai/cattyAgent/executor';
import { runExternalAgentTurn } from '../../../infrastructure/ai/externalAgentAdapter';
import { runAcpAgentTurn } from '../../../infrastructure/ai/acpAgentAdapter';
import { classifyError, sanitizeErrorMessage } from '../../../infrastructure/ai/errorClassifier';

// -------------------------------------------------------------------
// Stream chunk type interfaces (Issue #13: replace unsafe casts)
// -------------------------------------------------------------------

/** Shape of a text/text-delta chunk from the Vercel AI SDK fullStream. */
interface TextDeltaChunk {
  type: 'text' | 'text-delta';
  text?: string;
  textDelta?: string;
}

/** Shape of a reasoning chunk from the Vercel AI SDK fullStream. */
interface ReasoningChunk {
  type: 'reasoning' | 'reasoning-start' | 'reasoning-delta';
  text?: string;
}

/** Shape of a tool-call chunk from the Vercel AI SDK fullStream. */
interface ToolCallChunk {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input?: unknown;
  args?: unknown;
}

/** Shape of a tool-result chunk from the Vercel AI SDK fullStream. */
interface ToolResultChunk {
  type: 'tool-result';
  toolCallId: string;
  output?: unknown;
  result?: unknown;
}

/** Shape of a tool-approval-request chunk from the Vercel AI SDK fullStream. */
interface ToolApprovalRequestChunk {
  type: 'tool-approval-request';
  approvalId: string;
  toolCall: {
    toolCallId: string;
    toolName: string;
    args?: Record<string, unknown>;
    input?: Record<string, unknown>;
  };
}

/** Shape of an error chunk from the Vercel AI SDK fullStream. */
interface ErrorChunk {
  type: 'error';
  error: unknown;
}

/** Union of all stream chunk shapes we handle. */
type StreamChunk =
  | TextDeltaChunk
  | ReasoningChunk
  | ToolCallChunk
  | ToolResultChunk
  | ToolApprovalRequestChunk
  | ErrorChunk
  | { type: 'reasoning-end' | 'text-start' | 'text-end' | 'start' | 'finish' | 'start-step' | 'finish-step' };

/** Shape of the netcatty bridge exposed on `window` (panel-specific subset). */
export interface PanelBridge extends NetcattyBridge {
  credentialsDecrypt?: (value: string) => Promise<string>;
  aiSyncProviders?: (providers: Array<{ id: string; providerId: string; apiKey?: string; baseURL?: string; enabled: boolean }>) => Promise<{ ok: boolean }>;
  aiSyncWebSearch?: (apiHost: string | null, apiKey: string | null) => Promise<{ ok: boolean }>;
  aiMcpUpdateSessions?: (sessions: TerminalSessionInfo[], chatSessionId?: string) => Promise<unknown>;
  aiAcpCleanup?: (chatSessionId: string) => Promise<{ ok: boolean }>;
  [key: string]: ((...args: unknown[]) => unknown) | undefined;
}

/** Terminal session info used throughout the streaming hooks. */
export interface TerminalSessionInfo {
  sessionId: string;
  hostId: string;
  hostname: string;
  label: string;
  os?: string;
  username?: string;
  connected: boolean;
}

/** Typed accessor for the netcatty bridge on the window object. */
export function getNetcattyBridge(): PanelBridge | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).netcatty as PanelBridge | undefined;
}

/** Approval info returned by processCattyStream when a tool-approval-request is received. */
export interface ApprovalInfo {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}

/** Pending approval context stored between approval request and user response. */
export interface PendingApprovalContext {
  sessionId: string;
  scopeKey: string;
  sdkMessages: Array<ModelMessage>;
  approvalInfo: ApprovalInfo;
  model: ReturnType<typeof createModelFromConfig>;
  systemPrompt: string;
  tools: ReturnType<typeof createCattyTools>;
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const sharedStreamingSessionIds = new Set<string>();
const sharedAbortControllers = new Map<string, AbortController>();
const streamingSubscribers = new Set<() => void>();

function emitStreamingStoreChange(): void {
  streamingSubscribers.forEach(listener => {
    try {
      listener();
    } catch (err) {
      console.error('[AIChatStreaming] Failed to notify streaming subscriber:', err);
    }
  });
}

// -------------------------------------------------------------------
// Hook parameters
// -------------------------------------------------------------------

export interface UseAIChatStreamingParams {
  maxIterations: number;
  addMessageToSession: (sessionId: string, message: ChatMessage) => void;
  updateLastMessage: (sessionId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  updateMessageById: (sessionId: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
}

// -------------------------------------------------------------------
// Hook return type
// -------------------------------------------------------------------

export interface UseAIChatStreamingReturn {
  /** Set of session IDs currently streaming. */
  streamingSessionIds: Set<string>;
  /** Set or unset streaming state for a session. */
  setStreamingForScope: (key: string, val: boolean) => void;
  /** Ref to per-session abort controllers. */
  abortControllersRef: React.MutableRefObject<Map<string, AbortController>>;
  /** Process a Catty agent stream, returning approval info if one is requested. */
  processCattyStream: (
    streamSessionId: string,
    model: ReturnType<typeof createModelFromConfig>,
    systemPrompt: string,
    tools: ReturnType<typeof createCattyTools>,
    sdkMessages: Array<ModelMessage>,
    signal: AbortSignal,
    currentAssistantMsgId: string,
  ) => Promise<ApprovalInfo | null>;
  /** Send a message to the Catty agent (built-in). */
  sendToCattyAgent: (
    sessionId: string,
    sendScopeKey: string,
    trimmed: string,
    abortController: AbortController,
    currentSession: AISession | undefined,
    assistantMsgId: string,
    context: SendToCattyContext,
  ) => Promise<void>;
  /** Send a message to an external agent (ACP or raw process). */
  sendToExternalAgent: (
    sessionId: string,
    trimmed: string,
    agentConfig: ExternalAgentConfig,
    abortController: AbortController,
    attachedImages: Array<{ base64Data: string; mediaType: string; filename?: string }>,
    context: SendToExternalContext,
  ) => Promise<void>;
  /** Report a streaming error to the chat. */
  reportStreamError: (sessionId: string, abortSignal: AbortSignal, err: unknown) => void;
}

/** Context values needed by sendToCattyAgent that change frequently (avoids stale closures). */
export interface SendToCattyContext {
  activeProvider: ProviderConfig | undefined;
  activeModelId: string;
  scopeType: 'terminal' | 'workspace';
  scopeTargetId?: string;
  scopeLabel?: string;
  globalPermissionMode: AIPermissionMode;
  commandBlocklist?: string[];
  terminalSessions: TerminalSessionInfo[];
  webSearchConfig?: WebSearchConfig | null;
  getExecutorContext?: () => ExecutorContext;
  setPendingApproval: (ctx: PendingApprovalContext | null) => void;
  autoTitleSession: (sessionId: string, text: string) => void;
}

/** Context values needed by sendToExternalAgent that change frequently. */
export interface SendToExternalContext {
  existingSessionId?: string;
  updateExternalSessionId?: (sessionId: string, externalSessionId: string | undefined) => void;
  historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  terminalSessions: TerminalSessionInfo[];
  providers: ProviderConfig[];
  selectedAgentModel?: string;
}

// -------------------------------------------------------------------
// Hook implementation
// -------------------------------------------------------------------

export function useAIChatStreaming({
  maxIterations,
  addMessageToSession,
  updateLastMessage,
  updateMessageById,
}: UseAIChatStreamingParams): UseAIChatStreamingReturn {
  // Per-session streaming state (keyed by sessionId)
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

  // Per-scope abort controllers
  const abortControllersRef = useRef<Map<string, AbortController>>(sharedAbortControllers);

  // -------------------------------------------------------------------
  // reportStreamError
  // -------------------------------------------------------------------

  const reportStreamError = useCallback((
    sessionId: string,
    abortSignal: AbortSignal,
    err: unknown,
  ) => {
    if (abortSignal.aborted) return;
    let errorStr: string;
    if (err instanceof Error) errorStr = err.message;
    else if (typeof err === 'object' && err !== null && 'message' in err) errorStr = String((err as { message: unknown }).message);
    else if (typeof err === 'string') errorStr = err;
    else { try { errorStr = JSON.stringify(err) ?? 'Unknown error'; } catch { errorStr = 'Unknown error'; } }
    // Log the full unsanitized error for debugging
    console.error('[AIChatSidePanel] Stream error (full):', errorStr);
    const errorInfo = classifyError(errorStr);
    // Sanitize the displayed message to avoid leaking paths, keys, or other sensitive info
    errorInfo.message = sanitizeErrorMessage(errorInfo.message);
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

  // -------------------------------------------------------------------
  // processCattyStream
  // -------------------------------------------------------------------

  const processCattyStream = useCallback(async (
    streamSessionId: string,
    model: ReturnType<typeof createModelFromConfig>,
    systemPrompt: string,
    tools: ReturnType<typeof createCattyTools>,
    sdkMessages: Array<ModelMessage>,
    signal: AbortSignal,
    currentAssistantMsgId: string,
  ): Promise<ApprovalInfo | null> => {
    const result = streamText({
      model,
      messages: sdkMessages,
      system: systemPrompt,
      tools,
      stopWhen: stepCountIs(maxIterations),
      abortSignal: signal,
    });

    // Track the current assistant message ID so updates target the correct message
    let activeMsgId = currentAssistantMsgId;
    let lastAddedRole: 'assistant' | 'tool' = 'assistant';
    const reader = result.fullStream.getReader();
    let pendingApprovalInfo: ApprovalInfo | null = null;

    // -- Text-delta batching: accumulate deltas and flush periodically --
    let pendingText = '';
    let rafId: number | null = null;

    const flushText = () => {
      if (pendingText) {
        const text = pendingText;
        pendingText = '';
        if (lastAddedRole === 'tool') {
          const newId = generateId();
          addMessageToSession(streamSessionId, {
            id: newId,
            role: 'assistant',
            content: text,
            timestamp: Date.now(),
          });
          activeMsgId = newId;
          lastAddedRole = 'assistant';
        } else {
          updateMessageById(streamSessionId, activeMsgId, msg => ({
            ...msg,
            content: msg.content + text,
          }));
        }
      }
      rafId = null;
    };

    const cancelPendingFlush = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Use the StreamChunk union for type narrowing instead of unsafe casts
      const chunk = value as StreamChunk;
      switch (chunk.type) {
        case 'text':
        case 'text-delta': {
          const typedChunk = chunk as TextDeltaChunk;
          const text = typedChunk.text ?? typedChunk.textDelta;
          if (text) {
            pendingText += text;
            if (rafId === null) {
              rafId = requestAnimationFrame(flushText);
            }
          }
          break;
        }
        case 'reasoning':
        case 'reasoning-start':
        case 'reasoning-delta': {
          cancelPendingFlush();
          flushText();
          const typedChunk = chunk as ReasoningChunk;
          const rText = typedChunk.text;
          if (rText) {
            if (lastAddedRole === 'tool') {
              const newId = generateId();
              addMessageToSession(streamSessionId, {
                id: newId,
                role: 'assistant',
                content: '',
                thinking: rText,
                timestamp: Date.now(),
              });
              activeMsgId = newId;
              lastAddedRole = 'assistant';
            } else {
              updateMessageById(streamSessionId, activeMsgId, msg => ({
                ...msg,
                thinking: (msg.thinking || '') + rText,
              }));
            }
          }
          break;
        }
        case 'reasoning-end':
        case 'text-start':
        case 'text-end':
        case 'start':
        case 'finish':
        case 'start-step':
        case 'finish-step':
          break;
        case 'tool-call': {
          cancelPendingFlush();
          flushText();
          const typedChunk = chunk as ToolCallChunk;
          updateMessageById(streamSessionId, activeMsgId, msg => ({
            ...msg,
            toolCalls: [...(msg.toolCalls || []), {
              id: typedChunk.toolCallId,
              name: typedChunk.toolName,
              arguments: (typedChunk.input ?? typedChunk.args) as Record<string, unknown>,
            }],
            executionStatus: 'running',
            statusText: undefined,
          }));
          break;
        }
        case 'tool-result': {
          cancelPendingFlush();
          flushText();
          const typedChunk = chunk as ToolResultChunk;
          // Mark the assistant message's tool execution as completed
          updateMessageById(streamSessionId, activeMsgId, msg =>
            msg.role === 'assistant' && msg.executionStatus === 'running'
              ? { ...msg, executionStatus: 'completed', statusText: undefined } : msg,
          );
          const toolOutput = typedChunk.output ?? typedChunk.result;
          addMessageToSession(streamSessionId, {
            id: generateId(),
            role: 'tool',
            content: '',
            toolResults: [{
              toolCallId: typedChunk.toolCallId,
              content: typeof toolOutput === 'string'
                ? toolOutput
                : JSON.stringify(toolOutput),
              isError: false,
            }],
            timestamp: Date.now(),
            executionStatus: 'completed',
          });
          lastAddedRole = 'tool';
          break;
        }
        case 'tool-approval-request': {
          cancelPendingFlush();
          flushText();
          const typedChunk = chunk as ToolApprovalRequestChunk;
          pendingApprovalInfo = {
            approvalId: typedChunk.approvalId,
            toolCallId: typedChunk.toolCall.toolCallId,
            toolName: typedChunk.toolCall.toolName,
            toolArgs: typedChunk.toolCall.args ?? typedChunk.toolCall.input ?? {},
          };
          updateMessageById(streamSessionId, activeMsgId, msg => ({
            ...msg,
            pendingApproval: {
              ...pendingApprovalInfo!,
              status: 'pending' as const,
            },
          }));
          break;
        }
        case 'error': {
          cancelPendingFlush();
          flushText();
          const typedChunk = chunk as ErrorChunk;
          updateMessageById(streamSessionId, activeMsgId, msg => ({
            ...msg,
            statusText: '',
            executionStatus: msg.executionStatus === 'running' ? 'failed' : msg.executionStatus,
          }));
          addMessageToSession(streamSessionId, {
            id: generateId(),
            role: 'assistant',
            content: '',
            errorInfo: classifyError(
              typedChunk.error instanceof Error ? typedChunk.error.message
                : typeof typedChunk.error === 'string' ? typedChunk.error
                : (() => { try { return JSON.stringify(typedChunk.error) ?? 'Unknown error'; } catch { return 'Unknown error'; } })(),
            ),
            timestamp: Date.now(),
          });
          break;
        }
        default:
          break;
      }
    }
    } finally {
      cancelPendingFlush();
      flushText();
      reader.releaseLock();
    }
    return pendingApprovalInfo;
  }, [maxIterations, addMessageToSession, updateMessageById]);

  // -------------------------------------------------------------------
  // sendToExternalAgent
  // -------------------------------------------------------------------

  const sendToExternalAgent = useCallback(async (
    sessionId: string,
    trimmed: string,
    agentConfig: ExternalAgentConfig,
    abortController: AbortController,
    attachedImages: Array<{ base64Data: string; mediaType: string; filename?: string }>,
    context: SendToExternalContext,
  ) => {
    const bridge = getNetcattyBridge();

    if (agentConfig.acpCommand && bridge) {
      const requestId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      // Push terminal session metadata to MCP bridge
      if (bridge?.aiMcpUpdateSessions) {
        await bridge.aiMcpUpdateSessions(context.terminalSessions, sessionId);
      }

      // Pass only the provider ID — the main process resolves and decrypts the API key itself,
      // avoiding plaintext key transit across the IPC boundary.
      const openaiProvider = context.providers.find(p => p.providerId === 'openai' && p.enabled && p.apiKey);
      const agentProviderId = openaiProvider?.id;

      // Mutable flag: set after tool-result, cleared when new assistant msg is created
      let needsNewAssistantMsg = false;
      const maybeCreateAssistantMsg = () => {
        if (needsNewAssistantMsg) {
          needsNewAssistantMsg = false;
          addMessageToSession(sessionId, {
            id: generateId(), role: 'assistant', content: '', timestamp: Date.now(),
            model: agentConfig.name || 'external',
          });
        }
      };

      await runAcpAgentTurn(
        bridge,
        requestId,
        sessionId,
        agentConfig,
        trimmed,
        {
          onTextDelta: (text: string) => {
            maybeCreateAssistantMsg();
            updateLastMessage(sessionId, msg => ({
              ...msg,
              content: msg.content + text,
              statusText: undefined,
              thinkingDurationMs: msg.thinking && !msg.thinkingDurationMs
                ? Date.now() - msg.timestamp : msg.thinkingDurationMs,
            }));
          },
          onThinkingDelta: (text: string) => {
            maybeCreateAssistantMsg();
            updateLastMessage(sessionId, msg => ({
              ...msg, thinking: (msg.thinking || '') + text,
            }));
          },
          onThinkingDone: () => {
            updateLastMessage(sessionId, msg => ({
              ...msg, thinkingDurationMs: msg.thinkingDurationMs || (Date.now() - msg.timestamp),
            }));
          },
          onToolCall: (toolName: string, args: Record<string, unknown>) => {
            maybeCreateAssistantMsg();
            updateLastMessage(sessionId, msg => ({
              ...msg,
              toolCalls: [...(msg.toolCalls || []), { id: `tc_${Date.now()}`, name: toolName, arguments: args }],
              executionStatus: 'running',
              statusText: undefined,
            }));
          },
          onToolResult: (toolCallId: string, result: string) => {
            updateLastMessage(sessionId, msg =>
              msg.role === 'assistant' && msg.executionStatus === 'running'
                ? { ...msg, executionStatus: 'completed', statusText: undefined } : msg,
            );
            addMessageToSession(sessionId, {
              id: generateId(), role: 'tool', content: '',
              toolResults: [{ toolCallId, content: result, isError: false }],
              timestamp: Date.now(), executionStatus: 'completed',
            });
            needsNewAssistantMsg = true;
          },
          onStatus: (message: string) => {
            maybeCreateAssistantMsg();
            updateLastMessage(sessionId, msg => ({ ...msg, statusText: message }));
          },
          onSessionId: (externalSessionId: string) => {
            context.updateExternalSessionId?.(sessionId, externalSessionId);
          },
          onError: (error: string) => {
            reportStreamError(sessionId, abortController.signal, error);
            setStreamingForScope(sessionId, false);
          },
          onDone: () => {},
        },
        abortController.signal,
        agentProviderId,
        context.selectedAgentModel,
        context.existingSessionId,
        context.historyMessages,
        attachedImages.length > 0 ? attachedImages : undefined,
      );
    } else {
      // Fallback: spawn as raw process
      await runExternalAgentTurn(
        agentConfig,
        trimmed,
        {
          onTextDelta: (text: string) => {
            updateLastMessage(sessionId, msg => ({ ...msg, content: msg.content + text }));
          },
          onError: (error: string) => {
            reportStreamError(sessionId, abortController.signal, error);
            setStreamingForScope(sessionId, false);
          },
          onDone: () => {},
        },
        bridge as unknown as Parameters<typeof runExternalAgentTurn>[3],
        abortController.signal,
      );
    }
  }, [
    addMessageToSession, updateLastMessage, setStreamingForScope, reportStreamError,
  ]);

  // -------------------------------------------------------------------
  // sendToCattyAgent
  // -------------------------------------------------------------------

  const sendToCattyAgent = useCallback(async (
    sessionId: string,
    sendScopeKey: string,
    trimmed: string,
    abortController: AbortController,
    currentSession: AISession | undefined,
    assistantMsgId: string,
    context: SendToCattyContext,
  ) => {
    const bridge = getNetcattyBridge();
    const toolContext = context.getExecutorContext ?? (() => ({
      sessions: context.terminalSessions,
      workspaceId: context.scopeType === 'workspace' ? context.scopeTargetId : undefined,
      workspaceName: context.scopeType === 'workspace' ? context.scopeLabel : undefined,
    }));
    const tools = createCattyTools(
      bridge,
      toolContext,
      context.commandBlocklist,
      context.globalPermissionMode,
      context.webSearchConfig ?? undefined,
    );

    const systemPrompt = buildSystemPrompt({
      scopeType: context.scopeType, scopeLabel: context.scopeLabel,
      hosts: context.terminalSessions.map(s => ({
        sessionId: s.sessionId, hostname: s.hostname, label: s.label,
        os: s.os, username: s.username, connected: s.connected,
      })),
      permissionMode: context.globalPermissionMode,
      webSearchEnabled: isWebSearchReady(context.webSearchConfig),
    });

    // Guard: activeProvider must exist for Catty agent path
    if (!context.activeProvider) {
      reportStreamError(sessionId, abortController.signal, 'No AI provider configured. Please configure a provider in Settings → AI.');
      return;
    }

    // Create model with placeholder API key — the main process injects the real
    // decrypted key when the HTTP request is proxied through IPC, so plaintext
    // keys never transit the renderer ↔ main IPC boundary.
    let model;
    try {
      model = createModelFromConfig({
        ...context.activeProvider,
        defaultModel: context.activeModelId || context.activeProvider.defaultModel || '',
      });
    } catch (e) {
      console.error('[Catty] Model creation failed:', e);
      reportStreamError(sessionId, abortController.signal, `Model creation failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    try {
      // Issue #5: Build SDK messages including tool-call and tool-result messages
      // so the LLM maintains full conversation context
      const allMessages = currentSession?.messages ?? [];

      // Collect all tool call IDs that have a corresponding tool result,
      // so we can skip orphaned tool calls (e.g. from user stopping mid-execution)
      const resolvedToolCallIds = new Set<string>();
      for (const m of allMessages) {
        if (m.role === 'tool' && m.toolResults) {
          for (const tr of m.toolResults) resolvedToolCallIds.add(tr.toolCallId);
        }
      }

      const findToolName = (toolCallId: string): string => {
        for (const prev of allMessages) {
          if (prev.role === 'assistant' && prev.toolCalls) {
            const tc = prev.toolCalls.find(t => t.id === toolCallId);
            if (tc) return tc.name;
          }
        }
        return 'unknown';
      };

      const sdkMessages: Array<ModelMessage> = [];
      for (const m of allMessages) {
        if (m.role === 'user') {
          sdkMessages.push({ role: 'user', content: m.content });
        } else if (m.role === 'assistant') {
          if (m.toolCalls?.length) {
            // Only include tool calls that have matching results
            const resolvedCalls = m.toolCalls.filter(tc => resolvedToolCallIds.has(tc.id));
            const contentParts: Array<
              { type: 'text'; text: string } |
              { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
            > = [];
            if (m.content) {
              contentParts.push({ type: 'text' as const, text: m.content });
            }
            for (const tc of resolvedCalls) {
              contentParts.push({
                type: 'tool-call' as const,
                toolCallId: tc.id,
                toolName: tc.name,
                input: tc.arguments ?? {},
              });
            }
            // If all tool calls were orphaned, just include the text content
            if (contentParts.length > 0) {
              sdkMessages.push({ role: 'assistant', content: contentParts.length === 1 && contentParts[0].type === 'text' ? (contentParts[0] as { type: 'text'; text: string }).text : contentParts });
            }
          } else if (m.content) {
            sdkMessages.push({ role: 'assistant', content: m.content });
          }
        } else if (m.role === 'tool' && m.toolResults?.length) {
          sdkMessages.push({
            role: 'tool',
            content: m.toolResults.map(tr => ({
              type: 'tool-result' as const,
              toolCallId: tr.toolCallId,
              toolName: findToolName(tr.toolCallId),
              output: { type: 'text' as const, value: tr.content },
            })),
          });
        }
      }
      sdkMessages.push({ role: 'user', content: trimmed });

      const approvalInfo = await processCattyStream(sessionId, model, systemPrompt, tools, sdkMessages, abortController.signal, assistantMsgId);

      if (approvalInfo) {
        context.setPendingApproval({
          sessionId, scopeKey: sendScopeKey, sdkMessages, approvalInfo, model, systemPrompt, tools,
        });
        return; // Keep streaming flag — waiting for user approval
      }
    } catch (err) {
      console.error('[Catty] streamText error:', err);
      reportStreamError(sessionId, abortController.signal, err);
    } finally {
      // Clear any lingering statusText when the stream finishes
      updateLastMessage(sessionId, msg => msg.statusText ? { ...msg, statusText: '' } : msg);
      setStreamingForScope(sessionId, false);
      abortControllersRef.current.delete(sessionId);
      context.autoTitleSession(sessionId, trimmed);
    }
  }, [
    processCattyStream, reportStreamError, setStreamingForScope,
    updateLastMessage,
  ]);

  return {
    streamingSessionIds,
    setStreamingForScope,
    abortControllersRef,
    processCattyStream,
    sendToCattyAgent,
    sendToExternalAgent,
    reportStreamError,
  };
}
