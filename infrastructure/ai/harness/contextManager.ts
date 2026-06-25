import type { ModelMessage } from 'ai';
import type { ChatMessage, AIPermissionMode } from '../types';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_PROTECT_RECENT_MESSAGES,
  keepRecentContextMessages,
  prepareContextCompaction,
} from '../contextCompaction';
import { compressMessagesForRequestTooLargeRetry } from '../requestPayloadCompression';
import { estimateModelMessagesTokensWithKind } from './tokenEstimator';
import type { PrepareStepContextInput } from './turnDrivers/types';
import type {
  AgentEventListener,
  CompactionTrace,
  ContextPrepareResult,
  ContextPrepareTrigger,
  ExternalBridgeHistoryMessage,
} from './types';
import { buildExternalBridgeContextMessages } from './externalBridgeContext';

export interface PrepareTurnContextInput {
  messages: ModelMessage[];
  backend: 'catty' | 'external-bridge';
  contextWindow?: number;
  reservedTokens?: number;
  trigger: ContextPrepareTrigger;
  protectRecentMessages?: number;
  force?: boolean;
  compressForRequestTooLargeRetry?: boolean;
  summarize?: (messagesToSummarize: ModelMessage[]) => Promise<string>;
  onEvent?: AgentEventListener;
  sessionId?: string;
  chatSessionId?: string;
  providerId?: string | null;
  reinjection?: PostCompactReinjection;
}

export interface PostCompactReinjection {
  permissionMode?: AIPermissionMode;
  sessionScopeSummary?: string;
  userGoal?: string;
  pendingToolHandleIds?: string[];
}

function emitCompactionEvent(
  onEvent: AgentEventListener | undefined,
  input: PrepareTurnContextInput,
  trace: CompactionTrace,
): void {
  if (!onEvent || !input.sessionId) return;
  onEvent({
    id: `compaction-${Date.now()}`,
    type: 'compaction',
    sessionId: input.sessionId,
    chatSessionId: input.chatSessionId,
    backend: input.backend === 'catty' ? 'catty' : 'external-sdk',
    timestamp: Date.now(),
    trace,
  });
}

function applyTypedMessageCompression(messages: ModelMessage[]): {
  messages: ModelMessage[];
  didAdjust: boolean;
} {
  const compressed = compressMessagesForRequestTooLargeRetry(messages);
  return { messages: compressed.messages, didAdjust: compressed.didAdjust };
}

function buildReinjectionMessages(reinjection?: PostCompactReinjection): ModelMessage[] {
  if (!reinjection) return [];
  const lines: string[] = ['[Netcatty session context — preserved after compaction]'];
  if (reinjection.permissionMode) {
    lines.push(`Permission mode: ${reinjection.permissionMode}`);
  }
  if (reinjection.sessionScopeSummary) {
    lines.push(reinjection.sessionScopeSummary);
  }
  if (reinjection.userGoal) {
    lines.push(`Current user goal: ${reinjection.userGoal}`);
  }
  if (reinjection.pendingToolHandleIds?.length) {
    lines.push(`Unresolved tool output handles: ${reinjection.pendingToolHandleIds.join(', ')}`);
  }
  if (lines.length <= 1) return [];
  return [{
    role: 'user',
    content: lines.join('\n'),
  }];
}

