import type { ModelMessage } from 'ai';
import { estimateModelMessagesTokensWithKind } from './tokenEstimator';
import { COMPACTION_PROMPT_RESERVE } from './contextBudget';

function endsWithToolCall(message: ModelMessage | undefined): boolean {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return false;
  return message.content.some((part) => {
    return part && typeof part === 'object' && (part as { type?: string }).type === 'tool-call';
  });
}

function startsWithToolResult(message: ModelMessage | undefined): boolean {
  if (!message || message.role !== 'tool') return false;
  if (!Array.isArray(message.content)) return true;
  return message.content.some((part) => {
    return part && typeof part === 'object' && (part as { type?: string }).type === 'tool-result';
  });
}

/** Prune from the tail while preserving valid tool-call/tool-result pairing. */
export function pruneLastModelMessage(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  if (messages.length === 1) return [];

  const secondToLastIndex = messages.length - 2;
  const secondToLast = messages[secondToLastIndex];

  if (secondToLast.role === 'assistant' && endsWithToolCall(secondToLast)) {
    return messages.slice(0, -2);
  }
  if (secondToLast.role === 'user') {
    return messages.slice(0, -2);
  }
  if (startsWithToolResult(messages[messages.length - 1])) {
    return messages.slice(0, -1);
  }

  return messages.slice(0, -1);
}

/** Prune from the head while preserving valid tool-call/tool-result pairing. */
export function pruneFirstModelMessage(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  if (messages.length === 1) return [];

  const first = messages[0];
  const second = messages[1];

  if (first.role === 'assistant' && endsWithToolCall(first) && second?.role === 'tool') {
    return messages.slice(2);
  }
  if (first.role === 'user' && second?.role === 'assistant' && endsWithToolCall(second) && messages[2]?.role === 'tool') {
    return messages.slice(3);
  }
  if (first.role === 'user' && second?.role === 'assistant') {
    return messages.slice(2);
  }
  if (startsWithToolResult(first)) {
    return messages.slice(1);
  }

  return messages.slice(1);
}

export function countMessagesTokens(messages: ModelMessage[], providerId?: string | null): number {
  return estimateModelMessagesTokensWithKind({ messages, providerId }).tokens;
}

export interface PruneUntilFitsCompactionInput {
  messages: ModelMessage[];
  availableForInput: number;
  providerId?: string | null;
  compactionPromptTokens?: number;
}

export function pruneUntilFitsCompaction(input: PruneUntilFitsCompactionInput): ModelMessage[] {
  const reserve = input.compactionPromptTokens ?? COMPACTION_PROMPT_RESERVE;
  let working = input.messages;

  while (working.length > 0) {
    const tokens = countMessagesTokens(working, input.providerId) + reserve;
    if (tokens <= input.availableForInput) {
      return working;
    }
    const pruned = pruneFirstModelMessage(working);
    if (pruned.length === working.length) break;
    working = pruned;
  }

  return working;
}
