import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createAiPrivacyService } from '../../electron/shared/aiPrivacyService.cjs';
import {
  hasReversibleModelPrivacy,
  setReversibleModelPrivacy,
} from '../../infrastructure/ai/harness/modelSecretRedaction';
import {
  STORAGE_KEY_AI_SESSIONS,
  STORAGE_KEY_AI_SESSIONS_OVERFLOW,
  STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW,
  STORAGE_KEY_CLOUD_SYNC_AI_SESSIONS,
} from '../../infrastructure/config/storageKeys';
import type { AISession } from '../../infrastructure/ai/types';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import {
  cleanupClosedTerminalSessions,
  cleanupDeletedAIChatSessions,
  cleanupOrphanedAISessions,
  cleanupSdkAgentSessions,
  latestAIActiveSessionMapSnapshot,
  latestAISessionsSnapshot,
  setLatestAIActiveSessionMapSnapshot,
  setLatestAISessionsSnapshot,
  rebindActiveSessionMap,
  readSessionsFromStorage,
  prewarmAIStateStorageSnapshots,
  writeSessionsForStorage,
  flushBackupMirror,
  __resetBackupMirrorForTests,
} from './aiStateSnapshots';

test('orphan cleanup keeps durable Catty output while explicit deletion removes it', async () => {
  const sdkCleanups: string[] = [];
  const outputCleanups: string[] = [];
  const terminalOutputCleanups: string[] = [];
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      netcatty: {
        aiSdkAgentCleanup: async (chatSessionId: string) => {
          sdkCleanups.push(chatSessionId);
          return { ok: true };
        },
        deleteChatToolOutputsTemp: async (chatSessionId: string) => {
          outputCleanups.push(chatSessionId);
          return { deletedCount: 1 };
        },
        deleteTerminalToolOutputsEverywhereTemp: async (terminalSessionId: string) => {
          terminalOutputCleanups.push(terminalSessionId);
          return { deletedCount: 1 };
        },
      },
    },
  });

  try {
    cleanupSdkAgentSessions(['history-kept']);
    cleanupDeletedAIChatSessions(['history-deleted']);
    cleanupClosedTerminalSessions(['terminal-closed', 'terminal-closed']);
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(sdkCleanups, ['history-kept', 'history-deleted']);
    assert.deepEqual(outputCleanups, ['history-deleted']);
    assert.deepEqual(terminalOutputCleanups, ['terminal-closed']);
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previousWindow,
    });
  }
});

function makeSession(id: string, updatedAt: number, messages: unknown[]): AISession {
  return {
    id,
    title: id,
    agentId: 'agent',
    scope: { type: 'terminal', targetId: 't' },
    messages: messages as never,
    createdAt: updatedAt,
    updatedAt,
  } as never;
}

function installSessionStorage(t: TestContext, aggregateQuota = Number.POSITIVE_INFINITY) {
  const storage = new Map<string, string>();
  const previousStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        const storedBytes = [...storage].reduce((total, [storedKey, storedValue]) => (
          total + (storedKey === key ? 0 : Buffer.byteLength(storedKey + storedValue))
        ), 0);
        if (storedBytes + Buffer.byteLength(key + value) > aggregateQuota) {
          throw new DOMException('aggregate quota exceeded', 'QuotaExceededError');
        }
        storage.set(key, value);
      },
      removeItem: (key: string) => { storage.delete(key); },
    },
  });
  __resetBackupMirrorForTests();
  t.after(() => {
    __resetBackupMirrorForTests();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage });
  });
  storage.set(STORAGE_KEY_CLOUD_SYNC_AI_SESSIONS, JSON.stringify({ enabled: false }));
  return storage;
}

function makeLargeSessions(count = 4) {
  return Array.from({ length: count }, (_, index) => makeSession(
    `large-${index}`, count - index,
    Array.from({ length: 200 }, (_, messageIndex) => ({
      id: `message-${messageIndex}`,
      role: messageIndex % 2 ? 'assistant' : 'user',
      content: 'x'.repeat(5 * 1024 + 128),
      timestamp: messageIndex,
    })),
  ));
}

test('local-only writes retain four full large chats across overflow chunks and prewarming', (t) => {
  const storage = installSessionStorage(t);
  const sessions = freezeHistory(makeLargeSessions());
  assert.ok(JSON.stringify(sessions).length > 2 * 1024 * 1024);
  assert.equal(writeSessionsForStorage(sessions), true);
  const primary = JSON.parse(storage.get(STORAGE_KEY_AI_SESSIONS)!) as AISession[];
  assert.ok(primary.length < sessions.length);
  assert.ok(storage.has(`${STORAGE_KEY_AI_SESSIONS_OVERFLOW}_2`));
  for (const [key, value] of storage) {
    if (key.startsWith(STORAGE_KEY_AI_SESSIONS_OVERFLOW) || key === STORAGE_KEY_AI_SESSIONS) {
      assert.ok(value.length <= 2 * 1024 * 1024);
    }
  }
  assert.deepEqual(readSessionsFromStorage(), sessions);
  // A later write of the reloaded history must retain the overflow again.
  assert.equal(writeSessionsForStorage(readSessionsFromStorage()), true);
  assert.deepEqual(readSessionsFromStorage(), sessions);
  const previousSessions = latestAISessionsSnapshot;
  try {
    setLatestAISessionsSnapshot(null as unknown as AISession[]);
    prewarmAIStateStorageSnapshots();
    assert.deepEqual(latestAISessionsSnapshot, sessions);
  } finally {
    setLatestAISessionsSnapshot(previousSessions as AISession[]);
  }
});

test('backup includes overflow chats before the primary blob is replaced', (t) => {
  installSessionStorage(t);
  const backupWrites: string[] = [];
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { netcatty: { aiSessionsBackupWrite: async ({ json }: { json: string }) => {
      backupWrites.push(json);
      return { ok: true };
    } } },
  });
  t.after(() => Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow }));
  const sessions = makeLargeSessions();
  const setItem = globalThis.localStorage.setItem;
  t.mock.method(globalThis.localStorage, 'setItem', (key: string, value: string) => {
    if (key === STORAGE_KEY_AI_SESSIONS) {
      flushBackupMirror();
      assert.deepEqual(JSON.parse(backupWrites[0]), sessions);
    }
    setItem(key, value);
  });
  assert.equal(writeSessionsForStorage(sessions), true);
  flushBackupMirror();
  assert.equal(backupWrites.length, 1);
  const primary = JSON.parse(localStorageAdapter.readString(STORAGE_KEY_AI_SESSIONS)!) as AISession[];
  const primaryIds = new Set(primary.map(session => session.id));
  assert.ok(sessions.some(session => !primaryIds.has(session.id)));
});

test('shrinking local history removes stale overflow chunks and deleted chats', (t) => {
  const storage = installSessionStorage(t);
  const sessions = makeLargeSessions();
  assert.equal(writeSessionsForStorage(sessions), true);
  assert.equal(writeSessionsForStorage(sessions.slice(0, 2)), true);
  assert.ok(storage.has(STORAGE_KEY_AI_SESSIONS_OVERFLOW));
  assert.equal(storage.has(`${STORAGE_KEY_AI_SESSIONS_OVERFLOW}_2`), false);
  assert.deepEqual(readSessionsFromStorage(), sessions.slice(0, 2));
  assert.equal(writeSessionsForStorage([sessions[0]]), true);
  assert.equal(storage.has(STORAGE_KEY_AI_SESSIONS_OVERFLOW), false);
  assert.deepEqual(readSessionsFromStorage(), [sessions[0]]);
  assert.equal(writeSessionsForStorage([]), true);
  assert.deepEqual(readSessionsFromStorage(), []);
});

