import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiPrivacyService } from '../../electron/shared/aiPrivacyService.cjs';
import {
  hasReversibleModelPrivacy,
  setReversibleModelPrivacy,
} from '../../infrastructure/ai/harness/modelSecretRedaction';
import type { AISession } from '../../infrastructure/ai/types';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { installFakeIndexedDb } from './testSupport/fakeIndexedDb';
import {
  cleanupClosedTerminalSessions,
  cleanupDeletedAIChatSessions,
  cleanupOrphanedAISessions,
  cleanupSdkAgentSessions,
  latestAIActiveSessionMapSnapshot,
  latestAISessionsSnapshot,
  markAiSessionsHydrationComplete,
  pruneSessionsForStorage,
  setLatestAIActiveSessionMapSnapshot,
  setLatestAISessionsSnapshot,
  rebindActiveSessionMap,
} from './aiStateSnapshots';

// These unit tests exercise maintenance after boot hydration.
test.beforeEach(() => { markAiSessionsHydrationComplete(); });

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

test('orphan cleanup marks dangling chats instead of stripping them, and clears the flag when the target returns', async (t) => {
  const { __resetIdbPersistenceForTests, __flushIdbWritesForTests, getPersistedAiSessionsSnapshot } =
    await import('./aiStateSnapshots');
  __resetIdbPersistenceForTests();
  const previousSessions = latestAISessionsSnapshot;
  const previousActiveSessionMap = latestAIActiveSessionMapSnapshot;
  const read = t.mock.method(localStorageAdapter, 'read', () => null);
  t.mock.method(localStorageAdapter, 'readString', () => null);
  t.mock.method(localStorageAdapter, 'write', () => true);
  t.mock.method(localStorageAdapter, 'writeString', () => true);
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
    // Issue #4123: the marked state is persisted (to IndexedDB when
    // available), not to the legacy localStorage key.
    await __flushIdbWritesForTests();
    assert.equal(
      getPersistedAiSessionsSnapshot().find((s) => s.id === 'dangling-chat')?.scopeDangling,
      true,
    );

    // The scope target becomes live again → the dangling flag clears.
    read.mock.mockImplementation(() => null);
    cleanupOrphanedAISessions(new Set(['open', 'closed-ws']));
    persisted = latestAISessionsSnapshot;
    assert.ok(persisted);
    assert.equal(persisted.find((s) => s.id === 'dangling-chat')?.scopeDangling, undefined);
    await __flushIdbWritesForTests();
    assert.equal(
      getPersistedAiSessionsSnapshot().find((s) => s.id === 'dangling-chat')?.scopeDangling,
      undefined,
    );
  } finally {
    __resetIdbPersistenceForTests();
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

test('pruneSessionsForStorage shifts the compaction boundary when trimming old messages', () => {
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

  const persisted = pruneSessionsForStorage([session])[0];

  assert.equal(persisted.messages.length, 200);
  assert.equal(persisted.messages[0].id, 'message-50');
  assert.equal(persisted.contextCompaction?.compactedMessageCount, 50);
});

test('pruneSessionsForStorage does not trim between a tool call and its result', () => {
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

  const persisted = pruneSessionsForStorage([session])[0];

  assert.equal(persisted.messages.length, 201);
  assert.equal(persisted.messages[0].id, 'assistant-call');
  assert.equal(persisted.messages[1].id, 'tool-result');
  assert.equal(persisted.contextCompaction?.compactedMessageCount, 0);
});

test('pruneSessionsForStorage keeps only the newest 1000 sessions', () => {
  const sessions = Array.from({ length: 1001 }, (_, index) =>
    makeSession(`session-${index}`, index + 1, []));
  const persisted = pruneSessionsForStorage(sessions);
  assert.equal(persisted.length, 1000);
  // Oldest (lowest updatedAt) is dropped.
  assert.equal(persisted.some((session) => session.id === 'session-0'), false);
  assert.equal(persisted.some((session) => session.id === 'session-1000'), true);
});

test('pruneSessionsForStorage honors a lowered explicit message cap', () => {
  const messages = Array.from({ length: 250 }, (_, index) => ({
    id: `message-${index}`,
    role: 'user' as const,
    content: `turn ${index}`,
    timestamp: index,
  }));
  const persisted = pruneSessionsForStorage(
    [makeSession('capped-low', 1, messages)],
    50,
  );
  assert.equal(persisted[0].messages.length, 50);
  assert.equal(persisted[0].messages[0].id, 'message-200');
});

test('pruneSessionsForStorage honors a raised explicit message cap', () => {
  const messages = Array.from({ length: 1200 }, (_, index) => ({
    id: `message-${index}`,
    role: 'user' as const,
    content: `turn ${index}`,
    timestamp: index,
  }));
  const persisted = pruneSessionsForStorage(
    [makeSession('capped-high', 1, messages)],
    1000,
  );
  assert.equal(persisted[0].messages.length, 1000);
  assert.equal(persisted[0].messages[0].id, 'message-200');
});

test('pruneSessionsForStorage defaults to the stored aiSessionMessageCap setting', (t) => {
  const messages = Array.from({ length: 250 }, (_, index) => ({
    id: `message-${index}`,
    role: 'user' as const,
    content: `turn ${index}`,
    timestamp: index,
  }));
  let storedCap: number | null = null;
  t.mock.method(localStorageAdapter, 'readNumber', () => storedCap);

  // Unset → legacy default of 200.
  const defaultTrimmed = pruneSessionsForStorage([makeSession('cap-default', 1, messages)]);
  assert.equal(defaultTrimmed[0].messages.length, 200);

  // Stored setting drives the trim on the next write.
  storedCap = 60;
  const lowered = pruneSessionsForStorage([makeSession('cap-lowered', 1, messages)]);
  assert.equal(lowered[0].messages.length, 60);
  assert.equal(lowered[0].messages[0].id, 'message-190');

  // Values outside the allowed range clamp to it.
  storedCap = 10;
  const clampedLow = pruneSessionsForStorage([makeSession('cap-clamp-low', 1, messages)]);
  assert.equal(clampedLow[0].messages.length, 50);

  storedCap = 5000;
  const clampedHigh = pruneSessionsForStorage([makeSession('cap-clamp-high', 1, messages)]);
  assert.equal(clampedHigh[0].messages.length, 250);
});

test('writeSessionsForStorage persists per record to IndexedDB and never touches the legacy localStorage key', async (t) => {
  const { writeSessionsForStorage, __flushIdbWritesForTests, __resetIdbPersistenceForTests, getPersistedAiSessionsSnapshot } =
    await import('./aiStateSnapshots');
  __resetIdbPersistenceForTests();
  const idb = installFakeIndexedDb();
  const writeStringKeys: string[] = [];
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: () => true, netcatty: {} },
  });
  const writeString = t.mock.method(localStorageAdapter, 'writeString', (key: string) => {
    writeStringKeys.push(key);
    return true;
  });
  t.mock.method(localStorageAdapter, 'read', () => null);
  try {
    const a = makeSession('chat-a', 2, []);
    const b = makeSession('chat-b', 1, []);
    assert.equal(writeSessionsForStorage([a, b]), true);
    await __flushIdbWritesForTests();
    // Legacy key untouched (read-only fallback for one release).
    assert.deepEqual(writeStringKeys, []);
    assert.deepEqual(
      idb.db.dumpStore('sessions').map((s) => (s as AISession).id).sort(),
      ['chat-a', 'chat-b'],
    );

    // Second write changes only one record: exactly one put, no full rewrite.
    const a2 = { ...a, title: 'renamed' };
    assert.equal(writeSessionsForStorage([a2, b]), true);
    await __flushIdbWritesForTests();
    const sessionOps = idb.db.opCounts.get('sessions')!;
    // 2 puts from the first write + 1 put for the changed record.
    assert.equal(sessionOps.put, 3);
    assert.deepEqual(
      idb.db.dumpStore('sessions').map((s) => (s as AISession).id).sort(),
      ['chat-a', 'chat-b'],
    );
    assert.equal(getPersistedAiSessionsSnapshot().length, 2);
    assert.equal(writeString.mock.callCount(), 0);
  } finally {
    idb.restore();
    __resetIdbPersistenceForTests();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  }
});

