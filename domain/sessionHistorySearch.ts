import type { AgentActivity } from './agentActivity';
import type { AISession, ChatMessageAttachment } from '../infrastructure/ai/types';
import {
  matchesPreparedSearchQuery,
  prepareSearchFields,
  type PreparedSearchFields,
} from '../lib/searchMatcher';

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
      // Fill the remaining per-session budget with the freshest evidence:
      // truncate an oversized field instead of discarding it wholesale (whole-
      // field rejection would let older, smaller fields win the leftover space).
      const remaining = MAX_SESSION_SEARCHABLE_TOTAL_LENGTH - totalLength;
      if (remaining <= 0) return;
      const effectiveMaxLength = Math.min(maxLength, MAX_SEARCHABLE_FIELD_LENGTH, remaining);
      // Bound the input before trimming so whitespace outside the searchable
      // window cannot trigger an unbounded scan on every keystroke.
      const capped = text.slice(0, effectiveMaxLength).trim();
      if (!capped) return;
      totalLength += capped.length;
      fields.push(capped);
    },
    get isFull() {
      return totalLength >= MAX_SESSION_SEARCHABLE_TOTAL_LENGTH;
    },
  };
  return collector;
}

/** Depth bound for argument traversal so pathological nesting cannot recurse unboundedly. */
const MAX_TOOL_ARGUMENTS_SERIALIZATION_DEPTH = 12;

/**
 * Serialize tool-call arguments within a hard character budget: traversal and
 * emitted text both stop as soon as the field cap is reached, so a retained
 * call carrying a multi-megabyte blob (e.g. an uncapped `content` for
 * `sftp_write_file`) never materializes in full on every search keystroke.
 * The output mirrors `JSON.stringify` for the region it covers.
 */
function serializeToolCallArguments(args: Record<string, unknown>): string {
  try {
    let out = '';
    let exhausted = false;
    const emit = (text: string): boolean => {
      const remaining = MAX_TOOL_ARGUMENTS_FIELD_LENGTH - out.length;
      if (remaining <= 0) {
        exhausted = true;
        return false;
      }
      if (text.length > remaining) {
        out += text.slice(0, remaining);
        exhausted = true;
        return false;
      }
      out += text;
      return true;
    };
    const writeValue = (value: unknown, depth: number): boolean => {
      if (exhausted) return false;
      if (value === null || value === undefined || typeof value === 'function' || typeof value === 'symbol') {
        return emit('null');
      }
      switch (typeof value) {
        case 'boolean':
          return emit(value ? 'true' : 'false');
        case 'number':
          return emit(Number.isFinite(value) ? String(value) : 'null');
        case 'bigint':
          // `JSON.stringify` throws on BigInt; degrade to a cappable string.
          return emit(JSON.stringify(String(value)) ?? 'null');
        case 'string':
          // Keep per-value allocation bounded too: escaping a multi-megabyte
          // string whole would defeat the budget even if `emit` slices after.
          return emit(
            JSON.stringify(
              value.length > MAX_TOOL_ARGUMENTS_FIELD_LENGTH
                ? value.slice(0, MAX_TOOL_ARGUMENTS_FIELD_LENGTH)
                : value,
            ) ?? 'null',
          );
        default: {
          if (depth <= 0) return emit('null');
          if (Array.isArray(value)) {
            if (!emit('[')) return false;
            let first = true;
            for (const item of value) {
              if (!first && !emit(',')) return false;
              first = false;
              if (!writeValue(item, depth - 1)) return false;
            }
            return emit(']');
          }
          if (typeof value === 'object') {
            if (!emit('{')) return false;
            let first = true;
            // Iterate own properties lazily instead of materializing the full
            // `Object.entries` array first: an argument object with thousands
            // of keys (or one very large key) must not allocate for every
            // keystroke just to have most of it sliced away again.
            for (const key in value as Record<string, unknown>) {
              if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
              if (!first && !emit(',')) return false;
              first = false;
              // Cap the key before escaping it: escaping a multi-megabyte
              // property name whole would defeat the per-field budget.
              const serializedKey = JSON.stringify(
                key.length > MAX_TOOL_ARGUMENTS_FIELD_LENGTH
                  ? key.slice(0, MAX_TOOL_ARGUMENTS_FIELD_LENGTH)
                  : key,
              ) ?? 'null';
              if (!emit(serializedKey)) return false;
              if (!emit(':')) return false;
              if (!writeValue(value[key as keyof typeof value], depth - 1)) return false;
            }
            return emit('}');
          }
          return emit('null');
        }
      }
    };
    writeValue(args, MAX_TOOL_ARGUMENTS_SERIALIZATION_DEPTH);
    return out;
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
        for (let j = activity.changes.length - 1; j >= 0; j--) {
          if (collector.isFull) return;
          collector.push(activity.changes[j].path, MAX_TOOL_ARGUMENTS_FIELD_LENGTH);
        }
        break;
      case 'web_search':
        collector.push(activity.query, MAX_TOOL_ARGUMENTS_FIELD_LENGTH);
        break;
      case 'plan_update':
        for (let j = activity.items.length - 1; j >= 0; j--) {
          if (collector.isFull) return;
          collector.push(activity.items[j].text, MAX_TOOL_ARGUMENTS_FIELD_LENGTH);
        }
        break;
      case 'warning':
        collector.push(activity.message, MAX_TOOL_ARGUMENTS_FIELD_LENGTH);
        break;
    }
  }
}

