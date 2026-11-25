import { streamText, isStepCount, type ModelMessage } from 'ai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { classifyError, isInvalidAnthropicThinkingSignatureError, isRequestTooLargeError } from '../../errorClassifier';
import { isSdkStreamStateError } from '../../shared/streamStateErrors';
import {
  createCattyAnthropicSignatureRetryError,
  createCattyRequestTooLargeRetryError,
  hadToolProgressBeforeRequestTooLarge,
} from '../../cattyRequestTooLargeRetry';
import { mapCattyStreamChunkToAgentEvents } from '../agentEventAdapter';
import type { AgentEvent } from '../types';
import { resolveProviderStyle, type ProviderAdvancedParams } from '../../types';
import type { CattyReasoningProviderOptions } from '../../cattyReasoning';
import { resolveProviderEndpoint } from '../../sdk/providers';
import type { CattyToolsBundle } from '../capabilityTools';
import { buildCattyToolApproval } from '../cattyToolApproval';
import type { CattyRuntimeContext } from '../cattyRuntimeContext';
import { buildCattyStreamTimeouts } from '../streamTimeouts';
import { createCattyPromptCache } from '../cattyPromptCache';
import {
  extractProviderContinuationFromRawChunk,
  mergeProviderContinuation,
  normalizeProviderContinuationOptions,
  withProviderContinuationSource,
  type ProviderContinuation,
  type ProviderContinuationOptions,
  type ProviderContinuationReasoningPart,
} from '../../providerContinuation';
import {
  formatToolErrorContent,
  generateId,
  isToolResultError,
  resolveStreamChunkToolCallId,
  type CattyProviderContinuationContext,
  type ErrorChunk,
  type RawChunk,
  type ReasoningChunk,
  type StreamChunk,
  type TextDeltaChunk,
  type ToolApprovalResponseChunk,
  type ToolCallChunk,
  type ToolErrorChunk,
  type ToolOutputDeniedChunk,
  type ToolResultChunk,
} from '../../aiChatStreamingSupport';
import type { ChatMessage, ProviderConfig } from '../../types';

export type CattyModel = LanguageModelV4;

