import assert from 'node:assert/strict';
import test from 'node:test';

import type { AISession } from '../../infrastructure/ai/types';
import {
  DebouncedBackupMirror,
  isMissingOrCorruptSessionsStore,
  mergeImportedSessions,
  parseBackupSessions,
  readLiveSessionsArray,
  shouldRestoreFromBackup,
} from './aiSessionsBackup';
import { prepareRestoredSessions, pruneSessionsForStorage } from './aiStateSnapshots';

function makeSession(id: string, updatedAt = 1_000): AISession {
  return {
    id,
    title: id,
    agentId: 'catty',
    scope: { type: 'workspace', targetId: 'ws-1' },
    messages: [],
    createdAt: updatedAt,
    updatedAt,
  } as never;
}

test('isMissingOrCorruptSessionsStore distinguishes missing or corrupt stores from valid arrays', () => {
  assert.equal(isMissingOrCorruptSessionsStore(null), true);
  assert.equal(isMissingOrCorruptSessionsStore(''), true);
  assert.equal(isMissingOrCorruptSessionsStore('[]'), false);
  assert.equal(isMissingOrCorruptSessionsStore('{corrupt'), true);
  assert.equal(isMissingOrCorruptSessionsStore('{}'), true);
  assert.equal(isMissingOrCorruptSessionsStore('[{"id":"s1"}]'), false);
});

test('readLiveSessionsArray normalizes missing and corrupt stores', () => {
  for (const raw of [null, undefined, '', '{}', 'not-json']) {
    assert.deepEqual(readLiveSessionsArray(raw), []);
  }
  const sessions = [makeSession('s1')];
  assert.deepEqual(readLiveSessionsArray(JSON.stringify(sessions)), sessions);
});

test('parseBackupSessions ignores corrupt payloads and drops malformed entries', () => {
  assert.equal(parseBackupSessions(null), null);
  assert.equal(parseBackupSessions(''), null);
  assert.equal(parseBackupSessions('not json'), null);
  assert.equal(parseBackupSessions('{"id":"s1"}'), null);
  assert.equal(parseBackupSessions(JSON.stringify([{ id: 's1' }])), null);
  const sessions = parseBackupSessions(JSON.stringify([
    { id: 's1' },
    { nope: true },
    { id: 'missing-scope', title: 'Missing scope', agentId: 'catty', messages: [], updatedAt: 1000 },
    { ...makeSession('null-scope'), scope: null },
    { ...makeSession('missing-title'), title: undefined },
    { ...makeSession('missing-agent'), agentId: undefined },
    { ...makeSession('null-message'), messages: [null] },
    { ...makeSession('incomplete-message'), messages: [{ id: 'm' }] },
    { ...makeSession('missing-content'), messages: [{ id: 'm', role: 'user', timestamp: 1000 }] },
    { ...makeSession('invalid-content'), messages: [{ id: 'm', role: 'user', timestamp: 1000, content: null }] },
    { ...makeSession('invalid-timestamp'), messages: [{ id: 'm', role: 'user', timestamp: null, content: 'hello' }] },
    null,
    { ...makeSession('s2'), messages: [{ id: 'm', role: 'user', timestamp: 1000, content: 'hello' }] },
  ]));
  assert.deepEqual(sessions?.map((session) => session.id), ['s2']);
});

test('restore preserves all sessions when cloud sync is enabled', () => {
  // Issue #4123: the retention cap is a session count (raised to 1000) —
  // there is no byte budget any more.
  const sessions = Array.from({ length: 1001 }, (_, index) => makeSession(`s${index}`, index));
  assert.deepEqual(prepareRestoredSessions(sessions, true), sessions);
  const local = prepareRestoredSessions(sessions, false);
  assert.equal(local.length, 1000);
  assert.equal(local.some(session => session.id === 's0'), false);
});

