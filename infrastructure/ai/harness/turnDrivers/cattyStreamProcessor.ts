import { streamText, isStepCount, type ModelMessage } from 'ai';
import { classifyError } from '../../errorClassifier';
import { isRequestTooLargeError } from '../../errorClassifier';
import { isSdkStreamStateError } from '../../shared/streamStateErrors';
import {
  createCattyRequestTooLargeRetryError,
  hadToolProgressBeforeRequestTooLarge,
} from '../../cattyRequestTooLargeRetry';
import { mapCattyStreamChunkToAgentEvents } from '../agentEventAdapter';
import type { AgentEvent } from '../types';
import type { ProviderAdvancedParams } from '../../types';
import { createModelFromConfig } from '../../sdk/providers';
import type { CattyToolsBundle } from '../capabilityTools';
import { buildCattyToolApproval } from '../cattyToolApproval';
import type { CattyRuntimeContext } from '../cattyRuntimeContext';
import { buildCattyStreamTimeouts } from '../streamTimeouts';
import {
  extractProviderContinuationFromRawChunk,
  mergeProviderContinuation,
  normalizeProviderContinuationOptions,
  withProviderContinuationSource,
  type ProviderContinuation,
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
} from '../../../../components/ai/hooks/aiChatStreamingSupport';
import type { ChatMessage } from '../../types';

export type CattyModel = ReturnType<typeof createModelFromConfig>;

export interface CattyStreamUiSink {
  addMessageToSession: (sessionId: string, message: ChatMessage) => void;
  updateMessageById: (sessionId: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
}

export interface ProcessCattyStreamInput {
  streamSessionId: string;
  model: CattyModel;
  systemPrompt: string;
  toolsBundle: CattyToolsBundle;
  sdkMessages: ModelMessage[];
  signal: AbortSignal;
  currentAssistantMsgId: string;
  maxIterations: number;
  advancedParams?: ProviderAdvancedParams;
  continuationContext?: CattyProviderContinuationContext;
  turnId?: string;
  commandTimeoutMs?: number;
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
    continuationContext,
    turnId,
    commandTimeoutMs,
    runtimeContext: initialRuntimeContext,
    onAgentEvent,
    prepareStep,
    ui,
  } = input;

  let runtimeContext = initialRuntimeContext;
  const { tools, toolsContext } = toolsBundle;

  const result = streamText({
    model,
    messages: sdkMessages,
    instructions: systemPrompt,
    tools,
    toolsContext,
    runtimeContext,
    toolApproval: buildCattyToolApproval({
      permissionMode: runtimeContext.permissionMode,
      chatSessionId: runtimeContext.chatSessionId,
    }),
    stopWhen: isStepCount(maxIterations),
    abortSignal: signal,
    include: { rawChunks: true },
    timeout: buildCattyStreamTimeouts({ permissionMode: runtimeContext.permissionMode, commandTimeoutMs }),
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
          completionTokens: usage.outputTokens ?? 0,
          totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
          estimated: false,
        } as AgentEvent);
      }
    },
    ...(prepareStep ? {
      prepareStep: async ({ stepNumber, messages, runtimeContext: stepRuntimeContext }) => {
        const prepared = await prepareStep({
          stepNumber,
          messages,
          runtimeContext: stepRuntimeContext as CattyRuntimeContext,
        });
        if (prepared?.runtimeContext) {
          runtimeContext = prepared.runtimeContext;
        }
        return prepared ?? { messages };
      },
    } : {}),
    ...(advancedParams?.maxTokens != null && { maxOutputTokens: advancedParams.maxTokens }),
    ...(advancedParams?.temperature != null && { temperature: advancedParams.temperature }),
    ...(advancedParams?.topP != null && { topP: advancedParams.topP }),
    ...(advancedParams?.frequencyPenalty != null && { frequencyPenalty: advancedParams.frequencyPenalty }),
    ...(advancedParams?.presencePenalty != null && { presencePenalty: advancedParams.presencePenalty }),
  });

  let activeMsgId = currentAssistantMsgId;
  let lastAddedRole: 'assistant' | 'tool' = 'assistant';
  let hadToolProgress = false;
  const reader = result.stream.getReader();

  let pendingText = '';
  let rafId: number | null = null;

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

  const flushText = () => {
    if (pendingText) {
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
    }
    rafId = null;
  };

  const cancelPendingFlush = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  const appendToolResultToUi = (toolCallId: string, content: string, isError: boolean) => {
    cancelPendingFlush();
    flushText();
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
          flushText();
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
            console.warn('[Catty] suppressed SDK stream state error:', typedChunk.error);
            break;
          }
          if (isRequestTooLargeError(typedChunk.error)) {
            cancelPendingFlush();
            flushText();
            throw createCattyRequestTooLargeRetryError(
              typedChunk.error,
              hadToolProgress,
            );
          }
          cancelPendingFlush();
          flushText();
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
    flushText();
    reader.releaseLock();
  }

  const usage = await result.usage;
  const finalStep = await result.finalStep;
  const performance = finalStep?.performance;

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
