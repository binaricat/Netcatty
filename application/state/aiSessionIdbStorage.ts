import type { AISession } from '../../infrastructure/ai/types';

/**
 * IndexedDB persistence for AI chat sessions (issue #4123).
 *
 * The legacy store kept every session as one JSON blob in localStorage under
 * a 2 MB byte budget. Each write re-serialized the whole store, and when the
 * budget was exceeded the degradation ladder dropped whole oldest sessions —
 * silently destroying capped chats (~1 MB each) on every write.
 *
 * IndexedDB removes both halves of that failure mode: records are written
 * per session (no global re-serialization), and there is no shared byte
 * quota to defend, so byte-driven eviction disappears entirely.
 *
 * Layout:
 * - db `netcatty_ai_sessions`
 *   - object store `sessions` (keyPath `id`): one record per AISession
 *   - object store `meta` (keyPath `key`): schemaVersion, lastWriteAt and the
 *     migrated `netcatty_ai_active_session_map_v1` active-pointer map
 *
 * The legacy localStorage key `netcatty_ai_sessions_v1` is kept UNTOUCHED for
 * one release as a read-only fallback; it is no longer written or pruned.
 */

export const AI_SESSIONS_IDB_NAME = 'netcatty_ai_sessions';
export const AI_SESSIONS_IDB_VERSION = 1;
export const AI_SESSIONS_IDB_SESSION_STORE = 'sessions';
export const AI_SESSIONS_IDB_META_STORE = 'meta';
export const AI_SESSIONS_META_SCHEMA_VERSION_KEY = 'schemaVersion';
export const AI_SESSIONS_META_LAST_WRITE_KEY = 'lastWriteAt';
export const AI_SESSIONS_META_ACTIVE_MAP_KEY = 'activeSessionMap';
export const AI_SESSIONS_META_MIGRATION_KEY = 'migrationCompleted';

/** Cross-window change notification (replaces the localStorage `storage` event for sessions). */
const AI_SESSIONS_IDB_CHANGE_CHANNEL = 'netcatty_ai_sessions_changed';

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

let openPromise: Promise<IDBDatabase> | null = null;

function upgradeDatabase(db: IDBDatabase) {
  if (!db.objectStoreNames.contains(AI_SESSIONS_IDB_SESSION_STORE)) {
    db.createObjectStore(AI_SESSIONS_IDB_SESSION_STORE, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(AI_SESSIONS_IDB_META_STORE)) {
    db.createObjectStore(AI_SESSIONS_IDB_META_STORE, { keyPath: 'key' });
  }
}

export function openAiSessionsIdb(): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(new Error('IndexedDB is not available'));
  }
  if (!openPromise) {
    openPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(AI_SESSIONS_IDB_NAME, AI_SESSIONS_IDB_VERSION);
      request.onupgradeneeded = () => upgradeDatabase(request.result);
      request.onsuccess = () => {
        const db = request.result;
        // Drop the cached handle so a later open() re-establishes it instead
        // of handing out a closed connection.
        db.onclose = () => { openPromise = null; };
        db.onversionchange = () => {
          db.close();
          openPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        openPromise = null;
        reject(request.error ?? new Error('Failed to open IndexedDB'));
      };
      request.onblocked = () => {
        openPromise = null;
      };
    });
  }
  return openPromise;
}

export function resetAiSessionsIdbForTests() {
  openPromise = null;
}

export async function idbGetAllSessions(db?: IDBDatabase): Promise<AISession[]> {
  const database = db ?? await openAiSessionsIdb();
  const transaction = database.transaction(AI_SESSIONS_IDB_SESSION_STORE, 'readonly');
  const result = await requestToPromise(
    transaction.objectStore(AI_SESSIONS_IDB_SESSION_STORE).getAll() as IDBRequest<AISession[]>,
  );
  return Array.isArray(result) ? result : [];
}

export async function idbPutSessions(db: IDBDatabase, sessions: AISession[]): Promise<void> {
  if (sessions.length === 0) return;
  const transaction = db.transaction(AI_SESSIONS_IDB_SESSION_STORE, 'readwrite');
  const store = transaction.objectStore(AI_SESSIONS_IDB_SESSION_STORE);
  for (const session of sessions) store.put(session);
  await transactionDone(transaction);
}

export async function idbPutSession(db: IDBDatabase, session: AISession): Promise<void> {
  await idbPutSessions(db, [session]);
}

export async function idbDeleteSessionIds(db: IDBDatabase, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const transaction = db.transaction(AI_SESSIONS_IDB_SESSION_STORE, 'readwrite');
  const store = transaction.objectStore(AI_SESSIONS_IDB_SESSION_STORE);
  for (const id of ids) store.delete(id);
  await transactionDone(transaction);
}