test('merged storage deduplicates primary and overflow by the newer updatedAt', (t) => {
  const storage = installSessionStorage(t);
  const primary = [makeSession('primary-newer', 3, []), makeSession('overflow-newer', 1, [])];
  const overflow = [makeSession('primary-newer', 2, []), makeSession('overflow-newer', 4, [])];
  storage.set(STORAGE_KEY_AI_SESSIONS, JSON.stringify(primary));
  storage.set(STORAGE_KEY_AI_SESSIONS_OVERFLOW, JSON.stringify(overflow));
  assert.deepEqual(readSessionsFromStorage(), [overflow[1], primary[0]]);
});

test('the 50-session count cap still applies to primary plus overflow', (t) => {
  installSessionStorage(t);
  const sessions = Array.from({ length: 51 }, (_, index) => makeSession(`session-${index}`, index, [{
    id: 'm', role: 'user', content: 'x'.repeat(50 * 1024), timestamp: 0,
  }]));
  assert.equal(writeSessionsForStorage(sessions), true);
  const loaded = readSessionsFromStorage();
  assert.equal(loaded.length, 50);
  assert.deepEqual(loaded.map(session => session.id), sessions.slice(1).reverse().map(session => session.id));
});

test('cloud sync restores overflow if its full authoritative write fails', (t) => {
  const storage = installSessionStorage(t);
  assert.equal(writeSessionsForStorage(makeLargeSessions()), true);
  const originalOverflow = storage.get(STORAGE_KEY_AI_SESSIONS_OVERFLOW);
  storage.set(STORAGE_KEY_CLOUD_SYNC_AI_SESSIONS, JSON.stringify({ enabled: true }));
  const before = new Map(storage);
  const sessions = [makeSession('synced', 5, [])];
  const writeString = localStorageAdapter.writeString;
  const write = t.mock.method(localStorageAdapter, 'writeString', (key: string, value: string) => (
    key === STORAGE_KEY_AI_SESSIONS ? false : writeString(key, value)
  ));
  assert.equal(writeSessionsForStorage(sessions), false);
  assert.equal(storage.get(STORAGE_KEY_AI_SESSIONS_OVERFLOW), originalOverflow);
  assert.deepEqual(storage, before);
  const error = new Error('unexpected primary write failure');
  write.mock.mockImplementation((key: string, value: string) => {
    if (key === STORAGE_KEY_AI_SESSIONS) throw error;
    return writeString(key, value);
  });
  assert.throws(() => writeSessionsForStorage(sessions), candidate => candidate === error);
  assert.deepEqual(storage, before);
  write.mock.restore();
  assert.equal(writeSessionsForStorage(sessions), true);
  assert.equal([...storage.keys()].some(key => key.startsWith(STORAGE_KEY_AI_SESSIONS_OVERFLOW)), false);
  assert.deepEqual(readSessionsFromStorage(), sessions);
});

test('enabling cloud sync frees overflow quota for the authoritative primary', (t) => {
  const storage = installSessionStorage(t, 5 * 1024 * 1024);
  const sessions = freezeHistory(makeLargeSessions());
  assert.equal(writeSessionsForStorage(sessions), true);
  assert.ok(storage.has(STORAGE_KEY_AI_SESSIONS_OVERFLOW));
  storage.set(STORAGE_KEY_CLOUD_SYNC_AI_SESSIONS, JSON.stringify({ enabled: true }));
  assert.equal(writeSessionsForStorage(sessions), true);
  assert.equal([...storage.keys()].some(key => key.startsWith(STORAGE_KEY_AI_SESSIONS_OVERFLOW)), false);
  assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY_AI_SESSIONS)!), sessions);
  assert.deepEqual(readSessionsFromStorage(), sessions);
});

test('aggregate quota retries shed replay bulk from overflow and retain every chat', (t) => {
  const storage = installSessionStorage(t, 5 * 1024 * 1024);
  const sessions = freezeHistory(Array.from({ length: 6 }, (_, index) => makeSession(
    `bulk-${index}`, 6 - index, [{
      id: `message-${index}`,
      role: 'assistant',
      content: 'x'.repeat(700 * 1024),
      timestamp: index,
      toolResults: [{ toolCallId: `call-${index}`, content: 'z'.repeat(300 * 1024) }],
      providerContinuation: {
        reasoningParts: [{ text: '', providerOptions: { openai: {
          reasoningEncryptedContent: 'c'.repeat(100 * 1024),
        } } }],
      },
    }],
  )));
  assert.ok(JSON.stringify(sessions).length > 5 * 1024 * 1024);
  const writes = t.mock.method(localStorageAdapter, 'writeString');
  assert.equal(writeSessionsForStorage(sessions), true);
  assert.ok(writes.mock.calls.some(call => call.result === false));
  const primary = JSON.parse(storage.get(STORAGE_KEY_AI_SESSIONS)!) as AISession[];
  assert.equal(primary[0].id, sessions[0].id);
  const overflow = JSON.parse([...storage]
    .filter(([key]) => key.startsWith(STORAGE_KEY_AI_SESSIONS_OVERFLOW))
    .map(([, value]) => value).join('')) as AISession[];
  assert.ok(overflow.length > 0);
  assert.ok(overflow.every(session => {
    const message = session.messages[0];
    return (message.toolResults?.[0].content.length ?? 0) <= 8 * 1024
      && !JSON.stringify(message.providerContinuation).includes('reasoningEncryptedContent');
  }));
  const loaded = readSessionsFromStorage();
  assert.deepEqual(loaded.map(session => session.id), sessions.map(session => session.id));
  assert.deepEqual(loaded.map(session => session.messages[0].content), sessions.map(session => session.messages[0].content));
});

test('a smaller primary reclaims quota before overflow when the final history fits', (t) => {
  const storage = installSessionStorage(t, 5 * 1024 * 1024);
  const chat = (id: string, updatedAt: number, mib: number) => makeSession(id, updatedAt, [{
    id: 'm', role: 'user', content: 'x'.repeat(Math.floor(mib * 1024 * 1024)), timestamp: 0,
  }]);
  const previous = [chat('old-primary', 2, 1.9), chat('old-overflow', 1, 1.5)];
  assert.equal(writeSessionsForStorage(previous), true);
  const next = [chat('new-primary', 3, 1.1), ...previous];
  assert.equal(writeSessionsForStorage(next), true);
  assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY_AI_SESSIONS)!), [next[0]]);
  assert.deepEqual(readSessionsFromStorage(), next);
  assert.equal(storage.has(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW), false);
});

test('overflow failure rolls back a replaced primary and the previous overflow', (t) => {
  const storage = installSessionStorage(t, 5 * 1024 * 1024);
  const previous = makeLargeSessions();
  assert.equal(writeSessionsForStorage(previous), true);
  const before = new Map(storage);
  const writeString = localStorageAdapter.writeString;
  const error = new Error('overflow write failed');
  let failOnce = true;
  t.mock.method(localStorageAdapter, 'writeString', (key: string, value: string) => {
    if (failOnce && key === STORAGE_KEY_AI_SESSIONS_OVERFLOW) {
      failOnce = false;
      assert.notEqual(storage.get(STORAGE_KEY_AI_SESSIONS), before.get(STORAGE_KEY_AI_SESSIONS));
      throw error;
    }
    return writeString(key, value);
  });
  assert.throws(() => writeSessionsForStorage([
    { ...previous[0], title: 'New primary' }, ...previous.slice(1),
  ]), candidate => candidate === error);
  assert.deepEqual(storage, before);
});

