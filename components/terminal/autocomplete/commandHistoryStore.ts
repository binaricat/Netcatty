/**
 * Persistent command history store for terminal autocomplete.
 * Stores commands per host with frequency tracking and timestamp ordering.
 * Uses localStorageAdapter as the persistence layer (works in renderer process).
 */

import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";

const STORAGE_KEY = "netcatty:commandHistory";
const MAX_ENTRIES = 10000;
const MAX_ENTRIES_PER_HOST = 5000;

export interface HistoryEntry {
  command: string;
  hostId: string;
  /** OS type for cross-host matching */
  os: "linux" | "windows" | "macos";
  /** Number of times this exact command was executed */
  frequency: number;
  /** Timestamp of last execution */
  lastUsedAt: number;
  /** Timestamp of first execution */
  createdAt: number;
}

interface HistoryStore {
  entries: HistoryEntry[];
  version: number;
}

let cachedStore: HistoryStore | null = null;

function loadStore(): HistoryStore {
  if (cachedStore) return cachedStore;
  try {
    const parsed = localStorageAdapter.read<HistoryStore>(STORAGE_KEY);
    if (parsed) {
      cachedStore = parsed;
      return parsed;
    }
  } catch {
    // Corrupted data, reset
  }
  cachedStore = { entries: [], version: 1 };
  return cachedStore;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function saveStore(store: HistoryStore): void {
  cachedStore = store;
  // Debounce saves to avoid excessive writes
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const ok = localStorageAdapter.write(STORAGE_KEY, store);
    if (!ok) {
      // Storage full — evict lowest scored entries (not just oldest by insertion)
      const now = Date.now();
      store.entries.sort((a, b) => scoreEntryAt(b, now) - scoreEntryAt(a, now));
      store.entries = store.entries.slice(0, Math.floor(MAX_ENTRIES / 2));
      localStorageAdapter.write(STORAGE_KEY, store);
    }
    saveTimer = null;
  }, 500);
}

/**
 * Record a command execution. Updates frequency if the command already exists
 * for this host, otherwise creates a new entry.
 */
export function recordCommand(
  command: string,
  hostId: string,
  os: "linux" | "windows" | "macos" = "linux",
): void {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 2000) return;

  const store = loadStore();
  const now = Date.now();

  // Find existing entry for same command + host
  const existingIdx = store.entries.findIndex(
    (e) => e.command === trimmed && e.hostId === hostId,
  );

  if (existingIdx >= 0) {
    store.entries[existingIdx].frequency++;
    store.entries[existingIdx].lastUsedAt = now;
  } else {
    store.entries.push({
      command: trimmed,
      hostId,
      os,
      frequency: 1,
      lastUsedAt: now,
      createdAt: now,
    });
  }

  // Enforce per-host limit (evict by score, not insertion order)
  const hostEntries = store.entries.filter((e) => e.hostId === hostId);
  if (hostEntries.length > MAX_ENTRIES_PER_HOST) {
    hostEntries.sort((a, b) => scoreEntryAt(a, now) - scoreEntryAt(b, now));
    const toRemove = new Set(
      hostEntries.slice(0, hostEntries.length - MAX_ENTRIES_PER_HOST).map((e) => e.command),
    );
    store.entries = store.entries.filter(
      (e) => e.hostId !== hostId || !toRemove.has(e.command),
    );
  }

  // Enforce global limit
  if (store.entries.length > MAX_ENTRIES) {
    store.entries.sort((a, b) => scoreEntryAt(b, now) - scoreEntryAt(a, now));
    store.entries = store.entries.slice(0, MAX_ENTRIES);
  }

  saveStore(store);
}

/**
 * Score an entry for ranking at a specific timestamp.
 * Caches Date.now() at query boundaries to avoid repeated syscalls during sort.
 */
function scoreEntryAt(entry: HistoryEntry, now: number): number {
  const ageMs = now - entry.lastUsedAt;
  const ageHours = ageMs / (1000 * 60 * 60);
  // Exponential decay: halve relevance every 24 hours
  const recencyScore = Math.pow(0.5, ageHours / 24);
  return entry.frequency * recencyScore;
}

export interface HistoryQueryOptions {
  /** Filter by host ID */
  hostId?: string;
  /** Also include entries from hosts with the same OS */
  includeOsMatches?: boolean;
  /** OS to match for cross-host suggestions */
  os?: "linux" | "windows" | "macos";
  /** Maximum number of results */
  limit?: number;
}

/**
 * Query history entries matching a prefix.
 * Returns entries sorted by relevance (frequency * recency).
 */
