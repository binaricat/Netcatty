import assert from 'node:assert/strict';
import test from 'node:test';
import type { AISession } from '../../infrastructure/ai/types';
import { installFakeIndexedDb } from './testSupport/fakeIndexedDb';
import {
  AI_SESSIONS_META_LAST_WRITE_KEY,
  AI_SESSIONS_META_MIGRATION_KEY,
  AI_SESSIONS_META_SCHEMA_VERSION_KEY,
  idbClearSessions,
  idbDeleteSessionIds,
  idbGetAllSessions,
  idbGetMeta,
  idbPutMeta,
  idbPutSession,
  idbPutSessions,
  isIndexedDbAvailable,
  loadOrMigrateAiSessions,
  mirrorActiveSessionMapToIdb,
  openAiSessionsIdb,
  readActiveSessionMapFromIdb,
  resetAiSessionsIdbForTests,
} from './aiSessionIdbStorage';

function makeSession(id: string, updatedAt: number): AISession {
  return {
    id,
    title: id,
    agentId: 'agent',
    scope: { type: 'terminal', targetId: 't' },
    messages: [],
    createdAt: updatedAt,
    updatedAt,
  } as AISession;
}

test('module wrapper roundtrips sessions through the object stores', async () => {
  const idb = installFakeIndexedDb();
  try {
    assert.equal(isIndexedDbAvailable(), true);
    const db = await openAiSessionsIdb();
    assert.equal(db.objectStoreNames.contains('sessions'), true);
    assert.equal(db.objectStoreNames.contains('meta'), true);

    await idbPutSessions(db, [makeSession('chat-a', 2), makeSession('chat-b', 1)]);
    await idbPutSession(db, { ...makeSession('chat-a', 3), title: 'updated' });
    const all = await idbGetAllSessions(db);
    assert.deepEqual(all.map((s) => s.id).sort(), ['chat-a', 'chat-b']);
    assert.equal(all.find((s) => s.id === 'chat-a')?.title, 'updated');

    await idbDeleteSessionIds(db, ['chat-a']);
    assert.deepEqual((await idbGetAllSessions(db)).map((s) => s.id), ['chat-b']);
    await idbClearSessions(db);
    assert.deepEqual(await idbGetAllSessions(db), []);
  } finally {
    idb.restore();
    resetAiSessionsIdbForTests();
  }
});

test('meta store roundtrips schema and active-map records', async () => {
  const idb = installFakeIndexedDb();
  try {
    const db = await openAiSessionsIdb();
    await idbPutMeta(db, AI_SESSIONS_META_SCHEMA_VERSION_KEY, 1);
    await idbPutMeta(db, AI_SESSIONS_META_LAST_WRITE_KEY, 1234);
    assert.equal(await idbGetMeta<number>(db, AI_SESSIONS_META_SCHEMA_VERSION_KEY), 1);
    assert.equal(await idbGetMeta<number>(db, AI_SESSIONS_META_LAST_WRITE_KEY), 1234);
    assert.equal(await idbGetMeta<number>(db, 'missing'), undefined);

    await mirrorActiveSessionMapToIdb({ 'terminal:t': 'chat-a' });
    // Mirror uses its own connection.
    assert.deepEqual(await readActiveSessionMapFromIdb(), { 'terminal:t': 'chat-a' });
  } finally {
    idb.restore();
    resetAiSessionsIdbForTests();
  }
});

test('loadOrMigrateAiSessions reads IndexedDB first and returns its sessions', async () => {
  const idb = installFakeIndexedDb();
  try {
    const db = await openAiSessionsIdb();
    await idbPutSessions(db, [makeSession('idb-chat', 1)]);
    const result = await loadOrMigrateAiSessions(() => JSON.stringify([makeSession('legacy-chat', 2)]));
    assert.equal(result.source, 'indexeddb');
    assert.equal(result.idbFailed, false);
    assert.deepEqual(result.sessions.map((s) => s.id), ['idb-chat']);
    // Legacy key content was not consumed for a migration when IDB has data.
    assert.equal(idb.db.dumpStore('sessions').length, 1);
  } finally {
    idb.restore();
    resetAiSessionsIdbForTests();
  }
});

