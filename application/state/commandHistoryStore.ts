/**
 * Persistent command history store for terminal autocomplete.
 * Stores commands per host with frequency tracking and timestamp ordering.
 * Uses localStorageAdapter as the persistence layer (works in renderer process).
 *
 * Lives in application state rather than the UI layer so the vault hook and the
 * terminal UI depend on one lower-layer API, and so every renderer (main window
 * and detached terminal popups) shares the same clear semantics.
 */

import { localStorageAdapter } from "../../infrastructure/persistence/localStorageAdapter";
import {
  STORAGE_KEY_COMMAND_HISTORY,
  STORAGE_KEY_COMMAND_HISTORY_CLEARED,
} from "../../infrastructure/config/storageKeys";

const STORAGE_KEY = STORAGE_KEY_COMMAND_HISTORY;
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
  /**
   * Monotonic counter bumped by every global clear. Other renderers compare it
   * to detect a clear performed elsewhere, and in-flight histfile imports use
   * it to discard work that started before the clear.
   */
  clearGeneration?: number;
}

let cachedStore: HistoryStore | null = null;
/** Last clear generation this renderer has observed. */
let knownClearGeneration: number | null = null;

function readClearGeneration(store: HistoryStore): number {
  return typeof store.clearGeneration === "number" ? store.clearGeneration : 0;
}

function loadStore(): HistoryStore {
  if (cachedStore) return cachedStore;
  try {
    const parsed = localStorageAdapter.read<HistoryStore>(STORAGE_KEY);
    if (parsed) {
      cachedStore = parsed;
      knownClearGeneration = readClearGeneration(parsed);
      return parsed;
    }
  } catch {
    // Corrupted data, reset
  }
  cachedStore = { entries: [], version: 1, clearGeneration: 0 };
  knownClearGeneration = 0;
  return cachedStore;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveIdleHandle: number | null = null;

const CLEAR_GENERATION_PREFIX = /^\{"clearGeneration":(\d+)[,}]/;

/**
 * The store's clear generation, read from its raw JSON without parsing the
 * whole history (up to 10k entries, ~1.5 MB). Stores are serialized with
 * clearGeneration first (serializeStore); other layouts fall back to a parse.
 */
function readRawClearGeneration(raw: string | null): number | null {
  if (!raw) return null;
  const match = CLEAR_GENERATION_PREFIX.exec(raw.slice(0, 48));
  if (match) return Number(match[1]);
  try {
    return readClearGeneration(JSON.parse(raw) as HistoryStore);
  } catch {
    return null;
  }
}

function serializeStore(store: HistoryStore): HistoryStore {
  // Keep clearGeneration first so readRawClearGeneration can find it.
  return { clearGeneration: readClearGeneration(store), version: store.version, entries: store.entries };
}

function persistStoreNow(store: HistoryStore): boolean {
  // A peer clear is visible in storage before its queued event is handled.
  // Never flush a cached pre-clear snapshot over that newer empty store.
  // Only the generation is needed on this per-command path; parse the stored
  // history just in the rare case where it must be adopted.
  const persistedGeneration = readRawClearGeneration(localStorageAdapter.readString(STORAGE_KEY));
  if (persistedGeneration !== null && persistedGeneration > readClearGeneration(store)) {
    const persisted = localStorageAdapter.read<HistoryStore>(STORAGE_KEY);
    if (persisted && readClearGeneration(persisted) > readClearGeneration(store)) {
      cachedStore = persisted;
      knownClearGeneration = readClearGeneration(persisted);
      notifyCommandHistoryCleared();
      return true;
    }
  }
  const ok = localStorageAdapter.write(STORAGE_KEY, serializeStore(store));
  if (ok) return true;
  // Storage full — evict lowest scored entries (not just oldest by insertion)
  const now = Date.now();
  store.entries.sort((a, b) => scoreEntryAt(b, now) - scoreEntryAt(a, now));
  store.entries = store.entries.slice(0, Math.floor(MAX_ENTRIES / 2));
  return localStorageAdapter.write(STORAGE_KEY, serializeStore(store));
}

function hasPendingSave(): boolean {
  return saveTimer !== null || saveIdleHandle !== null;
}

function saveStore(store: HistoryStore): void {
  cachedStore = store;
  // Debounce saves, then write when the renderer is idle: serializing the
  // history right after Enter used to land in the middle of command output.
  cancelPendingSave();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const persist = () => {
      saveIdleHandle = null;
      persistStoreNow(store);
    };
    if (typeof requestIdleCallback === "function") {
      saveIdleHandle = requestIdleCallback(persist, { timeout: 2000 });
    } else {
      persist();
    }
  }, 500);
}

function cancelPendingSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (saveIdleHandle !== null) {
    if (typeof cancelIdleCallback === "function") cancelIdleCallback(saveIdleHandle);
    saveIdleHandle = null;
  }
}