test('aggregate quota falls back to a current primary with full backup and persists later turns', (t) => {
  const storage = installSessionStorage(t, 5 * 1024 * 1024);
  assert.equal(writeSessionsForStorage([makeSession('previous-primary', 0, [])]), true);
  __resetBackupMirrorForTests();
  const backupWrites: string[] = [];
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { netcatty: { aiSessionsBackupWrite: async ({ json }: { json: string }) => {
      backupWrites.push(json);
      return { ok: true };
    } } },
  });
  t.after(() => Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow }));
  const sessions = freezeHistory(makeLargeSessions(6));
  assert.ok(JSON.stringify(sessions).length > 5 * 1024 * 1024);
  const setItem = globalThis.localStorage.setItem;
  t.mock.method(globalThis.localStorage, 'setItem', (key: string, value: string) => {
    if (key === STORAGE_KEY_AI_SESSIONS) {
      // The full intended history must be scheduled before replacing the old
      // valid primary, including on the subsequent mutation of the same chat.
      flushBackupMirror();
      assert.equal((JSON.parse(backupWrites.at(-1)!) as AISession[]).length, 6);
    }
    setItem(key, value);
  });
  assert.equal(writeSessionsForStorage(sessions), true);
  flushBackupMirror();
  assert.deepEqual(JSON.parse(backupWrites.at(-1)!), sessions);
  assert.deepEqual(readSessionsFromStorage(), [sessions[0]]);
  assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW)!), sessions.slice(1).map(session => session.id));
  assert.equal([...storage.keys()].some(key => key.startsWith(STORAGE_KEY_AI_SESSIONS_OVERFLOW)), false);

  const updated = sessions.map((session, index) => index === 0 ? {
    ...session,
    updatedAt: session.updatedAt + 1,
    messages: [...session.messages.slice(1), {
      id: 'new-turn', role: 'user' as const, content: 'Latest turn survives reload', timestamp: 1000,
    }],
  } : session);
  assert.equal(writeSessionsForStorage(updated), true);
  flushBackupMirror();
  assert.deepEqual(JSON.parse(backupWrites.at(-1)!), updated);
  assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY_AI_SESSIONS)!), [updated[0]]);
  assert.deepEqual(readSessionsFromStorage(), [updated[0]]);
});

test('live writes resolve only the disk-only IDs included in primary or overflow', (t) => {
  const storage = installSessionStorage(t);
  const sessions = makeLargeSessions();
  storage.set(STORAGE_KEY_AI_SESSIONS, JSON.stringify([sessions[0]]));
  storage.set(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW, JSON.stringify([
    sessions[0].id, sessions[1].id, 'unrecovered', 'deleted',
  ]));
  assert.equal(writeSessionsForStorage(sessions, { deletedSessionIds: ['deleted'] }), true);
  assert.deepEqual(readSessionsFromStorage(), sessions);
  assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW)!), ['unrecovered']);

  // Reusing the same immutable array must still process explicit deletion,
  // including when the primary itself has not changed.
  assert.equal(writeSessionsForStorage(sessions, { deletedSessionIds: ['unrecovered'] }), true);
  assert.equal(storage.has(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW), false);
});

test('same-array primary writes preserve pending recovery until explicit deletion or sync', (t) => {
  const storage = installSessionStorage(t);
  const sessions = [makeSession('primary', 1, [])];
  assert.equal(writeSessionsForStorage(sessions), true);
  storage.set(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW, JSON.stringify(['unrecovered']));
  assert.equal(writeSessionsForStorage(sessions), true);
  assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW)!), ['unrecovered']);
  assert.equal(writeSessionsForStorage(sessions, { deletedSessionIds: ['unrecovered'] }), true);
  assert.equal(storage.has(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW), false);

  storage.set(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW, JSON.stringify(['unrecovered']));
  storage.set(STORAGE_KEY_CLOUD_SYNC_AI_SESSIONS, JSON.stringify({ enabled: true }));
  assert.equal(writeSessionsForStorage(sessions), true);
  assert.equal(storage.has(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW), false);
});

test('tiny newest chat bounds overflow writes under aggregate quota and preserves unresolved IDs', (t) => {
  const storage = installSessionStorage(t, 512 * 1024);
  const sessions = [makeSession('empty-newest', 10, []), ...Array.from({ length: 3 }, (_, index) => (
    makeSession(`huge-older-${index}`, 3 - index, [{
      id: 'm', role: 'user', content: 'x'.repeat(768 * 1024), timestamp: 0,
    }])
  ))];
  storage.set(STORAGE_KEY_AI_SESSIONS, JSON.stringify([sessions[0]]));
  storage.set(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW, JSON.stringify(['unrecovered']));
  const writes = t.mock.method(globalThis.localStorage, 'setItem');
  assert.equal(writeSessionsForStorage(sessions), true);
  assert.ok(writes.mock.callCount() < 150, `bounded writes: ${writes.mock.callCount()}`);
  assert.deepEqual(readSessionsFromStorage(), [sessions[0]]);
  assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW)!), [
    'unrecovered', ...sessions.slice(1).map(session => session.id),
  ]);
});

test('primary-only fallback frees primary quota before writing recovery metadata', (t) => {
  const storage = installSessionStorage(t);
  const previous = [makeSession('old-primary', 1, [{
    id: 'm', role: 'user', content: 'x'.repeat(64 * 1024), timestamp: 0,
  }])];
  const previousJson = JSON.stringify(previous);
  const sessions = [makeSession('empty-newest', 10, []), ...makeLargeSessions(2)];
  storage.set(STORAGE_KEY_AI_SESSIONS, previousJson);
  // The old primary fills the quota. Metadata fits only after it is replaced.
  const aggregateQuota = [...storage].reduce((total, [key, value]) => total + key.length + value.length, 0);
  const setItem = globalThis.localStorage.setItem;
  t.mock.method(globalThis.localStorage, 'setItem', (key: string, value: string) => {
    const total = [...storage].reduce((sum, [storedKey, storedValue]) => (
      sum + (storedKey === key ? 0 : storedKey.length + storedValue.length)
    ), key.length + value.length);
    if (total > aggregateQuota) throw new DOMException('aggregate quota exceeded', 'QuotaExceededError');
    setItem(key, value);
  });
  assert.equal(writeSessionsForStorage(sessions), true);
  assert.deepEqual(readSessionsFromStorage(), [sessions[0]]);
  assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW)!), sessions.slice(1).map(session => session.id));
});

test('primary-only fallback rolls back when recovery metadata cannot be written', (t) => {
  const storage = installSessionStorage(t);
  const previous = [makeSession('previous', 0, [])];
  assert.equal(writeSessionsForStorage(previous), true);
  storage.set(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW, JSON.stringify(['unrecovered']));
  const before = new Map(storage);
  const setItem = globalThis.localStorage.setItem;
  t.mock.method(globalThis.localStorage, 'setItem', (key: string, value: string) => {
    if (key.startsWith(STORAGE_KEY_AI_SESSIONS_OVERFLOW) || key === STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW) {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    }
    setItem(key, value);
  });
  assert.equal(writeSessionsForStorage([makeSession('new', 1, []), ...makeLargeSessions(2)]), false);
  assert.deepEqual(storage, before);
});

