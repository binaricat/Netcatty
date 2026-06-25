import { streamText, stepCountIs, type ModelMessage } from 'ai';
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
import { createCattyToolsFromCatalog } from '../capabilityTools';
import {
  extractProviderContinuationFromRawChunk,
  mergeProviderContinuation,
  normalizeProviderContinuationOptions,
  withProviderContinuationSource,
  type ProviderContinuation,
} from '../../providerContinuation';
import {
  generateId,
  isToolResultError,
  type CattyProviderContinuationContext,
  type ErrorChunk,
  type RawChunk,
  type ReasoningChunk,
  type StreamChunk,
  type TextDeltaChunk,
  type ToolCallChunk,
  type ToolResultChunk,
} from '../../../../components/ai/hooks/aiChatStreamingSupport';
import type { ChatMessage } from '../../types';

export type CattyModel = ReturnType<typeof createModelFromConfig>;
export type CattyTools = ReturnType<typeof createCattyToolsFromCatalog>;

export interface CattyStreamUiSink {
  addMessageToSession: (sessionId: string, message: ChatMessage) => void;
  updateMessageById: (sessionId: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
}

export interface ProcessCattyStreamInput {
  streamSessionId: string;
  model: CattyModel;
  systemPrompt: string;
  tools: CattyTools;
  sdkMessages: ModelMessage[];
  signal: AbortSignal;
  currentAssistantMsgId: string;
  maxIterations: number;
  advancedParams?: ProviderAdvancedParams;
  continuationContext?: CattyProviderContinuationContext;
  turnId?: string;
  onAgentEvent?: (event: AgentEvent) => void;
  prepareStep?: (args: { stepNumber: number; messages: ModelMessage[] }) => Promise<{ messages: ModelMessage[] } | undefined>;
  ui: CattyStreamUiSink;
}

export async function processCattyStream(input: ProcessCattyStreamInput): Promise<{ usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }> {
  const {
    streamSessionId,
    model,
    systemPrompt,
    tools,
    sdkMessages,
    signal,
    currentAssistantMsgId,
    maxIterations,
    advancedParams,
    continuationContext,
    turnId,
    onAgentEvent,
    prepareStep,
    ui,
  } = input;

  const result = streamText({
    model,
    messages: sdkMessages,
    system: systemPrompt,
    tools,
    stopWhen: stepCountIs(maxIterations),
    abortSignal: signal,
    includeRawChunks: true,
    ...(prepareStep ? {
      prepareStep: async ({ stepNumber, messages }) => {
        const prepared = await prepareStep({ stepNumber, messages });
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
  const reader = result.fullStream.getReader();

  let pendingText = '';
  let rafId: number | null = null;

  const ensureAssistantMessage = (): string => {
    if (lastAddedRole !== 'tool') return activeMsgId;
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
      for (const agentEvent of mapCattyStreamChunkToAgentEvents(chunk, {
        sessionId: streamSessionId,
        chatSessionId: streamSessionId,
        turnId,
      })) {
        onAgentEvent?.(agentEvent);
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
          break;
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
          cancelPendingFlush();
          flushText();
          const typedChunk = chunk as ToolResultChunk;
          hadToolProgress = true;
          ui.updateMessageById(streamSessionId, activeMsgId, msg =>
            msg.role === 'assistant' && msg.executionStatus === 'running'
              ? { ...msg, executionStatus: 'completed', statusText: undefined } : msg,
          );
          const toolOutput = typedChunk.output ?? typedChunk.result;
          const toolError = isToolResultError(toolOutput);
          ui.addMessageToSession(streamSessionId, {
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
  return {
    usage: usage ? {
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
      totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    } : undefined,
  };
}

export { hadToolProgressBeforeRequestTooLarge };