/**
 * Flush any pending debounced history write immediately.
 * Used after bulk imports (e.g. local histfile seeding) so a seed-complete
 * flag is not persisted before the imported commands land in storage.
 * Returns false when the write could not be persisted.
 */
export function flushCommandHistoryStore(): boolean {
  if (!cachedStore) return true;
  cancelPendingSave();
  return persistStoreNow(cachedStore);
}

/**
 * React to a write performed by another renderer (main window or a detached
 * terminal popup).
 *
 * A bumped clear generation drops the cache and pending save, then notifies
 * live autocomplete controllers. Ordinary peer writes must not cancel a local
 * command that is still waiting for its debounced save.
 */
function applyExternalCommandHistoryWrite(
  rawNewValue: string | null,
  rawOldValue: string | null,
): void {
  // Fires in every other window for each save; read just the generation.
  const incomingGeneration = readRawClearGeneration(rawNewValue);

  let previousGeneration = knownClearGeneration;
  if (previousGeneration === null) {
    // A fresh popup can have compose recall before its first autocomplete query.
    // The event's old value is its baseline, even after an earlier global clear.
    previousGeneration = readRawClearGeneration(rawOldValue) ?? 0;
  }
  if (incomingGeneration !== null && incomingGeneration > previousGeneration) {
    cancelPendingSave();
    cachedStore = null;
    knownClearGeneration = incomingGeneration;
    notifyCommandHistoryCleared();
  } else {
    if (!hasPendingSave()) cachedStore = null;
    if (incomingGeneration !== null && knownClearGeneration === null) {
      knownClearGeneration = incomingGeneration;
    }
  }
}

// The native `storage` event fires in *other* same-origin windows (main window
// and detached terminal popups) when a key changes there.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) applyExternalCommandHistoryWrite(event.newValue, event.oldValue);
  });
}

/**
 * Current clear generation. Callers capture this before async work and compare
 * afterwards to detect a clear that happened while they were waiting.
 */
export function getCommandHistoryClearGeneration(): number {
  if (knownClearGeneration === null) loadStore();
  return knownClearGeneration ?? 0;
}

/**
 * Record that the user explicitly cleared all command history.
 *
 * Histfile seeding honors this tombstone: a clear is a user decision to delete
 * locally recorded history, so a later first-time import must not restore the
 * commands the user deleted (a pre-clear in-flight check alone cannot catch a
 * clear that happened before the import started).
 */
export function markCommandHistoryCleared(): void {
  localStorageAdapter.writeBoolean(STORAGE_KEY_COMMAND_HISTORY_CLEARED, true);
}

/** True once the user has cleared all command history at least once. */
export function hasCommandHistoryBeenCleared(): boolean {
  return localStorageAdapter.readBoolean(STORAGE_KEY_COMMAND_HISTORY_CLEARED) === true;
}

type CommandHistoryClearedListener = () => void;
const clearedListeners = new Set<CommandHistoryClearedListener>();

/**
 * Subscribe to command-history clears, including clears performed in another
 * renderer. Live autocomplete controllers use this to drop visible suggestions
 * and ghost text and abort in-flight completions, so a stale row cannot be
 * accepted and recorded after the history was cleared.
 */
export function subscribeCommandHistoryCleared(
  listener: CommandHistoryClearedListener,
): () => void {
  clearedListeners.add(listener);
  return () => {
    clearedListeners.delete(listener);
  };
}