export interface CattyStreamUiSink {
  addMessageToSession: (sessionId: string, message: ChatMessage) => void;
  updateMessageById: (sessionId: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
}

export interface ProcessCattyStreamInput {
  streamSessionId: string;
  model: CattyModel;
  providerConfig?: ProviderConfig;
  systemPrompt: string;
  toolsBundle: CattyToolsBundle;
  sdkMessages: ModelMessage[];
  signal: AbortSignal;
  currentAssistantMsgId: string;
  maxIterations: number;
  advancedParams?: ProviderAdvancedParams;
  reasoningProviderOptions?: CattyReasoningProviderOptions;
  continuationContext?: CattyProviderContinuationContext;
  turnId?: string;
  commandTimeoutMs?: number;
  responseIdleTimeoutMs?: number;
  runtimeContext: CattyRuntimeContext;
  onAgentEvent?: (event: AgentEvent) => void;
  prepareStep?: (args: {
    stepNumber: number;
    messages: ModelMessage[];
    runtimeContext: CattyRuntimeContext;
  }) => Promise<{ messages: ModelMessage[]; runtimeContext?: CattyRuntimeContext } | undefined>;
  ui: CattyStreamUiSink;
}

export interface ProcessCattyStreamResult {
  usage?: {
    promptTokens?: number;
    cachedPromptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  performance?: {
    responseTimeMs?: number;
    timeToFirstOutputMs?: number;
    outputTokensPerSecond?: number;
  };
}

/** Skip trace emission for SDK-internal stream bookkeeping errors we suppress in UI. */
export function shouldEmitAgentEventsForStreamChunk(chunk: StreamChunk): boolean {
  if (chunk.type !== 'error') return true;
  return !isSdkStreamStateError((chunk as ErrorChunk).error);
}

/**
 * Detect provider metadata that actually carries replayable reasoning
 * ciphertext (e.g. `openai.reasoningEncryptedContent`). A null/absent payload
 * must not be persisted: merging it over a previously captured ciphertext
 * would invalidate the stateless reasoning replay.
 */
function hasReasoningEncryptedContent(options: Record<string, Record<string, unknown>>): boolean {
  return Object.values(options).some(providerOptions =>
    typeof providerOptions?.reasoningEncryptedContent === 'string'
    && providerOptions.reasoningEncryptedContent.length > 0,
  );
}

function areJsonValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!areJsonValuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!areJsonValuesEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

function isBatchableRawReasoningContinuation(continuation: ProviderContinuation): boolean {
  if (continuation.textProviderOptions || continuation.toolCallProviderOptionsById) {
    return false;
  }
  const fields = continuation.openAIChatAssistantFields;
  if (fields) {
    const keys = Object.keys(fields);
    if (keys.some(key => key !== 'reasoning_content')) return false;
    if (fields.reasoning_content !== undefined && typeof fields.reasoning_content !== 'string') {
      return false;
    }
  }
  return Boolean(continuation.reasoningParts?.length || fields?.reasoning_content);
}

export async function processCattyStream(input: ProcessCattyStreamInput): Promise<ProcessCattyStreamResult> {
  const {
    streamSessionId,
    model,
    systemPrompt,
    toolsBundle,
    sdkMessages,
    signal,
    currentAssistantMsgId,
    maxIterations,
    advancedParams,
    reasoningProviderOptions,
    continuationContext,
    turnId,
    commandTimeoutMs,
    responseIdleTimeoutMs,
    runtimeContext: initialRuntimeContext,
    onAgentEvent,
    prepareStep,
    ui,
  } = input;

  let runtimeContext = initialRuntimeContext;
  if (!Array.isArray(sdkMessages) || sdkMessages.length === 0) {
    throw new Error('Invalid prompt: Catty refused an empty messages array (#4102).');
  }
  const { tools, toolsContext } = toolsBundle;
  const endpoint = input.providerConfig
    ? resolveProviderEndpoint(input.providerConfig, resolveProviderStyle(input.providerConfig), undefined)
    : undefined;
  const promptCache = createCattyPromptCache(systemPrompt, model.provider, endpoint);

  let reachedIterationLimit = false;
  const stopAtIterationLimit = isStepCount(maxIterations);
  const result = streamText({
    model,
    messages: promptCache.prepareMessages(sdkMessages),
    instructions: promptCache.instructions,
    tools,
    toolsContext,
    runtimeContext,
    toolApproval: runtimeContext.delegated ? undefined : buildCattyToolApproval({
      permissionMode: runtimeContext.permissionMode,
      chatSessionId: runtimeContext.chatSessionId,
    }),
    // The SDK evaluates stopWhen only when tool work would allow another
    // step. A natural final reply (even on the last allowed step) bypasses it.
    stopWhen: async (options) => {
      reachedIterationLimit = await stopAtIterationLimit(options);
      return reachedIterationLimit;
    },
    abortSignal: signal,
    include: { rawChunks: true },
    timeout: buildCattyStreamTimeouts({
      permissionMode: runtimeContext.permissionMode,
      commandTimeoutMs,
      responseIdleTimeoutMs,
      maxIterations,
    }),
    telemetry: {
      functionId: `catty-${runtimeContext.agentKind}`,
      metadata: {
        chatSessionId: runtimeContext.chatSessionId,
        turnId: runtimeContext.turnId,
      },
    },
    onStart: ({ callId, modelId, runtimeContext: startContext }) => {
      onAgentEvent?.({
        id: `model-call-start-${callId}`,
        type: 'model_call_start',
        sessionId: streamSessionId,
        chatSessionId: startContext.chatSessionId,
        backend: 'catty',
        timestamp: Date.now(),
        turnId,
        callId,
        modelId,
        providerId: startContext.providerId,
      } as AgentEvent);
    },
    onStepEnd: (step) => {
      const usage = step.usage;
      onAgentEvent?.({
        id: `step-end-${step.callId}-${step.stepNumber}`,
        type: 'step_end',
        sessionId: streamSessionId,
        chatSessionId: step.runtimeContext.chatSessionId,
        backend: 'catty',
        timestamp: Date.now(),
        turnId,
        callId: step.callId,
        stepNumber: step.stepNumber,
        modelId: step.model.modelId,
        finishReason: step.finishReason,
        promptTokens: usage.inputTokens ?? 0,
        cachedPromptTokens: usage.inputTokenDetails?.cacheReadTokens,
        completionTokens: usage.outputTokens ?? 0,
        totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      } as AgentEvent);
    },
    onEnd: ({ callId, usage, runtimeContext: endContext }) => {
      if (usage) {
        onAgentEvent?.({
          id: `usage-${callId}`,
          type: 'usage',
          sessionId: streamSessionId,
          chatSessionId: endContext.chatSessionId,
          backend: 'catty',
          timestamp: Date.now(),
          turnId,
          promptTokens: usage.inputTokens ?? 0,
          cachedPromptTokens: usage.inputTokenDetails?.cacheReadTokens,
          completionTokens: usage.outputTokens ?? 0,
          reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
          totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
          estimated: false,
        } as AgentEvent);
      }
    },
    ...(prepareStep || promptCache.enabled ? {
      prepareStep: async ({ stepNumber, messages, runtimeContext: stepRuntimeContext }) => {
        const prepared = await prepareStep?.({
          stepNumber,
          messages,
          runtimeContext: stepRuntimeContext as CattyRuntimeContext,
        });
        if (prepared?.runtimeContext) {
          runtimeContext = prepared.runtimeContext;
        }
        return { ...prepared, messages: promptCache.prepareMessages(prepared?.messages ?? messages) };
      },
    } : {}),
    ...(advancedParams?.maxTokens != null && { maxOutputTokens: advancedParams.maxTokens }),
    ...(advancedParams?.temperature != null && { temperature: advancedParams.temperature }),
    ...(advancedParams?.topP != null && { topP: advancedParams.topP }),
    ...(advancedParams?.frequencyPenalty != null && { frequencyPenalty: advancedParams.frequencyPenalty }),
    ...(advancedParams?.presencePenalty != null && { presencePenalty: advancedParams.presencePenalty }),
    ...(reasoningProviderOptions ? { providerOptions: reasoningProviderOptions } : {}),
  });

  let activeMsgId = currentAssistantMsgId;
  let lastAddedRole: 'assistant' | 'tool' = 'assistant';
  let hadToolProgress = false;
  const reader = result.stream.getReader();

  let pendingText = '';
  let pendingReasoningParts: ProviderContinuationReasoningPart[] = [];
  let pendingOpenAIReasoningContent = '';
  let pendingThinkingText = '';
  let rafId: number | null = null;
  let rafIsTimeout = false;

  const clearCompactionStatusFromAssistant = (messageId: string) => {
    ui.updateMessageById(streamSessionId, messageId, msg =>
      msg.role === 'assistant' && msg.statusText
        ? { ...msg, statusText: undefined }
        : msg,
    );
  };

  const ensureAssistantMessage = (): string => {
    if (lastAddedRole !== 'tool') return activeMsgId;
    clearCompactionStatusFromAssistant(activeMsgId);
    const newId = generateId();
    ui.addMessageToSession(streamSessionId, {
      id: newId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    });
    activeMsgId = newId;
    lastAddedRole = 'assistant';
    return activeMsgId;
  };

  const updateAssistantContinuation = (
    messageId: string,
    continuation: ProviderContinuation | undefined,
    thinkingText = '',
  ) => {
    if (!continuation && !thinkingText) return;
    const sourcedContinuation = withProviderContinuationSource(continuation, continuationContext?.source);
    ui.updateMessageById(streamSessionId, messageId, msg => {
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

  const hasPendingReasoning = () =>
    pendingReasoningParts.length > 0
    || pendingOpenAIReasoningContent.length > 0
    || pendingThinkingText.length > 0;

  const bufferReasoningPart = (
    rText: string,
    providerOptions: ProviderContinuationOptions | undefined,
  ) => {
    if (!rText && !providerOptions) return;
    const last = pendingReasoningParts.at(-1);
    if (
      last
      && last.text.length > 0
      && rText.length > 0
      && areJsonValuesEqual(last.providerOptions, providerOptions)
    ) {
      last.text += rText;
      return;
    }
    pendingReasoningParts.push({
      text: rText,
      ...(providerOptions ? { providerOptions } : {}),
    });
  };

  const flushPendingReasoning = () => {
    if (!hasPendingReasoning()) return;
    const reasoningParts = pendingReasoningParts;
    const openAIReasoningContent = pendingOpenAIReasoningContent;
    const thinkingText = pendingThinkingText;
    pendingReasoningParts = [];
    pendingOpenAIReasoningContent = '';
    pendingThinkingText = '';

    const continuation: ProviderContinuation | undefined =
      reasoningParts.length > 0 || openAIReasoningContent.length > 0
        ? {
            ...(reasoningParts.length > 0 ? { reasoningParts } : {}),
            ...(openAIReasoningContent.length > 0
              ? { openAIChatAssistantFields: { reasoning_content: openAIReasoningContent } }
              : {}),
          }
        : undefined;
    const messageId = ensureAssistantMessage();
    updateAssistantContinuation(messageId, continuation, thinkingText);
  };

  const flushPendingText = () => {
    if (!pendingText) return;
    const text = pendingText;
    pendingText = '';
    if (lastAddedRole === 'tool') {
      clearCompactionStatusFromAssistant(activeMsgId);
      const newId = generateId();
      ui.addMessageToSession(streamSessionId, {
        id: newId,
        role: 'assistant',
        content: text,
        timestamp: Date.now(),
      });
      activeMsgId = newId;
      lastAddedRole = 'assistant';
    } else {
      ui.updateMessageById(streamSessionId, activeMsgId, msg => ({
        ...msg,
        content: msg.content + text,
        ...(msg.statusText ? { statusText: undefined } : {}),
      }));
    }
  };

  const flushPending = () => {
    rafId = null;
    rafIsTimeout = false;
    flushPendingReasoning();
    flushPendingText();
  };

  const scheduleFlush = () => {
    if (rafId !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      rafId = requestAnimationFrame(flushPending);
      rafIsTimeout = false;
    } else {
      rafId = setTimeout(flushPending, 0) as unknown as number;
      rafIsTimeout = true;
    }
  };

  const cancelPendingFlush = () => {
    if (rafId !== null) {
      if (rafIsTimeout) {
        clearTimeout(rafId);
      } else if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
      }
      rafId = null;
      rafIsTimeout = false;
    }
  };

  const appendToolResultToUi = (toolCallId: string, content: string, isError: boolean) => {
    cancelPendingFlush();
    flushPending();
    hadToolProgress = true;
    ui.updateMessageById(streamSessionId, activeMsgId, msg =>
      msg.role === 'assistant' && msg.executionStatus === 'running'
        ? { ...msg, executionStatus: 'completed', statusText: undefined } : msg,
    );
    ui.addMessageToSession(streamSessionId, {
      id: generateId(),
      role: 'tool',
      content: '',
      toolResults: [{
        toolCallId,
        content,
        isError,
      }],
      timestamp: Date.now(),
      executionStatus: 'completed',
    });
    lastAddedRole = 'tool';
  };

  const deniedToolResultIds = new Set<string>();
  const appendDeniedToolResultToUi = (toolCallId: string, reason?: unknown) => {
    if (deniedToolResultIds.has(toolCallId)) return;
    deniedToolResultIds.add(toolCallId);
    appendToolResultToUi(
      toolCallId,
      formatToolErrorContent(reason, 'Tool execution denied.'),
      true,
    );
  };

  try {
    while (true) {
      let readResult: ReadableStreamReadResult<unknown>;
      try {
        readResult = await reader.read();
      } catch (readErr) {
        if (isRequestTooLargeError(readErr)) {
          throw createCattyRequestTooLargeRetryError(readErr, hadToolProgress);
        }
        if (isInvalidAnthropicThinkingSignatureError(readErr)) {
          throw createCattyAnthropicSignatureRetryError(readErr, hadToolProgress);
        }
        throw readErr;
      }
      const { done, value } = readResult;
      if (done) break;
      const chunk = value as StreamChunk;
      if (shouldEmitAgentEventsForStreamChunk(chunk)) {
        for (const agentEvent of mapCattyStreamChunkToAgentEvents(chunk, {
          sessionId: streamSessionId,
          chatSessionId: streamSessionId,
          turnId,
        })) {
          onAgentEvent?.(agentEvent);
        }
      }
      switch (chunk.type) {
        case 'text':
        case 'text-delta': {
          if (hasPendingReasoning()) {
            cancelPendingFlush();
            flushPendingReasoning();
          }
          const typedChunk = chunk as TextDeltaChunk;
          const text = typedChunk.text ?? typedChunk.textDelta;
          const providerOptions = normalizeProviderContinuationOptions(typedChunk.providerMetadata);
          if (providerOptions) {
            const messageId = ensureAssistantMessage();
            updateAssistantContinuation(messageId, { textProviderOptions: providerOptions });
          }
          if (text) {
            pendingText += text;
            scheduleFlush();
          }
          break;
        }
        case 'reasoning':
        case 'reasoning-start':
        case 'reasoning-delta': {
          if (pendingText) {
            cancelPendingFlush();
            flushPendingText();
          }
          const typedChunk = chunk as ReasoningChunk;
          const rText = typedChunk.text ?? typedChunk.textDelta ?? typedChunk.delta ?? '';
          const providerOptions = normalizeProviderContinuationOptions(typedChunk.providerMetadata);
          if (rText || providerOptions) {
            bufferReasoningPart(rText, providerOptions);
            if (rText) {
              pendingThinkingText += rText;
            }
            scheduleFlush();
          }
          break;
        }
        case 'raw': {
          const typedChunk = chunk as RawChunk;
          const continuation = extractProviderContinuationFromRawChunk(typedChunk.rawValue);
          if (continuation) {
            if (pendingText) {
              cancelPendingFlush();
              flushPendingText();
            }
            if (isBatchableRawReasoningContinuation(continuation)) {
              for (const part of continuation.reasoningParts ?? []) {
                bufferReasoningPart(part.text, part.providerOptions);
              }
              const rawReasoningText = getOpenAIReasoningText(continuation);
              if (rawReasoningText) {
                pendingOpenAIReasoningContent += rawReasoningText;
                pendingThinkingText += rawReasoningText;
              }
              scheduleFlush();
            } else {
              cancelPendingFlush();
              flushPending();
              const messageId = ensureAssistantMessage();
              updateAssistantContinuation(messageId, continuation, getOpenAIReasoningText(continuation));
            }
          }
          break;
        }
        case 'reasoning-end': {
          // With Responses `store: false`, the SDK delivers the reasoning
          // item's encrypted content on the reasoning-end chunk (via
          // output_item.done). Flush buffered reasoning strictly before
          // merging it into the persisted reasoning parts so the stateless
          // replay never drops the reasoning item.
          // Skip metadata without ciphertext (e.g. store:true item ids) so a
          // null payload cannot overwrite a previously captured one.
          if (hasPendingReasoning()) {
            cancelPendingFlush();
            flushPendingReasoning();
          }
          const typedChunk = chunk as { providerMetadata?: unknown };
          const providerOptions = normalizeProviderContinuationOptions(typedChunk.providerMetadata);
          if (providerOptions && hasReasoningEncryptedContent(providerOptions)) {
            cancelPendingFlush();
            flushPending();
            const messageId = ensureAssistantMessage();
            updateAssistantContinuation(messageId, {
              reasoningParts: [{ text: '', providerOptions }],
            });
          }
          break;
        }
        case 'finish':
        case 'finish-step': {
          cancelPendingFlush();
          flushPending();
          break;
        }
        case 'text-start':
        case 'text-end':
        case 'start':
        case 'start-step':
        case 'tool-approval-request':
          break;
        case 'tool-approval-response': {
          const typedChunk = chunk as ToolApprovalResponseChunk;
          if (typedChunk.approved === false) {
            const toolCallId = resolveStreamChunkToolCallId(typedChunk);
            if (toolCallId) {
              appendDeniedToolResultToUi(toolCallId, typedChunk.reason);
            }
          }
          break;
        }
        case 'tool-call': {
          cancelPendingFlush();
          flushPending();
          const typedChunk = chunk as ToolCallChunk;
          hadToolProgress = true;
          const messageId = ensureAssistantMessage();
          const providerOptions = normalizeProviderContinuationOptions(typedChunk.providerMetadata);
          ui.updateMessageById(streamSessionId, messageId, msg => ({
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
          const typedChunk = chunk as ToolResultChunk;
          const toolOutput = typedChunk.output ?? typedChunk.result;
          appendToolResultToUi(
            typedChunk.toolCallId,
            typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput),
            isToolResultError(toolOutput),
          );
          break;
        }
        case 'tool-error': {
          const typedChunk = chunk as ToolErrorChunk;
          appendToolResultToUi(
            typedChunk.toolCallId,
            formatToolErrorContent(typedChunk.error),
            true,
          );
          break;
        }
        case 'tool-output-denied': {
          const typedChunk = chunk as ToolOutputDeniedChunk;
          appendDeniedToolResultToUi(typedChunk.toolCallId);
          break;
        }
        case 'error': {
          const typedChunk = chunk as ErrorChunk;
          if (isSdkStreamStateError(typedChunk.error)) {
            if (runtimeContext.delegated) console.warn('[Plugin Agent] SDK stream state unavailable');
            else console.warn('[Catty] suppressed SDK stream state error:', typedChunk.error);
            break;
          }
          if (isRequestTooLargeError(typedChunk.error)) {
            cancelPendingFlush();
            flushPending();
            throw createCattyRequestTooLargeRetryError(
              typedChunk.error,
              hadToolProgress,
            );
          }
          if (isInvalidAnthropicThinkingSignatureError(typedChunk.error)) {
            // Propagate to turn-driver strip-and-retry (#4074 P1); do not consume
            // as a terminal error message the way other stream errors are.
            cancelPendingFlush();
            flushPending();
            throw createCattyAnthropicSignatureRetryError(
              typedChunk.error,
              hadToolProgress,
            );
          }
          cancelPendingFlush();
          flushPending();
          ui.updateMessageById(streamSessionId, activeMsgId, msg => ({
            ...msg,
            statusText: '',
            executionStatus: msg.executionStatus === 'running' ? 'failed' : msg.executionStatus,
          }));
          ui.addMessageToSession(streamSessionId, {
            id: generateId(),
            role: 'assistant',
            content: '',
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
    flushPending();
    reader.releaseLock();
  }

  const usage = await result.usage;
  const finalStep = await result.finalStep;
  const performance = finalStep?.performance;
  if (reachedIterationLimit && !signal.aborted) {
    clearCompactionStatusFromAssistant(activeMsgId);
    ui.addMessageToSession(streamSessionId, {
      id: generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      iterationLimit: maxIterations,
    });
  }
  // onEnd can run before this consumer flushes its final text and creates the
  // post-tool assistant message. Attach turn totals only after that flush.
  if (usage) {
    ui.updateMessageById(streamSessionId, activeMsgId, message => ({
      ...message,
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens,
        outputTokens: usage.outputTokens ?? 0,
        reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
        totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        estimated: false,
      },
    }));
  }

  if (performance) {
    onAgentEvent?.({
      id: `performance-${turnId ?? Date.now()}`,
      type: 'performance',
      sessionId: streamSessionId,
      chatSessionId: runtimeContext.chatSessionId,
      backend: 'catty',
      timestamp: Date.now(),
      turnId,
      responseTimeMs: performance.responseTimeMs,
      timeToFirstOutputMs: performance.timeToFirstOutputMs,
      outputTokensPerSecond: performance.outputTokensPerSecond,
    } as AgentEvent);
  }

  return {
    usage: usage ? {
      promptTokens: usage.inputTokens,
      cachedPromptTokens: usage.inputTokenDetails?.cacheReadTokens,
      completionTokens: usage.outputTokens,
      totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    } : undefined,
    performance: performance ? {
      responseTimeMs: performance.responseTimeMs,
      timeToFirstOutputMs: performance.timeToFirstOutputMs,
      outputTokensPerSecond: performance.outputTokensPerSecond,
    } : undefined,
  };
}

export { hadToolProgressBeforeRequestTooLarge };