/**
 * Collect the human-visible labels of a message's attachments: file names
 * and Vault note titles. Rendered from `message.attachments` when the
 * conversation is reopened (with the legacy `images` field as fallback), so
 * a session whose only mention of a term sits in an attachment label must
 * stay findable. Only the short labels are indexed — never the base64
 * payloads — so attaching files cannot blow up the search haystack.
 */
function collectAttachmentLabelFields(
  collector: SearchFieldCollector,
  attachments: ChatMessageAttachment[],
): void {
  // Individual labels are handed to the collector newest-first so the 2,000-
  // character field cap (and the remaining session budget) can truncate the
  // list at its oldest end instead of swallowing every later label from the
  // reopened conversation.
  for (let i = attachments.length - 1; i >= 0; i--) {
    if (collector.isFull) return;
    const attachment = attachments[i];
    collector.push(attachment.vaultNoteTitle, MAX_TOOL_ARGUMENTS_FIELD_LENGTH);
    if (collector.isFull) return;
    collector.push(attachment.filename, MAX_TOOL_ARGUMENTS_FIELD_LENGTH);
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
    // Persisted status text: when an external SDK turn stops after an
    // `onStatus` update, the final status remains in `message.statusText`,
    // is persisted, and is the only distinctive visible text rendered in the
    // reopened conversation. Status strings stay short, hence the tight cap.
    collector.push(message.statusText, MAX_TOOL_ARGUMENTS_FIELD_LENGTH);
    if (collector.isFull) continue;
    // Persisted failure diagnostics: when a Catty turn fails with empty
    // content the error message is the only visible text in the reopened
    // conversation, so it must be indexed. Error strings are short, hence the
    // tight cap.
    collector.push(message.errorInfo?.message, MAX_TOOL_ARGUMENTS_FIELD_LENGTH);
    collectAttachmentLabelFields(collector, message.attachments ?? message.images ?? []);
    // Tool calls accumulate at the end of `message.toolCalls`, so iterate
    // newest-first: if a burst of calls from this message exhausts the
    // remaining session budget, the newest (still visible) calls stay
    // searchable instead of being dropped in favor of the oldest ones.
    const toolCalls = message.toolCalls ?? [];
    for (let i = toolCalls.length - 1; i >= 0; i--) {
      if (collector.isFull) break;
      const toolCall = toolCalls[i];
      collector.push(toolCall.name);
      collector.push(serializeToolCallArguments(toolCall.arguments), MAX_TOOL_ARGUMENTS_FIELD_LENGTH);
    }
    // Tool results accumulate at the end of `message.toolResults` (and
    // `ChatMessageList` renders them in array order), so iterate newest-first:
    // if a burst of large results from this message exhausts the remaining
    // session budget, the newest (still visible) results stay searchable
    // instead of being dropped in favor of the oldest ones.
    const toolResults = message.toolResults ?? [];
    for (let i = toolResults.length - 1; i >= 0; i--) {
      if (collector.isFull) break;
      const toolResult = toolResults[i];
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

type SessionSearchIndex = {
  fields: string[];
  prepared: PreparedSearchFields;
};

/**
 * Per-session search index cache. `filterSessionHistory` runs on every search
 * keystroke, but `pruneSessionsForStorage` only bounds the persisted copy —
 * `useAIState` retains hundreds of live sessions in memory, and rebuilding plus
 * re-normalizing each session's (up to 64,000-character) haystack per keystroke
 * scans tens of megabytes and freezes the renderer. Sessions in state are
 * updated immutably (`{ ...s, messages: next }`), so object identity is a
 * reliable cache key: each session's fields and normalized/compact haystacks
 * are built once and reused until that session's object changes. The entry
 * dies with the session object, so no eviction bookkeeping is needed.
 */
const SESSION_SEARCH_INDEX_CACHE = new WeakMap<SessionHistorySearchTarget, SessionSearchIndex>();

function getSessionSearchIndex(session: SessionHistorySearchTarget): SessionSearchIndex {
  const cached = SESSION_SEARCH_INDEX_CACHE.get(session);
  if (cached) return cached;
  const fields = collectSessionSearchFields(session);
  const index: SessionSearchIndex = {
    fields,
    prepared: prepareSearchFields(fields),
  };
  SESSION_SEARCH_INDEX_CACHE.set(session, index);
  return index;
}

export function filterSessionHistory<T extends SessionHistorySearchTarget>(
  sessions: readonly T[],
  query: string,
): T[] {
  const trimmed = query.trim();
  if (!trimmed) return [...sessions];
  return sessions.filter((session) =>
    // Pinyin transliteration is too expensive to run over every collected
    // message field on each keystroke; the pinyin fallback is restricted to
    // the (small) title field, while literal/compact matching stays global.
    // Restricting pinyin per field still allows tokens within one query to
    // span fields: "chongqi nginx" matches a session titled "重启服务器"
    // whose message contains "nginx" ("chongqi" via title pinyin, "nginx"
    // literally in the message content).
    matchesPreparedSearchQuery(
      trimmed,
      getSessionSearchIndex(session).prepared,
      { pinyinFields: [session.title] },
    ),
  );
}