function notifyCommandHistoryCleared(): void {
  for (const listener of [...clearedListeners]) listener();
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

/** Remove one command from autocomplete history for a specific host. */
export function removeCommandHistoryEntry(command: string, hostId: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  const store = loadStore();
  const nextEntries = store.entries.filter(
    (entry) => entry.command !== trimmed || entry.hostId !== hostId,
  );
  if (nextEntries.length === store.entries.length) return false;

  store.entries = nextEntries;
  cancelPendingSave();
  return persistStoreNow(store);
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
  /** Filter by host ID (strict isolation — only this host's history) */
  hostId?: string;
  /** Maximum number of results */
  limit?: number;
}

export interface RecentHistoryQueryOptions extends HistoryQueryOptions {
  /** Base command name, e.g. `cd` or `ls` */
  commandName: string;
  /** Exact command text to exclude from results */
  excludeCommand?: string;
  /** Optional path prefix to require on the current argument */
  argumentPrefix?: string;
}

interface RankedHistoryEntry {
  entry: HistoryEntry;
  score: number;
}

/**
 * Keep only the best k distinct commands. Queries score each match once and
 * retain O(k) candidates instead of sorting/allocating all matches (k is 5
 * for autocomplete). Entries arrive in store order for stable score ties.
 */
function retainHistoryMatch(
  best: RankedHistoryEntry[],
  entry: HistoryEntry,
  score: number,
  limit: number,
): void {
  if (best.length >= limit && score <= best[best.length - 1].score) return;

  const duplicate = best.findIndex((candidate) => candidate.entry.command === entry.command);
  if (duplicate >= 0) {
    if (score <= best[duplicate].score) return;
    best.splice(duplicate, 1);
  }

  // Insert after equal scores to preserve the original store order on ties.
  const index = best.findIndex((candidate) => score > candidate.score);
  if (best.length >= limit) best.pop();
  best.splice(index < 0 ? best.length : index, 0, { entry, score });
}

/**
 * Query history entries matching a prefix.
 * Returns entries sorted by relevance (frequency * recency).
 */
export function queryHistory(
  prefix: string,
  options: HistoryQueryOptions = {},
): HistoryEntry[] {
  const { hostId, limit = 20 } = options;
  if (limit <= 0) return [];
  const store = loadStore();
  const lowerPrefix = prefix.toLowerCase();
  const now = Date.now(); // Cache once per query

  const best: RankedHistoryEntry[] = [];
  for (const entry of store.entries) {
    if (hostId && entry.hostId !== hostId) continue;
    // Must match prefix
    if (!entry.command.toLowerCase().startsWith(lowerPrefix)) continue;
    // Must not be identical to prefix
    if (entry.command === prefix) continue;
    retainHistoryMatch(best, entry, scoreEntryAt(entry, now), limit);
  }

  return best.map(({ entry }) => entry);
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
  const { hostId, limit = 10 } = options;
  if (limit <= 0) return [];
  const store = loadStore();
  const lowerQuery = query.toLowerCase();
  const now = Date.now(); // Cache once per query

  const best: RankedHistoryEntry[] = [];

  for (const entry of store.entries) {
    // Host filtering
    if (hostId) {
      if (entry.hostId !== hostId) continue;
    }

    const matchScore = fuzzyScore(lowerQuery, entry.command.toLowerCase());
    if (matchScore > 0 && entry.command !== query) {
      retainHistoryMatch(best, entry, matchScore * scoreEntryAt(entry, now), limit);
    }
  }

  return best.map(({ entry }) => entry);
}

/**
 * Query the most recently used history entries for the same command name.
 * Useful when the user is currently completing a path argument and wants
 * a few recent command-line examples (e.g. recent `cd ...` commands).
 */
export function queryRecentHistoryByCommand(
  options: RecentHistoryQueryOptions,
): HistoryEntry[] {
  const {
    commandName,
    excludeCommand,
    argumentPrefix,
    hostId,
    limit = 3,
  } = options;
  if (!commandName || limit <= 0) return [];

  const store = loadStore();
  const trimmedCommandName = commandName.trim().toLowerCase();
  const commandPrefix = `${trimmedCommandName} `;
  const normalizedArgumentPrefix = normalizeArgumentToken(argumentPrefix ?? "");

  const best: RankedHistoryEntry[] = [];
  for (const entry of store.entries) {
    if (hostId && entry.hostId !== hostId) continue;
    const lowerCommand = entry.command.toLowerCase();
    if (lowerCommand !== trimmedCommandName && !lowerCommand.startsWith(commandPrefix)) {
      continue;
    }
    if (excludeCommand && entry.command === excludeCommand) continue;

    if (normalizedArgumentPrefix) {
      const currentToken = normalizeArgumentToken(getCurrentCommandToken(entry.command));
      if (!currentToken.startsWith(normalizedArgumentPrefix)) {
        continue;
      }
    }

    retainHistoryMatch(best, entry, entry.lastUsedAt, limit);
  }

  return best.map(({ entry }) => entry);
}

function getCurrentCommandToken(command: string): string {
  const tokens = tokenizeShellLike(command);
  return tokens.length > 0 ? (tokens[tokens.length - 1] || "") : "";
}

function normalizeArgumentToken(token: string): string {
  return token
    .trim()
    .replace(/^['"]/, "")
    .replace(/['"]$/, "")
    .replace(/\\ /g, " ")
    .toLowerCase();
}

function tokenizeShellLike(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      current += ch;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }

    if (ch === " " && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  tokens.push(current);
  return tokens;
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
  let searchFrom = 0;
  let prevMatchIdx = -2;

  for (let queryIdx = 0; queryIdx < query.length; queryIdx++) {
    // Skip unmatched runs in native string search, especially for long commands.
    const i = target.indexOf(query[queryIdx], searchFrom);
    if (i < 0) return 0;
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
    searchFrom = i + 1;
  }

  return score;
}

/**
 * Clear all history for a specific host, or all history if no hostId given.
 * A global clear also bumps the shared clear generation so other renderers and
 * in-flight histfile imports can detect it.
 */
export function clearHistory(hostId?: string): void {
  const store = loadStore();
  if (hostId) {
    store.entries = store.entries.filter((e) => e.hostId !== hostId);
  } else {
    store.entries = [];
    store.clearGeneration = readClearGeneration(store) + 1;
  }
  // Destructive clears must be durable: cancel any pending debounced write and
  // persist synchronously so a later stale flush cannot restore the entries.
  cancelPendingSave();
  persistStoreNow(store);
  knownClearGeneration = readClearGeneration(store);
  if (!hostId) notifyCommandHistoryCleared();
}
