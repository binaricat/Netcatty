import type { ModelMessage } from 'ai';
import { generateText, pruneMessages } from 'ai';
import {
  CONTEXT_COMPACTION_SYSTEM_PROMPT,
  DEFAULT_PROTECT_RECENT_MESSAGES,
  formatMessagesForCompaction,
  resolveContextWindow,
} from '../contextCompaction';
import type { ProviderConfig } from '../types';
import {
  extractLatestUserGoal,
  prepareTurnContext,
} from './contextManager';
import type { AgentEventListener, CompactionTrace } from './types';
import { buildCattyCompactionTimeout } from './streamTimeouts';
import {
  COMPACTION_PROMPT_RESERVE,
  COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  resolveEffectiveMaxOutputTokens,
} from './contextBudget';
import { pruneUntilFitsCompaction } from './compactionPruner';

export interface CompactCattyMessagesInput {
  messages: ModelMessage[];
  sessionId: string;
  chatSessionId?: string;
  provider?: Pick<ProviderConfig, 'contextWindow' | 'modelContextWindows' | 'providerId' | 'advancedParams'> | null;
  modelId?: string | null;
  reservedTokens?: () => number;
  model: Parameters<typeof generateText>[0]['model'];
  abortSignal: AbortSignal;
  trigger?: 'pre-turn' | '413-retry' | 'force';
  force?: boolean;
  compressForRequestTooLargeRetry?: boolean;
  maxOutputTokens?: number;
  onCompactionStart?: (trigger: 'pre-turn' | '413-retry' | 'force') => void;
  onCompaction?: (trace: CompactionTrace) => void;
  reinjection?: {
    permissionMode?: import('../types').AIPermissionMode;
    sessionScopeSummary?: string;
    sessionStateText?: string;
  };
}

export interface CompactCattyMessagesResult {
  messages: ModelMessage[];
  trace?: CompactionTrace;
}

function createEventListener(
  input: CompactCattyMessagesInput,
): AgentEventListener | undefined {
  if (!input.onCompaction) return undefined;
  return (event) => {
    if (event.type === 'compaction') {
      input.onCompaction?.(event.trace);
    }
  };
}

export async function compactCattyMessages(
  input: CompactCattyMessagesInput,
): Promise<CompactCattyMessagesResult> {
  const contextWindow = resolveContextWindow({
    provider: input.provider,
    modelId: input.modelId,
  });
  const maxOutputTokens = input.maxOutputTokens
    ?? input.provider?.advancedParams?.maxTokens
    ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const providerId = input.provider?.providerId;

  const summarize = async (messagesToSummarize: ModelMessage[]) => {
    const summarizeTrigger = input.trigger === '413-retry' || input.compressForRequestTooLargeRetry
      ? '413-retry'
      : input.trigger === 'force' || input.force
        ? 'force'
        : 'pre-turn';
    input.onCompactionStart?.(summarizeTrigger);
    const reserved = input.reservedTokens?.() ?? 0;
    const compactionOutputTokens = resolveEffectiveMaxOutputTokens(
      contextWindow,
      COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
    );
    const availableForInput = Math.max(
      1,
      contextWindow - compactionOutputTokens - COMPACTION_PROMPT_RESERVE - reserved,
    );
    const pruned = pruneUntilFitsCompaction({
      messages: messagesToSummarize,
      availableForInput: Math.max(1, availableForInput),
      providerId,
    });
    const result = await generateText({
      model: input.model,
      instructions: CONTEXT_COMPACTION_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Summarize this earlier conversation context for the next model turn:\n\n${formatMessagesForCompaction(pruned)}`,
      }],
      abortSignal: input.abortSignal,
      maxOutputTokens: COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
      temperature: 0,
      timeout: buildCattyCompactionTimeout(),
    });
    return result.text;
  };

  const trigger = input.trigger ?? (input.force ? 'force' : 'pre-turn');

  try {
    const prepared = await prepareTurnContext({
      messages: input.messages,
      backend: 'catty',
      contextWindow,
      reservedTokens: input.reservedTokens?.() ?? 0,
      maxOutputTokens,
      trigger,
      force: input.force,
      compressForRequestTooLargeRetry: input.compressForRequestTooLargeRetry,
      protectRecentMessages: DEFAULT_PROTECT_RECENT_MESSAGES,
      summarize,
      sessionId: input.sessionId,
      chatSessionId: input.chatSessionId,
      onEvent: createEventListener(input),
      reinjection: {
        ...input.reinjection,
        userGoal: extractLatestUserGoal(input.messages),
      },
      providerId,
    });
    return { messages: prepared.messages, trace: prepared.trace };
  } catch (err) {
    if (input.abortSignal.aborted) throw err;
    console.warn('[Harness] Context compaction failed; falling back to recent messages only:', err);
    const fallback = await prepareTurnContext({
      messages: input.messages,
      backend: 'catty',
      contextWindow,
      trigger: 'force',
      force: true,
      compressForRequestTooLargeRetry: input.compressForRequestTooLargeRetry,
      protectRecentMessages: DEFAULT_PROTECT_RECENT_MESSAGES,
      sessionId: input.sessionId,
      chatSessionId: input.chatSessionId,
      onEvent: createEventListener(input),
    });
    return { messages: fallback.messages, trace: fallback.trace };
  }
}

export function prepareCattyMessagesForStream(messages: ModelMessage[]): ModelMessage[] {
  return pruneMessages({
    messages,
    reasoning: 'all',
    emptyMessages: 'remove',
  });
}