test('count-cap eviction writes a pre-eviction backup generation and removes evicted records', async (t) => {
  const { writeSessionsForStorage, __flushIdbWritesForTests, __resetIdbPersistenceForTests, __resetBackupMirrorForTests, flushBackupMirror } =
    await import('./aiStateSnapshots');
  __resetIdbPersistenceForTests();
  __resetBackupMirrorForTests();
  const idb = installFakeIndexedDb();
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
  t.mock.method(localStorageAdapter, 'read', () => null);
  t.mock.method(localStorageAdapter, 'writeString', () => true);
  try {
    // Round 1: 1000 sessions fit the cap and are all persisted.
    const round1 = Array.from({ length: 1000 }, (_, index) =>
      makeSession(`session-${index}`, index + 1, []));
    assert.equal(writeSessionsForStorage(round1), true);
    await __flushIdbWritesForTests();
    const postRound1 = backupWrites.length;
    flushBackupMirror();
    assert.equal(backupWrites.length, postRound1 + 1);

    // Round 2: one newer session pushes the oldest past the cap.
    const round2 = [makeSession('session-newest', 10_000, []), ...round1];
    assert.equal(writeSessionsForStorage(round2), true);
    await __flushIdbWritesForTests();
    flushBackupMirror();

    // A pre-eviction generation was written immediately, before the
    // debounced post-write mirror, and contains the evicted chat.
    const preEviction = backupWrites[backupWrites.length - 2];
    assert.ok(preEviction.includes('"session-0"'));
    // The post-write mirror no longer carries the evicted chat.
    const postWrite = backupWrites[backupWrites.length - 1];
    assert.equal(postWrite.includes('"session-0"'), false);
    assert.ok(postWrite.includes('"session-newest"'));

    // The evicted record is gone from IndexedDB; the newcomer is present.
    const persistedIds = idb.db.dumpStore('sessions').map((s) => (s as AISession).id);
    assert.equal(persistedIds.includes('session-0'), false);
    assert.equal(persistedIds.includes('session-newest'), true);
    assert.equal(persistedIds.length, 1000);
  } finally {
    idb.restore();
    __resetIdbPersistenceForTests();
    __resetBackupMirrorForTests();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  }
});