test('unchanged primary does not hide modified overflow from the write cache', (t) => {
  const storage = installSessionStorage(t);
  const sessions = freezeHistory(makeLargeSessions());
  assert.equal(writeSessionsForStorage(sessions), true);
  storage.set(STORAGE_KEY_AI_SESSIONS_OVERFLOW, 'corrupt overflow');
  assert.equal(writeSessionsForStorage(sessions), true);
  assert.deepEqual(readSessionsFromStorage(), sessions);
});

test('quota failures retain the previous overflow and back up the intended full set', (t) => {
  const storage = installSessionStorage(t);
  const original = makeLargeSessions();
  assert.equal(writeSessionsForStorage(original), true);
  __resetBackupMirrorForTests();
  const before = new Map(storage);
  const next = original.map(session => ({ ...session, title: 'Changed', updatedAt: session.updatedAt + 10 }));
  t.mock.method(localStorageAdapter, 'writeString', (key: string, value: string) => {
    if (key === STORAGE_KEY_AI_SESSIONS) return false;
    storage.set(key, value);
    return true;
  });
  const backupWrites: string[] = [];
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { netcatty: { aiSessionsBackupWrite: async ({ json }: { json: string }) => {
      backupWrites.push(json);
      return { ok: true };
    } } },
  });
  t.after(() => Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow }));
  assert.equal(writeSessionsForStorage(next), false);
  assert.deepEqual(storage, before);
  assert.deepEqual(readSessionsFromStorage(), original);
  flushBackupMirror();
  assert.deepEqual(JSON.parse(backupWrites[0]), next);
});

test('orphan cleanup preserves resumable privacy maps until explicit chat deletion', (t) => {
  const service = createAiPrivacyService({ maxSessions: 3 });
  service.configure({ enabled: true });
  const sessions = [
    { ...makeSession('privacy-orphan', 1, []), scope: { type: 'terminal' as const, targetId: 'closed' } },
    { ...makeSession('privacy-live', 2, []), scope: { type: 'terminal' as const, targetId: 'open' } },
    { ...makeSession('privacy-resumed', 3, []), scope: { type: 'terminal' as const, targetId: 'closed' } },
  ];
  const aliases = sessions.map(session => {
    setReversibleModelPrivacy(session.id, true);
    return service.redact(session.id, '8.8.8.8');
  });
  const sdkCleanups: string[] = [];
  const privacyCleanups: string[] = [];
  const outputCleanups: string[] = [];
  const previousWindow = globalThis.window;
  const previousSessions = latestAISessionsSnapshot;
  const previousActiveSessionMap = latestAIActiveSessionMapSnapshot;
  t.mock.method(localStorageAdapter, 'read', () => null);
  t.mock.method(localStorageAdapter, 'readString', () => null);
  t.mock.method(localStorageAdapter, 'write', () => true);
  t.mock.method(localStorageAdapter, 'writeString', () => true);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dispatchEvent: () => true,
      netcatty: {
        aiSdkAgentCleanup: async (id: string) => {
          sdkCleanups.push(id);
          return { ok: true };
        },
        aiPrivacyClearSession: async (id: string) => {
          privacyCleanups.push(id);
          service.clearSession(id);
          return { ok: true };
        },
        deleteChatToolOutputsTemp: async (id: string) => {
          outputCleanups.push(id);
          return { deletedCount: 1 };
        },
      },
    },
  });
  setLatestAISessionsSnapshot(sessions);
  setLatestAIActiveSessionMapSnapshot({
    'terminal:closed': 'privacy-orphan',
    'terminal:open': 'privacy-live',
    'terminal:resumed-into': 'privacy-resumed',
  });

  try {
    cleanupOrphanedAISessions(new Set(['open', 'resumed-into']));

    // Issue #4015 R2: the dropped chat is marked dangling but its record and
    // its active pointer stay intact so /chats can offer a rebind.
    const persistedSessions = latestAISessionsSnapshot;
    assert.ok(persistedSessions);
    assert.equal(
      persistedSessions.find((session) => session.id === 'privacy-orphan')?.scopeDangling,
      true,
    );
    assert.equal(
      persistedSessions.find((session) => session.id === 'privacy-live')?.scopeDangling,
      undefined,
    );
    assert.equal(
      persistedSessions.find((session) => session.id === 'privacy-resumed')?.scopeDangling,
      undefined,
    );
    assert.deepEqual(latestAIActiveSessionMapSnapshot, {
      'terminal:closed': 'privacy-orphan',
      'terminal:open': 'privacy-live',
      'terminal:resumed-into': 'privacy-resumed',
    });
    assert.deepEqual(sdkCleanups, ['privacy-orphan']);
    assert.deepEqual(privacyCleanups, []);
    assert.deepEqual(outputCleanups, []);
    for (const [index, session] of sessions.entries()) {
      assert.equal(hasReversibleModelPrivacy(session.id), true);
      assert.equal(service.redact(session.id, '8.8.8.8'), aliases[index]);
      assert.equal(service.restore(session.id, aliases[index]), '8.8.8.8');
    }
    assert.throws(() => service.checkSession('privacy-next'), /session limit reached/);

    cleanupDeletedAIChatSessions(['privacy-orphan']);

    assert.deepEqual(privacyCleanups, ['privacy-orphan']);
    assert.deepEqual(outputCleanups, ['privacy-orphan']);
    assert.equal(hasReversibleModelPrivacy('privacy-orphan'), false);
    assert.equal(service.hasSession('privacy-orphan'), false);
    assert.throws(() => service.checkSession('privacy-orphan'), /start a new chat/);
    assert.equal(service.checkSession('privacy-next'), true);
    for (const [index, session] of sessions.entries()) {
      if (session.id === 'privacy-orphan') continue;
      assert.equal(hasReversibleModelPrivacy(session.id), true);
      assert.equal(service.restore(session.id, aliases[index]), '8.8.8.8');
    }
  } finally {
    for (const session of sessions) setReversibleModelPrivacy(session.id, false);
    setLatestAISessionsSnapshot(previousSessions ?? []);
    setLatestAIActiveSessionMapSnapshot(previousActiveSessionMap ?? {});
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  }
});

test('orphan cleanup marks dangling chats instead of stripping them, and clears the flag when the target returns', (t) => {
  const previousSessions = latestAISessionsSnapshot;
  const previousActiveSessionMap = latestAIActiveSessionMapSnapshot;
  const read = t.mock.method(localStorageAdapter, 'read', () => null);
  t.mock.method(localStorageAdapter, 'readString', () => null);
  t.mock.method(localStorageAdapter, 'write', () => true);
  const writeString = t.mock.method(localStorageAdapter, 'writeString', () => true);
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: () => true, netcatty: {} },
  });
  const dangling = {
    ...makeSession('dangling-chat', 1, []),
    scope: { type: 'terminal' as const, targetId: 'closed-ws' },
  };
  const live = {
    ...makeSession('live-chat', 2, []),
    scope: { type: 'terminal' as const, targetId: 'open' },
  };
  setLatestAISessionsSnapshot([dangling, live]);
  setLatestAIActiveSessionMapSnapshot({
    'terminal:closed-ws': 'dangling-chat',
    'terminal:open': 'live-chat',
  });

  try {
    cleanupOrphanedAISessions(new Set(['open']));

    let persisted = latestAISessionsSnapshot;
    assert.ok(persisted);
    assert.equal(persisted.find((s) => s.id === 'dangling-chat')?.scopeDangling, true);
    assert.equal(persisted.find((s) => s.id === 'live-chat')?.scopeDangling, undefined);
    // The active pointer survives the dangling marking.
    assert.deepEqual(latestAIActiveSessionMapSnapshot, {
      'terminal:closed-ws': 'dangling-chat',
      'terminal:open': 'live-chat',
    });
    assert.ok(writeString.mock.callCount() > 0);

    // The scope target becomes live again → the dangling flag clears.
    read.mock.mockImplementation(() => null);
    cleanupOrphanedAISessions(new Set(['open', 'closed-ws']));
    persisted = latestAISessionsSnapshot;
    assert.ok(persisted);
    assert.equal(persisted.find((s) => s.id === 'dangling-chat')?.scopeDangling, undefined);
  } finally {
    setLatestAISessionsSnapshot(previousSessions ?? []);
    setLatestAIActiveSessionMapSnapshot(previousActiveSessionMap ?? {});
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previousWindow,
    });
  }
});

