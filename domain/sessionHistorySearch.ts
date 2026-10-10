import type { AgentActivity } from './agentActivity';
import {
  matchesPreparedSearchQuery,
  prepareSearchFields,
  type PreparedSearchFields,
} from '../lib/searchMatcher';

/**
 * Minimal structural shapes for session history search. Declared here (not
 * imported from `infrastructure/ai/types`) so this domain module keeps no
 * dependency on the infrastructure layer; persisted `AISession`s satisfy
 * these shapes structurally.
 */
export type SessionHistorySearchAttachment = {
  /** Rendered file label (absent for terminal selections and note-only files). */
  filename?: string;
  /** Rendered Vault note label. */
  vaultNoteTitle?: string;
};

export type SessionHistorySearchMessage = {
  content: string;
  thinking?: string;
  statusText?: string;
  errorInfo?: { message: string };
  attachments?: readonly SessionHistorySearchAttachment[];
  /** @deprecated Legacy attachment field, kept for backward compatibility. */
  images?: readonly SessionHistorySearchAttachment[];
  toolCalls?: readonly { name: string; arguments: Record<string, unknown> }[];
  toolResults?: readonly { toolName?: string; content: string }[];
  agentActivities?: readonly AgentActivity[];
};

/**
 * Searchable shape for session history search. Pure domain logic consumed by
 * the session history drawer; matches on title plus user/assistant message
 * text, including thinking, tool call names/arguments, tool result content,
 * persisted agent activities (web-search queries, file paths, plan items,
 * warnings) already stored on messages, visible attachment labels (file names
 * and Vault note titles) and persisted error messages.
 */
export type SessionHistorySearchTarget = {
  /** Raw persisted title; may be empty (the UI then renders a fallback). */
  title: string;
  messages: readonly SessionHistorySearchMessage[];
};

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
  activities: readonly AgentActivity[],
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
  attachments: readonly SessionHistorySearchAttachment[],
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

/**
 * The title exactly as the history drawer renders it: an empty persisted
 * title is displayed with the localized "Untitled" fallback, so the fallback
 * text (passed by the caller) must be indexed too — searching for the label
 * the user actually sees must not hide the session.
 */
function resolveDisplayTitle(session: SessionHistorySearchTarget, untitledLabel: string): string {
  return session.title || untitledLabel;
}

export function collectSessionSearchFields(
  session: SessionHistorySearchTarget,
  untitledLabel: string = '',
): string[] {
  const collector = createSearchFieldCollector();
  // The displayed title is indexed first so it always survives the
  // total-length cap. Still skipped entirely when both the raw title and the
  // fallback are blank.
  collector.push(resolveDisplayTitle(session, untitledLabel));
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
  /** Displayed title the index was built for (raw title or the fallback). */
  displayTitle: string;
  prepared: PreparedSearchFields;
};

/**
 * Memory bounds for the per-session search index cache. `filterSessionHistory`
 * runs on every search keystroke, but `pruneSessionsForStorage` only bounds the
 * persisted copy — `useAIState` retains hundreds of live sessions in memory,
 * and rebuilding plus re-normalizing each session's (up to 64,000-character)
 * haystack per keystroke scans tens of megabytes and freezes the renderer.
 *
 * The raw collected fields are NOT retained (only the prepared haystacks), and
 * the cache holds at most `MAX_SESSION_SEARCH_INDEX_CACHE_ENTRIES` entries
 * within a `MAX_SESSION_SEARCH_INDEX_CACHE_CHARS` character budget: an
 * unbounded cache would let one entry per live session (several normalized
 * copies of each session's searchable corpus) permanently pin hundreds of
 * megabytes in a long-running process. Both bounds hold after every scan's
 * prune; mid-scan, the char budget is checked eagerly against a running
 * total (see `canCacheSessionSearchIndex`), so a single search over thousands
 * of uncached sessions cannot transiently pin hundreds of megabytes — only
 * the entry count may transiently overshoot (each overshooting insert passed
 * the char gate first, so the overshoot is bounded by the scanned list's
 * length and by the char budget) and the prune at the end of
 * `filterSessionHistory` trims it back. When the eager char gate has no
 * headroom, the miss evicts the cache's stale, lowest-ranked tail (entries the
 * in-flight scan has not yet visited — they rank below every visited session,
 * so this can never cycle-evict an entry the same scan still needs) to admit
 * the higher-ranked new index; skipping the insert instead would freeze cache
 * membership exactly like a hard entry-count gate: a cache held full by large
 * cached sessions would retain the stale lower-ranked tail forever while every
 * newly prepended high-ranked session rebuilt its index on every keystroke.
 */
