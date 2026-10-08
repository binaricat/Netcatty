import type { AgentActivity } from './agentActivity';
import type { AISession, ChatMessageAttachment } from '../infrastructure/ai/types';
import { matchesSearchQuery } from '../lib/searchMatcher';

/**
 * Searchable shape for session history search. Pure domain logic consumed by
 * the session history drawer; matches on title plus user/assistant message
 * text, including thinking, tool call names/arguments, tool result content,
 * persisted agent activities (web-search queries, file paths, plan items,
 * warnings) already stored on messages, visible attachment labels (file names
 * and Vault note titles) and persisted error messages.
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
  /** True once the per-session budget is exhausted: further fields are dropped. */
  isFull: boolean;
};

function createSearchFieldCollector(): SearchFieldCollector {
  const fields: string[] = [];
  let totalLength = 0;
  const collector = {
    fields,
    push(text: unknown, maxLength: number = MAX_SEARCHABLE_FIELD_LENGTH) {
      if (typeof text !== 'string') return;
      const trimmed = text.trim();
      if (!trimmed) return;
      const effectiveMaxLength = Math.min(maxLength, MAX_SEARCHABLE_FIELD_LENGTH);
      let capped = trimmed.length > effectiveMaxLength
        ? trimmed.slice(0, effectiveMaxLength)
        : trimmed;
      // Fill the remaining per-session budget with the freshest evidence:
      // truncate an oversized field instead of discarding it wholesale (whole-
      // field rejection would let older, smaller fields win the leftover space).
      const remaining = MAX_SESSION_SEARCHABLE_TOTAL_LENGTH - totalLength;
      if (remaining <= 0) return;
      if (capped.length > remaining) capped = capped.slice(0, remaining);
      totalLength += capped.length;
      fields.push(capped);
    },
    get isFull() {
      return totalLength >= MAX_SESSION_SEARCHABLE_TOTAL_LENGTH;
    },
  };
  return collector;
}

function serializeToolCallArguments(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args) ?? '';
  } catch {
    return '';
  }
}

/**
 * Collect the human-visible text carried by persisted agent activities
 * (web-search queries, changed file paths, plan items, warnings) as
 * individual fields. For external SDK sessions these live only in
 * `message.agentActivities` and are rendered when the conversation is
 * reopened, so they must be indexed too. Each value is fed to the collector
 * on its own (capped per value, not per message) so activities accumulated
 * later in one message stay searchable, and values are pushed newest-first to
 * match the newest-first budget allocation of the message loop.
 */
function collectAgentActivityFields(
  collector: SearchFieldCollector,
  activities: AgentActivity[],
): void {
  for (let i = activities.length - 1; i >= 0; i--) {
    if (collector.isFull) return;
    const activity = activities[i];
    switch (activity.type) {
      case 'file_change':
        for (const change of activity.changes) {
          if (collector.isFull) return;
          collector.push(change.path, MAX_TOOL_ARGUMENTS_FIELD_LENGTH);
        }
        break;
      case 'web_search':
        collector.push(activity.query, MAX_TOOL_ARGUMENTS_FIELD_LENGTH);
        break;
      case 'plan_update':
        for (const item of activity.items) {
          if (collector.isFull) return;
          collector.push(item.text, MAX_TOOL_ARGUMENTS_FIELD_LENGTH);
        }
        break;
      case 'warning':
        collector.push(activity.message, MAX_TOOL_ARGUMENTS_FIELD_LENGTH);
        break;
    }
  }
}

/**
 * Serialize the human-visible labels of a message's attachments: file names
 * and Vault note titles. Rendered from `message.attachments` when the
 * conversation is reopened (with the legacy `images` field as fallback), so
 * a session whose only mention of a term sits in an attachment label must
 * stay findable. Only the short labels are indexed — never the base64
 * payloads — so attaching files cannot blow up the search haystack.
 */
function serializeAttachmentLabels(attachments: ChatMessageAttachment[] | undefined): string {
  if (!attachments?.length) return '';
  const parts: string[] = [];
  for (const attachment of attachments) {
    if (attachment.vaultNoteTitle) parts.push(attachment.vaultNoteTitle);
    if (attachment.filename) parts.push(attachment.filename);
  }
  return parts.join('\n');
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
    // Stop as soon as the per-session budget is exhausted: older messages
    // cannot contribute anything, and traversing them (or serializing their
    // tool arguments/activities) would waste work on every keystroke.
    if (collector.isFull) break;
    const message = session.messages[i];
    collector.push(message.content);
    // `push` drops fields once the budget is spent; skip the remaining
    // (potentially expensive) serialization for this message too.
    if (collector.isFull) continue;
    collector.push(message.thinking);
    if (collector.isFull) continue;
    // Persisted failure diagnostics: when a Catty turn fails with empty
    // content the error message is the only visible text in the reopened
    // conversation, so it must be indexed. Error strings are short, hence the
    // tight cap.
    collector.push(message.errorInfo?.message, MAX_TOOL_ARGUMENTS_FIELD_LENGTH);
    collector.push(serializeAttachmentLabels(message.attachments ?? message.images), MAX_TOOL_ARGUMENTS_FIELD_LENGTH);
    for (const toolCall of message.toolCalls ?? []) {
      if (collector.isFull) break;
      collector.push(toolCall.name);
      collector.push(serializeToolCallArguments(toolCall.arguments), MAX_TOOL_ARGUMENTS_FIELD_LENGTH);
    }
    for (const toolResult of message.toolResults ?? []) {
      if (collector.isFull) break;
      collector.push(toolResult.toolName);
      collector.push(toolResult.content);
    }
    if (collector.isFull) continue;
    collectAgentActivityFields(collector, message.agentActivities ?? []);
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