test('loadOrMigrateAiSessions migrates a populated legacy store into empty IndexedDB, keeping the key untouched', async () => {
  const idb = installFakeIndexedDb();
  try {
    const legacyRaw = JSON.stringify([makeSession('legacy-1', 2), makeSession('legacy-2', 1)]);
    let readCount = 0;
    const result = await loadOrMigrateAiSessions(() => {
      readCount += 1;
      return legacyRaw;
    });
    assert.equal(result.source, 'legacy-localstorage');
    assert.equal(result.idbFailed, false);
    assert.deepEqual(result.sessions.map((s) => s.id).sort(), ['legacy-1', 'legacy-2']);
    // Now in IndexedDB (one record per session).
    assert.deepEqual(
      idb.db.dumpStore('sessions').map((s) => (s as AISession).id).sort(),
      ['legacy-1', 'legacy-2'],
    );
    // Meta records written for the migration.
    const db = await openAiSessionsIdb();
    assert.equal(await idbGetMeta<number>(db, AI_SESSIONS_META_SCHEMA_VERSION_KEY), 1);
    assert.ok(await idbGetMeta<number>(db, AI_SESSIONS_META_LAST_WRITE_KEY));
    assert.ok(readCount >= 1);
    // The legacy raw string itself is only read, never rewritten or removed
    // — the callback is the only interface to the legacy store.
    assert.equal(readCount >= 1, true);
  } finally {
    idb.restore();
    resetAiSessionsIdbForTests();
  }
});

test('loadOrMigrateAiSessions returns none for an empty store without legacy data', async () => {
  const idb = installFakeIndexedDb();
  try {
    const result = await loadOrMigrateAiSessions(() => null);
    assert.equal(result.source, 'none');
    assert.deepEqual(result.sessions, []);
    assert.equal(result.idbFailed, false);
    assert.equal(result.authoritativeEmpty, false, 'a newly created store still permits disk recovery');
    assert.equal(result.migrationPending, false);
  } finally {
    idb.restore();
    resetAiSessionsIdbForTests();
  }
});

test('loadOrMigrateAiSessions treats a legacy empty array as an intentional wipe (no migration, no restore source)', async () => {
  const idb = installFakeIndexedDb();
  try {
    const result = await loadOrMigrateAiSessions(() => '[]');
    assert.equal(result.source, 'none');
    assert.deepEqual(result.sessions, []);
    assert.equal(idb.db.dumpStore('sessions').length, 0);
  } finally {
    idb.restore();
    resetAiSessionsIdbForTests();
  }
});

test('loadOrMigrateAiSessions falls back to legacy localStorage when IndexedDB is corrupt', async () => {
  const idb = installFakeIndexedDb({ failOpen: true });
  try {
    const legacy = [makeSession('legacy-chat', 1)];
    const result = await loadOrMigrateAiSessions(() => JSON.stringify(legacy));
    assert.equal(result.source, 'legacy-localstorage');
    assert.equal(result.idbFailed, true);
    assert.deepEqual(result.sessions, legacy);
  } finally {
    idb.restore();
    resetAiSessionsIdbForTests();
  }
});