test('orphan cleanup with an empty live-target set marks all scoped chats dangling', (t) => {
  const previousSessions = latestAISessionsSnapshot;
  const previousActiveSessionMap = latestAIActiveSessionMapSnapshot;
  t.mock.method(localStorageAdapter, 'read', () => null);
  t.mock.method(localStorageAdapter, 'readString', () => null);
  t.mock.method(localStorageAdapter, 'write', () => true);
  t.mock.method(localStorageAdapter, 'writeString', () => true);
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: () => true, netcatty: {} },
  });
  const orphan = {
    ...makeSession('orphan-chat', 1, []),
    scope: { type: 'terminal' as const, targetId: 'gone' },
  };
  setLatestAISessionsSnapshot([orphan]);
  setLatestAIActiveSessionMapSnapshot({ 'terminal:gone': 'orphan-chat' });

  try {
    // Empty is a valid observed live set (nothing mounted), not "unknown".
    cleanupOrphanedAISessions(new Set());
    const persisted = latestAISessionsSnapshot;
    assert.ok(persisted);
    assert.equal(persisted.find((s) => s.id === 'orphan-chat')?.scopeDangling, true);
  } finally {
    setLatestAISessionsSnapshot(previousSessions ?? []);
    setLatestAIActiveSessionMapSnapshot(previousActiveSessionMap ?? {});
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previousWindow,
    });
  }
});

test('serializeSessionsForStorage strips oldest ciphertext before dropping visible sessions', async () => {
  const { serializeSessionsForStorage } = await import('./aiStateSnapshots');
  const ciphertext = 'gAAAA'.repeat(50000); // ~250 KB of ciphertext per message
  const messages = () => [{
    id: 'm',
    role: 'assistant' as const,
    content: 'hello',
    timestamp: 0,
    providerContinuation: {
      reasoningParts: [{ text: '', providerOptions: { openai: { reasoningEncryptedContent: ciphertext } } }],
    },
  }];
  const sessions = [
    makeSession('newest', 3, messages()),
    makeSession('older', 2, messages()),
    makeSession('oldest', 1, messages()),
  ];

  const hasCiphertext = (result: { sessions: AISession[] }) =>
    result.sessions.some(s => s.messages.some(m =>
      m.providerContinuation?.reasoningParts?.some(p => typeof p.providerOptions?.openai?.reasoningEncryptedContent === 'string')));

  // Removing replay-only ciphertext from the oldest session fits the budget,
  // so every visible chat remains available after restart.
  const withOldestCiphertextStripped = serializeSessionsForStorage(sessions, 600 * 1024);
  assert.deepEqual(
    withOldestCiphertextStripped.sessions.map(s => s.id),
    ['newest', 'older', 'oldest'],
  );
  assert.equal(hasCiphertext(withOldestCiphertextStripped), true);
  assert.ok(withOldestCiphertextStripped.json.length <= 600 * 1024);

  // Tight budget that even a single session exceeds: ciphertext stripped but
  // the visible conversation content survives.
  const withCiphertextStripped = serializeSessionsForStorage(sessions, 220 * 1024);
  assert.ok(withCiphertextStripped.json.length <= 220 * 1024);
  assert.equal(hasCiphertext(withCiphertextStripped), false);
  assert.deepEqual(withCiphertextStripped.sessions.map(s => s.id), ['newest', 'older', 'oldest']);
  assert.equal(withCiphertextStripped.sessions[0].messages[0].content, 'hello');
});

test('serializeSessionsForStorage keeps new ciphertext when an oversized old chat must be dropped', async () => {
  const { serializeSessionsForStorage } = await import('./aiStateSnapshots');
  const ciphertext = 'gAAAA'.repeat(20 * 1024); // ~100 KB
  const newest = makeSession('newest', 2, [{
    id: 'new-message',
    role: 'assistant',
    content: 'new visible chat',
    timestamp: 2,
    providerContinuation: {
      source: { providerConfigId: 'p', providerType: 'openai', modelId: 'm' },
      reasoningParts: [{ text: '', providerOptions: { openai: { reasoningEncryptedContent: ciphertext } } }],
    },
  }]);
  const oversizedOld = makeSession('oldest', 1, [{
    id: 'old-message',
    role: 'user',
    content: 'x'.repeat(300 * 1024),
    timestamp: 1,
  }]);

  const result = serializeSessionsForStorage([oversizedOld, newest], 200 * 1024);

  assert.deepEqual(result.sessions.map(session => session.id), ['newest']);
  assert.equal(
    result.sessions[0].messages[0].providerContinuation
      ?.reasoningParts?.[0].providerOptions?.openai?.reasoningEncryptedContent,
    ciphertext,
  );
  assert.ok(result.json.length <= 200 * 1024);
});

test('serializeSessionsForStorage prioritizes a usable newest chat over older visible history', async () => {
  const { serializeSessionsForStorage } = await import('./aiStateSnapshots');
  const ciphertext = 'gAAAA'.repeat(20 * 1024); // ~100 KB
  const newest = makeSession('newest', 2, [{
    id: 'new-message',
    role: 'assistant',
    content: 'new visible chat',
    timestamp: 2,
    providerContinuation: {
      source: { providerConfigId: 'p', providerType: 'openai', modelId: 'm' },
      reasoningParts: [{ text: '', providerOptions: { openai: { reasoningEncryptedContent: ciphertext } } }],
    },
  }]);
  const olderVisible = makeSession('oldest', 1, [{
    id: 'old-message',
    role: 'user',
    content: 'x'.repeat(100 * 1024),
    timestamp: 1,
  }]);

  const result = serializeSessionsForStorage([olderVisible, newest], 150 * 1024);

  assert.deepEqual(result.sessions.map(session => session.id), ['newest']);
  assert.equal(
    result.sessions[0].messages[0].providerContinuation
      ?.reasoningParts?.[0].providerOptions?.openai?.reasoningEncryptedContent,
    ciphertext,
  );
  assert.ok(result.json.length <= 150 * 1024);
});

