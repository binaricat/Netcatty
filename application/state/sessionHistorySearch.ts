import {
  getSessionSearchTitle,
  matchesSessionSearchIndex,
  prepareSessionSearchIndex,
  type SessionHistorySearchTarget,
  type SessionSearchIndex,
} from '../../domain/sessionHistorySearch';
import { prepareSearchQuery, truncateQueryForMatch } from '../../lib/searchMatcher';

/**
 * Memory bounds for the per-session search index cache. `filterSessionHistory`
 * runs on every search keystroke, but `pruneSessionsForStorage` only bounds the
 * persisted copy — `useAIState` retains hundreds of live sessions in memory,
 * and rebuilding plus re-normalizing each session's (up to 64,000-character)
 * haystack per keystroke scans tens of megabytes and freezes the renderer.
 *
 * The raw collected fields are NOT retained (only the prepared search fields),
 * and
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
 * Mutable cache state owned by exactly one search client (one mounted history
 * drawer). Keeping this out of module scope means several concurrently mounted
 * drawers (one per terminal tab) never share a cache: each drawer's prune only
 * drops entries no longer in that drawer's scoped session list, and one
 * drawer's unmount releases only its own store (previously a shared
 * module-level cache was discarded for every drawer on any unmount and pruned
 * against whichever drawer scanned last).
 */
export type SessionHistorySearchStore = {
  /**
   * Sessions in state are updated immutably (`{ ...s, messages: next }`), so
   * object identity is a reliable cache key: each session's normalized/compact
   * haystacks are built once and reused until that session's object changes.
   * A changed display title (e.g. a localized fallback switch) forces a rebuild.
   */
  cache: Map<SessionHistorySearchTarget, SessionSearchIndex>;
  /**
   * Session keys the in-flight `filterSessionHistory` scan has already visited
   * (re-appended cache hits or inserted misses). `canCacheSessionSearchIndex`
   * never evicts a touched key: it either ranks above the current insert (it was
   * visited earlier in this newest-first scan) or it is the current session
   * itself (whose stale entry a rebuild is about to replace), and evicting either
   * would cycle-evict entries the same scan still needs.
   */
  scanTouched: Set<SessionHistorySearchTarget>;
  /**
   * Running total of the cache's retained characters. Maintained at every
   * mutation site so the eager insert gate in `canCacheSessionSearchIndex` stays
   * O(1) per miss instead of re-summing the whole cache on every keystroke
   * (mid-scan overshoot of the entry cap would otherwise make that sum O(n²)
   * across a scan).
   */
  cacheChars: number;
};

/** Retained characters of an index (the prepared haystacks; raw fields are dropped). */
function indexRetainedChars(index: SessionSearchIndex): number {
  // `normalizedFields`, `haystack` and `haystackCompact` are all retained
  // (`haystack` is `normalizedFields` joined, `haystackCompact` is derived
  // from `haystack`), so their combined length approximates the cache's
  // per-entry memory cost. Counting only the joined haystacks would
  // undercount by roughly a full copy of the corpus and let the char budget
  // retain ~50% more than advertised.
  let total = index.prepared.haystack.length + index.prepared.haystackCompact.length;
  for (const field of index.prepared.normalizedFields) total += field.length;
  return total;
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
  store: SessionHistorySearchStore,
  previous: SessionSearchIndex | undefined,
  index: SessionSearchIndex,
): boolean {
  const deltaChars = indexRetainedChars(index) - (previous ? indexRetainedChars(previous) : 0);
  if (deltaChars <= 0) return true;
  const budgetAfter = store.cacheChars + deltaChars;
  if (budgetAfter <= MAX_SESSION_SEARCH_INDEX_CACHE_CHARS) return true;
  // Not enough headroom: evict the lowest-ranked untouched entries. Mid-scan
  // the Map's order is old-insertion-order front to back with this scan's
  // touched keys re-appended at the end, so scanning the keys back-to-front
  // and skipping touched ones reaches the untouched (stalest, lowest-ranked)
  // entries first.
  const keysInInsertionOrder = [...store.cache.keys()];
  for (let i = keysInInsertionOrder.length - 1; i >= 0; i--) {
    if (store.cacheChars + deltaChars <= MAX_SESSION_SEARCH_INDEX_CACHE_CHARS) break;
    const key = keysInInsertionOrder[i];
    if (store.scanTouched.has(key)) continue;
    const evicted = store.cache.get(key);
    if (!evicted) continue;
    store.cacheChars -= indexRetainedChars(evicted);
    store.cache.delete(key);
  }
  return store.cacheChars + deltaChars <= MAX_SESSION_SEARCH_INDEX_CACHE_CHARS;
}