test('pending disk recovery suppresses queued, ordinary and pre-eviction backup generations', async (t) => {
  const { writeSessionsForStorage, __flushIdbWritesForTests, __resetIdbPersistenceForTests, __resetBackupMirrorForTests,
    flushBackupMirror, scheduleBackupMirror, setAiSessionsBackupRecoveryPending } = await import('./aiStateSnapshots');
  __resetIdbPersistenceForTests();
  __resetBackupMirrorForTests();
  const idb = installFakeIndexedDb();
  const backupWrites: string[] = [];
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      netcatty: {
        aiSessionsBackupWrite: async ({ json }: { json: string }) => {
          backupWrites.push(json);
          return { ok: true };
        },
      },
    },
  });
  t.mock.method(localStorageAdapter, 'read', () => null);
  try {
    scheduleBackupMirror('queued partial backup');
    setAiSessionsBackupRecoveryPending(true);
    flushBackupMirror();
    assert.deepEqual(backupWrites, []);

    const sessions = Array.from({ length: 1000 }, (_, index) => makeSession(`session-${index}`, index + 1, []));
    writeSessionsForStorage(sessions);
    await __flushIdbWritesForTests();
    flushBackupMirror();
    const overCap = [makeSession('newest', 10_000, []), ...sessions];
    writeSessionsForStorage(overCap);
    await __flushIdbWritesForTests();
    flushBackupMirror();
    assert.deepEqual(backupWrites, [], 'neither debounced nor immediate writes may rotate recovery generations');
    assert.equal(idb.db.dumpStore('sessions').length, 1000, 'IndexedDB writes continue during recovery');

    setAiSessionsBackupRecoveryPending(false);
    scheduleBackupMirror(JSON.stringify(overCap));
    flushBackupMirror();
    assert.deepEqual(backupWrites, [JSON.stringify(overCap)]);
  } finally {
    idb.restore();
    __resetIdbPersistenceForTests();
    __resetBackupMirrorForTests();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  }
});