test('loadOrMigrateAiSessions falls back to legacy localStorage when IndexedDB is unavailable', async () => {
  const previous = (globalThis as { indexedDB?: unknown }).indexedDB;
  (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
  try {
    const legacy = [makeSession('legacy-chat', 1)];
    const result = await loadOrMigrateAiSessions(() => JSON.stringify(legacy));
    assert.equal(isIndexedDbAvailable(), false);
    assert.equal(result.source, 'legacy-localstorage');
    assert.equal(result.idbFailed, false);
    assert.deepEqual(result.sessions, legacy);
  } finally {
    (globalThis as { indexedDB?: unknown }).indexedDB = previous;
    resetAiSessionsIdbForTests();
  }
});

// ── Issue #4125 review P1②: the migration is one-shot via a persisted marker ──

test('a completed migration is one-shot: a chat deleted afterwards stays deleted on the next boot', async () => {
  const idb = installFakeIndexedDb();
  try {
    const legacyRaw = JSON.stringify([makeSession('legacy-1', 2), makeSession('legacy-2', 1)]);
    const first = await loadOrMigrateAiSessions(() => legacyRaw);
    assert.equal(first.source, 'legacy-localstorage');
    // The marker was persisted after the migration data became durable.
    let db = await openAiSessionsIdb();
    assert.ok(await idbGetMeta(db, AI_SESSIONS_META_MIGRATION_KEY));
    // The user deletes a chat; the legacy key stays behind by design.
    await idbDeleteSessionIds(db, ['legacy-1']);
    // Next boot: the marker is present, so the legacy key is never
    // re-migrated and the deletion is not resurrected.
    const second = await loadOrMigrateAiSessions(() => legacyRaw);
    assert.equal(second.source, 'indexeddb');
    assert.deepEqual(second.sessions.map((s) => s.id), ['legacy-2']);
    assert.equal((await openAiSessionsIdb()).objectStoreNames.contains('sessions'), true);
    db = await openAiSessionsIdb();
    assert.deepEqual((await idbGetAllSessions(db)).map((s) => s.id), ['legacy-2']);
  } finally {
    idb.restore();
    resetAiSessionsIdbForTests();
  }
});

test('an empty IndexedDB store with the migration marker ignores a populated legacy key', async () => {
  const idb = installFakeIndexedDb();
  try {
    // First boot with nothing anywhere records the marker.
    const first = await loadOrMigrateAiSessions(() => null);
    assert.equal(first.source, 'none');
    assert.ok(await idbGetMeta(await openAiSessionsIdb(), AI_SESSIONS_META_MIGRATION_KEY));
    // The user deleted every chat, but the stale legacy key is still there.
    const second = await loadOrMigrateAiSessions(
      () => JSON.stringify([makeSession('resurrected', 1)]),
    );
    assert.equal(second.source, 'none');
    assert.equal(second.authoritativeEmpty, true);
    assert.deepEqual(second.sessions, []);
    assert.equal(idb.db.dumpStore('sessions').length, 0);
  } finally {
    idb.restore();
    resetAiSessionsIdbForTests();
  }
});

test('partial disk migration retries missing IDs beside existing IDB records until all are durable', async () => {
  const idb = installFakeIndexedDb();
  try {
    const primary = makeSession('primary', 3);
    const diskA = makeSession('disk-a', 2);
    const diskB = makeSession('disk-b', 1);
    const diskIds = [diskA.id, diskB.id];
    const db = await openAiSessionsIdb();
    const first = await loadOrMigrateAiSessions(() => JSON.stringify([primary]), diskIds);
    assert.equal(first.migrationPending, true);
    assert.deepEqual(await idbGetAllSessions(db), [primary]);
    assert.equal(await idbGetMeta(db, AI_SESSIONS_META_MIGRATION_KEY), undefined);

    const updated = { ...primary, title: 'edited in IndexedDB', updatedAt: 4 };
    await idbPutSession(db, updated);
    const partial = await loadOrMigrateAiSessions(() => JSON.stringify([primary, diskA]), diskIds);
    assert.equal(partial.migrationPending, true, 'one recovered disk ID does not complete migration');
    assert.deepEqual(partial.sessions, [updated, diskA]);
    assert.equal(await idbGetMeta(db, AI_SESSIONS_META_MIGRATION_KEY), undefined);

    const complete = await loadOrMigrateAiSessions(() => JSON.stringify([primary, diskA, diskB]), diskIds);
    assert.equal(complete.source, 'indexeddb');
    assert.equal(complete.migrationPending, false);
    assert.deepEqual(complete.sessions, [updated, diskA, diskB]);
    assert.deepEqual(await idbGetAllSessions(db), [updated, diskA, diskB]);
    assert.ok(await idbGetMeta(db, AI_SESSIONS_META_MIGRATION_KEY));

    await idbClearSessions(db);
    const deleted = await loadOrMigrateAiSessions(() => {
      assert.fail('completed migration must not retry the stale overflow markers');
    }, diskIds);
    assert.equal(deleted.authoritativeEmpty, true);
    assert.deepEqual(deleted.sessions, []);
  } finally {
    idb.restore();
    resetAiSessionsIdbForTests();
  }
});

test('a pre-marker store that already holds sessions records the marker on boot', async () => {
  const idb = installFakeIndexedDb();
  try {
    const db = await openAiSessionsIdb();
    await idbPutSessions(db, [makeSession('already-here', 1)]);
    const result = await loadOrMigrateAiSessions(() => JSON.stringify([makeSession('legacy', 2)]));
    assert.equal(result.source, 'indexeddb');
    assert.ok(await idbGetMeta(db, AI_SESSIONS_META_MIGRATION_KEY));
    assert.equal(idb.db.dumpStore('sessions').length, 1);
  } finally {
    idb.restore();
    resetAiSessionsIdbForTests();
  }
});