test('serializeSessionsForStorage keeps the newest replayable turn in one oversized chat', async () => {
  const { serializeSessionsForStorage } = await import('./aiStateSnapshots');
  const ciphertext = 'gAAAA'.repeat(20 * 1024); // ~100 KB per reasoning turn
  const reasoning = (itemId: string) => ({
    source: { providerConfigId: 'p', providerType: 'openai', modelId: 'm' },
    reasoningParts: [{
      text: '',
      providerOptions: { openai: { itemId, reasoningEncryptedContent: ciphertext } },
    }],
  });
  const session = makeSession('active', 1, [
    {
      id: 'assistant-old',
      role: 'assistant',
      content: 'old turn',
      timestamp: 1,
      providerContinuation: reasoning('rs_old'),
      toolCalls: [{ id: 'call-old', name: 'terminal_execute', arguments: { command: 'pwd' } }],
    },
    {
      id: 'tool-old',
      role: 'tool',
      content: '',
      timestamp: 2,
      toolResults: [{ toolCallId: 'call-old', content: '/tmp' }],
    },
    {
      id: 'assistant-new',
      role: 'assistant',
      content: 'new turn',
      timestamp: 3,
      providerContinuation: reasoning('rs_new'),
      toolCalls: [{ id: 'call-new', name: 'terminal_execute', arguments: { command: 'ls' } }],
    },
    {
      id: 'tool-new',
      role: 'tool',
      content: '',
      timestamp: 4,
      toolResults: [{ toolCallId: 'call-new', content: 'file.txt' }],
    },
  ]);

  const result = serializeSessionsForStorage([session], 150 * 1024);

  assert.ok(result.json.length <= 150 * 1024);
  assert.deepEqual(result.sessions[0].messages.map(message => message.id), [
    'assistant-old',
    'tool-old',
    'assistant-new',
    'tool-new',
  ]);
  assert.equal(
    result.sessions[0].messages[0].providerContinuation
      ?.reasoningParts?.[0].providerOptions?.openai?.reasoningEncryptedContent,
    undefined,
  );
  assert.equal(
    result.sessions[0].messages[2].providerContinuation
      ?.reasoningParts?.[0].providerOptions?.openai?.reasoningEncryptedContent,
    ciphertext,
  );
});

test('serializeSessionsForStorage drops compacted ciphertext before protecting the newest chat', async () => {
  const { serializeSessionsForStorage } = await import('./aiStateSnapshots');
  const ciphertext = 'gAAAA'.repeat(20 * 1024); // ~100 KB per reasoning turn
  const compactedMessages = Array.from({ length: 17 }, (_, index) => ({
    id: `compacted-${index}`,
    role: 'assistant' as const,
    content: `compacted turn ${index}`,
    timestamp: index,
    providerContinuation: {
      reasoningParts: [{
        text: '',
        providerOptions: {
          openai: { itemId: `rs_${index}`, reasoningEncryptedContent: ciphertext },
        },
      }],
    },
  }));
  const newest = {
    ...makeSession('newest', 2, [
      ...compactedMessages,
      {
        id: 'recent',
        role: 'assistant',
        content: 'recent turn',
        timestamp: 18,
        providerContinuation: {
          reasoningParts: [{
            text: '',
            providerOptions: {
              openai: { itemId: 'rs_recent', reasoningEncryptedContent: ciphertext },
            },
          }],
        },
      },
    ]),
    contextCompaction: {
      summary: 'The first 17 turns were summarized.',
      compactedMessageCount: 17,
    },
  };
  const olderVisible = makeSession('older', 1, [{
    id: 'older-visible',
    role: 'user',
    content: 'x'.repeat(600 * 1024),
    timestamp: 1,
  }]);

  const result = serializeSessionsForStorage([olderVisible, newest]);

  assert.deepEqual(result.sessions.map(session => session.id), ['newest', 'older']);
  assert.ok(result.json.length <= 2 * 1024 * 1024);
  const persistedNewest = result.sessions[0];
  for (const message of persistedNewest.messages.slice(0, 17)) {
    assert.equal(
      message.providerContinuation
        ?.reasoningParts?.[0].providerOptions?.openai?.reasoningEncryptedContent,
      undefined,
    );
  }
  assert.equal(
    persistedNewest.messages[17].providerContinuation
      ?.reasoningParts?.[0].providerOptions?.openai?.reasoningEncryptedContent,
    ciphertext,
  );
});

test('serializeSessionsForStorage shifts the compaction boundary when trimming old messages', async () => {
  const { serializeSessionsForStorage } = await import('./aiStateSnapshots');
  const ciphertext = 'enc'.repeat(100);
  const messages = Array.from({ length: 250 }, (_, index) => ({
    id: `message-${index}`,
    role: 'assistant' as const,
    content: `turn ${index}`,
    timestamp: index,
    providerContinuation: {
      reasoningParts: [{
        text: '',
        providerOptions: {
          openai: { itemId: `rs_${index}`, reasoningEncryptedContent: ciphertext },
        },
      }],
    },
  }));
  const session = {
    ...makeSession('trimmed', 1, messages),
    contextCompaction: {
      summary: 'The first 100 messages were summarized.',
      compactedMessageCount: 100,
    },
  };

  const result = serializeSessionsForStorage([session]);
  const persisted = result.sessions[0];

  assert.equal(persisted.messages.length, 200);
  assert.equal(persisted.messages[0].id, 'message-50');
  assert.equal(persisted.contextCompaction?.compactedMessageCount, 50);
  assert.equal(
    persisted.messages[49].providerContinuation
      ?.reasoningParts?.[0].providerOptions?.openai?.reasoningEncryptedContent,
    undefined,
  );
  assert.equal(
    persisted.messages[50].providerContinuation
      ?.reasoningParts?.[0].providerOptions?.openai?.reasoningEncryptedContent,
    ciphertext,
  );
});

test('serializeSessionsForStorage does not trim between a tool call and its result', async () => {
  const { serializeSessionsForStorage } = await import('./aiStateSnapshots');
  const messages = Array.from({ length: 250 }, (_, index) => ({
    id: `message-${index}`,
    role: 'user' as const,
    content: `turn ${index}`,
    timestamp: index,
  }));
  messages[49] = {
    id: 'assistant-call',
    role: 'assistant',
    content: 'Running it.',
    timestamp: 49,
    toolCalls: [{ id: 'call-1', name: 'terminal_execute', arguments: { command: 'pwd' } }],
  } as never;
  messages[50] = {
    id: 'tool-result',
    role: 'tool',
    content: '',
    timestamp: 50,
    toolResults: [{ toolCallId: 'call-1', content: '/tmp' }],
  } as never;
  const session = {
    ...makeSession('tool-boundary', 1, messages),
    contextCompaction: {
      summary: 'The first 10 messages were summarized.',
      compactedMessageCount: 10,
    },
  };

  const result = serializeSessionsForStorage([session]);
  const persisted = result.sessions[0];

  assert.equal(persisted.messages.length, 201);
  assert.equal(persisted.messages[0].id, 'assistant-call');
  assert.equal(persisted.messages[1].id, 'tool-result');
  assert.equal(persisted.contextCompaction?.compactedMessageCount, 0);
});

test('writeSessionsForStorage retries below nominal budgets after a quota failure', async () => {
  const { writeSessionsForStorage } = await import('./aiStateSnapshots');
  const writes: string[] = [];
  let stored: string | undefined;
  const previousLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: (_key: string, value: string) => {
        writes.push(value);
        if (value.length > 350 * 1024) {
          throw new DOMException('quota exceeded', 'QuotaExceededError');
        }
        stored = value;
      },
      removeItem: () => {},
    },
  });
  try {
    // The retry loop must attempt progressively smaller payloads (here the
    // ciphertext stripping at the tighter budget) before reporting failure.
    const huge = 'x'.repeat(260 * 1024);
    const ciphertext = 'gAAAA'.repeat(30 * 1024); // ~150 KB
    const sessions = [makeSession('s', 1, [{
      id: 'm',
      role: 'user' as const,
      content: huge,
      timestamp: 0,
      providerContinuation: {
        reasoningParts: [{ text: '', providerOptions: { openai: { reasoningEncryptedContent: ciphertext } } }],
      },
    }])];
    assert.equal(writeSessionsForStorage(sessions), true);
    assert.equal(writes.length, 2);
    assert.equal(stored, writes[1]);
    assert.ok(writes[writes.length - 1].length < writes[0].length);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: previousLocalStorage,
    });
  }
});