test('explicitly deleted sessions do not trigger the pre-eviction generation', async (t) => {
  const { writeSessionsForStorage, __flushIdbWritesForTests, __resetIdbPersistenceForTests, __resetBackupMirrorForTests, flushBackupMirror, cleanupDeletedAIChatSessions } =
    await import('./aiStateSnapshots');
  __resetIdbPersistenceForTests();
  __resetBackupMirrorForTests();
  const idb = installFakeIndexedDb();
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
        aiSdkAgentCleanup: async () => ({ ok: true }),
        deleteChatToolOutputsTemp: async () => ({ deletedCount: 1 }),
      },
    },
  });
  t.mock.method(localStorageAdapter, 'read', () => null);
  t.mock.method(localStorageAdapter, 'writeString', () => true);
  try {
    const a = makeSession('chat-a', 2, []);
    const b = makeSession('chat-b', 1, []);
    assert.equal(writeSessionsForStorage([a, b]), true);
    await __flushIdbWritesForTests();
    flushBackupMirror();
    const writesAfterFirst = backupWrites.length;

    // User deletes chat-b: the drop is intentional, so no extra (immediate)
    // generation is written — only the regular debounced post-write mirror.
    cleanupDeletedAIChatSessions(['chat-b']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(writeSessionsForStorage([a]), true);
    await __flushIdbWritesForTests();
    flushBackupMirror();
    assert.equal(backupWrites.length, writesAfterFirst + 1);
    const persistedIds = idb.db.dumpStore('sessions').map((s) => (s as AISession).id);
    assert.deepEqual(persistedIds, ['chat-a']);
  } finally {
    idb.restore();
    __resetIdbPersistenceForTests();
    __resetBackupMirrorForTests();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  }
});

test('synced history persists without pruning and without legacy localStorage writes', async (t) => {
  const { writeSessionsForStorage, __flushIdbWritesForTests, __resetIdbPersistenceForTests, getPersistedAiSessionsSnapshot } =
    await import('./aiStateSnapshots');
  __resetIdbPersistenceForTests();
  const idb = installFakeIndexedDb();
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: () => true, netcatty: {} },
  });
  t.mock.method(localStorageAdapter, 'read', () => ({ enabled: true }));
  const writeString = t.mock.method(localStorageAdapter, 'writeString', () => true);
  try {
    const many = Array.from({ length: 51 }, (_, index) => ({
      ...makeSession(`chat-${index}`, index, []),
      messages: Array.from({ length: 201 }, (_, turn) => ({
        id: `m-${turn}`,
        role: 'user' as const,
        content: 'History',
        timestamp: turn,
      })),
    })) as AISession[];
    assert.equal(writeSessionsForStorage(many), true);
    await __flushIdbWritesForTests();
    // Synced records are authoritative: no pruning, no legacy writes.
    const persisted = getPersistedAiSessionsSnapshot();
    assert.equal(persisted.length, 51);
    assert.equal(persisted[0].messages.length, 201);
    assert.equal(writeString.mock.callCount(), 0);
    assert.equal(idb.db.dumpStore('sessions').length, 51);
  } finally {
    idb.restore();
    __resetIdbPersistenceForTests();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  }
});

test('getPersistedAiSessionsSnapshot falls back to the read-only legacy store when nothing was persisted', async (t) => {
  const { __resetIdbPersistenceForTests, getPersistedAiSessionsSnapshot } = await import('./aiStateSnapshots');
  __resetIdbPersistenceForTests();
  const legacy = [makeSession('legacy-chat', 1, [])];
  t.mock.method(localStorageAdapter, 'readString', () => JSON.stringify(legacy));
  assert.deepEqual(getPersistedAiSessionsSnapshot(), legacy);
  __resetIdbPersistenceForTests();
});

test('IndexedDB sync failures fall back to a legacy localStorage write and never throw', async (t) => {
  const { writeSessionsForStorage, __flushIdbWritesForTests, __resetIdbPersistenceForTests } = await import('./aiStateSnapshots');
  __resetIdbPersistenceForTests();
  const idb = installFakeIndexedDb({ failOpen: true });
  const previousWindow = globalThis.window;
  const legacyWrites: Array<{ key: string; value: string }> = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: () => true, netcatty: {} },
  });
  t.mock.method(localStorageAdapter, 'read', () => null);
  t.mock.method(localStorageAdapter, 'writeString', (key: string, value: string) => {
    legacyWrites.push({ key, value });
    return true;
  });
  try {
    const a = makeSession('chat-a', 1, []);
    assert.equal(writeSessionsForStorage([a]), true);
    await __flushIdbWritesForTests();
    assert.equal(legacyWrites.length, 1);
    assert.equal(legacyWrites[0].key, 'netcatty_ai_sessions_v1');
    assert.deepEqual(
      (JSON.parse(legacyWrites[0].value) as AISession[]).map((s) => s.id),
      ['chat-a'],
    );
  } finally {
    idb.restore();
    __resetIdbPersistenceForTests();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  }
});

