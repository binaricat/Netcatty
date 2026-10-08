import type { AISession } from '../../infrastructure/ai/types';
import { matchesSearchQuery } from '../../lib/searchMatcher';

/**
 * Searchable shape for session history search. Pure logic so the drawer and
 * tests can share it; matches on title plus user/assistant message text,
 * including thinking and tool call/result content already stored on messages.
 */
export type SessionHistorySearchTarget = Pick<AISession, 'title' | 'messages'>;

/** Cap per-field text so very large tool result payloads stay cheap to scan. */
const MAX_SEARCHABLE_FIELD_LENGTH = 20_000;

function pushSearchableField(fields: string[], text: unknown): void {
  if (typeof text !== 'string') return;
  const trimmed = text.trim();
  if (!trimmed) return;
  fields.push(trimmed.length > MAX_SEARCHABLE_FIELD_LENGTH
    ? trimmed.slice(0, MAX_SEARCHABLE_FIELD_LENGTH)
    : trimmed);
}

export function collectSessionSearchFields(session: SessionHistorySearchTarget): string[] {
  const fields: string[] = [];
  pushSearchableField(fields, session.title);
  for (const message of session.messages) {
    pushSearchableField(fields, message.content);
    pushSearchableField(fields, message.thinking);
    for (const toolCall of message.toolCalls ?? []) {
      pushSearchableField(fields, toolCall.name);
    }
    for (const toolResult of message.toolResults ?? []) {
      pushSearchableField(fields, toolResult.toolName);
      pushSearchableField(fields, toolResult.content);
    }
  }
  return fields;
}

export function filterSessionHistory<T extends SessionHistorySearchTarget>(
  sessions: readonly T[],
  query: string,
): T[] {
  const trimmed = query.trim();
  if (!trimmed) return [...sessions];
  return sessions.filter((session) => matchesSearchQuery(
    trimmed,
    ...collectSessionSearchFields(session),
  ));
}
