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

export interface CompactCattyMessagesInput {
  messages: ModelMessage[];
  sessionId: string;
  chatSessionId?: string;
  provider?: Pick<ProviderConfig, 'contextWindow' | 'modelContextWindows'> | null;
  modelId?: string | null;
  reservedTokens?: () => number;
  model: Parameters<typeof generateText>[0]['model'];
  abortSignal: AbortSignal;
  trigger?: 'pre-turn' | '413-retry' | 'force';
  force?: boolean;
  compressForRequestTooLargeRetry?: boolean;
  onStatusText?: (text: string) => void;
  onCompaction?: (trace: CompactionTrace) => void;
  reinjection?: {
    permissionMode?: import('../types').AIPermissionMode;
    sessionScopeSummary?: string;
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

  const summarize = async (messagesToSummarize: ModelMessage[]) => {
    input.onStatusText?.('Compacting earlier context...');
    const result = await generateText({
      model: input.model,
      system: CONTEXT_COMPACTION_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Summarize this earlier conversation context for the next model turn:\n\n${formatMessagesForCompaction(messagesToSummarize)}`,
      }],
      abortSignal: input.abortSignal,
      maxOutputTokens: 1600,
      temperature: 0,
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
      providerId: input.provider?.providerId,
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