test('writeSessionsForStorage splits overflow to fit a sub-512 KB per-key quota', (t) => {
  const storage = installSessionStorage(t);
  const writes: string[] = [];
  t.mock.method(globalThis.localStorage, 'setItem', (key: string, value: string) => {
    writes.push(value);
    if (value.length > 300 * 1024) {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    }
    storage.set(key, value);
  });
  const sessions = Array.from({ length: 10 }, (_, index) => makeSession(
    `session-${index}`, 10 - index,
    [{ id: `message-${index}`, role: 'user', content: 'x'.repeat(40 * 1024), timestamp: index }],
  ));
  assert.equal(writeSessionsForStorage(sessions), true);
  assert.ok(writes[0].length > 300 * 1024);
  const primary = storage.get(STORAGE_KEY_AI_SESSIONS)!;
  assert.ok(primary.length <= 300 * 1024);
  assert.ok((JSON.parse(primary) as AISession[]).length < sessions.length);
  assert.deepEqual(readSessionsFromStorage(), sessions);
});

test('serializeSessionsForStorage truncates slightly-over-cap tool results to strictly smaller sizes', async () => {
  const { serializeSessionsForStorage } = await import('./aiStateSnapshots');
  // Just over the 8 KiB cap: the truncation marker must not make the degraded
  // copy larger than the original, or the ladder could evict a session whose
  // unmodified JSON would have fit the budget.
  for (const oversize of [8193, 8266, 20000]) {
    const session = makeSession('near-cap', 1, [{
      id: 'tool-message',
      role: 'tool',
      content: '',
      timestamp: 1,
      toolResults: [{ toolCallId: 'call-1', content: 'z'.repeat(oversize) }],
    }]);
    const fullJson = JSON.stringify([session]);
    const result = serializeSessionsForStorage([session], fullJson.length - 10);
    const content = result.sessions[0].messages[0].toolResults?.[0].content ?? '';
    assert.ok(content.length <= 8 * 1024, `cap respected for ${oversize}`);
    assert.ok(
      JSON.stringify(result.sessions).length < fullJson.length,
      `degraded copy smaller than original for ${oversize}`,
    );
    assert.ok(content.includes('truncated'));
  }
});

test('serializeSessionsForStorage sheds oversized tool output before dropping visible sessions', async () => {
  const { serializeSessionsForStorage } = await import('./aiStateSnapshots');
  const newest = makeSession('newest', 2, [{
    id: 'new-message',
    role: 'assistant',
    content: 'still-open chat',
    timestamp: 2,
  }]);
  const toolBulk = makeSession('tool-bulk', 1, [{
    id: 'tool-message',
    role: 'tool',
    content: '',
    timestamp: 1,
    toolResults: [{ toolCallId: 'call-1', content: 'z'.repeat(400 * 1024) }],
  }]);

  const result = serializeSessionsForStorage([toolBulk, newest], 100 * 1024);

  // The bloated tool result must not evict the other visible chat.
  assert.deepEqual(result.sessions.map(session => session.id), ['newest', 'tool-bulk']);
  assert.ok(result.json.length <= 100 * 1024);
  const persistedToolContent = result.sessions[1].messages[0].toolResults?.[0].content;
  assert.ok(persistedToolContent);
  assert.ok(persistedToolContent.length <= 9 * 1024);
  assert.ok(persistedToolContent.includes('truncated'));
  assert.ok(persistedToolContent.startsWith('zzz'));
  assert.equal(result.sessions[0].messages[0].content, 'still-open chat');
});

test('writeSessionsForStorage keeps every chat by shedding tool output under quota pressure', async () => {
  const { writeSessionsForStorage } = await import('./aiStateSnapshots');
  let stored: string | undefined;
  const previousLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: (_key: string, value: string) => {
        if (value.length > 300 * 1024) {
          throw new DOMException('quota exceeded', 'QuotaExceededError');
        }
        stored = value;
      },
      removeItem: () => {},
    },
  });

  try {
    const sessions = Array.from({ length: 10 }, (_, index) => makeSession(
      `session-${index}`,
      10 - index,
      [{
        id: `message-${index}`,
        role: 'tool' as const,
        content: '',
        timestamp: index,
        toolResults: [{ toolCallId: `call-${index}`, content: 'z'.repeat(40 * 1024) }],
      }],
    ));

    assert.equal(writeSessionsForStorage(sessions), true);
    assert.ok(stored);
    assert.ok(stored.length <= 300 * 1024);
    const persisted = JSON.parse(stored) as AISession[];
    assert.deepEqual(
      persisted.map(session => session.id),
      sessions.map(session => session.id),
    );
    // Degradation sheds only as many messages as the budget demands, so at
    // least one chat keeps its full tool output while the persisted set stays
    // complete. Assert completion first; truncation second.
    const shedContents = persisted.map(
      session => session.messages[0].toolResults?.[0].content ?? '',
    );
    assert.ok(shedContents.some(content => content.includes('truncated')));
    assert.ok(shedContents.some(content => content.startsWith('zzz') && !content.includes('truncated')));
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: previousLocalStorage,
    });
  }
});

test('writeSessionsForStorage makes a final attempt with the newest primary and keeps overflow', (t) => {
  const storage = installSessionStorage(t);
  const writes: string[] = [];
  t.mock.method(globalThis.localStorage, 'setItem', (key: string, value: string) => {
    writes.push(value);
    if (value.length > 50 * 1024) {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    }
    storage.set(key, value);
  });
  const sessions = Array.from({ length: 10 }, (_, index) => makeSession(
    `session-${index}`, 10 - index,
    [{ id: `message-${index}`, role: 'user', content: 'x'.repeat(40 * 1024), timestamp: index }],
  ));
  assert.equal(writeSessionsForStorage(sessions), true);
  assert.ok(writes.some(value => value.length > 50 * 1024));
  const primary = storage.get(STORAGE_KEY_AI_SESSIONS)!;
  assert.deepEqual((JSON.parse(primary) as AISession[]).map(session => session.id), ['session-0']);
  assert.ok(primary.length <= 50 * 1024);
  assert.deepEqual(readSessionsFromStorage(), sessions);
});

function freezeHistory<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeHistory);
    Object.freeze(value);
  }
  return value;
}

function makePersistenceHistory(count: number, activeMessages = 6): AISession[] {
  return Array.from({ length: count }, (_, index) => makeSession(
    `session-${index}`,
    count - index,
    Array.from({ length: index === 0 ? activeMessages : 6 }, (_, messageIndex) => ({
      id: `message-${index}-${messageIndex}`,
      role: messageIndex % 2 ? 'assistant' : 'user',
      content: 'ordinary text '.repeat(8),
      timestamp: messageIndex,
      ...(messageIndex % 2 ? {
        toolResults: [{ toolCallId: `tool-${messageIndex}`, content: 'sample output '.repeat(700) }],
        providerContinuation: {
          reasoningParts: [{
            text: 'reasoning',
            providerOptions: { openai: { reasoningEncryptedContent: 'x'.repeat(256) } },
          }],
        },
      } : {}),
    })),
  ));
}