export function queryHistory(
  prefix: string,
  options: HistoryQueryOptions = {},
): HistoryEntry[] {
  const { hostId, includeOsMatches = true, os, limit = 20 } = options;
  const store = loadStore();
  const lowerPrefix = prefix.toLowerCase();
  const now = Date.now(); // Cache once per query

  const filtered = store.entries.filter((entry) => {
    // Must match prefix
    if (!entry.command.toLowerCase().startsWith(lowerPrefix)) return false;
    // Must not be identical to prefix
    if (entry.command === prefix) return false;

    // Host filtering
    if (hostId) {
      if (entry.hostId === hostId) return true;
      if (includeOsMatches && os && entry.os === os) return true;
      return false;
    }
    return true;
  });

  // Sort by: same host first, then by score
  filtered.sort((a, b) => {
    if (hostId) {
      const aIsHost = a.hostId === hostId ? 1 : 0;
      const bIsHost = b.hostId === hostId ? 1 : 0;
      if (aIsHost !== bIsHost) return bIsHost - aIsHost;
    }
    return scoreEntryAt(b, now) - scoreEntryAt(a, now);
  });

  // Deduplicate by command text (keep highest scored)
  const seen = new Set<string>();
  const results: HistoryEntry[] = [];
  for (const entry of filtered) {
    if (seen.has(entry.command)) continue;
    seen.add(entry.command);
    results.push(entry);
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Fuzzy query: matches commands containing all characters of the query
 * in order (not necessarily contiguous). Used as a fallback when prefix
 * matching yields few results.
 */
export function fuzzyQueryHistory(
  query: string,
  options: HistoryQueryOptions = {},
): HistoryEntry[] {
  const { hostId, includeOsMatches = true, os, limit = 10 } = options;
  const store = loadStore();
  const lowerQuery = query.toLowerCase();
  const now = Date.now(); // Cache once per query

  const scored: { entry: HistoryEntry; matchScore: number }[] = [];

  for (const entry of store.entries) {
    // Host filtering
    if (hostId) {
      const isHost = entry.hostId === hostId;
      const isOsMatch = includeOsMatches && os && entry.os === os;
      if (!isHost && !isOsMatch) continue;
    }

    const matchScore = fuzzyScore(lowerQuery, entry.command.toLowerCase());
    if (matchScore > 0 && entry.command !== query) {
      scored.push({ entry, matchScore });
    }
  }

  scored.sort((a, b) => {
    // Prefer same host
    if (hostId) {
      const aIsHost = a.entry.hostId === hostId ? 1 : 0;
      const bIsHost = b.entry.hostId === hostId ? 1 : 0;
      if (aIsHost !== bIsHost) return bIsHost - aIsHost;
    }
    // Then by fuzzy match quality * history score
    return b.matchScore * scoreEntryAt(b.entry, now) - a.matchScore * scoreEntryAt(a.entry, now);
  });

  const seen = new Set<string>();
  const results: HistoryEntry[] = [];
  for (const { entry } of scored) {
    if (seen.has(entry.command)) continue;
    seen.add(entry.command);
    results.push(entry);
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Compute a fuzzy match score. Returns 0 for no match.
 * Higher score = better match quality.
 * Rewards: first-char match, consecutive matches, word-boundary matches.
 */
function fuzzyScore(query: string, target: string): number {
  if (query.length === 0) return 0;
  if (query.length > target.length) return 0;

  let score = 0;
  let queryIdx = 0;
  let prevMatchIdx = -2;

  for (let i = 0; i < target.length && queryIdx < query.length; i++) {
    if (target[i] === query[queryIdx]) {
      queryIdx++;
      // First character bonus
      if (i === 0) score += 10;
      // Consecutive match bonus
      if (i === prevMatchIdx + 1) score += 5;
      // Word boundary bonus
      if (i === 0 || target[i - 1] === " " || target[i - 1] === "/" ||
          target[i - 1] === "-" || target[i - 1] === "_") {
        score += 3;
      }
      score += 1;
      prevMatchIdx = i;
    }
  }

  // All query characters must be matched
  return queryIdx === query.length ? score : 0;
}

/**
 * Delete a specific command from history for a host.
 */
export function deleteHistoryEntry(command: string, hostId: string): void {
  const store = loadStore();
  store.entries = store.entries.filter(
    (e) => !(e.command === command && e.hostId === hostId),
  );
  saveStore(store);
}

/**
 * Clear all history for a specific host, or all history if no hostId given.
 */
export function clearHistory(hostId?: string): void {
  const store = loadStore();
  if (hostId) {
    store.entries = store.entries.filter((e) => e.hostId !== hostId);
  } else {
    store.entries = [];
  }
  saveStore(store);
}

/**
 * Get total number of stored history entries.
 */
export function getHistoryCount(hostId?: string): number {
  const store = loadStore();
  if (hostId) {
    return store.entries.filter((e) => e.hostId === hostId).length;
  }
  return store.entries.length;
}