export async function idbClearSessions(db: IDBDatabase): Promise<void> {
  const transaction = db.transaction(AI_SESSIONS_IDB_SESSION_STORE, 'readwrite');
  transaction.objectStore(AI_SESSIONS_IDB_SESSION_STORE).clear();
  await transactionDone(transaction);
}

export async function idbGetMeta<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  const transaction = db.transaction(AI_SESSIONS_IDB_META_STORE, 'readonly');
  const record = await requestToPromise(
    transaction.objectStore(AI_SESSIONS_IDB_META_STORE).get(key) as IDBRequest<{ key: string; value: T } | undefined>,
  );
  return record?.value;
}

export async function idbPutMeta<T>(db: IDBDatabase, key: string, value: T): Promise<void> {
  const transaction = db.transaction(AI_SESSIONS_IDB_META_STORE, 'readwrite');
  transaction.objectStore(AI_SESSIONS_IDB_META_STORE).put({ key, value });
  await transactionDone(transaction);
}

// ── Cross-window change notification ──

let changeChannel: BroadcastChannel | null = null;

function getChangeChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    if (!changeChannel) {
      changeChannel = new BroadcastChannel(AI_SESSIONS_IDB_CHANGE_CHANNEL);
      // The channel must never keep the process alive (Node exposes unref).
      (changeChannel as unknown as { unref?: () => void }).unref?.();
    }
    return changeChannel;
  } catch {
    return null;
  }
}

/** Announce a session-store change to OTHER windows (never the sender). */
export function publishAiSessionsIdbChange(): void {
  try {
    getChangeChannel()?.postMessage(Date.now());
  } catch {
    // Notification is best-effort; the write itself already succeeded.
  }
}

export function subscribeAiSessionsIdbChange(listener: () => void): () => void {
  const channel = getChangeChannel();
  if (!channel) return () => {};
  const handler = () => listener();
  channel.addEventListener('message', handler);
  return () => channel.removeEventListener('message', handler);
}

// ── Boot load + one-release legacy migration ──

export interface AiSessionsBootLoadResult {
  sessions: AISession[];
  /** Where the returned sessions came from. */
  source: 'indexeddb' | 'legacy-localstorage' | 'none';
  /** True when IndexedDB itself could not be opened (corrupt/blocked). */
  idbFailed: boolean;
  /** The store was already initialized before this boot; empty means deleted. */
  authoritativeEmpty: boolean;
  /** Marked disk-only records are still missing; keep their backup generations. */
  migrationPending: boolean;
}

/**
 * Boot-time store resolution, shared with tests:
 * 1. IndexedDB `getAll()` — the primary store.
 * 2. If empty, migrate the legacy localStorage store into IndexedDB (the
 *    legacy key itself stays untouched as a read-only fallback for one
 *    release).
 * 3. If IndexedDB is corrupt/unavailable, fall back to legacy localStorage.
 *
 * The migration is one-shot (issue #4125 review P1②): a `migrationCompleted`
 * marker is persisted in the meta store after the first successful boot
 * resolution. Once present, the legacy key is never consulted again —
 * otherwise a boot whose migration ran while the legacy key could not be
 * removed would re-migrate the stale legacy list and resurrect deleted
 * chats. The marker also distinguishes "intentionally empty" (the user
 * deleted every chat) from "uninitialized".
 *
 * Callers decide what to do when both sources are empty (the #4018 backup
 * generations remain the last restore step in useAIState).
 * The legacy reader may await disk-only recovery before migration completes.
 * Missing disk-only IDs keep migration resumable, including in a populated IDB.
 */