for (const [count, activeMessages] of [[20, 6], [200, 6], [20, 200]]) {
  test(`fitting history serializes only retained full sessions (${count} chats, ${activeMessages} active messages)`, async (t) => {
    const { serializeSessionsForStorage } = await import('./aiStateSnapshots');
    const sessions = freezeHistory(makePersistenceHistory(count, activeMessages));
    const expected = sessions.slice(0, 50);
    const expectedJson = JSON.stringify(expected);
    const stringify = t.mock.method(JSON, 'stringify');

    const result = serializeSessionsForStorage(sessions);

    assert.equal(stringify.mock.callCount(), expected.length);
    assert.equal(result.json, expectedJson);
    assert.deepEqual(result.sessions, expected);
    assert.equal(result.sessions[0], sessions[0]);
  });
}

test('fit-first budget keeps string-length units and exact-fit replay data without mutating input', async () => {
  const { serializeSessionsForStorage } = await import('./aiStateSnapshots');
  const sessions = makePersistenceHistory(1);
  sessions[0].messages[0].content = '\u4e2d\u6587\ud83d\ude00'.repeat(100);
  freezeHistory(sessions);
  const fullJson = JSON.stringify(sessions);
  assert.ok(Buffer.byteLength(fullJson) > fullJson.length);
  for (const budget of [fullJson.length, fullJson.length + 1]) {
    assert.equal(serializeSessionsForStorage(sessions, budget).json, fullJson);
  }
  const overflow = serializeSessionsForStorage(sessions, fullJson.length - 1);
  assert.ok(overflow.json.length < fullJson.length);
  assert.equal(JSON.stringify(sessions), fullJson);
});

test('fit-first empty history preserves output even below the minimum array budget', async () => {
  const { serializeSessionsForStorage } = await import('./aiStateSnapshots');
  for (const budget of [0, 1, 2, 3]) {
    assert.deepEqual(serializeSessionsForStorage([], budget), { json: '[]', sessions: [] });
  }
});

test('synced storage bypasses fit-first pruning and non-quota failures still propagate', async (t) => {
  const { writeSessionsForStorage } = await import('./aiStateSnapshots');
  const sessions = freezeHistory(makePersistenceHistory(51, 201));
  const read = t.mock.method(localStorageAdapter, 'read', () => ({ enabled: true }));
  t.mock.method(localStorageAdapter, 'readString', () => null);
  const writeString = t.mock.method(localStorageAdapter, 'writeString', () => false);
  assert.equal(writeSessionsForStorage(sessions), false);
  // Synced: one write of the complete, unpruned history (serialized once).
  assert.equal(writeString.mock.callCount(), 1);
  assert.equal(writeString.mock.calls[0].arguments[1], JSON.stringify(sessions));

  read.mock.mockImplementation(() => ({ enabled: false }));
  const error = new Error('non-quota storage failure');
  writeString.mock.mockImplementation(() => { throw error; });
  assert.throws(() => writeSessionsForStorage(sessions), candidate => candidate === error);
  assert.equal(writeString.mock.callCount(), 2);
});

for (const [budget, expectedCalls] of [[128 * 1024, 160], [0, 161]]) {
  test(`overflow reuses prepared full JSON at budget ${budget}`, async (t) => {
    const { serializeSessionsForStorage } = await import('./aiStateSnapshots');
    const sessions = freezeHistory(makePersistenceHistory(20));
    const stringify = t.mock.method(JSON, 'stringify');
    const result = serializeSessionsForStorage(sessions, budget);
    // Same work as the original ladder: no second full-session serialization
    // after the fit check, even when a last-resort degraded chat is needed.
    assert.equal(stringify.mock.callCount(), expectedCalls);
    assert.equal(result.sessions.length, budget === 0 ? 1 : 4);
  });
}
test('successful store writes schedule a throttled disk backup mirror', async (t) => {
  const { writeSessionsForStorage, flushBackupMirror, __resetBackupMirrorForTests } =
    await import('./aiStateSnapshots');
  __resetBackupMirrorForTests();
  const backupWrites: string[] = [];
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      netcatty: {
        aiSessionsBackupWrite: async (payload: { json: string }) => {
          backupWrites.push(payload.json);
          return { ok: true };
        },
      },
    },
  });
  const sessions = freezeHistory(makePersistenceHistory(3, 10));
  const writeString = t.mock.method(localStorageAdapter, 'writeString', () => true);
  t.mock.method(localStorageAdapter, 'read', () => null);
  t.mock.method(localStorageAdapter, 'readString', () => null);
  try {
    assert.equal(writeSessionsForStorage(sessions), true);
    // Throttled: nothing has been written to disk yet.
    assert.equal(backupWrites.length, 0);
    flushBackupMirror();
    assert.equal(backupWrites.length, 1);
    // The mirror carries exactly the JSON that landed in localStorage.
    assert.equal(backupWrites[0], writeString.mock.calls[0].arguments[1]);
    // A failed shrinking write still mirrors the full count-capped history.
    writeString.mock.mockImplementation(() => false);
    assert.equal(writeSessionsForStorage(sessions), false);
    flushBackupMirror();
    assert.equal(backupWrites.length, 2);
    assert.deepEqual(JSON.parse(backupWrites[1]), sessions);
  } finally {
    __resetBackupMirrorForTests();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previousWindow,
    });
  }
});

test('rebindActiveSessionMap drops stale pointers and sets the new scope', () => {
  const cleaned = rebindActiveSessionMap(
    {
      'terminal:old-ws': 'chat-1',
      'terminal:other': 'chat-2',
      'workspace:keep': 'chat-1',
    },
    'chat-1',
    'terminal:new-ws',
  );
  assert.deepEqual(cleaned, {
    'terminal:other': 'chat-2',
    'terminal:new-ws': 'chat-1',
  });
  // Idempotent when already bound to the target scope with no other pointers.
  assert.deepEqual(
    rebindActiveSessionMap({ 'terminal:new-ws': 'chat-1' }, 'chat-1', 'terminal:new-ws'),
    { 'terminal:new-ws': 'chat-1' },
  );
});

test('rewriting the same sessions array skips re-serialization while storage still holds it', async (t) => {
  const { writeSessionsForStorage } = await import('./aiStateSnapshots');
  const sessions = freezeHistory(makePersistenceHistory(3, 10));
  let stored: string | null = null;
  t.mock.method(localStorageAdapter, 'read', () => ({ enabled: true }));
  const writeString = t.mock.method(localStorageAdapter, 'writeString', (_key: string, value: string) => {
    stored = value;
    return true;
  });
  t.mock.method(localStorageAdapter, 'readString', (key: string) => key === STORAGE_KEY_AI_SESSIONS ? stored : null);
  assert.equal(writeSessionsForStorage(sessions), true);
  const stringify = t.mock.method(JSON, 'stringify');
  // Cloud-sync collection writes the same immutable array again.
  assert.equal(writeSessionsForStorage(sessions), true);
  assert.equal(writeString.mock.callCount(), 1);
  assert.equal(stringify.mock.callCount(), 0);
  // Another window replaced the store: write again.
  stored = '[]';
  assert.equal(writeSessionsForStorage(sessions), true);
  assert.equal(writeString.mock.callCount(), 2);
});
