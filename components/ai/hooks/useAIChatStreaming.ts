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
  AIToolIntegrationMode,
  AISession,
  ChatMessage,
  ChatMessageAttachment,
  ExternalAgentConfig,
  ProviderAdvancedParams,
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
import { classifyError } from '../../../infrastructure/ai/errorClassifier';
import {
  extractProviderContinuationFromRawChunk,
  isProviderContinuationForSource,
  mergeProviderContinuation,
  normalizeProviderContinuationOptions,
  withProviderContinuationSource,
  type OpenAIChatAssistantFields,
  type ProviderContinuation,
  type ProviderContinuationOptions,
  type ProviderContinuationSource,
} from '../../../infrastructure/ai/providerContinuation';

// -------------------------------------------------------------------
// Stream chunk type interfaces (Issue #13: replace unsafe casts)
// -------------------------------------------------------------------

/** Shape of a text/text-delta chunk from the Vercel AI SDK fullStream. */
interface TextDeltaChunk {
  type: 'text' | 'text-delta';
  text?: string;
  textDelta?: string;
  providerMetadata?: unknown;
}

/** Shape of a reasoning chunk from the Vercel AI SDK fullStream. */
interface ReasoningChunk {
  type: 'reasoning' | 'reasoning-start' | 'reasoning-delta';
  text?: string;
  textDelta?: string;
  delta?: string;
  providerMetadata?: unknown;
}

/** Shape of a raw provider chunk from the Vercel AI SDK fullStream. */
interface RawChunk {
  type: 'raw';
  rawValue: unknown;
}

/** Shape of a tool-call chunk from the Vercel AI SDK fullStream. */
interface ToolCallChunk {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input?: unknown;
  args?: unknown;
  providerMetadata?: unknown;
}

/** Shape of a tool-result chunk from the Vercel AI SDK fullStream. */
interface ToolResultChunk {
  type: 'tool-result';
  toolCallId: string;
  output?: unknown;
  result?: unknown;
}

/** Detect tool results that represent errors/denials (e.g. `{ error: "..." }` or `{ ok: false }`) */
function isToolResultError(output: unknown): boolean {
  if (output == null) return false;
  
  if (typeof output === 'object') {
    const obj = output as Record<string, unknown>;
    // Check for explicit error objects
    if ('error' in obj && typeof obj.error === 'string') return true;
    if ('ok' in obj && obj.ok === false) return true;
  }
  
  // Check stringified JSON (common for tool result wrapping)
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed === 'object') {
        const parsedObj = parsed as Record<string, unknown>;
        if ('error' in parsedObj && typeof parsedObj.error === 'string') return true;
        if ('ok' in parsedObj && parsedObj.ok === false) return true;
      }
    } catch { /* not JSON, not an error */ }
  }
  
  return false;
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
  | ErrorChunk
  | RawChunk
  | { type: 'reasoning-end' | 'text-start' | 'text-end' | 'start' | 'finish' | 'start-step' | 'finish-step' | 'tool-approval-request' };

/** Shape of the netcatty bridge exposed on `window` (panel-specific subset). */
export interface PanelBridge extends NetcattyBridge {
  credentialsDecrypt?: (value: string) => Promise<string>;
  aiSyncProviders?: (providers: Array<{ id: string; providerId: string; apiKey?: string; baseURL?: string; enabled: boolean }>) => Promise<{ ok: boolean }>;
  aiSyncWebSearch?: (apiHost: string | null, apiKey: string | null) => Promise<{ ok: boolean }>;
  aiMcpUpdateSessions?: (sessions: TerminalSessionInfo[], chatSessionId?: string) => Promise<unknown>;
  aiAcpListModels?: (
    acpCommand: string,
    acpArgs?: string[],
    cwd?: string,
    providerId?: string,
    chatSessionId?: string,
  ) => Promise<{ ok: boolean; models?: Array<{ id: string; name: string; description?: string; thinkingLevels?: string[] }>; currentModelId?: string | null; error?: string }>;
  aiAcpCleanup?: (chatSessionId: string) => Promise<{ ok: boolean }>;
  aiUserSkillsGetStatus?: () => Promise<{
    ok: boolean;
    skills?: Array<{
      id: string;
      slug: string;
      name: string;
      description: string;
      status: 'ready' | 'warning';
    }>;
  }>;
  aiUserSkillsBuildContext?: (prompt: string, selectedSkillSlugs?: string[]) => Promise<{ ok: boolean; context?: string; error?: string }>;
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
  protocol?: string;
  shellType?: string;
  deviceType?: string;
  connected: boolean;
}