export async function loadOrMigrateAiSessions(
  readLegacyRaw: () => string | null | undefined | Promise<string | null | undefined>,
  diskOnlySessionIds: readonly string[] = [],
): Promise<AiSessionsBootLoadResult> {
  const hasUnresolvedDiskSessions = (sessions: AISession[]) => {
    const ids = new Set(sessions.map(session => session.id));
    return diskOnlySessionIds.some(id => !ids.has(id));
  };
  const legacyFallback = async (idbFailed: boolean): Promise<AiSessionsBootLoadResult> => {
    const legacy = parseLegacySessions(await readLegacyRaw());
    return {
      sessions: legacy,
      source: legacy.length > 0 ? 'legacy-localstorage' : 'none',
      idbFailed,
      authoritativeEmpty: false,
      migrationPending: hasUnresolvedDiskSessions(legacy),
    };
  };
  if (!isIndexedDbAvailable()) {
    return legacyFallback(false);
  }
  let db: IDBDatabase;
  try {
    db = await openAiSessionsIdb();
  } catch (error) {
    console.warn('[AIState] IndexedDB unavailable, falling back to the legacy localStorage store:', error);
    return legacyFallback(true);
  }
  let sessions: AISession[];
  try {
    sessions = await idbGetAllSessions(db);
  } catch (error) {
    console.warn('[AIState] IndexedDB read failed, falling back to the legacy localStorage store:', error);
    return legacyFallback(true);
  }
  let marker: AiSessionsMigrationMarker | undefined;
  try {
    marker = await idbGetMeta<AiSessionsMigrationMarker>(db, AI_SESSIONS_META_MIGRATION_KEY);
  } catch {
    marker = undefined;
  }
  if (marker || (sessions.length > 0 && !hasUnresolvedDiskSessions(sessions))) {
    if (!marker) {
      // First boot on a store that already holds sessions (e.g. migrated by
      // a build without the marker): record one-shot completion so the
      // legacy key can never re-seed the store.
      await writeMigrationMarker(db).catch(() => {});
    }
    return {
      sessions,
      source: sessions.length > 0 ? 'indexeddb' : 'none',
      idbFailed: false,
      authoritativeEmpty: sessions.length === 0,
      migrationPending: false,
    };
  }
  // Unfinished migration (empty or partially populated IDB). The legacy key is
  // intentionally NOT removed: it stays as a read-only fallback for one
  // release.
  const legacy = parseLegacySessions(await readLegacyRaw());
  // A partial migration may already have primary/chunk records in IDB. Only
  // fill missing marked IDs; never replay stale primary data over live IDB.
  const existingIds = new Set(sessions.map(session => session.id));
  const diskOnlyIds = new Set(diskOnlySessionIds);
  const recovered = sessions.length === 0
    ? legacy
    : legacy.filter(session => diskOnlyIds.has(session.id) && !existingIds.has(session.id));
  const merged = [...sessions, ...recovered].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const migrationPending = hasUnresolvedDiskSessions(merged);
  const result: AiSessionsBootLoadResult = {
    sessions: merged,
    source: sessions.length > 0 ? 'indexeddb' : merged.length > 0 ? 'legacy-localstorage' : 'none',
    idbFailed: false,
    authoritativeEmpty: false,
    migrationPending,
  };
  if (merged.length === 0) {
    // Nothing to migrate: mark the store initialized so this state is
    // distinguishable from "uninitialized" on the next boot.
    if (!migrationPending) await writeMigrationMarker(db).catch(() => {});
    return result;
  }
  try {
    await idbPutSessions(db, recovered);
    await idbPutMeta(db, AI_SESSIONS_META_SCHEMA_VERSION_KEY, AI_SESSIONS_IDB_VERSION);
    await idbPutMeta(db, AI_SESSIONS_META_LAST_WRITE_KEY, Date.now());
    // Written AFTER the migration data is durable: a crash before this point
    // leaves the marker absent and the next boot safely re-migrates.
    if (!migrationPending) await writeMigrationMarker(db);
  } catch (error) {
    console.warn('[AIState] IndexedDB migration write failed; keeping legacy store authoritative:', error);
    return { ...result, idbFailed: true };
  }
  console.info(`[AIState] Migrated ${recovered.length} AI session(s) from localStorage to IndexedDB.`);
  return result;
}

interface AiSessionsMigrationMarker {
  migrationCompleted: true;
  migrationAt: number;
}

async function writeMigrationMarker(db: IDBDatabase): Promise<void> {
  await idbPutMeta<AiSessionsMigrationMarker>(
    db,
    AI_SESSIONS_META_MIGRATION_KEY,
    { migrationCompleted: true, migrationAt: Date.now() },
  );
}

function parseLegacySessions(raw: string | null | undefined): AISession[] {
  if (raw == null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as AISession[] : [];
  } catch {
    return [];
  }
}

// ── Active-session map mirror (meta store) ──

/**
 * Mirror the active-pointer map into the IndexedDB meta store. The
 * localStorage key remains written as before (small, quota-safe) and stays
 * the read-mostly authority for this release; the mirror makes the pointer
 * available to future store work without another migration.
 */
export async function mirrorActiveSessionMapToIdb(
  map: Record<string, string | null>,
): Promise<void> {
  try {
    const db = await openAiSessionsIdb();
    await idbPutMeta(db, AI_SESSIONS_META_ACTIVE_MAP_KEY, map);
  } catch (error) {
    console.warn('[AIState] Failed to mirror the active-session map to IndexedDB:', error);
  }
}

/**
 * Read the mirrored active-pointer map (boot restore aid when the
 * localStorage key is missing).
 */
export async function readActiveSessionMapFromIdb(): Promise<Record<string, string | null> | null> {
  try {
    const db = await openAiSessionsIdb();
    const value = await idbGetMeta<Record<string, string | null>>(db, AI_SESSIONS_META_ACTIVE_MAP_KEY);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}