const MAX_SESSION_SEARCH_INDEX_CACHE_ENTRIES = 64;
const MAX_SESSION_SEARCH_INDEX_CACHE_CHARS = 4_000_000;

/**
 * Session keys the in-flight `filterSessionHistory` scan has already visited
 * (re-appended cache hits or inserted misses). `canCacheSessionSearchIndex`
 * never evicts a touched key: it either ranks above the current insert (it was
 * visited earlier in this newest-first scan) or it is the current session
 * itself (whose stale entry a rebuild is about to replace), and evicting either
 * would cycle-evict entries the same scan still needs.
 */
const sessionSearchIndexScanTouched = new Set<SessionHistorySearchTarget>();

/**
 * Running total of the cache's retained characters. Maintained at every
 * mutation site so the eager insert gate in `canCacheSessionSearchIndex` stays
 * O(1) per miss instead of re-summing the whole cache on every keystroke
 * (mid-scan overshoot of the entry cap would otherwise make that sum O(n²)
 * across a scan).
 */
let sessionSearchIndexCacheChars = 0;

/**
 * Sessions in state are updated immutably (`{ ...s, messages: next }`), so
 * object identity is a reliable cache key: each session's normalized/compact
 * haystacks are built once and reused until that session's object changes.
 * A changed display title (e.g. a localized fallback switch) forces a rebuild.
 */
const SESSION_SEARCH_INDEX_CACHE = new Map<SessionHistorySearchTarget, SessionSearchIndex>();

/** Retained characters of an index (the prepared haystacks; raw fields are dropped). */
function indexRetainedChars(index: SessionSearchIndex): number {
  // `haystackCompact` is derived from `haystack`, but both are retained and
  // their combined length approximates the cache's per-entry memory cost.
  return index.prepared.haystack.length + index.prepared.haystackCompact.length;
}

/**
 * Whether a freshly built index may be inserted into the cache without
 * pushing the char budget past its bound. The char budget must fit eagerly —
 * the prune that enforces the char bound only runs once per scan, so
 * inserting every prepared index would let a single search over
 * hundreds/thousands of uncached sessions transiently pin the whole corpus
 * (several normalized haystacks per session) before pruning, briefly
 * allocating hundreds of megabytes.
 *
 * The entry-count bound is intentionally NOT a gate here: hard-rejecting new
 * entries once `MAX_SESSION_SEARCH_INDEX_CACHE_ENTRIES` live sessions are
 * cached would permanently freeze the cache's membership — since new sessions
 * are prepended to the ranked list, every subsequently created conversation
 * (and its immutable streaming updates) would then rebuild its index on every
 * keystroke while stale lower-ranked entries stay cached. Instead, misses
 * overshoot the entry cap mid-scan (bounded by the scanned list's length and
 * the eagerly enforced char budget) and the end-of-scan prune trims the
 * lowest-ranked tail back under the cap, so the freshest, highest-ranked
 * prefix is always admitted. Eviction never touches an entry this scan has
 * already visited (see `sessionSearchIndexScanTouched`), which keeps that
 * prune safe from cycle-evicting entries the same scan still needs.
 *
 * The char check is only applied to NEW entries: cache hits merely re-append
 * an existing entry (no growth), and a rebuild replaces the same session's
 * entry (no size growth; the char delta against the replaced index is
 * checked). When the budget is full, the gate admits a new/rebuilt index by
 * evicting the cache's stale tail — the entries this scan has not yet visited.
 * Because the scan visits the ranked list newest-first, every untouched entry
 * ranks below the current insert, so replacing any of them never drops an
 * index a later visit of the same scan still needs (no cycle thrash) and
 * always preserves the highest-ranked cached prefix. Only if no untouched
 * entry releases enough characters does the insert get skipped — the index is
 * then simply rebuilt on the next search.
 */
function canCacheSessionSearchIndex(
  previous: SessionSearchIndex | undefined,
  index: SessionSearchIndex,
): boolean {
  const deltaChars = indexRetainedChars(index) - (previous ? indexRetainedChars(previous) : 0);
  if (deltaChars <= 0) return true;
  const budgetAfter = sessionSearchIndexCacheChars + deltaChars;
  if (budgetAfter <= MAX_SESSION_SEARCH_INDEX_CACHE_CHARS) return true;
  // Not enough headroom: evict the lowest-ranked untouched entries. Mid-scan
  // the Map's order is old-insertion-order front to back with this scan's
  // touched keys re-appended at the end, so scanning the keys back-to-front
  // and skipping touched ones reaches the untouched (stalest, lowest-ranked)
  // entries first.
  const keysInInsertionOrder = [...SESSION_SEARCH_INDEX_CACHE.keys()];
  for (let i = keysInInsertionOrder.length - 1; i >= 0; i--) {
    if (sessionSearchIndexCacheChars + deltaChars <= MAX_SESSION_SEARCH_INDEX_CACHE_CHARS) break;
    const key = keysInInsertionOrder[i];
    if (sessionSearchIndexScanTouched.has(key)) continue;
    const evicted = SESSION_SEARCH_INDEX_CACHE.get(key);
    if (!evicted) continue;
    sessionSearchIndexCacheChars -= indexRetainedChars(evicted);
    SESSION_SEARCH_INDEX_CACHE.delete(key);
  }
  return sessionSearchIndexCacheChars + deltaChars <= MAX_SESSION_SEARCH_INDEX_CACHE_CHARS;
}