export interface DefaultTargetSessionHint extends TerminalSessionInfo {
  source: 'scope-target' | 'only-connected-in-scope';
}

interface CattyProviderContinuationContext {
  source: ProviderContinuationSource;
  openAIChatAssistantFields: Array<OpenAIChatAssistantFields | undefined>;
}

type AssistantContentPart =
  | { type: 'reasoning'; text: string; providerOptions?: ProviderContinuationOptions }
  | { type: 'text'; text: string; providerOptions?: ProviderContinuationOptions }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown; providerOptions?: ProviderContinuationOptions };

function toAssistantModelContent(parts: AssistantContentPart[]): string | AssistantContentPart[] {
  if (parts.length === 1 && parts[0].type === 'text' && !parts[0].providerOptions) {
    return parts[0].text;
  }
  return parts;
}

/** Typed accessor for the netcatty bridge on the window object. */
export function getNetcattyBridge(): PanelBridge | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).netcatty as PanelBridge | undefined;
}

// ApprovalInfo and PendingApprovalContext removed — approval is now handled
// inside the tool's execute function via the approvalGate module.

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const USER_SKILLS_CONTEXT_TIMEOUT_MS = 500;

interface UserSkillsContextResult {
  ok: boolean;
  context?: string;
  error?: string;
}

function buildExplicitUserSkillsFallback(selectedUserSkillSlugs?: string[]): string {
  if (!selectedUserSkillSlugs?.length) return '';
  return `The user explicitly selected these Netcatty user skills for this request: ${selectedUserSkillSlugs.map((slug) => `/${slug}`).join(', ')}. Honor those selections even if their expanded skill content is unavailable.`;
}

async function resolveUserSkillsContext(
  bridge: PanelBridge | undefined,
  prompt: string,
  selectedUserSkillSlugs?: string[],
): Promise<string> {
  if (!bridge?.aiUserSkillsBuildContext) {
    return buildExplicitUserSkillsFallback(selectedUserSkillSlugs);
  }

  const buildContextPromise: Promise<UserSkillsContextResult> = bridge
    .aiUserSkillsBuildContext(prompt, selectedUserSkillSlugs)
    .catch(() => ({ ok: false, context: '' }));

  const hasExplicitSelections = (selectedUserSkillSlugs?.length ?? 0) > 0;
  const result = hasExplicitSelections
    ? await buildContextPromise
    : await Promise.race([
        buildContextPromise,
        new Promise<UserSkillsContextResult>((resolve) =>
          setTimeout(() => resolve({ ok: false, context: '' }), USER_SKILLS_CONTEXT_TIMEOUT_MS),
        ),
      ]);

  return result.context || buildExplicitUserSkillsFallback(selectedUserSkillSlugs);
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
  /** Process a Catty agent stream. */
  processCattyStream: (
    streamSessionId: string,
    model: ReturnType<typeof createModelFromConfig>,
    systemPrompt: string,
    tools: ReturnType<typeof createCattyTools>,
    sdkMessages: Array<ModelMessage>,
    signal: AbortSignal,
    currentAssistantMsgId: string,
    advancedParams?: ProviderAdvancedParams,
    continuationContext?: CattyProviderContinuationContext,
  ) => Promise<void>;
  /** Send a message to the Catty agent (built-in). */
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
  autoTitleSession: (sessionId: string, text: string) => void;
  selectedUserSkillSlugs?: string[];
}

