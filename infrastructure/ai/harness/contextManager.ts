import type { ModelMessage } from 'ai';
import type { ChatMessage, AIPermissionMode } from '../types';
import { isStepHandleNoticeMessage } from './agentEventAdapter';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_PROTECT_RECENT_MESSAGES,
  findSafeCompactionSplitIndex,
  keepRecentContextMessages,
  prepareContextCompaction,
} from '../contextCompaction';
import { compressMessagesForRequestTooLargeRetry } from '../requestPayloadCompression';
import {
  computeCompactionThreshold,
  computeTotalInputTokens,
  DEFAULT_MAX_OUTPUT_TOKENS,
  shouldCompactByBudget,
} from './contextBudget';
import { estimateModelMessagesTokensWithKind } from './tokenEstimator';
import { pruneStaleToolContext } from './staleContextPruner';
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
  maxOutputTokens?: number;
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
  sessionStateText?: string;
  userGoal?: string;
  pendingToolHandleIds?: string[];
}

function emitCompactionEvent(
  onEvent: AgentEventListener | undefined,
  input: {
    sessionId?: string;
    chatSessionId?: string;
    backend: PrepareTurnContextInput['backend'];
  },
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

function emitCompactionStart(
  onEvent: AgentEventListener | undefined,
  input: {
    sessionId?: string;
    chatSessionId?: string;
    backend: PrepareTurnContextInput['backend'];
  },
  trigger: ContextPrepareTrigger,
): void {
  if (!onEvent || !input.sessionId) return;
  onEvent({
    id: `compaction-start-${Date.now()}`,
    type: 'compaction_start',
    sessionId: input.sessionId,
    chatSessionId: input.chatSessionId,
    backend: input.backend === 'catty' ? 'catty' : 'external-sdk',
    timestamp: Date.now(),
    trigger,
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
  if (reinjection.sessionStateText) {
    lines.push(reinjection.sessionStateText);
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

function buildCompactionTrace(input: {
  trigger: ContextPrepareTrigger;
  tokensBefore: number;
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  compressedMessageCount: number;
  retainedTailCount: number;
  summaryLength?: number;
  didTypedCompression: boolean;
  didLlmSummarize: boolean;
  did413Fallback: boolean;
  estimatorKind?: CompactionTrace['estimatorKind'];
}): CompactionTrace {
  return {
    trigger: input.trigger,
    estimatedTokensBefore: input.tokensBefore,
    estimatedTokensAfter: input.tokensAfter,
    messagesBefore: input.messagesBefore,
    messagesAfter: input.messagesAfter,
    compressedMessageCount: input.compressedMessageCount,
    retainedTailCount: input.retainedTailCount,
    summaryLength: input.summaryLength,
    didTypedCompression: input.didTypedCompression,
    didLlmSummarize: input.didLlmSummarize,
    did413Fallback: input.did413Fallback,
    estimatorKind: input.estimatorKind,
  };
}

function isContextUnderBudgetPressure(input: {
  messages: ModelMessage[];
  contextWindow: number;
  maxOutputTokens: number;
  providerId?: string | null;
  reservedTokens?: number;
  force?: boolean;
  trigger?: ContextPrepareTrigger;
}): boolean {
  if (input.force || input.trigger === '413-retry' || input.trigger === 'force') {
    return true;
  }
  return shouldCompactByBudget({
    messages: input.messages,
    contextWindow: input.contextWindow,
    maxOutputTokens: input.maxOutputTokens,
    providerId: input.providerId,
    reservedTokens: input.reservedTokens,
  });
}

export async function prepareTurnContext(
  input: PrepareTurnContextInput,
): Promise<ContextPrepareResult> {
  const contextWindow = input.contextWindow ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const protectRecent = input.protectRecentMessages ?? DEFAULT_PROTECT_RECENT_MESSAGES;
  const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const messagesBeforeCount = input.messages.length;

  const underBudgetPressure = isContextUnderBudgetPressure({
    messages: input.messages,
    contextWindow,
    maxOutputTokens,
    providerId: input.providerId,
    reservedTokens: input.reservedTokens,
    force: input.force,
    trigger: input.trigger,
  });
  const stale = pruneStaleToolContext(input.messages, {
    underBudgetPressure,
  });
  let working = stale.messages;
  let didAdjust = stale.didAdjust;

  const tokensBeforeResult = estimateModelMessagesTokensWithKind({
    messages: working,
    providerId: input.providerId,
  });
  const tokensBefore = tokensBeforeResult.tokens;
  const estimatorKind = tokensBeforeResult.estimatorKind;

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
      maxOutputTokens,
      providerId: input.providerId,
      protectRecentMessages: protectRecent,
      summarize: input.summarize,
    });

    if (compacted.didCompact) {
      working = compacted.messages;
      didLlmSummarize = true;
      didAdjust = true;
      summaryLength = compacted.summary?.length;
      compressedMessageCount = Math.max(0, messagesBeforeCount - protectRecent);
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
  if (reinjection.length > 0 && didAdjust) {
    working = [...reinjection, ...working];
  }

  const tokensAfter = estimateModelMessagesTokensWithKind({
    messages: working,
    providerId: input.providerId,
  }).tokens;

  if (didAdjust) {
    const trace = buildCompactionTrace({
      trigger: input.trigger,
      tokensBefore,
      tokensAfter,
      messagesBefore: messagesBeforeCount,
      messagesAfter: working.length,
      compressedMessageCount,
      retainedTailCount,
      summaryLength,
      didTypedCompression,
      didLlmSummarize,
      did413Fallback,
      estimatorKind,
    });
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
    if (content && !content.startsWith('[Netcatty session context')) return content.slice(0, 500);
  }
  return undefined;
}

function applyStepBudgetGuard(
  messages: ModelMessage[],
  input: {
    contextWindow: number;
    reservedTokens: number;
    maxOutputTokens: number;
    providerId?: string | null;
    protectRecentMessages: number;
  },
): { messages: ModelMessage[]; didAdjust: boolean; didTypedCompression: boolean } {
  const threshold = computeCompactionThreshold({
    contextWindow: input.contextWindow,
    maxOutputTokens: input.maxOutputTokens,
  });
  const total = computeTotalInputTokens({
    messages,
    providerId: input.providerId,
    reservedTokens: input.reservedTokens,
  });
  if (total < threshold) {
    return { messages, didAdjust: false, didTypedCompression: false };
  }

  const splitAt = findSafeCompactionSplitIndex(messages, input.protectRecentMessages);
  const head = messages.slice(0, splitAt);
  const tail = messages.slice(splitAt);
  const compressedHead = applyTypedMessageCompression(head);
  let next = [...compressedHead.messages, ...tail];
  let didAdjust = compressedHead.didAdjust;

  let afterTotal = computeTotalInputTokens({
    messages: next,
    providerId: input.providerId,
    reservedTokens: input.reservedTokens,
  });
  if (afterTotal >= threshold && splitAt > 0) {
    next = keepRecentContextMessages(next, input.protectRecentMessages);
    didAdjust = true;
  }

  return {
    messages: next,
    didAdjust: didAdjust || next.length !== messages.length,
    didTypedCompression: compressedHead.didAdjust,
  };
}

/** Step-level typed pruning — no LLM summarize (reserved for pre-turn / 413). */
export async function prepareStepContext(
  input: PrepareStepContextInput,
): Promise<ContextPrepareResult & { runtimeContext?: import('./cattyRuntimeContext').CattyRuntimeContext }> {
  const contextWindow = input.contextWindow ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const protectRecent = input.protectRecentMessages ?? DEFAULT_PROTECT_RECENT_MESSAGES;
  const messagesBeforeCount = input.messages.length;

  const underBudgetPressure = isContextUnderBudgetPressure({
    messages: input.messages,
    contextWindow,
    maxOutputTokens,
    providerId: input.providerId,
    reservedTokens: input.reservedTokens,
  });
  const stale = pruneStaleToolContext(input.messages, {
    underBudgetPressure,
  });
  let working = stale.messages;

  const typed = compressMessagesForRequestTooLargeRetry(working);
  working = typed.messages;

  const pendingHandles = input.toolOutputStore?.listPendingHandles(input.chatSessionId ?? input.sessionId) ?? [];
  let didHandleNotice = false;
  if (pendingHandles.length > 0 && input.stepNumber > 0) {
    working = working.filter((message) => {
      if (message.role !== 'user') return true;
      const content = typeof message.content === 'string' ? message.content : '';
      return !isStepHandleNoticeMessage(content);
    });
    const notice: ModelMessage = {
      role: 'user',
      content: `[step ${input.stepNumber}] Tool output handles available: ${pendingHandles.map(h => h.id).join(', ')}`,
    };
    working = [notice, ...working];
    didHandleNotice = true;
  }

  const budgetGuard = applyStepBudgetGuard(working, {
    contextWindow,
    reservedTokens: input.reservedTokens ?? 0,
    maxOutputTokens,
    providerId: input.providerId,
    protectRecentMessages: protectRecent,
  });
  working = budgetGuard.messages;
  if (didHandleNotice && pendingHandles.length > 0) {
    const hasHandleNotice = working.some(
      (message) => message.role === 'user' && isStepHandleNoticeMessage(message.content),
    );
    if (!hasHandleNotice) {
      working = [{
        role: 'user',
        content: `[step ${input.stepNumber}] Tool output handles available: ${pendingHandles.map(h => h.id).join(', ')}`,
      }, ...working];
    }
  }
  const didBudgetAdjust = stale.didAdjust || typed.didAdjust || budgetGuard.didAdjust;
  const didAdjust = didBudgetAdjust || didHandleNotice;

  const before = estimateModelMessagesTokensWithKind({
    messages: input.messages,
    providerId: input.providerId,
  });
  const after = estimateModelMessagesTokensWithKind({
    messages: working,
    providerId: input.providerId,
  });

  const trace = didBudgetAdjust ? buildCompactionTrace({
    trigger: 'step',
    tokensBefore: before.tokens,
    tokensAfter: after.tokens,
    messagesBefore: messagesBeforeCount,
    messagesAfter: working.length,
    compressedMessageCount: Math.max(0, messagesBeforeCount - working.length),
    retainedTailCount: working.length,
    didTypedCompression: typed.didAdjust || budgetGuard.didTypedCompression,
    didLlmSummarize: false,
    did413Fallback: false,
    estimatorKind: before.estimatorKind,
  }) : undefined;

  if (trace && didBudgetAdjust && input.onEvent && input.sessionId) {
    emitCompactionStart(input.onEvent, {
      sessionId: input.sessionId,
      chatSessionId: input.chatSessionId,
      backend: 'catty',
    }, 'step');
    emitCompactionEvent(input.onEvent, {
      sessionId: input.sessionId,
      chatSessionId: input.chatSessionId,
      backend: 'catty',
    }, trace);
  }

  const runtimeContext = {
    ...input.runtimeContext,
    ...(trace ? { lastCompaction: trace, lastStepAdjusted: didBudgetAdjust } : {}),
    ...(didAdjust ? { lastStepAdjusted: true } : {}),
  };

  return {
    messages: working,
    didAdjust,
    trace,
    runtimeContext,
  };
}