function getSessionSearchIndex(
  session: SessionHistorySearchTarget,
  untitledLabel: string,
): SessionSearchIndex {
  const displayTitle = resolveDisplayTitle(session, untitledLabel);
  const cached = SESSION_SEARCH_INDEX_CACHE.get(session);
  if (cached && cached.displayTitle === displayTitle) {
    // Re-append on every visit so the cache's insertion order mirrors the
    // latest scan's visitation order (the ranked, newest-first session list);
    // `pruneSessionSearchIndexCache` relies on that order when evicting.
    SESSION_SEARCH_INDEX_CACHE.delete(session);
    SESSION_SEARCH_INDEX_CACHE.set(session, cached);
    sessionSearchIndexScanTouched.add(session);
    return cached;
  }
  const fields = collectSessionSearchFields(session, untitledLabel);
  const index: SessionSearchIndex = {
    displayTitle,
    prepared: prepareSearchFields(fields),
  };
  // Mark the session touched before the gate so the gate's admission eviction
  // can never pick this session's own (stale) entry — the rebuild below is
  // about to replace it, and evicting it would corrupt the running char total.
  sessionSearchIndexScanTouched.add(session);
  if (canCacheSessionSearchIndex(cached, index)) {
    SESSION_SEARCH_INDEX_CACHE.set(session, index);
    // Keep the eager gate's running total in sync (also covers the
    // display-title-change rebuild, which replaces an existing entry).
    sessionSearchIndexCacheChars +=
      indexRetainedChars(index) - (cached ? indexRetainedChars(cached) : 0);
  }
  return index;
}

/**
 * Eviction runs once per full scan (at the end of `filterSessionHistory`), not
 * on every cache miss: evicting during the scan would make each miss drop the
 * index of a later session in the same scan, so any history longer than the
 * entry cap would cycle-evict the whole cache and rebuild every session's
 * haystack on every keystroke. Deferring eviction keeps every retained entry
 * usable within a scan while still bounding the cache — first by dropping
 * indexes for sessions no longer in the scanned list, then by evicting the
 * lowest-ranked entries (the oldest tail of the newest-first ranked list)
 * until both bounds hold, preserving the front of the ranked list.
 *
 * In practice the eviction loop is cheap: the char budget is enforced
 * eagerly (see `canCacheSessionSearchIndex`), so the prune's overshoot is
 * only the entry count above the entry cap (at most one entry per missed
 * session in the scan) — it drops that overshoot plus indexes for sessions
 * that left the scanned list.
 */
function pruneSessionSearchIndexCache(sessions: readonly SessionHistorySearchTarget[]): void {
  const live = new Set<SessionHistorySearchTarget>(sessions);
  for (const key of [...SESSION_SEARCH_INDEX_CACHE.keys()]) {
    if (!live.has(key)) SESSION_SEARCH_INDEX_CACHE.delete(key);
  }
  let retained = 0;
  for (const cachedIndex of SESSION_SEARCH_INDEX_CACHE.values()) {
    retained += indexRetainedChars(cachedIndex);
  }
  // Re-sync the eager gate's running total: the sum above is authoritative
  // here (once per scan), so any drift accumulated mid-scan is corrected.
  sessionSearchIndexCacheChars = retained;
  // Evict from the END of the Map until both bounds hold. Every scan visits
  // the full ranked session list newest-first and `getSessionSearchIndex`
  // re-appends each visited entry, so after a scan the Map's insertion order
  // mirrors visitation order: the highest-ranked (newest) sessions sit at the
  // FRONT and the oldest tail at the BACK. Evicting the front (classic LRU on
  // Map order) would therefore drop the newest, highest-ranked sessions and
  // retain the stalest tail — every subsequent keystroke would rebuild every
  // session above the cache cap. Evicting the back instead preserves the
  // front of the ranked list. The single remaining entry is always kept, even
  // if it alone exceeds the char budget (a single entry is bounded by ~192K
  // chars by the collector caps).
  // Snapshot the keys once: prune only deletes (never inserts), so popping
  // from this array visits keys exactly in Map order, back to front.
  const keysInInsertionOrder = [...SESSION_SEARCH_INDEX_CACHE.keys()];
  while (
    SESSION_SEARCH_INDEX_CACHE.size > MAX_SESSION_SEARCH_INDEX_CACHE_ENTRIES
    || retained > MAX_SESSION_SEARCH_INDEX_CACHE_CHARS
  ) {
    // A single entry can never push the cache past the char budget (it is
    // bounded by ~192K chars by the collector caps), so keep the last entry.
    if (SESSION_SEARCH_INDEX_CACHE.size <= 1) break;
    const evictKey = keysInInsertionOrder.pop();
    if (evictKey === undefined) break;
    const evicted = SESSION_SEARCH_INDEX_CACHE.get(evictKey);
    if (evicted) retained -= indexRetainedChars(evicted);
    SESSION_SEARCH_INDEX_CACHE.delete(evictKey);
  }
  sessionSearchIndexCacheChars = retained;
}