function getSessionSearchIndex(
  store: SessionHistorySearchStore,
  session: SessionHistorySearchTarget,
  untitledLabel: string,
): SessionSearchIndex {
  const indexedTitle = getSessionSearchTitle(session, untitledLabel);
  const cached = store.cache.get(session);
  if (cached && cached.displayTitle === indexedTitle) {
    // Re-append on every visit so the cache's insertion order mirrors the
    // latest scan's visitation order (the ranked, newest-first session list);
    // `pruneSessionSearchIndexCache` relies on that order when evicting.
    store.cache.delete(session);
    store.cache.set(session, cached);
    store.scanTouched.add(session);
    return cached;
  }
  const index = prepareSessionSearchIndex(session, untitledLabel);
  // Mark the session touched before the gate so the gate's admission eviction
  // can never pick this session's own (stale) entry — the rebuild below is
  // about to replace it, and evicting it would corrupt the running char total.
  store.scanTouched.add(session);
  if (canCacheSessionSearchIndex(store, cached, index)) {
    store.cache.set(session, index);
    // Keep the eager gate's running total in sync (also covers the
    // display-title-change rebuild, which replaces an existing entry).
    store.cacheChars += indexRetainedChars(index) - (cached ? indexRetainedChars(cached) : 0);
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
function pruneSessionSearchIndexCache(
  store: SessionHistorySearchStore,
  sessions: readonly SessionHistorySearchTarget[],
): void {
  const live = new Set<SessionHistorySearchTarget>(sessions);
  for (const key of [...store.cache.keys()]) {
    if (!live.has(key)) store.cache.delete(key);
  }
  let retained = 0;
  for (const cachedIndex of store.cache.values()) {
    retained += indexRetainedChars(cachedIndex);
  }
  // Re-sync the eager gate's running total: the sum above is authoritative
  // here (once per scan), so any drift accumulated mid-scan is corrected.
  store.cacheChars = retained;
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
  const keysInInsertionOrder = [...store.cache.keys()];
  while (
    store.cache.size > MAX_SESSION_SEARCH_INDEX_CACHE_ENTRIES
    || retained > MAX_SESSION_SEARCH_INDEX_CACHE_CHARS
  ) {
    // A single entry can never push the cache past the char budget (it is
    // bounded by ~192K chars by the collector caps), so keep the last entry.
    if (store.cache.size <= 1) break;
    const evictKey = keysInInsertionOrder.pop();
    if (evictKey === undefined) break;
    const evicted = store.cache.get(evictKey);
    if (evicted) retained -= indexRetainedChars(evicted);
    store.cache.delete(evictKey);
  }
  store.cacheChars = retained;
}

/**
 * Release every cached index and touched-session reference for one store
 * (invoked for the drawer's unmount lifecycle via the per-drawer search
 * instance). Cache keys are the session objects themselves, so clearing fully
 * drops all strong session references — the retained haystack characters
 * become garbage together with their sessions.
 */
function clearSessionHistorySearchStore(store: SessionHistorySearchStore): void {
  store.cache.clear();
  store.scanTouched.clear();
  store.cacheChars = 0;
}

export type SessionHistorySearchOptions = {
  /**
   * Localized fallback label rendered by the drawer for sessions with an
   * empty persisted title (e.g. `t('ai.chat.untitled')`); indexed as the
   * displayed title so searching for the visible label finds the session.
   */
  untitledLabel?: string;
};

function filterSessionHistoryStore<T extends SessionHistorySearchTarget>(
  store: SessionHistorySearchStore,
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
    store.scanTouched.clear();
    // Cache keys are the session objects themselves, so an entry for a
    // deleted/replaced session strongly retains that session (and its full
    // message/attachment payloads). Prune against the current list here too:
    // the blank-query path may run while the drawer stays open after
    // deletions, and a later nonblank search that would prune otherwise may
    // never happen (e.g. the user just closes the drawer).
    pruneSessionSearchIndexCache(store, sessions);
    return [...sessions];
  }
  const untitledLabel = options.untitledLabel ?? '';
  // Bound and prepare the query once per scan: a pasted-in multi-megabyte
  // query would otherwise be re-normalized (NFKC), tokenized and compacted
  // inside `matchesSessionSearchIndex` for every session, freezing the
  // renderer. The cap (`truncateQueryForMatch`, `MAX_SEARCH_QUERY_LENGTH`) is
  // applied here at this scan's input — not inside the shared `prepareSearchQuery`
  // — so the meaning of over-limit queries stays local to session history and
  // the normalized forms are computed a single time, letting the per-session
  // work below only do `includes` scans over the cached haystacks.
  const preparedQuery = prepareSearchQuery(truncateQueryForMatch(trimmed));
  // A new scan starts with no visited sessions: the touched set records only
  // this scan's visits so `canCacheSessionSearchIndex` can never mistake a
  // previous scan's keys for keys the current scan still needs.
  store.scanTouched.clear();
  try {
    // Drop entries still held by sessions that left the scan list (e.g. the
    // history shrank or session objects changed since the previous scan). Those
    // entries are never visited by this scan — the end-of-scan prune would
    // remove them too — but dropping them up front keeps their characters
    // available to this scan's inserts (via the eager char gate). Cheap: one
    // Set plus one pass over the cached keys.
    const currentLive = new Set<SessionHistorySearchTarget>(sessions);
    for (const key of [...store.cache.keys()]) {
      if (!currentLive.has(key)) {
        const removed = store.cache.get(key);
        if (removed) store.cacheChars -= indexRetainedChars(removed);
        store.cache.delete(key);
      }
    }
    // Scan all sessions first (a miss admits its index into the cache — evicting
    // this scan's untouched stale tail if the char budget is full; the
    // entry-count overshoot this may cause mid-scan is trimmed by the prune
    // below), then prune entries that fell out of the scan list at the end of
    // the scan.
    const result = sessions.filter((session) => {
      const index = getSessionSearchIndex(store, session, untitledLabel);
      return matchesSessionSearchIndex(preparedQuery, index);
    });
    // Prune against the full scanned list (not the filtered result): sessions
    // that merely did not match this query must keep their cached indexes.
    pruneSessionSearchIndexCache(store, sessions);
    return result;
  } finally {
    // The touched set only guards against cycle-eviction within the current
    // scan; once the scan ends (even if it throws), release its strong
    // references to session objects so deleted/replaced sessions and their
    // large message/attachment payloads aren't retained until the next
    // nonblank search.
    store.scanTouched.clear();
  }
}

/**
 * One stateful search instance per consumer (one mounted session history
 * drawer). The cache lives in the returned instance's store instead of module
 * scope, so concurrently mounted drawers (one per terminal tab) never share
 * state: an unmount of one drawer clears only that drawer's indexes, and each
 * drawer's prune is scoped to its own session list.
 */
export type SessionHistorySearch = {
  filterSessionHistory: <T extends SessionHistorySearchTarget>(
    sessions: readonly T[],
    query: string,
    options?: SessionHistorySearchOptions,
  ) => T[];
  clearSessionHistorySearchCache: () => void;
};

export function createSessionHistorySearch(): SessionHistorySearch {
  const store: SessionHistorySearchStore = {
    cache: new Map(),
    scanTouched: new Set(),
    cacheChars: 0,
  };
  return {
    filterSessionHistory(sessions, query, options = {}) {
      return filterSessionHistoryStore(store, sessions, query, options);
    },
    clearSessionHistorySearchCache() {
      clearSessionHistorySearchStore(store);
    },
  };
}