export async function prepareTurnContext(
  input: PrepareTurnContextInput,
): Promise<ContextPrepareResult> {
  const contextWindow = input.contextWindow ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const protectRecent = input.protectRecentMessages ?? DEFAULT_PROTECT_RECENT_MESSAGES;
  const tokensBeforeResult = estimateModelMessagesTokensWithKind({
    messages: input.messages,
    providerId: input.providerId,
  });
  const tokensBefore = tokensBeforeResult.tokens;
  const estimatorKind = tokensBeforeResult.estimatorKind;

  let working = input.messages;
  let didAdjust = false;
  let didTypedCompression = false;
  let didLlmSummarize = false;
  let did413Fallback = false;
  let summaryLength: number | undefined;
  let compressedMessageCount = 0;
  let retainedTailCount = working.length;

  if (input.compressForRequestTooLargeRetry || input.trigger === '413-retry') {
    const typed = applyTypedMessageCompression(working);
    working = typed.messages;
    didTypedCompression = typed.didAdjust;
    did413Fallback = typed.didAdjust;
    didAdjust = didAdjust || typed.didAdjust;
  } else {
    const typed = applyTypedMessageCompression(working);
    if (typed.didAdjust) {
      working = typed.messages;
      didTypedCompression = true;
      didAdjust = true;
    }
  }

  if (input.summarize) {
    const compacted = await prepareContextCompaction({
      messages: working,
      contextWindow,
      reservedTokens: input.reservedTokens ?? 0,
      thresholdRatio: input.force || input.trigger === 'force' ? 0 : undefined,
      protectRecentMessages: protectRecent,
      summarize: input.summarize,
    });

    if (compacted.didCompact) {
      working = compacted.messages;
      didLlmSummarize = true;
      didAdjust = true;
      summaryLength = compacted.summary?.length;
      compressedMessageCount = Math.max(0, input.messages.length - protectRecent);
      retainedTailCount = protectRecent;
    } else if (input.force || input.trigger === '413-retry' || input.trigger === 'force') {
      working = keepRecentContextMessages(working, protectRecent);
      didAdjust = true;
      retainedTailCount = working.length;
    }
  } else if (input.force || input.trigger === '413-retry' || input.trigger === 'force') {
    working = keepRecentContextMessages(working, protectRecent);
    didAdjust = true;
    retainedTailCount = working.length;
  }

  const reinjection = buildReinjectionMessages(input.reinjection);
  if (reinjection.length > 0) {
    working = [...reinjection, ...working];
    didAdjust = true;
  }

  const tokensAfter = estimateModelMessagesTokensWithKind({
    messages: working,
    providerId: input.providerId,
  }).tokens;

  if (didAdjust) {
    const trace: CompactionTrace = {
      trigger: input.trigger,
      estimatedTokensBefore: tokensBefore,
      estimatedTokensAfter: tokensAfter,
      messagesBefore: input.messages.length,
      messagesAfter: working.length,
      compressedMessageCount,
      retainedTailCount,
      summaryLength,
      didTypedCompression,
      didLlmSummarize,
      did413Fallback,
      estimatorKind,
    };
    emitCompactionEvent(input.onEvent, input, trace);
    return { messages: working, didAdjust: true, trace };
  }

  return { messages: working, didAdjust: false };
}

export function buildExternalBridgeContext(
  messages: ChatMessage[],
): ExternalBridgeHistoryMessage[] {
  return buildExternalBridgeContextMessages(messages);
}

export function extractLatestUserGoal(messages: ModelMessage[] | ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const content = typeof message.content === 'string'
      ? message.content.trim()
      : '';
    if (content) return content.slice(0, 500);
  }
  return undefined;
}

/** Step-level typed pruning — no LLM summarize (reserved for pre-turn / 413). */
export async function prepareStepContext(
  input: PrepareStepContextInput,
): Promise<ContextPrepareResult> {
  const typed = compressMessagesForRequestTooLargeRetry(input.messages);
  let working = typed.messages;
  let didAdjust = typed.didAdjust;

  const pendingHandles = input.toolOutputStore?.listPendingHandles(input.chatSessionId ?? input.sessionId) ?? [];
  if (pendingHandles.length > 0 && input.stepNumber > 0) {
    const notice: ModelMessage = {
      role: 'user',
      content: `[step ${input.stepNumber}] Tool output handles available: ${pendingHandles.map(h => h.id).join(', ')}`,
    };
    working = [notice, ...working];
    didAdjust = true;
  }

  const before = estimateModelMessagesTokensWithKind({
    messages: input.messages,
    providerId: input.providerId,
  });
  const after = estimateModelMessagesTokensWithKind({
    messages: working,
    providerId: input.providerId,
  });

  return {
    messages: working,
    didAdjust,
    trace: didAdjust ? {
      trigger: 'pre-turn',
      estimatedTokensBefore: before.tokens,
      estimatedTokensAfter: after.tokens,
      messagesBefore: input.messages.length,
      messagesAfter: working.length,
      compressedMessageCount: 0,
      retainedTailCount: working.length,
      didTypedCompression: typed.didAdjust,
      didLlmSummarize: false,
      did413Fallback: false,
      estimatorKind: before.estimatorKind,
    } : undefined,
  };
}