export type SessionHistorySearchOptions = {
  /**
   * Localized fallback label rendered by the drawer for sessions with an
   * empty persisted title (e.g. `t('ai.chat.untitled')`); indexed as the
   * displayed title so searching for the visible label finds the session.
   */
  untitledLabel?: string;
};

export function filterSessionHistory<T extends SessionHistorySearchTarget>(
  sessions: readonly T[],
  query: string,
  options: SessionHistorySearchOptions = {},
): T[] {
  const trimmed = query.trim();
  if (!trimmed) {
    // The blank-query path skips the scan entirely; release any stale
    // scan-touched state so it cannot pin visited sessions (and their
    // message/attachment memory) while the drawer is open without a query.
    // Normally this set is already empty — the nonblank scan clears it in its
    // `finally` — but clearing here too keeps every entry path leak-free.
    sessionSearchIndexScanTouched.clear();
    return [...sessions];
  }
  const untitledLabel = options.untitledLabel ?? '';
  // A new scan starts with no visited sessions: the touched set records only
  // this scan's visits so `canCacheSessionSearchIndex` can never mistake a
  // previous scan's keys for keys the current scan still needs.
  sessionSearchIndexScanTouched.clear();
  try {
    // Drop entries still held by sessions that left the scan list (e.g. the
    // history shrank or session objects changed since the previous scan). Those
    // entries are never visited by this scan — the end-of-scan prune would
    // remove them too — but dropping them up front keeps their characters
    // available to this scan's inserts (via the eager char gate). Cheap: one
    // Set plus one pass over the cached keys.
    const currentLive = new Set<SessionHistorySearchTarget>(sessions);
    for (const key of [...SESSION_SEARCH_INDEX_CACHE.keys()]) {
      if (!currentLive.has(key)) {
        const removed = SESSION_SEARCH_INDEX_CACHE.get(key);
        if (removed) sessionSearchIndexCacheChars -= indexRetainedChars(removed);
        SESSION_SEARCH_INDEX_CACHE.delete(key);
      }
    }
    // Scan all sessions first (a miss admits its index into the cache — evicting
    // this scan's untouched stale tail if the char budget is full; the
    // entry-count overshoot this may cause mid-scan is trimmed by the prune
    // below), then prune entries that fell out of the scan list at the end of
    // the scan.
    const result = sessions.filter((session) => {
      // Pinyin transliteration is too expensive to run over every collected
      // message field on each keystroke; the pinyin fallback is restricted to
      // the (small) displayed-title field, while literal/compact matching stays
      // global. Restricting pinyin per field still allows tokens within one
      // query to span fields: "chongqi nginx" matches a session titled
      // "重启服务器" whose message contains "nginx" ("chongqi" via title
      // pinyin, "nginx" literally in the message content).
      const index = getSessionSearchIndex(session, untitledLabel);
      return matchesPreparedSearchQuery(trimmed, index.prepared, {
        pinyinFields: [index.displayTitle],
      });
    });
    // Prune against the full scanned list (not the filtered result): sessions
    // that merely did not match this query must keep their cached indexes.
    pruneSessionSearchIndexCache(sessions);
    return result;
  } finally {
    // The touched set only guards against cycle-eviction within the current
    // scan; once the scan ends (even if it throws), release its strong
    // references to session objects so deleted/replaced sessions and their
    // large message/attachment payloads aren't retained until the next
    // nonblank search.
    sessionSearchIndexScanTouched.clear();
  }
}
