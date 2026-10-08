import type { AISession } from '../infrastructure/ai/types';
import { matchesSearchQuery } from '../lib/searchMatcher';

/**
 * Searchable shape for session history search. Pure domain logic consumed by
 * the session history drawer; matches on title plus user/assistant message
 * text, including thinking, tool call names/arguments and tool result content
 * already stored on messages.
 */
export type SessionHistorySearchTarget = Pick<AISession, 'title' | 'messages'>;

/** Cap per-field text so very large tool result payloads stay cheap to scan. */
const MAX_SEARCHABLE_FIELD_LENGTH = 20_000;

/**
 * Cap the total searchable text collected per session. Pinyin matching joins
 * every collected field into one haystack, so a long retained session with
 * hundreds of large messages could otherwise contribute megabytes that gets
 * re-normalized (and pinyin-transliterated) on every keystroke.
 */
const MAX_SESSION_SEARCHABLE_TOTAL_LENGTH = 64_000;

/** Cap serialized tool-call argument text so bulky payloads stay cheap to scan. */
const MAX_TOOL_ARGUMENTS_FIELD_LENGTH = 2_000;

type SearchFieldCollector = {
  fields: string[];
  push: (text: unknown, maxLength?: number) => void;
};

function createSearchFieldCollector(): SearchFieldCollector {
  const fields: string[] = [];
  let totalLength = 0;
  return {
    fields,
    push(text: unknown, maxLength: number = MAX_SEARCHABLE_FIELD_LENGTH) {
      if (typeof text !== 'string') return;
      const trimmed = text.trim();
      if (!trimmed) return;
      const effectiveMaxLength = Math.min(maxLength, MAX_SEARCHABLE_FIELD_LENGTH);
      const capped = trimmed.length > effectiveMaxLength
        ? trimmed.slice(0, effectiveMaxLength)
        : trimmed;
      if (totalLength + capped.length > MAX_SESSION_SEARCHABLE_TOTAL_LENGTH) return;
      totalLength += capped.length;
      fields.push(capped);
    },
  };
}

function serializeToolCallArguments(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args) ?? '';
  } catch {
    return '';
  }
}

export function collectSessionSearchFields(session: SessionHistorySearchTarget): string[] {
  const collector = createSearchFieldCollector();
  // The title is indexed first so it always survives the total-length cap.
  collector.push(session.title);
  // Fields pushed before the message loop (0 or 1 entries; the title may be
  // blank and therefore skipped).
  const headCount = collector.fields.length;
  // Allocate the remaining budget newest-first: when a long session exceeds
  // the cap, recent messages stay searchable instead of being silently
  // dropped in favor of the oldest content.
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i];
    collector.push(message.content);
    collector.push(message.thinking);
    for (const toolCall of message.toolCalls ?? []) {
      collector.push(toolCall.name);
      collector.push(serializeToolCallArguments(toolCall.arguments), MAX_TOOL_ARGUMENTS_FIELD_LENGTH);
    }
    for (const toolResult of message.toolResults ?? []) {
      collector.push(toolResult.toolName);
      collector.push(toolResult.content);
    }
  }
  const fields = collector.fields;
  // Restore chronological output order: the head (title) stays first, while
  // the message fields — collected newest-to-oldest — are reversed back.
  const head = fields.slice(0, headCount);
  const tail = fields.slice(headCount);
  tail.reverse();
  return [...head, ...tail];
}

export function filterSessionHistory<T extends SessionHistorySearchTarget>(
  sessions: readonly T[],
  query: string,
): T[] {
  const trimmed = query.trim();
  if (!trimmed) return [...sessions];
  return sessions.filter((session) =>
    // Pinyin transliteration is too expensive to run over every collected
    // message field on each keystroke; literal/compact matching stays global,
    // while the pinyin fallback is restricted to the (small) title field.
    matchesSearchQuery(
      trimmed,
      ...collectSessionSearchFields(session),
      { allowPinyin: false },
    )
    || matchesSearchQuery(trimmed, session.title),
  );
}
