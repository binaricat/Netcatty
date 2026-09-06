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
import type { CompactionTrace } from './types';
import { buildCattyCompactionTimeout } from './streamTimeouts';
import {
  COMPACTION_PROMPT_RESERVE,
  COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  resolveEffectiveMaxOutputTokens,
  computeCompactionThreshold,
  computeTotalInputTokens,
} from './contextBudget';
import { pruneUntilFitsCompaction } from './compactionPruner';
import type { ToolOutputStore } from './toolOutputStore';
import { storeCompactionArchive, storeCompactionArtifact } from './compactionArtifacts';
import { globalTwoPassCompactionCache } from './twoPassCompaction';

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
  /** Override protect-recent window (default: DEFAULT_PROTECT_RECENT_MESSAGES). */
  protectRecentMessages?: number;
  maxOutputTokens?: number;
  onCompactionStart?: (trigger: 'pre-turn' | '413-retry' | 'force') => void;
  onCompaction?: (trace: CompactionTrace) => void;
  toolOutputStore?: ToolOutputStore;
  reinjection?: {
    permissionMode?: import('../types').AIPermissionMode;
    sessionScopeSummary?: string;
    sessionStateText?: string;
  };
}

export interface CompactCattyMessagesResult {
  messages: ModelMessage[];
  trace?: CompactionTrace;
  summary?: string;
}

export function buildCompactionFailureArchiveNotice(
  archiveHandleId: string | undefined,
  sourceTruncated: boolean,
): string | undefined {
  return archiveHandleId
    ? `Compaction summary failed. Earlier ${sourceTruncated ? 'bounded' : 'exact'} conversation remains available at tool output handle ${archiveHandleId}; search/read it before guessing missing details.`
    : undefined;
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
  let archiveHandleId: string | undefined;
  let archiveSourceTruncated = false;
  let artifactHandleId: string | undefined;
  let archiveChars: number | undefined;
  let twoPassCacheHit = false;
  let twoPassPrefixMessages: number | undefined;
  let compactionSummary: string | undefined;
  const reservedTokens = input.reservedTokens?.() ?? 0;
  const threshold = computeCompactionThreshold({ contextWindow, maxOutputTokens });
  const estimatedInput = computeTotalInputTokens({
    messages: input.messages,
    providerId,
    reservedTokens,
  });
  const prewarmThreshold = Math.max(1, threshold - Math.ceil(contextWindow * 0.1));
  if (
    !input.force
    && input.trigger !== '413-retry'
    && estimatedInput >= prewarmThreshold
    && estimatedInput < threshold
    && input.chatSessionId
    && input.modelId
  ) {
    globalTwoPassCompactionCache.start(
      input.chatSessionId,
      input.modelId,
      input.messages,
      async prefix => {
        const result = await generateText({
          model: input.model,
          instructions: CONTEXT_COMPACTION_SYSTEM_PROMPT,
          messages: [{
            role: 'user',
            content: `Create the first-pass note for this stable earlier prefix. Preserve exact decisions, paths, commands, errors, and unfinished work:\n\n${formatMessagesForCompaction(prefix)}`,
          }],
          abortSignal: input.abortSignal,
          maxOutputTokens: COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
          temperature: 0,
          timeout: buildCattyCompactionTimeout(),
        });
        return result.text;
      },
    );
  }

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
    const cached = input.chatSessionId && input.modelId
      ? await globalTwoPassCompactionCache.consume(input.chatSessionId, input.modelId, pruned)
      : undefined;
    twoPassCacheHit = Boolean(cached);
    twoPassPrefixMessages = cached?.prefixLength;
    const formattedHistory = cached
      ? [
          `[FIRST-PASS NOTE FOR ${cached.prefixLength} EARLIER MESSAGES]\n${cached.note}`,
          `[REMAINING EXACT MESSAGES]\n${formatMessagesForCompaction(pruned.slice(cached.prefixLength))}`,
        ].join('\n\n')
      : formatMessagesForCompaction(pruned);
    // Archive the untouched turn input. messagesToSummarize has already passed
    // through integrity repair and stale-result pruning, so it is not an exact
    // recovery source even though it is the right input for the summary model.
    const exactFormattedHistory = formatMessagesForCompaction(input.messages);
    archiveChars = exactFormattedHistory.length;
    if (input.toolOutputStore && input.chatSessionId) {
      const archive = storeCompactionArchive(
        input.toolOutputStore,
        input.chatSessionId,
        exactFormattedHistory,
      );
      archiveHandleId = archive.id;
      archiveSourceTruncated = archive.sourceTruncated;
    }
    const result = await generateText({
      model: input.model,
      instructions: CONTEXT_COMPACTION_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Summarize this earlier conversation context for the next model turn:\n\n${formattedHistory}`,
      }],
      abortSignal: input.abortSignal,
      maxOutputTokens: COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
      temperature: 0,
      timeout: buildCattyCompactionTimeout(),
    });
    if (input.toolOutputStore && input.chatSessionId) {
      artifactHandleId = storeCompactionArtifact(
        input.toolOutputStore,
        input.chatSessionId,
        {
          trigger: summarizeTrigger,
          modelId: input.modelId,
          archiveHandleId,
          formattedHistory,
          summary: result.text,
        },
      ).id;
    }
    const archiveNotice = archiveHandleId
      ? `\n\n[${archiveSourceTruncated ? 'Bounded conversation snapshot (source exceeded the local archive cap)' : 'Exact conversation snapshot'} archived locally: handleId=${archiveHandleId}. Use tool_output_read search/range only when the summary lacks a needed exact detail.]`
      : '';
    compactionSummary = `${result.text}${archiveNotice}`;
    return compactionSummary;
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
      protectRecentMessages: input.protectRecentMessages ?? DEFAULT_PROTECT_RECENT_MESSAGES,
      summarize,
      sessionId: input.sessionId,
      chatSessionId: input.chatSessionId,
      onEvent: undefined,
      reinjection: {
        ...input.reinjection,
        userGoal: extractLatestUserGoal(input.messages),
      },
      providerId,
    });
    const trace = prepared.trace ? {
      ...prepared.trace,
      archiveHandleId,
      artifactHandleId,
      archiveChars,
      twoPassCacheHit,
      twoPassPrefixMessages,
    } : undefined;
    if (trace) input.onCompaction?.(trace);
    return { messages: prepared.messages, trace, summary: compactionSummary };
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
      protectRecentMessages: input.protectRecentMessages ?? DEFAULT_PROTECT_RECENT_MESSAGES,
      sessionId: input.sessionId,
      chatSessionId: input.chatSessionId,
      onEvent: undefined,
      reinjection: {
        ...input.reinjection,
        sessionScopeSummary: [
          input.reinjection?.sessionScopeSummary,
          buildCompactionFailureArchiveNotice(archiveHandleId, archiveSourceTruncated),
        ].filter(Boolean).join('\n') || undefined,
        userGoal: extractLatestUserGoal(input.messages),
      },
    });
    const trace = fallback.trace ? {
      ...fallback.trace,
      archiveHandleId,
      artifactHandleId,
      archiveChars,
      twoPassCacheHit,
      twoPassPrefixMessages,
    } : undefined;
    if (trace) input.onCompaction?.(trace);
    return { messages: fallback.messages, trace, summary: compactionSummary };
  }
}

export function prepareCattyMessagesForStream(
  messages: ModelMessage[],
  options: { preserveReasoning?: boolean } = {},
): ModelMessage[] {
  return pruneMessages({
    messages,
    reasoning: options.preserveReasoning ? 'none' : 'all',
    emptyMessages: 'remove',
  });
}