/** Context values needed by sendToExternalAgent that change frequently. */
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
    // Log the full unsanitized error for debugging
    console.error('[AIChatSidePanel] Stream error (full):', err);
    // Pass the raw error to classifyError so it can inspect structured
    // fields (statusCode, responseBody) from APICallError and friends;
    // string-coercing here would strip the metadata we need to detect
    // 413 / HTML-error-page / parse-failure scenarios.
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
    advancedParams?: ProviderAdvancedParams,
    continuationContext?: CattyProviderContinuationContext,
  ): Promise<void> => {
    const result = streamText({
      model,
      messages: sdkMessages,
      system: systemPrompt,
      tools,
      stopWhen: stepCountIs(maxIterations),
      abortSignal: signal,
      includeRawChunks: true,
      ...(advancedParams?.maxTokens != null && { maxOutputTokens: advancedParams.maxTokens }),
      ...(advancedParams?.temperature != null && { temperature: advancedParams.temperature }),
      ...(advancedParams?.topP != null && { topP: advancedParams.topP }),
      ...(advancedParams?.frequencyPenalty != null && { frequencyPenalty: advancedParams.frequencyPenalty }),
      ...(advancedParams?.presencePenalty != null && { presencePenalty: advancedParams.presencePenalty }),
    });

    // Track the current assistant message ID so updates target the correct message
    let activeMsgId = currentAssistantMsgId;
    let lastAddedRole: 'assistant' | 'tool' = 'assistant';
    const reader = result.fullStream.getReader();

    // -- Text-delta batching: accumulate deltas and flush periodically --
    let pendingText = '';
    let rafId: number | null = null;
    const openAIFieldIndexByMessageId = new Map<string, number>();

    const ensureAssistantMessage = (): string => {
      if (lastAddedRole !== 'tool') return activeMsgId;

      const newId = generateId();
      addMessageToSession(streamSessionId, {
        id: newId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
      });
      activeMsgId = newId;
      lastAddedRole = 'assistant';
      return activeMsgId;
    };

    const ensureOpenAIChatFieldSlot = (messageId: string): number | undefined => {
      if (!continuationContext) return undefined;
      let fieldIndex = openAIFieldIndexByMessageId.get(messageId);
      if (fieldIndex === undefined) {
        fieldIndex = continuationContext.openAIChatAssistantFields.length;
        continuationContext.openAIChatAssistantFields.push(undefined);
        openAIFieldIndexByMessageId.set(messageId, fieldIndex);
      }
      return fieldIndex;
    };

    const mergeOpenAIChatFields = (
      messageId: string,
      fields: OpenAIChatAssistantFields | undefined,
    ) => {
      if (!fields || !continuationContext) return;

      const fieldIndex = ensureOpenAIChatFieldSlot(messageId);
      if (fieldIndex === undefined) return;

      const merged = mergeProviderContinuation(
        { openAIChatAssistantFields: continuationContext.openAIChatAssistantFields[fieldIndex] },
        { openAIChatAssistantFields: fields },
      );
      continuationContext.openAIChatAssistantFields[fieldIndex] = merged?.openAIChatAssistantFields;
    };

    const updateAssistantContinuation = (
      messageId: string,
      continuation: ProviderContinuation | undefined,
      thinkingText = '',
    ) => {
      if (!continuation && !thinkingText) return;
      const sourcedContinuation = withProviderContinuationSource(continuation, continuationContext?.source);
      mergeOpenAIChatFields(messageId, sourcedContinuation?.openAIChatAssistantFields);
      updateMessageById(streamSessionId, messageId, msg => {
        const providerContinuation = mergeProviderContinuation(msg.providerContinuation, sourcedContinuation);
        return {
          ...msg,
          ...(providerContinuation ? { providerContinuation } : {}),
          ...(thinkingText ? { thinking: (msg.thinking || '') + thinkingText } : {}),
        };
      });
    };

    const getOpenAIReasoningText = (continuation: ProviderContinuation | undefined): string => {
      const reasoningContent = continuation?.openAIChatAssistantFields?.reasoning_content;
      return typeof reasoningContent === 'string' ? reasoningContent : '';
    };

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
          const providerOptions = normalizeProviderContinuationOptions(typedChunk.providerMetadata);
          if (providerOptions) {
            const messageId = ensureAssistantMessage();
            updateAssistantContinuation(messageId, { textProviderOptions: providerOptions });
          }
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
          const rText = typedChunk.text ?? typedChunk.textDelta ?? typedChunk.delta ?? '';
          const providerOptions = normalizeProviderContinuationOptions(typedChunk.providerMetadata);
          const continuation = rText || providerOptions
            ? {
                reasoningParts: [{
                  text: rText,
                  ...(providerOptions ? { providerOptions } : {}),
                }],
              } satisfies ProviderContinuation
            : undefined;
          if (continuation || rText) {
            const messageId = ensureAssistantMessage();
            updateAssistantContinuation(messageId, continuation, rText);
          }
          break;
        }
        case 'raw': {
          const typedChunk = chunk as RawChunk;
          const continuation = extractProviderContinuationFromRawChunk(typedChunk.rawValue);
          if (continuation) {
            cancelPendingFlush();
            flushText();
            const messageId = ensureAssistantMessage();
            updateAssistantContinuation(messageId, continuation, getOpenAIReasoningText(continuation));
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
          const messageId = ensureAssistantMessage();
          ensureOpenAIChatFieldSlot(messageId);
          const providerOptions = normalizeProviderContinuationOptions(typedChunk.providerMetadata);
          updateMessageById(streamSessionId, messageId, msg => ({
            ...msg,
            toolCalls: [...(msg.toolCalls || []), {
              id: typedChunk.toolCallId,
              name: typedChunk.toolName,
              arguments: (typedChunk.input ?? typedChunk.args) as Record<string, unknown>,
            }],
            executionStatus: 'running',
            statusText: undefined,
          }));
          if (providerOptions) {
            updateAssistantContinuation(messageId, {
              toolCallProviderOptionsById: {
                [typedChunk.toolCallId]: providerOptions,
              },
            });
          }
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
          const toolError = isToolResultError(toolOutput);
          addMessageToSession(streamSessionId, {
            id: generateId(),
            role: 'tool',
            content: '',
            toolResults: [{
              toolCallId: typedChunk.toolCallId,
              content: typeof toolOutput === 'string'
                ? toolOutput
                : JSON.stringify(toolOutput),
              isError: toolError,
            }],
            timestamp: Date.now(),
            executionStatus: 'completed',
          });
          lastAddedRole = 'tool';
          break;
        }
        // tool-approval-request is no longer handled here — approval is now
        // inside the tool's execute function via the approvalGate module.
        // The SDK may still emit this chunk type but we simply ignore it.
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
            // Pass the raw error so classifyError can detect 413 / HTML /
            // schema-parse scenarios via structured fields (statusCode,
            // responseBody) instead of lossy string conversion.
            errorInfo: classifyError(typedChunk.error),
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
    return;
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
    const userSkillsContext = await resolveUserSkillsContext(
      bridge,
      trimmed,
      context.selectedUserSkillSlugs,
    );

    if (agentConfig.acpCommand && bridge) {
      const requestId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      // Push terminal session metadata to MCP bridge
      if (bridge?.aiMcpUpdateSessions) {
        await bridge.aiMcpUpdateSessions(context.terminalSessions, sessionId);
      }

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
          onToolCall: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => {
            maybeCreateAssistantMsg();
            updateLastMessage(sessionId, msg => ({
              ...msg,
              toolCalls: [...(msg.toolCalls || []), { id: toolCallId || `tc_${Date.now()}`, name: toolName, arguments: args }],
              executionStatus: 'running',
              statusText: undefined,
            }));
          },
          onToolResult: (toolCallId: string, result: string, toolName?: string) => {
            updateLastMessage(sessionId, msg => {
              if (msg.role !== 'assistant' || msg.executionStatus !== 'running') return msg;
              // Only patch tool call name if the existing name is missing/generic
              // (don't overwrite a good name from onToolCall with a wrapper name from tool-result)
              const updatedToolCalls = toolName && !toolName.includes('acp_provider_agent_dynamic_tool') && msg.toolCalls
                ? msg.toolCalls.map(tc => tc.id === toolCallId && !tc.name ? { ...tc, name: toolName } : tc)
                : msg.toolCalls;
              return { ...msg, toolCalls: updatedToolCalls, executionStatus: 'completed', statusText: undefined };
            });
            const toolError = isToolResultError(result);
            addMessageToSession(sessionId, {
              id: generateId(), role: 'tool', content: '',
              toolResults: [{ toolCallId, content: result, isError: toolError }],
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
        // Managed ACP agents (codex, claude) must resolve auth from their own
        // CLI config/login state, so we deliberately pass no providerId here.
        // See issue #705 for Codex; same reasoning for Claude.
        undefined,
        context.selectedAgentModel,
        context.existingSessionId,
        context.historyMessages,
        attachedImages.length > 0 ? attachedImages : undefined,
        context.toolIntegrationMode,
        context.defaultTargetSession,
        userSkillsContext,
      );
    } else {
      // Fallback: spawn as raw process
      await runExternalAgentTurn(
        agentConfig,
        userSkillsContext ? `${userSkillsContext}\n\nUser request:\n${trimmed}` : trimmed,
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
    attachments?: ChatMessageAttachment[],
  ) => {
    const bridge = getNetcattyBridge();
    const userSkillsContext = await resolveUserSkillsContext(
      bridge,
      trimmed,
      context.selectedUserSkillSlugs,
    );
    const getExecutorContext = context.getExecutorContext ?? (() => ({
      sessions: context.terminalSessions,
      workspaceId: context.scopeType === 'workspace' ? context.scopeTargetId : undefined,
      workspaceName: context.scopeType === 'workspace' ? context.scopeLabel : undefined,
    }));
    const tools = createCattyTools(
      bridge,
      getExecutorContext,
      context.commandBlocklist,
      context.globalPermissionMode,
      context.webSearchConfig ?? undefined,
      sessionId,
    );

    const systemPrompt = buildSystemPrompt({
      scopeType: context.scopeType, scopeLabel: context.scopeLabel,
      hosts: context.terminalSessions.map(s => ({
        sessionId: s.sessionId, hostname: s.hostname, label: s.label,
        os: s.os,
        username: s.username,
        protocol: s.protocol,
        shellType: s.shellType,
        deviceType: s.deviceType,
        connected: s.connected,
      })),
      permissionMode: context.globalPermissionMode,
      webSearchEnabled: isWebSearchReady(context.webSearchConfig),
      userSkillsContext,
    });

    // Guard: activeProvider must exist for Catty agent path
    if (!context.activeProvider) {
      reportStreamError(sessionId, abortController.signal, 'No AI provider configured. Please configure a provider in Settings → AI.');
      return;
    }

    const activeModelId = context.activeModelId || context.activeProvider.defaultModel || '';
    const continuationContext: CattyProviderContinuationContext = {
      source: {
        providerConfigId: context.activeProvider.id,
        providerType: context.activeProvider.providerId,
        modelId: activeModelId,
      },
      openAIChatAssistantFields: [],
    };

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
          // Build multimodal content when attachments are present (fallback to legacy `images` field)
          const messageAttachments = m.attachments ?? m.images;
          if (messageAttachments?.length) {
            const parts: Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mediaType?: string } | { type: 'file'; data: string; mediaType: string; filename?: string }> = [];
            parts.push({ type: 'text', text: m.content });
            for (const att of messageAttachments) {
              if (att.mediaType.startsWith('image/')) {
                parts.push({ type: 'image', image: att.base64Data, mediaType: att.mediaType });
              } else {
                parts.push({ type: 'file', data: att.base64Data, mediaType: att.mediaType, filename: att.filename });
              }
            }
            sdkMessages.push({ role: 'user', content: parts });
          } else {
            sdkMessages.push({ role: 'user', content: m.content });
          }
        } else if (m.role === 'assistant') {
          const activeContinuation = isProviderContinuationForSource(
            m.providerContinuation,
            continuationContext.source,
          )
            ? m.providerContinuation
            : undefined;
          if (m.toolCalls?.length) {
            // Only include tool calls that have matching results
            const resolvedCalls = m.toolCalls.filter(tc => resolvedToolCallIds.has(tc.id));
            const contentParts: AssistantContentPart[] = [];
            if (resolvedCalls.length > 0) {
              for (const part of activeContinuation?.reasoningParts ?? []) {
                if (!part.text && !part.providerOptions) continue;
                contentParts.push({
                  type: 'reasoning' as const,
                  text: part.text,
                  ...(part.providerOptions ? { providerOptions: part.providerOptions } : {}),
                });
              }
            }
            if (m.content) {
              contentParts.push({
                type: 'text' as const,
                text: m.content,
                ...(activeContinuation?.textProviderOptions ? { providerOptions: activeContinuation.textProviderOptions } : {}),
              });
            }
            for (const tc of resolvedCalls) {
              const providerOptions = activeContinuation?.toolCallProviderOptionsById?.[tc.id];
              contentParts.push({
                type: 'tool-call' as const,
                toolCallId: tc.id,
                toolName: tc.name,
                input: tc.arguments ?? {},
                ...(providerOptions ? { providerOptions } : {}),
              });
            }
            // If all tool calls were orphaned, just include the text content
            if (contentParts.length > 0) {
              sdkMessages.push({ role: 'assistant', content: toAssistantModelContent(contentParts) });
              if (resolvedCalls.length > 0) {
                continuationContext.openAIChatAssistantFields.push(activeContinuation?.openAIChatAssistantFields);
              }
            }
          } else if (m.content) {
            const contentParts: AssistantContentPart[] = [];
            for (const part of activeContinuation?.reasoningParts ?? []) {
              if (!part.text && !part.providerOptions) continue;
              contentParts.push({
                type: 'reasoning' as const,
                text: part.text,
                ...(part.providerOptions ? { providerOptions: part.providerOptions } : {}),
              });
            }
            contentParts.push({
              type: 'text' as const,
              text: m.content,
              ...(activeContinuation?.textProviderOptions ? { providerOptions: activeContinuation.textProviderOptions } : {}),
            });
            sdkMessages.push({
              role: 'assistant',
              content: toAssistantModelContent(contentParts),
            });
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
      // Build the current user message — include attachments as multimodal content
      if (attachments?.length) {
        const parts: Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mediaType?: string } | { type: 'file'; data: string; mediaType: string; filename?: string }> = [];
        parts.push({ type: 'text', text: trimmed });
        for (const att of attachments) {
          if (att.mediaType.startsWith('image/')) {
            parts.push({ type: 'image', image: att.base64Data, mediaType: att.mediaType });
          } else {
            parts.push({ type: 'file', data: att.base64Data, mediaType: att.mediaType, filename: att.filename });
          }
        }
        sdkMessages.push({ role: 'user', content: parts });
      } else {
        sdkMessages.push({ role: 'user', content: trimmed });
      }

      // Create model with placeholder API key — the main process injects the real
      // decrypted key when the HTTP request is proxied through IPC, so plaintext
      // keys never transit the renderer ↔ main IPC boundary.
      let model;
      try {
        model = createModelFromConfig(
          {
            ...context.activeProvider,
            defaultModel: activeModelId,
          },
          {
            getOpenAIChatAssistantFields: () => continuationContext.openAIChatAssistantFields,
          },
        );
      } catch (e) {
        console.error('[Catty] Model creation failed:', e);
        reportStreamError(sessionId, abortController.signal, `Model creation failed: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }

      await processCattyStream(
        sessionId,
        model,
        systemPrompt,
        tools,
        sdkMessages,
        abortController.signal,
        assistantMsgId,
        context.activeProvider?.advancedParams,
        continuationContext,
      );
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