test('a thrown sync flag read reports failure without throwing', async (t) => {
  const { writeSessionsForStorage, __resetIdbPersistenceForTests } = await import('./aiStateSnapshots');
  __resetIdbPersistenceForTests();
  t.mock.method(localStorageAdapter, 'read', () => {
    throw new Error('storage probe failed');
  });
  assert.equal(writeSessionsForStorage([makeSession('chat-a', 1, [])]), false);
  __resetIdbPersistenceForTests();
});

test('store writes schedule a throttled disk backup mirror of the persisted set', async (t) => {
  const { writeSessionsForStorage, flushBackupMirror, __resetBackupMirrorForTests, __resetIdbPersistenceForTests } =
    await import('./aiStateSnapshots');
  __resetBackupMirrorForTests();
  __resetIdbPersistenceForTests();
  const idb = installFakeIndexedDb();
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
  const writeString = t.mock.method(localStorageAdapter, 'writeString', () => true);
  t.mock.method(localStorageAdapter, 'read', () => null);
  try {
    const sessions = [makeSession('chat-a', 2, []), makeSession('chat-b', 1, [])];
    assert.equal(writeSessionsForStorage(sessions), true);
    // Throttled: nothing has been written to disk yet.
    assert.equal(backupWrites.length, 0);
    flushBackupMirror();
    assert.equal(backupWrites.length, 1);
    // The mirror carries the persisted set (no byte-budget degradation any
    // more) and no legacy localStorage write happened.
    assert.deepEqual(
      (JSON.parse(backupWrites[0]) as AISession[]).map((s) => s.id),
      ['chat-a', 'chat-b'],
    );
    assert.equal(writeString.mock.callCount(), 0);
  } finally {
    idb.restore();
    __resetBackupMirrorForTests();
    __resetIdbPersistenceForTests();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
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

test('rewriting the same sessions array skips re-serialization and store writes', async (t) => {
  const { writeSessionsForStorage, seedLastPersistedSessions, __flushIdbWritesForTests, __resetIdbPersistenceForTests } =
    await import('./aiStateSnapshots');
  __resetIdbPersistenceForTests();
  const idb = installFakeIndexedDb();
  try {
    const sessions = freezeHistory(makePersistenceHistory(3, 10));
    t.mock.method(localStorageAdapter, 'read', () => ({ enabled: true }));
    const writeString = t.mock.method(localStorageAdapter, 'writeString', () => true);
    assert.equal(writeSessionsForStorage(sessions), true);
    await __flushIdbWritesForTests();
    const putsAfterFirst = idb.db.opCounts.get('sessions')!.put;
    const stringify = t.mock.method(JSON, 'stringify');
    // Cloud-sync collection writes the same immutable array again: no
    // re-serialization and no additional record writes (issue #4123 keeps
    // the #4121 skip, now backed by the per-record diff).
    assert.equal(writeSessionsForStorage(sessions), true);
    await __flushIdbWritesForTests();
    assert.equal(stringify.mock.callCount(), 0);
    assert.equal(idb.db.opCounts.get('sessions')!.put, putsAfterFirst);
    assert.equal(writeString.mock.callCount(), 0);
    // A cross-window write replaced the diff baseline (different record
    // instances): the next write persists the changed records again.
    seedLastPersistedSessions(sessions.map(session => ({ ...session })));
    assert.equal(writeSessionsForStorage(sessions), true);
    await __flushIdbWritesForTests();
    assert.ok(idb.db.opCounts.get('sessions')!.put > putsAfterFirst);
  } finally {
    idb.restore();
    __resetIdbPersistenceForTests();
  }
});