test('malformed imports cannot reach pruning or inject broken sessions', () => {
  const current = [makeSession('live')];
  const malformed = parseBackupSessions(JSON.stringify([{ id: 's1' }]));
  assert.deepEqual(mergeImportedSessions(current, pruneSessionsForStorage(malformed ?? [])), current);
  const valid = parseBackupSessions(JSON.stringify([{ id: 's1' }, makeSession('valid')]));
  const merged = mergeImportedSessions(current, pruneSessionsForStorage(valid ?? []));
  assert.deepEqual(new Set(merged.map((session) => session.id)), new Set(['live', 'valid']));
});

test('restore happens only on a missing or corrupt live store with a non-empty backup', () => {
  const backup = JSON.stringify([makeSession('s1')]);
  // Empty (or wiped) store -> restore.
  assert.equal(shouldRestoreFromBackup(null, backup), true);
  assert.equal(shouldRestoreFromBackup('', backup), true);
  assert.equal(shouldRestoreFromBackup('[]', backup), false);
  assert.equal(shouldRestoreFromBackup('{corrupt', backup), true);
  // Non-empty live store -> never restore (explicit deletions must win).
  assert.equal(shouldRestoreFromBackup('[{"id":"live"}]', backup), false);
  // Empty/corrupt backup -> nothing to restore.
  assert.equal(shouldRestoreFromBackup(null, null), false);
  assert.equal(shouldRestoreFromBackup(null, '[]'), false);
  assert.equal(shouldRestoreFromBackup(null, '{corrupt'), false);
});

test('mergeImportedSessions keys by id with the newer updatedAt winning', () => {
  const current = [makeSession('keep', 100), makeSession('older', 100)];
  const imported = [makeSession('newer', 200), makeSession('older', 50), makeSession('added', 1)];
  const merged = mergeImportedSessions(current, imported);
  const byId = new Map(merged.map((session) => [session.id, session]));
  assert.equal(byId.get('older')?.updatedAt, 100);
  assert.equal(byId.get('newer')?.updatedAt, 200);
  assert.equal(byId.has('added'), true);
  assert.equal(byId.has('keep'), true);
  // Sorted newest-first for stable history ordering.
  assert.deepEqual(
    merged.map((session) => session.updatedAt),
    [...merged.map((session) => session.updatedAt)].sort((a, b) => b - a),
  );
});

test('DebouncedBackupMirror writes once per batch with the last payload', async () => {
  const writes: string[] = [];
  const mirror = new DebouncedBackupMirror((json) => writes.push(json), 15);
  mirror.schedule('{"gen":1}');
  mirror.schedule('{"gen":2}');
  await new Promise((resolve) => setTimeout(resolve, 30));
  mirror.schedule('{"gen":3}');
  mirror.schedule('{"gen":4}');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(writes, ['{"gen":2}', '{"gen":4}']);
});

test('DebouncedBackupMirror flushNow writes the pending payload immediately', () => {
  const writes: string[] = [];
  const mirror = new DebouncedBackupMirror((json) => writes.push(json), 60_000);
  mirror.schedule('{"gen":1}');
  mirror.flushNow();
  assert.deepEqual(writes, ['{"gen":1}']);
  // A second flush with nothing pending is a no-op.
  mirror.flushNow();
  assert.deepEqual(writes, ['{"gen":1}']);
});

test('readLiveSessionsArray treats non-array JSON as empty (corrupt)', () => {
  assert.deepEqual(readLiveSessionsArray(null), []);
  assert.deepEqual(readLiveSessionsArray(''), []);
  assert.deepEqual(readLiveSessionsArray('{}'), []);
  assert.deepEqual(readLiveSessionsArray('{"sessions":[]}'), []);
  assert.deepEqual(readLiveSessionsArray('not-json'), []);
  assert.deepEqual(readLiveSessionsArray('[]'), []);
  assert.equal(readLiveSessionsArray('[{"id":"a"}]').length, 1);
});
