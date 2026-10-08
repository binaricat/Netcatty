import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TOOL_OUTPUT_ALIAS_MATERIALIZATION_RETRY_DELAY_MS,
  TOOL_OUTPUT_MAX_CLOSED_TERMINAL_SESSIONS,
  TOOL_OUTPUT_MAX_FAILED_SESSION_DELETIONS,
  TOOL_OUTPUT_MAX_PENDING_ALIAS_MATERIALIZATIONS,
  TOOL_OUTPUT_MAX_PENDING_ALIAS_RESTORES,
  TOOL_OUTPUT_READ_MAX_CHARS,
  type PersistedToolOutputRecord,
  type ToolOutputPersistence,
  ToolOutputStore,
} from './toolOutputStore';
import { ToolResultDedup } from './toolResultDedup';

test('ToolOutputStore stores and reads truncated output by handle', () => {
  const store = new ToolOutputStore();
  const handle = store.store({
    chatSessionId: 'chat-1',
    capabilityId: 'terminal.execute',
    sessionId: 'sess-1',
    content: 'A'.repeat(50_000),
  });

  assert.ok(handle.id.startsWith('tool-output-'));
  assert.equal(handle.totalChars, 50_000);

  const head = store.read({ handleId: handle.id, mode: 'head', maxChars: 100 }, 'chat-1');
  assert.equal(head?.length, 100);

  const tail = store.read({ handleId: handle.id, mode: 'tail', maxChars: 50 }, 'chat-1');
  assert.equal(tail?.length, 50);
  assert.equal(tail, 'A'.repeat(50));

  store.prune('chat-1');
  assert.equal(store.read({ handleId: handle.id }, 'chat-1'), null);
});

test('ToolOutputStore pages large output with a hard per-read cap', () => {
  const store = new ToolOutputStore();
  const content = `${'0123456789'.repeat(3_000)}END`;
  const handle = store.store({
    chatSessionId: 'chat-1',
    capabilityId: 'terminal.execute',
    content,
  });

  const first = store.readChunk({
    handleId: handle.id,
    mode: 'range',
    maxChars: content.length,
  }, 'chat-1');
  assert.equal(first?.content.length, TOOL_OUTPUT_READ_MAX_CHARS);
  assert.equal(first?.nextOffset, TOOL_OUTPUT_READ_MAX_CHARS);
  assert.equal(first?.hasMore, true);

  const second = store.readChunk({
    handleId: handle.id,
    mode: 'range',
    offset: first?.nextOffset,
  }, 'chat-1');
  assert.equal(second?.startOffset, first?.nextOffset);
});

test('ToolOutputStore searches stored output without returning the whole body', () => {
  const store = new ToolOutputStore();
  const handle = store.store({
    chatSessionId: 'chat-1',
    capabilityId: 'terminal.execute',
    content: `${'noise\n'.repeat(10_000)}Unique Failure Marker\n${'more noise\n'.repeat(10_000)}`,
  });

  const result = store.readChunk({
    handleId: handle.id,
    mode: 'search',
    query: 'unique failure marker',
  }, 'chat-1');
  assert.deepEqual(result?.matchOffsets.length, 1);
  assert.match(result?.content ?? '', /Unique Failure Marker/);
  assert.ok((result?.content.length ?? Infinity) < TOOL_OUTPUT_READ_MAX_CHARS);
});

test('ToolOutputStore search advances only past matches included in the response', () => {
  const store = new ToolOutputStore();
  const handle = store.store({
    chatSessionId: 'chat-1',
    capabilityId: 'terminal.execute',
    content: 'match middle match tail',
  });

  const first = store.readChunk({
    handleId: handle.id,
    mode: 'search',
    query: 'match',
    maxChars: 1,
  }, 'chat-1');
  assert.doesNotMatch(first?.content ?? '', /No matches found/);
  assert.deepEqual(first?.matchOffsets, [0]);
  assert.equal(first?.nextOffset, 5);
  assert.equal(first?.hasMore, true);

  const second = store.readChunk({
    handleId: handle.id,
    mode: 'search',
    query: 'match',
    offset: first?.nextOffset,
    maxChars: 30,
  }, 'chat-1');
  assert.deepEqual(second?.matchOffsets, [13]);
});

test('ToolOutputStore never splits a Unicode surrogate pair at page boundaries', () => {
  const store = new ToolOutputStore();
  const content = `${'a'.repeat(11_999)}😀中文结尾`;
  const handle = store.store({
    chatSessionId: 'chat-1',
    capabilityId: 'terminal.execute',
    content,
  });

  const first = store.readChunk({ handleId: handle.id, mode: 'range' }, 'chat-1');
  assert.equal(first?.content.endsWith('\ud83d'), false);
  const second = store.readChunk({
    handleId: handle.id,
    mode: 'range',
    offset: first?.nextOffset,
  }, 'chat-1');
  assert.equal(`${first?.content}${second?.content}`, content);
});

test('ToolOutputStore enforces per-handle, session count, and TTL limits', () => {
  let now = 1_000;
  const store = new ToolOutputStore({
    maxHandleChars: 20,
    maxHandlesPerSession: 2,
    maxCharsPerSession: 30,
    ttlMs: 100,
    now: () => now,
  });
  const first = store.store({ chatSessionId: 'chat-1', capabilityId: 'test', content: 'a'.repeat(15) });
  const second = store.store({ chatSessionId: 'chat-1', capabilityId: 'test', content: 'b'.repeat(15) });
  const third = store.store({ chatSessionId: 'chat-1', capabilityId: 'test', content: 'c'.repeat(100) });

  assert.equal(store.get(first.id, 'chat-1'), undefined);
  assert.equal(store.get(second.id, 'chat-1'), undefined);
  assert.equal(store.get(third.id, 'chat-1')?.storedChars, 20);
  assert.equal(store.get(third.id, 'chat-1')?.sourceTruncated, true);

  now += 101;
  assert.equal(store.get(third.id, 'chat-1'), undefined);
});

test('ToolOutputStore spills retained output through its persistence adapter', async () => {
  const files = new Map<string, string>();
  const deleted: string[] = [];
  const store = new ToolOutputStore({
    spillThresholdChars: 10,
    persistence: {
      write: async (_record, content) => {
        files.set('/netcatty/tool-output.log', content);
        return '/netcatty/tool-output.log';
      },
      read: async (path, input) => {
        const content = files.get(path);
        if (content == null) return null;
        const startOffset = input.mode === 'tail'
          ? Math.max(0, content.length - (input.maxChars ?? 12_000))
          : Math.max(0, input.offset ?? 0);
        const selected = content.slice(startOffset, startOffset + (input.maxChars ?? 12_000));
        const endOffset = startOffset + selected.length;
        return {
          mode: input.mode ?? 'head',
          content: selected,
          totalChars: content.length,
          startOffset,
          endOffset,
          nextOffset: endOffset,
          hasMore: endOffset < content.length,
        };
      },
      delete: async path => {
        deleted.push(path);
        files.delete(path);
      },
    },
  });
  const handle = store.store({
    chatSessionId: 'chat-1',
    capabilityId: 'terminal.execute',
    content: 'persist this terminal output',
  });

  const result = await store.readChunkAsync({ handleId: handle.id, mode: 'full' }, 'chat-1');
  assert.equal(result?.content, 'persist this terminal output');
  assert.equal(store.get(handle.id, 'chat-1')?.fullContent, undefined);
  store.prune('chat-1');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(deleted, ['/netcatty/tool-output.log']);
});

test('ToolOutputStore restores a durable handle after a runtime restart', async () => {
  const files = new Map<string, { record: PersistedToolOutputRecord; content: string }>();
  const persistence: ToolOutputPersistence = {
    write: async (record, content) => {
      const path = `/netcatty/${record.handleId}.log`;
      files.set(path, { record, content });
      return path;
    },
    restore: async (handleId, chatSessionId) => {
      for (const [path, entry] of files) {
        if (entry.record.handleId !== handleId || entry.record.chatSessionId !== chatSessionId) continue;
        return { path, record: entry.record };
      }
      return null;
    },
    read: async (path, input) => {
      const content = files.get(path)?.content;
      if (content == null) return null;
      const startOffset = input.mode === 'tail'
        ? Math.max(0, content.length - (input.maxChars ?? 12_000))
        : Math.max(0, input.offset ?? 0);
      const selected = content.slice(startOffset, startOffset + (input.maxChars ?? 12_000));
      const endOffset = startOffset + selected.length;
      return {
        mode: input.mode ?? 'head',
        content: selected,
        totalChars: content.length,
        startOffset,
        endOffset,
        nextOffset: endOffset,
        hasMore: endOffset < content.length,
      };
    },
    delete: async path => {
      files.delete(path);
    },
  };

  const beforeRestart = new ToolOutputStore({ spillThresholdChars: 0, persistence });
  const saved = beforeRestart.store({
    chatSessionId: 'chat-restart',
    capabilityId: 'terminal.execute',
    sessionId: 'terminal-1',
    content: 'restart evidence in the middle',
  });
  await saved.spillPromise;

  const afterRestart = new ToolOutputStore({ spillThresholdChars: 0, persistence });
  const restored = await afterRestart.readChunkAsync({
    handleId: saved.id,
    mode: 'search',
    query: 'evidence',
  }, 'chat-restart');

  assert.match(restored?.content ?? '', /restart evidence/);
  assert.equal(afterRestart.get(saved.id, 'chat-restart')?.sessionId, 'terminal-1');
  assert.equal(await afterRestart.readChunkAsync({ handleId: saved.id }, 'chat-other'), null);
});

test('ToolOutputStore drops a restored handle when its durable file is missing', async () => {
  const record: PersistedToolOutputRecord = {
    schemaVersion: 1,
    handleId: 'tool-output-missing',
    chatSessionId: 'chat-1',
    capabilityId: 'terminal.execute',
    totalChars: 100,
    storedChars: 100,
    sourceTruncated: false,
    preview: 'preview',
    storedAt: 1,
    accessedAt: 1,
  };
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async () => ({ path: '/missing.log', record }),
      read: async () => null,
      delete: async () => {},
    },
  });

  assert.equal(await store.readChunkAsync({ handleId: record.handleId }, 'chat-1'), null);
  assert.equal(store.listPendingHandles('chat-1').length, 0);
});

test('ToolOutputStore can delete durable handles for a chat that was never restored', async () => {
  const deletedSessions: string[] = [];
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async () => null,
      read: async () => null,
      delete: async () => {},
      deleteSession: async chatSessionId => {
        deletedSessions.push(chatSessionId);
      },
    },
  });

  store.prune('chat-after-restart');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(deletedSessions, ['chat-after-restart']);
});

test('ToolOutputStore can delete durable terminal handles that were never restored', async () => {
  const deletedTerminalSessions: Array<[string, string]> = [];
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async () => null,
      read: async () => null,
      delete: async () => {},
      deleteTerminalSession: async (chatSessionId, terminalSessionId) => {
        deletedTerminalSessions.push([chatSessionId, terminalSessionId]);
      },
    },
  });

  store.pruneTerminalSession('chat-after-restart', 'terminal-closed');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(deletedTerminalSessions, [['chat-after-restart', 'terminal-closed']]);
});

test('ToolOutputStore deletes unopened durable handles when a terminal closes', async () => {
  const deletedTerminals: string[] = [];
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/tmp/unused',
      read: async () => null,
      delete: async () => {},
      deleteTerminalEverywhere: async terminalSessionId => {
        deletedTerminals.push(terminalSessionId);
      },
    },
  });

  store.pruneTerminalSessionEverywhere('terminal-unopened-after-restart');
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.deepEqual(deletedTerminals, ['terminal-unopened-after-restart']);
});

test('ToolOutputStore does not persist output that arrives after its terminal closed', async () => {
  let writes = 0;
  const store = new ToolOutputStore({
    persistence: {
      write: async () => {
        writes += 1;
        return '/late.log';
      },
      read: async () => null,
      delete: async () => {},
      deleteTerminalSession: async () => {},
    },
  });

  store.pruneTerminalSessionEverywhere('terminal-closed-before-output');
  const lateHandle = store.store({
    chatSessionId: 'chat-late-output',
    capabilityId: 'terminal.execute',
    sessionId: 'terminal-closed-before-output',
    content: 'late output',
  });
  await store.flush('chat-late-output');

  assert.equal(writes, 0);
  assert.equal(store.listPendingHandles('chat-late-output').length, 0);
  assert.equal(await store.readChunkAsync({ handleId: lateHandle.id }, 'chat-late-output'), null);
});

test('ToolOutputStore does not resurrect a handle when its chat is deleted during restore', async () => {
  let finishRestore!: (value: { path: string; record: PersistedToolOutputRecord }) => void;
  const restoreFinished = new Promise<{ path: string; record: PersistedToolOutputRecord }>(resolve => {
    finishRestore = resolve;
  });
  const deletedPaths: string[] = [];
  const record: PersistedToolOutputRecord = {
    schemaVersion: 1,
    handleId: 'tool-output-racing-restore',
    chatSessionId: 'chat-racing-restore',
    capabilityId: 'terminal.execute',
    totalChars: 7,
    storedChars: 7,
    sourceTruncated: false,
    preview: 'private',
    storedAt: 1,
    accessedAt: 1,
  };
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async () => restoreFinished,
      read: async () => ({
        mode: 'head', content: 'private', totalChars: 7, startOffset: 0, endOffset: 7, nextOffset: 7, hasMore: false,
      }),
      delete: async path => {
        deletedPaths.push(path);
      },
      deleteSession: async () => {},
    },
  });

  const reading = store.readChunkAsync({ handleId: record.handleId }, record.chatSessionId);
  store.prune(record.chatSessionId);
  finishRestore({ path: '/netcatty/racing.log', record });

  assert.equal(await reading, null);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(deletedPaths, ['/netcatty/racing.log']);
  assert.equal(store.listPendingHandles(record.chatSessionId).length, 0);
});

test('ToolOutputStore waits for chat deletion before starting a later restore', async () => {
  let finishDeletion!: () => void;
  const deletionFinished = new Promise<void>(resolve => {
    finishDeletion = resolve;
  });
  let restoreCalls = 0;
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async () => {
        restoreCalls += 1;
        return null;
      },
      read: async () => null,
      delete: async () => {},
      deleteSession: async () => deletionFinished,
    },
  });

  store.prune('chat-delete-window');
  const reading = store.readChunkAsync({ handleId: 'old-handle' }, 'chat-delete-window');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(restoreCalls, 0);

  finishDeletion();
  assert.equal(await reading, null);
  assert.equal(restoreCalls, 1);
});

test('ToolOutputStore does not resurrect an old handle when its terminal is deleted during restore', async () => {
  let finishRestore!: (value: { path: string; record: PersistedToolOutputRecord }) => void;
  const restoreFinished = new Promise<{ path: string; record: PersistedToolOutputRecord }>(resolve => {
    finishRestore = resolve;
  });
  const deletedPaths: string[] = [];
  const record: PersistedToolOutputRecord = {
    schemaVersion: 1,
    handleId: 'tool-output-terminal-race',
    chatSessionId: 'chat-terminal-race',
    capabilityId: 'terminal.execute',
    terminalSessionId: 'terminal-race',
    totalChars: 7,
    storedChars: 7,
    sourceTruncated: false,
    preview: 'private',
    storedAt: 1,
    accessedAt: 1,
  };
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/new-output.log',
      restore: async () => restoreFinished,
      read: async () => null,
      delete: async path => {
        deletedPaths.push(path);
      },
      deleteTerminalSession: async () => {},
    },
  });

  const reading = store.readChunkAsync({ handleId: record.handleId }, record.chatSessionId);
  store.pruneTerminalSessionEverywhere(record.terminalSessionId!);
  store.store({
    chatSessionId: record.chatSessionId,
    capabilityId: 'terminal.execute',
    sessionId: record.terminalSessionId,
    content: 'new output',
  });
  finishRestore({ path: '/netcatty/old-output.log', record });

  assert.equal(await reading, null);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(deletedPaths.includes('/netcatty/old-output.log'));
  assert.equal(store.get(record.handleId, record.chatSessionId), undefined);
});

test('ToolOutputStore keeps restoring one terminal when a different terminal is deleted', async () => {
  let finishRestore!: (value: { path: string; record: PersistedToolOutputRecord }) => void;
  const restoreFinished = new Promise<{ path: string; record: PersistedToolOutputRecord }>(resolve => {
    finishRestore = resolve;
  });
  const record: PersistedToolOutputRecord = {
    schemaVersion: 1,
    handleId: 'tool-output-terminal-b',
    chatSessionId: 'chat-two-terminals',
    capabilityId: 'terminal.execute',
    terminalSessionId: 'terminal-b',
    totalChars: 8,
    storedChars: 8,
    sourceTruncated: false,
    preview: 'terminal',
    storedAt: 1,
    accessedAt: 1,
  };
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async () => restoreFinished,
      read: async () => ({
        mode: 'head', content: 'terminal', totalChars: 8, startOffset: 0, endOffset: 8, nextOffset: 8, hasMore: false,
      }),
      delete: async () => {},
      deleteTerminalSession: async () => {},
    },
  });

  const reading = store.readChunkAsync({ handleId: record.handleId }, record.chatSessionId);
  store.pruneTerminalSession(record.chatSessionId, 'terminal-a');
  finishRestore({ path: '/netcatty/terminal-b.log', record });

  assert.equal((await reading)?.content, 'terminal');
});

test('ToolOutputStore can restore a durable handle after its in-memory cache expires', async () => {
  let now = 1_000;
  const files = new Map<string, { record: PersistedToolOutputRecord; content: string }>();
  const persistence: ToolOutputPersistence = {
    write: async (record, content) => {
      const path = `/netcatty/${record.handleId}.log`;
      files.set(path, { record, content });
      return path;
    },
    restore: async (handleId, chatSessionId) => {
      for (const [path, entry] of files) {
        if (entry.record.handleId === handleId && entry.record.chatSessionId === chatSessionId) {
          return { path, record: entry.record };
        }
      }
      return null;
    },
    read: async (path, input) => {
      const content = files.get(path)?.content;
      if (content == null) return null;
      return {
        mode: input.mode ?? 'head',
        content,
        totalChars: content.length,
        startOffset: 0,
        endOffset: content.length,
        nextOffset: content.length,
        hasMore: false,
      };
    },
    delete: async path => {
      files.delete(path);
    },
  };
  const store = new ToolOutputStore({ ttlMs: 100, now: () => now, persistence });
  const handle = store.store({ chatSessionId: 'chat-1', capabilityId: 'test', content: 'durable' });
  await handle.spillPromise;
  now += 101;

  const restored = await store.readChunkAsync({ handleId: handle.id }, 'chat-1');
  assert.equal(restored?.content, 'durable');
});

test('ToolOutputStore flush waits until a handle is durable before a tool can return it', async () => {
  let finishWrite!: (path: string) => void;
  const writeFinished = new Promise<string>(resolve => {
    finishWrite = resolve;
  });
  const store = new ToolOutputStore({
    persistence: {
      write: async () => writeFinished,
      restore: async () => null,
      read: async () => null,
      delete: async () => {},
    },
  });
  const handle = store.store({ chatSessionId: 'chat-1', capabilityId: 'test', content: 'persist me' });
  let flushed = false;
  const flushing = store.flush('chat-1').then(() => {
    flushed = true;
  });

  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(flushed, false);
  finishWrite('/netcatty/durable.log');
  await flushing;
  assert.equal(handle.filePath, '/netcatty/durable.log');
});

test('ToolOutputStore reports restart persistence only after the individual spill succeeds', async () => {
  let failWrite = true;
  const store = new ToolOutputStore({
    persistence: {
      write: async () => {
        if (failWrite) throw new Error('disk full');
        return '/netcatty/durable.log';
      },
      restore: async () => null,
      read: async () => null,
      delete: async () => {},
    },
  });
  const failed = store.store({ chatSessionId: 'chat-1', capabilityId: 'test', content: 'memory only' });
  const failedNotice = `[output handle: handleId=${failed.id} restartPersistence=unavailable (read before closing the app)]`;
  await store.flush('chat-1');
  assert.equal(store.resolveRestartPersistenceNotices(failedNotice, 'chat-1'), failedNotice);

  failWrite = false;
  const durable = store.store({ chatSessionId: 'chat-1', capabilityId: 'test', content: 'saved' });
  const durableNotice = `[output handle: handleId=${durable.id} restartPersistence=unavailable (read before closing the app)]`;
  await store.flush('chat-1');
  assert.equal(
    store.resolveRestartPersistenceNotices(durableNotice, 'chat-1'),
    `[output handle: handleId=${durable.id}]`,
  );
});

test('ToolOutputStore enforces a shared quota across chat sessions', () => {
  const store = new ToolOutputStore({
    maxCharsGlobal: 25,
    maxHandlesGlobal: 2,
  });
  const first = store.store({ chatSessionId: 'chat-1', capabilityId: 'test', content: 'a'.repeat(15) });
  const second = store.store({ chatSessionId: 'chat-2', capabilityId: 'test', content: 'b'.repeat(15) });

  assert.equal(store.get(first.id, 'chat-1'), undefined);
  assert.ok(store.get(second.id, 'chat-2'));
});

test('ToolOutputStore rejects cross-chat handle reads', async () => {
  const store = new ToolOutputStore();
  const handle = store.store({
    chatSessionId: 'chat-owner',
    capabilityId: 'terminal.execute',
    content: 'private output',
  });

  assert.equal(await store.readChunkAsync({ handleId: handle.id }, 'chat-other'), null);
});

test('ToolOutputStore aliases session handles so a branched chat keeps reading them', async () => {
  const store = new ToolOutputStore();
  const spilled = store.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'A'.repeat(50_000),
  });
  const inMemory = store.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'exact detail',
  });
  await store.flush('chat-source');

  await store.aliasSessionHandles('chat-source', 'chat-branch');

  const aliasSpilled = await store.readChunkAsync({ handleId: spilled.id }, 'chat-branch');
  assert.equal(aliasSpilled?.content.length, TOOL_OUTPUT_READ_MAX_CHARS);
  assert.equal(aliasSpilled?.totalChars, 50_000);
  const aliasInMemory = await store.readChunkAsync({ handleId: inMemory.id }, 'chat-branch');
  assert.equal(aliasInMemory?.content, 'exact detail');
  assert.deepEqual(
    store.listPendingHandles('chat-branch').map(handle => handle.id).sort(),
    [spilled.id, inMemory.id].sort(),
  );

  // New handles stored in the source stay out of the branch.
  store.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'after undo',
  });
  assert.equal(
    store.listPendingHandles('chat-branch').some(handle => handle.preview === 'after undo'),
    false,
  );
});

test('ToolOutputStore aliasing is idempotent and blocked for pruned chats', async () => {
  const store = new ToolOutputStore();
  const handle = store.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'kept',
  });

  await store.aliasSessionHandles('chat-source', 'chat-branch');
  await store.aliasSessionHandles('chat-source', 'chat-branch');
  assert.equal(store.read({ handleId: handle.id }, 'chat-branch'), 'kept');
  assert.equal(store.listPendingHandles('chat-branch').length, 1);

  // A deleted chat must not be resurrected by later aliasing.
  store.prune('chat-branch');
  await store.aliasSessionHandles('chat-source', 'chat-branch');
  assert.equal(store.read({ handleId: handle.id }, 'chat-branch'), null);
});

test('ToolOutputStore aliases only the retained prefix of a branched chat', async () => {
  const store = new ToolOutputStore();
  const kept = store.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'kept by retained prefix',
  });
  const removed = store.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'created by the undone turn',
  });

  await store.aliasSessionHandles('chat-source', 'chat-branch', {
    retainedHandleIds: new Set([kept.id]),
  });

  assert.equal(store.read({ handleId: kept.id }, 'chat-branch'), 'kept by retained prefix');
  assert.equal(store.listPendingHandles('chat-branch').some(handle => handle.id === kept.id), true);
  // Handles created by the removed turn must not be advertised to the branch.
  assert.equal(store.listPendingHandles('chat-branch').some(handle => handle.id === removed.id), false);
  assert.equal(store.get(removed.id, 'chat-branch'), undefined);
  assert.equal(store.read({ handleId: removed.id }, 'chat-branch'), null);
});

function createFakeToolOutputPersistence(): ToolOutputPersistence & {
  entries: Map<string, { record: PersistedToolOutputRecord; content: string; path: string }>;
} {
  const entries = new Map<string, { record: PersistedToolOutputRecord; content: string; path: string }>();
  let fileCounter = 0;
  return {
    entries,
    write: async (record, content) => {
      const path = `/tmp/fake-tool-output-${++fileCounter}.log`;
      entries.set(`${record.chatSessionId}:${record.handleId}`, { record, content, path });
      return path;
    },
    restore: async (handleId, chatSessionId) => {
      const entry = entries.get(`${chatSessionId}:${handleId}`);
      return entry ? { path: entry.path, record: entry.record } : null;
    },
    read: async (path, request) => {
      const entry = [...entries.values()].find(candidate => candidate.path === path);
      if (!entry) return null;
      const mode = request.mode ?? 'head';
      const maxChars = Math.min(
        TOOL_OUTPUT_READ_MAX_CHARS,
        Math.max(1, Math.floor(request.maxChars ?? TOOL_OUTPUT_READ_MAX_CHARS)),
      );
      let start = 0;
      if (mode === 'tail') start = Math.max(0, entry.content.length - maxChars);
      else if (mode === 'range') start = Math.min(entry.content.length, Math.max(0, Math.floor(request.offset ?? 0)));
      const content = entry.content.slice(start, start + maxChars);
      const endOffset = start + content.length;
      return {
        mode,
        content,
        totalChars: entry.content.length,
        startOffset: start,
        endOffset,
        nextOffset: endOffset,
        hasMore: endOffset < entry.content.length,
      };
    },
    delete: async () => {},
  };
}

test('ToolOutputStore retries alias materialization after transient persistence failures', async () => {
  const base = createFakeToolOutputPersistence();
  let failingWrites = 2;
  let failingReads = 0;
  const persistence: ToolOutputPersistence & { entries: typeof base.entries } = {
    ...base,
    write: async (record, content) => {
      if (failingWrites > 0) {
        failingWrites -= 1;
        throw new Error('temporarily busy');
      }
      return base.write(record, content);
    },
    read: async (path, request) => {
      if (failingReads > 0) {
        failingReads -= 1;
        throw new Error('temporarily busy');
      }
      return base.read(path, request);
    },
  };
  const store = new ToolOutputStore({ persistence });
  const handle = store.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'A'.repeat(50_000),
  });
  await store.flush('chat-source');

  await store.aliasSessionHandles('chat-source', 'chat-branch', {
    retainedHandleIds: new Set([handle.id]),
  });
  // Both writes failed, so no branch-owned durable copy exists yet.
  assert.equal(persistence.entries.has(`chat-branch:${handle.id}`), false);

  // The queued retries land eventually without a new undo.
  await new Promise(resolve => setTimeout(
    resolve,
    TOOL_OUTPUT_ALIAS_MATERIALIZATION_RETRY_DELAY_MS * 3 + 50,
  ));
  assert.equal(persistence.entries.has(`chat-branch:${handle.id}`), true);
  const restored = await store.readChunkAsync({ handleId: handle.id }, 'chat-branch');
  assert.equal(restored?.content.length, TOOL_OUTPUT_READ_MAX_CHARS);
  assert.equal(restored?.totalChars, 50_000);

  // Deleting the source session must not break the branch read anymore.
  await store.prune('chat-source');
  await new Promise(resolve => setTimeout(resolve, 0));
  const afterDelete = await store.readChunkAsync({ handleId: handle.id }, 'chat-branch');
  assert.ok(afterDelete);
  assert.equal(afterDelete.totalChars, 50_000);
});

test('ToolOutputStore gives branched chats their own durable copies so reads survive a restart', async () => {
  const persistence = createFakeToolOutputPersistence();
  const sourceStore = new ToolOutputStore({ persistence });
  const handle = sourceStore.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'A'.repeat(50_000),
  });
  await sourceStore.flush('chat-source');

  await sourceStore.aliasSessionHandles('chat-source', 'chat-branch', {
    retainedHandleIds: new Set([handle.id]),
  });

  // Simulate an app restart: a fresh store over the same durable storage must
  // restore the branch-owned record, not only the source-owned manifest.
  const restartedStore = new ToolOutputStore({ persistence });
  const restored = await restartedStore.readChunkAsync({ handleId: handle.id }, 'chat-branch');
  assert.ok(restored);
  assert.equal(restored.totalChars, 50_000);
  assert.ok(restored.content.length > 0);

  // The branch owns a separate durable record under its own chat namespace.
  assert.ok(persistence.entries.has(`chat-branch:${handle.id}`));
  assert.ok(persistence.entries.has(`chat-source:${handle.id}`));
});

test('ToolOutputStore keeps referenced branch aliases resolvable beyond the per-session cache cap', async () => {
  // The source's in-memory cache only ever holds at most `maxHandlesPerSession`
  // handles, so a branch whose retained prefix references more of them (the
  // older one still restorable from its durable record after TTL pruning)
  // accumulates aliases beyond the cap. Those aliases must keep resolving in
  // the branch even after the session limit drops them from memory.
  let now = 10_000;
  const persistence = createFakeToolOutputPersistence();
  const store = new ToolOutputStore({
    persistence,
    maxHandlesPerSession: 2,
    ttlMs: 1_000,
    now: () => now,
  });

  const expired = store.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'expired-first-',
  });
  await store.flush('chat-source');

  // Expire the first handle out of memory; a later read (the alias pass)
  // prunes it, keeping its durable record restorable under the source id.
  now = 12_000;
  assert.equal(store.get(expired.id, 'chat-source'), undefined);
  const fresh1 = store.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'fresh-second-output',
  });
  now = 12_001;
  const fresh2 = store.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'fresh-third-output',
  });

  // Restore the expired handle last so the freshly aliased handles overflow
  // the branch's per-session cap.
  now = 12_002;
  await store.aliasSessionHandles('chat-source', 'chat-branch', {
    retainedHandleIds: new Set([fresh1.id, fresh2.id, expired.id]),
  });

  // Every retained reference materialized its own durable record under the
  // branch namespace — including the alias the session cap evicted from
  // memory, which otherwise would permanently return missing in the branch.
  assert.ok(persistence.entries.has(`chat-branch:${fresh1.id}`));
  assert.ok(persistence.entries.has(`chat-branch:${fresh2.id}`));
  assert.ok(persistence.entries.has(`chat-branch:${expired.id}`));

  // The cap still bounds the in-memory cache: only one of the three handles
  // may be evicted, and eviction must keep its branch-owned durable record.
  assert.ok(!store.listPendingHandles('chat-branch').some(handle => handle.id === fresh1.id));
  const restored = await store.readChunkAsync({ handleId: fresh1.id }, 'chat-branch');
  assert.equal(restored?.content, 'fresh-second-output');
  const kept = await store.readChunkAsync({ handleId: fresh2.id }, 'chat-branch');
  assert.equal(kept?.content, 'fresh-third-output');
  const expiredRestored = await store.readChunkAsync({ handleId: expired.id }, 'chat-branch');
  assert.equal(expiredRestored?.content, 'expired-first-');
});

test('ToolOutputStore reclaims chat generations after deletion churn settles', () => {
  const store = new ToolOutputStore();
  for (let index = 0; index < 2_000; index += 1) {
    store.prune(`chat-deleted-${index}`);
  }

  assert.equal(store.getLifecycleMetadataStatsForTests().sessionGenerations, 0);
});

test('ToolOutputStore rejects output that arrives after its chat was deleted', () => {
  const store = new ToolOutputStore();
  store.prune('chat-deleted-before-late-output');

  const lateHandle = store.store({
    chatSessionId: 'chat-deleted-before-late-output',
    capabilityId: 'terminal.execute',
    content: 'late output',
  });

  assert.equal(lateHandle.evicted, true);
  assert.equal(lateHandle.storedChars, 0);
  assert.equal(store.listPendingHandles('chat-deleted-before-late-output').length, 0);
});

test('ToolOutputStore reclaims per-chat terminal deletion metadata after churn settles', () => {
  const store = new ToolOutputStore();
  for (let index = 0; index < 2_000; index += 1) {
    store.pruneTerminalSession(`chat-${index}`, `terminal-${index}`);
  }

  const stats = store.getLifecycleMetadataStatsForTests();
  assert.equal(stats.terminalMutationGenerations, 0);
  assert.equal(stats.deletedTerminalSessions, 0);
});

test('ToolOutputStore bounds closed-terminal tombstones while isolating recent late writes', async () => {
  const store = new ToolOutputStore();
  const churnCount = TOOL_OUTPUT_MAX_CLOSED_TERMINAL_SESSIONS + 2_000;
  for (let index = 0; index < churnCount; index += 1) {
    store.pruneTerminalSessionEverywhere(`terminal-closed-${index}`);
  }

  assert.equal(
    store.getLifecycleMetadataStatsForTests().closedTerminalSessions,
    TOOL_OUTPUT_MAX_CLOSED_TERMINAL_SESSIONS,
  );
  const lateHandle = store.store({
    chatSessionId: 'chat-late-after-churn',
    capabilityId: 'terminal.execute',
    sessionId: `terminal-closed-${churnCount - 1}`,
    content: 'late output after heavy churn',
  });
  assert.equal(lateHandle.evicted, true);
  assert.equal(store.listPendingHandles('chat-late-after-churn').length, 0);
  assert.equal(await store.readChunkAsync({ handleId: lateHandle.id }, 'chat-late-after-churn'), null);
  const oldestLateHandle = store.store({
    chatSessionId: 'chat-oldest-late-after-churn',
    capabilityId: 'terminal.execute',
    sessionId: 'terminal-closed-0',
    content: 'very late output after exact tombstone eviction',
  });
  assert.equal(oldestLateHandle.evicted, true);
  assert.equal(store.listPendingHandles('chat-oldest-late-after-churn').length, 0);
});

test('ToolOutputStore bounds fallback terminal metadata when durable deletion is unavailable', () => {
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async () => null,
      read: async () => null,
      delete: async () => {},
    },
  });
  for (let index = 0; index < 2_000; index += 1) {
    store.pruneTerminalSession(`chat-fallback-${index}`, `terminal-fallback-${index}`);
  }

  const stats = store.getLifecycleMetadataStatsForTests();
  assert.equal(stats.terminalMutationGenerations, TOOL_OUTPUT_MAX_CLOSED_TERMINAL_SESSIONS);
  assert.equal(stats.deletedTerminalSessions, TOOL_OUTPUT_MAX_CLOSED_TERMINAL_SESSIONS);
});

test('ToolOutputStore keeps an in-flight restore tombstone protected during metadata churn', async () => {
  const chatSessionId = 'chat-protected-restore';
  const terminalSessionId = 'terminal-protected-restore';
  const handleId = 'tool-output-protected-restore';
  let finishRestore!: (value: { path: string; record: PersistedToolOutputRecord }) => void;
  const restoreFinished = new Promise<{ path: string; record: PersistedToolOutputRecord }>(resolve => {
    finishRestore = resolve;
  });
  const deletedPaths: string[] = [];
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async (requestedHandleId, requestedChatSessionId) => {
        if (requestedHandleId !== handleId || requestedChatSessionId !== chatSessionId) return null;
        return restoreFinished;
      },
      read: async () => null,
      delete: async path => { deletedPaths.push(path); },
    },
  });

  const reading = store.readChunkAsync({ handleId }, chatSessionId);
  store.pruneTerminalSession(chatSessionId, terminalSessionId);
  for (let index = 0; index < 2_000; index += 1) {
    store.pruneTerminalSession(`chat-churn-${index}`, `terminal-churn-${index}`);
  }
  finishRestore({
    path: '/netcatty/protected-old-output.log',
    record: {
      schemaVersion: 1,
      handleId,
      chatSessionId,
      capabilityId: 'terminal.execute',
      terminalSessionId,
      totalChars: 3,
      storedChars: 3,
      sourceTruncated: false,
      preview: 'old',
      storedAt: 1,
      accessedAt: 1,
    },
  });

  assert.equal(await reading, null);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(deletedPaths, ['/netcatty/protected-old-output.log']);
  const stats = store.getLifecycleMetadataStatsForTests();
  assert.ok(stats.terminalMutationGenerations <= TOOL_OUTPUT_MAX_CLOSED_TERMINAL_SESSIONS);
  assert.ok(stats.deletedTerminalSessions <= TOOL_OUTPUT_MAX_CLOSED_TERMINAL_SESSIONS);
});

test('ToolOutputStore retains a bounded tombstone when durable terminal deletion fails', async () => {
  const record: PersistedToolOutputRecord = {
    schemaVersion: 1,
    handleId: 'tool-output-delete-failed',
    chatSessionId: 'chat-delete-failed',
    capabilityId: 'terminal.execute',
    terminalSessionId: 'terminal-delete-failed',
    totalChars: 3,
    storedChars: 3,
    sourceTruncated: false,
    preview: 'old',
    storedAt: 1,
    accessedAt: 1,
  };
  const deletedPaths: string[] = [];
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async () => ({ path: '/netcatty/delete-failed.log', record }),
      read: async () => ({
        mode: 'head',
        content: 'old',
        totalChars: 3,
        startOffset: 0,
        endOffset: 3,
        nextOffset: 3,
        hasMore: false,
      }),
      delete: async path => { deletedPaths.push(path); },
      deleteTerminalSession: async () => { throw new Error('disk busy'); },
    },
  });

  store.pruneTerminalSession(record.chatSessionId, record.terminalSessionId!);
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(await store.readChunkAsync({ handleId: record.handleId }, record.chatSessionId), null);
  assert.deepEqual(deletedPaths, ['/netcatty/delete-failed.log']);
  const stats = store.getLifecycleMetadataStatsForTests();
  assert.equal(stats.terminalMutationGenerations, 1);
  assert.equal(stats.deletedTerminalSessions, 1);
});

test('ToolOutputStore ignores an older terminal deletion failure after a newer deletion succeeds', async () => {
  let rejectFirstDeletion!: (error: Error) => void;
  let finishSecondDeletion!: () => void;
  const firstDeletion = new Promise<void>((_resolve, reject) => {
    rejectFirstDeletion = reject;
  });
  const secondDeletion = new Promise<void>(resolve => {
    finishSecondDeletion = resolve;
  });
  let deletionCalls = 0;
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async () => null,
      read: async () => null,
      delete: async () => {},
      deleteTerminalSession: async () => {
        deletionCalls += 1;
        return deletionCalls === 1 ? firstDeletion : secondDeletion;
      },
    },
  });

  store.pruneTerminalSession('chat-repeat-delete', 'terminal-repeat-delete');
  store.pruneTerminalSession('chat-repeat-delete', 'terminal-repeat-delete');
  finishSecondDeletion();
  await new Promise(resolve => setTimeout(resolve, 0));
  rejectFirstDeletion(new Error('older deletion failed'));
  await new Promise(resolve => setTimeout(resolve, 0));

  const stats = store.getLifecycleMetadataStatsForTests();
  assert.equal(stats.terminalMutationGenerations, 0);
  assert.equal(stats.deletedTerminalSessions, 0);
  assert.equal(stats.failedTerminalDeletions, 0);
});

test('ToolOutputStore does not restore old output after durable chat deletion fails', async () => {
  const record: PersistedToolOutputRecord = {
    schemaVersion: 1,
    handleId: 'tool-output-chat-delete-failed',
    chatSessionId: 'chat-delete-failed',
    capabilityId: 'terminal.execute',
    totalChars: 3,
    storedChars: 3,
    sourceTruncated: false,
    preview: 'old',
    storedAt: 1,
    accessedAt: 1,
  };
  const deletedPaths: string[] = [];
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async () => ({ path: '/netcatty/chat-delete-failed.log', record }),
      read: async () => ({
        mode: 'head',
        content: 'old',
        totalChars: 3,
        startOffset: 0,
        endOffset: 3,
        nextOffset: 3,
        hasMore: false,
      }),
      delete: async path => { deletedPaths.push(path); },
      deleteSession: async () => { throw new Error('disk busy'); },
    },
  });

  store.prune(record.chatSessionId);
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(await store.readChunkAsync({ handleId: record.handleId }, record.chatSessionId), null);
  assert.deepEqual(deletedPaths, ['/netcatty/chat-delete-failed.log']);
});

test('ToolOutputStore bounds failed chat deletion tombstones after heavy churn', async () => {
  const oldRecord: PersistedToolOutputRecord = {
    schemaVersion: 1,
    handleId: 'tool-output-old-failed-chat',
    chatSessionId: 'chat-delete-failure-0',
    capabilityId: 'terminal.execute',
    totalChars: 3,
    storedChars: 3,
    sourceTruncated: false,
    preview: 'old',
    storedAt: 1,
    accessedAt: 1,
  };
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async (handleId, chatSessionId) => (
        handleId === oldRecord.handleId && chatSessionId === oldRecord.chatSessionId
          ? { path: '/old-failed-chat.log', record: oldRecord }
          : null
      ),
      read: async () => ({
        mode: 'head', content: 'old', totalChars: 3, startOffset: 0, endOffset: 3, nextOffset: 3, hasMore: false,
      }),
      delete: async () => {},
      deleteSession: async () => { throw new Error('disk busy'); },
    },
  });
  for (let index = 0; index < 2_000; index += 1) {
    store.prune(`chat-delete-failure-${index}`);
  }
  await new Promise(resolve => setTimeout(resolve, 0));

  const stats = store.getLifecycleMetadataStatsForTests();
  assert.equal(stats.failedSessionDeletions, TOOL_OUTPUT_MAX_FAILED_SESSION_DELETIONS);
  assert.equal(stats.sessionGenerations, TOOL_OUTPUT_MAX_FAILED_SESSION_DELETIONS);
  assert.equal(
    await store.readChunkAsync({ handleId: oldRecord.handleId }, oldRecord.chatSessionId),
    null,
  );
});

test('ToolOutputStore never restores a failed terminal deletion after exact tombstone churn', async () => {
  const oldRecord: PersistedToolOutputRecord = {
    schemaVersion: 1,
    handleId: 'tool-output-old-failed-terminal',
    chatSessionId: 'chat-terminal-failure-0',
    capabilityId: 'terminal.execute',
    terminalSessionId: 'terminal-failure-0',
    totalChars: 3,
    storedChars: 3,
    sourceTruncated: false,
    preview: 'old',
    storedAt: 1,
    accessedAt: 1,
  };
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async (handleId, chatSessionId) => (
        handleId === oldRecord.handleId && chatSessionId === oldRecord.chatSessionId
          ? { path: '/old-failed-terminal.log', record: oldRecord }
          : null
      ),
      read: async () => ({
        mode: 'head', content: 'old', totalChars: 3, startOffset: 0, endOffset: 3, nextOffset: 3, hasMore: false,
      }),
      delete: async () => {},
      deleteTerminalSession: async () => { throw new Error('disk busy'); },
    },
  });
  for (let index = 0; index < 2_000; index += 1) {
    store.pruneTerminalSession(`chat-terminal-failure-${index}`, `terminal-failure-${index}`);
  }
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(
    await store.readChunkAsync({ handleId: oldRecord.handleId }, oldRecord.chatSessionId),
    null,
  );
  assert.ok(
    store.getLifecycleMetadataStatsForTests().deletedTerminalSessions
      <= TOOL_OUTPUT_MAX_CLOSED_TERMINAL_SESSIONS,
  );
});

test('saved-output read budgets reset at the start of each turn', () => {
  const dedup = new ToolResultDedup();
  dedup.beginTurn();
  assert.equal(dedup.takeBudget('read', 24_000, 24_000), 24_000);
  assert.equal(dedup.takeBudget('read', 1, 24_000), 0);
  dedup.beginTurn();
  assert.equal(dedup.takeBudget('read', 24_000, 24_000), 24_000);
});

test('ToolOutputStore retries aliasing once persistence installs after a restart', async () => {
  // Simulate an app restart: the fresh store starts with empty in-memory
  // state and no persistence, because `setPersistence` only runs on the
  // first turn. Undo aliasing runs before that first turn.
  const persistence = createFakeToolOutputPersistence();
  const sourceStore = new ToolOutputStore({ persistence });
  const handle = sourceStore.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'kept across restart',
  });
  await sourceStore.flush('chat-source');

  const restartedStore = new ToolOutputStore();
  await restartedStore.aliasSessionHandles('chat-source', 'chat-branch', {
    retainedHandleIds: new Set([handle.id]),
  });
  assert.equal(await restartedStore.readChunkAsync({ handleId: handle.id }, 'chat-branch'), null);

  // The first branch turn installs persistence; the deferred alias request
  // must be replayed so the branch can read the retained output again.
  restartedStore.setPersistence(persistence);
  await new Promise(resolve => setTimeout(resolve, 0));
  const restored = await restartedStore.readChunkAsync({ handleId: handle.id }, 'chat-branch');
  assert.equal(restored?.content, 'kept across restart');
  assert.ok(persistence.entries.has(`chat-branch:${handle.id}`));
});

test('ToolOutputStore keeps the branch-owned copy readable while the source file is shared', async () => {
  const deletedPaths: string[] = [];
  const base = createFakeToolOutputPersistence();
  const readGates = new Map<string, Promise<void>>();
  const persistence: ToolOutputPersistence = {
    ...base,
    read: async (path, request) => {
      const gate = readGates.get(path);
      if (gate) await gate;
      return base.read(path, request);
    },
    delete: async path => {
      deletedPaths.push(path);
    },
    deleteSession: async () => {},
    deleteTerminalSession: async () => {},
  };
  const store = new ToolOutputStore({ persistence });
  const handle = store.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'A'.repeat(50_000),
  });
  await store.flush('chat-source');
  assert.ok(handle.filePath);

  // Block the alias materialization midway, then delete the source session:
  // the alias still shares the source file path, so the store must not drop
  // the file until the branch-owned copy has landed.
  let releaseRead!: () => void;
  readGates.set(handle.filePath!, new Promise<void>(resolve => {
    releaseRead = resolve;
  }));
  const aliasing = store.aliasSessionHandles('chat-source', 'chat-branch', {
    retainedHandleIds: new Set([handle.id]),
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  store.prune('chat-source');
  assert.equal(deletedPaths.includes(handle.filePath!), false);

  releaseRead();
  await aliasing;
  await new Promise(resolve => setTimeout(resolve, 0));
  const restored = await store.readChunkAsync({ handleId: handle.id }, 'chat-branch');
  assert.ok(restored);
  assert.equal(restored.totalChars, 50_000);
  assert.ok(restored.content.length > 0);
  assert.notEqual(restored.content.length, 0);

  // The source file path is no longer referenced once the branch owns its
  // durable copy, so the deferred delete eventually runs.
  assert.ok(!store.listPendingHandles('chat-branch').some(h => h.filePath === handle.filePath));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.notDeepEqual(deletedPaths, []);
});

test('alias materialization retries keep the source durable records until they drain', async () => {
  const base = createFakeToolOutputPersistence();
  const deletedSessionIds: string[] = [];
  // Fail exactly the first branch-owned materialization write and the first
  // source-record read so the initial flush spill still succeeds.
  let failingBranchWrites = 1;
  let failingSourceReads = 1;
  const persistence: ToolOutputPersistence & { entries: typeof base.entries } = {
    ...base,
    write: async (record, content) => {
      if (record.chatSessionId === 'chat-branch' && failingBranchWrites > 0) {
        failingBranchWrites -= 1;
        throw new Error('temporarily busy');
      }
      return base.write(record, content);
    },
    read: async (path, request) => {
      if (failingSourceReads > 0) {
        failingSourceReads -= 1;
        throw new Error('temporarily busy');
      }
      return base.read(path, request);
    },
    deleteSession: async chatSessionId => {
      deletedSessionIds.push(chatSessionId);
      for (const key of [...base.entries.keys()]) {
        if (key.startsWith(`${chatSessionId}:`)) base.entries.delete(key);
      }
    },
  };
  const store = new ToolOutputStore({ persistence });
  const handle = store.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'A'.repeat(50_000),
  });
  await store.flush('chat-source');

  // Alias materialization fails once, so the retry queue now depends on the
  // source-owned durable record.
  await store.aliasSessionHandles('chat-source', 'chat-branch', {
    retainedHandleIds: new Set([handle.id]),
  });
  assert.equal(persistence.entries.has(`chat-branch:${handle.id}`), false);

  // Deleting the source session must be deferred until the queued retry has
  // drained instead of destroying the record the retry still re-reads.
  store.prune('chat-source');
  assert.equal(persistence.entries.has(`chat-source:${handle.id}`), true);
  assert.deepEqual(deletedSessionIds, []);

  await new Promise(resolve => setTimeout(
    resolve,
    TOOL_OUTPUT_ALIAS_MATERIALIZATION_RETRY_DELAY_MS * 3 + 50,
  ));
  // The retry succeeded using the retained source record, so the deferred
  // deletion of the source session finally ran.
  assert.equal(persistence.entries.has(`chat-branch:${handle.id}`), true);
  assert.deepEqual(deletedSessionIds, ['chat-source']);
  assert.equal(persistence.entries.has(`chat-source:${handle.id}`), false);

  const restored = await store.readChunkAsync({ handleId: handle.id }, 'chat-branch');
  assert.ok(restored);
  assert.equal(restored.totalChars, 50_000);
});

test('the protected chat deletion promise rejects when the durable delete fails', async () => {
  const persistence: ToolOutputPersistence = {
    write: async () => { throw new Error('disk busy'); },
    read: async () => null,
    delete: async () => {},
    deleteSession: async () => { throw new Error('disk busy'); },
  };
  const store = new ToolOutputStore({ persistence });
  store.store({
    chatSessionId: 'chat-failed-delete',
    capabilityId: 'terminal.execute',
    content: 'A'.repeat(50_000),
  });
  await store.flush('chat-failed-delete');

  store.prune('chat-failed-delete');
  const deletion = store.getSessionDeletionPromise('chat-failed-delete');
  assert.ok(deletion);
  // The failure must be observable so callers can retry through the direct
  // cleanup path instead of silently leaving the durable records on disk.
  await assert.rejects(deletion, /disk busy/);
});

test('evicting a materialization retry at the queue cap invalidates its branch aliases', async () => {
  const base = createFakeToolOutputPersistence();
  const persistence: ToolOutputPersistence & { entries: typeof base.entries } = {
    ...base,
    // Every branch-owned durable copy fails, so each alias stays queued as a
    // materialization retry that still reads its source-owned durable file.
    write: async (record, content) => {
      if (record.chatSessionId.startsWith('chat-branch-')) {
        throw new Error('secure store unavailable');
      }
      return base.write(record, content);
    },
    deleteSession: async chatSessionId => {
      for (const key of [...base.entries.keys()]) {
        if (key.startsWith(`${chatSessionId}:`)) base.entries.delete(key);
      }
    },
  };
  const store = new ToolOutputStore({ persistence });

  const aliasesByIndex = new Map<number, { handleId: string; sourceId: string }>();
  for (let index = 1; index <= TOOL_OUTPUT_MAX_PENDING_ALIAS_MATERIALIZATIONS + 1; index += 1) {
    const sourceChatSessionId = `chat-source-${index}`;
    const handle = store.store({
      chatSessionId: sourceChatSessionId,
      capabilityId: 'terminal.execute',
      content: 'A'.repeat(50_000),
    });
    await store.flush(sourceChatSessionId);
    await store.aliasSessionHandles(sourceChatSessionId, `chat-branch-${index}`, {
      retainedHandleIds: new Set([handle.id]),
    });
    aliasesByIndex.set(index, { handleId: handle.id, sourceId: sourceChatSessionId });
  }

  // Adding one target beyond the cap evicts the oldest queued retry instead
  // of abandoning it silently: the branch alias that still points at the
  // source-owned durable file must be invalidated explicitly, so no handle
  // advertises a copy that dies with the source session.
  const oldest = aliasesByIndex.get(1)!;
  assert.equal(store.get(oldest.handleId, 'chat-branch-1'), undefined);
  assert.equal(store.listPendingHandles('chat-branch-1').length, 0);

  // Surviving targets keep their aliases (still queued for retry).
  const second = aliasesByIndex.get(2)!;
  assert.ok(store.get(second.handleId, 'chat-branch-2'));

  // The shared source file must not have been deleted by the eviction: the
  // source's own handle still references it until the source is pruned.
  const sourceEntry = [...persistence.entries.entries()]
    .find(([key]) => key.startsWith(`${oldest.sourceId}:`));
  assert.ok(sourceEntry);

  // And pruning the source no longer has a queue dependency to wait for, so
  // its durable records are deleted without stalling.
  store.prune(oldest.sourceId);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(
    [...persistence.entries.keys()].some(key => key.startsWith(`${oldest.sourceId}:`)),
    false,
  );

  // Drain the surviving queued retries with working persistence so the test
  // does not leave repeating retry timers behind; the branch-owned copies
  // land for every target that kept its alias.
  persistence.write = base.write;
  await new Promise(resolve => setTimeout(
    resolve,
    TOOL_OUTPUT_ALIAS_MATERIALIZATION_RETRY_DELAY_MS * 4 + 100,
  ));
  assert.ok(persistence.entries.has(`chat-branch-2:${second.handleId}`));
  assert.equal(store.listPendingHandles('chat-branch-2').length, 1);
});

test('a rejected restore is queued and retried instead of dropping the alias', async () => {
  const base = createFakeToolOutputPersistence();
  storeDurableRecord(base, 'chat-source', 'h1', 'persisted content', 16);
  let failingRestores = 1;
  const persistence: ToolOutputPersistence & { entries: typeof base.entries } = {
    ...base,
    restore: async (handleId, chatSessionId) => {
      if (failingRestores > 0) {
        failingRestores -= 1;
        throw new Error('secure store temporarily locked');
      }
      return base.restore(handleId, chatSessionId);
    },
  };
  const store = new ToolOutputStore({ persistence });

  await store.aliasSessionHandles('chat-source', 'chat-branch', {
    retainedHandleIds: new Set(['h1']),
  });
  assert.equal(store.get('h1', 'chat-branch'), undefined);

  // The queued restore request is retried once the store can restore again.
  await new Promise(resolve => setTimeout(
    resolve,
    TOOL_OUTPUT_ALIAS_MATERIALIZATION_RETRY_DELAY_MS * 3 + 50,
  ));
  const alias = store.get('h1', 'chat-branch');
  assert.ok(alias);
  const read = await store.readChunkAsync({ handleId: 'h1' }, 'chat-branch');
  assert.equal(read?.content, 'persisted content');
});

test('prune flushes queued alias restore retries and defers deletion until they drain', async () => {
  const base = createFakeToolOutputPersistence();
  storeDurableRecord(base, 'chat-source', 'h1', 'persisted content', 16);
  const deletedSessionIds: string[] = [];
  let failingRestores = 1;
  const persistence: ToolOutputPersistence & { entries: typeof base.entries } = {
    ...base,
    restore: async (handleId, chatSessionId) => {
      if (failingRestores > 0) {
        failingRestores -= 1;
        throw new Error('secure store temporarily locked');
      }
      return base.restore(handleId, chatSessionId);
    },
    deleteSession: async chatSessionId => {
      deletedSessionIds.push(chatSessionId);
      for (const key of [...base.entries.keys()]) {
        if (key.startsWith(`${chatSessionId}:`)) base.entries.delete(key);
      }
    },
  };
  const store = new ToolOutputStore({ persistence });

  // The first restore rejects transiently, so the request is queued instead
  // of dropping the branch alias.
  await store.aliasSessionHandles('chat-source', 'chat-branch', {
    retainedHandleIds: new Set(['h1']),
  });
  assert.equal(store.get('h1', 'chat-branch'), undefined);

  // Deleting the source session flushes the queued restore immediately,
  // keeps it exempt from the post-prune restore rejection, and defers the
  // durable deletion until the retry (which still reads the source's durable
  // record) has drained.
  store.prune('chat-source');
  assert.deepEqual(deletedSessionIds, []);
  assert.equal(persistence.entries.has('chat-source:h1'), true);

  await new Promise(resolve => setTimeout(
    resolve,
    TOOL_OUTPUT_ALIAS_MATERIALIZATION_RETRY_DELAY_MS * 3 + 50,
  ));
  // The flushed restore succeeded, the branch owns a durable copy, and the
  // deferred deletion of the source session finally ran.
  assert.equal(persistence.entries.has('chat-branch:h1'), true);
  assert.deepEqual(deletedSessionIds, ['chat-source']);
  assert.equal(persistence.entries.has('chat-source:h1'), false);

  const read = await store.readChunkAsync({ handleId: 'h1' }, 'chat-branch');
  assert.equal(read?.content, 'persisted content');
});

test('an in-flight materialization retry still defers deletion of its source records', async () => {
  const base = createFakeToolOutputPersistence();
  const deletedSessionIds: string[] = [];
  let failingBranchWrites = 1;
  let attemptOneWriteFailed = false;
  let retryReadStarted!: () => void;
  const retryReadStartedPromise = new Promise<void>(resolve => {
    retryReadStarted = resolve;
  });
  let releaseRetryRead!: () => void;
  const releaseRetryReadPromise = new Promise<void>(resolve => {
    releaseRetryRead = resolve;
  });
  const persistence: ToolOutputPersistence & { entries: typeof base.entries } = {
    ...base,
    write: async (record, content) => {
      if (record.chatSessionId === 'chat-branch' && failingBranchWrites > 0) {
        failingBranchWrites -= 1;
        attemptOneWriteFailed = true;
        throw new Error('temporarily busy');
      }
      return base.write(record, content);
    },
    read: async (path, request) => {
      // Only the queued retry (whose branch write attempt already failed) is
      // gated while it re-reads the source-owned file.
      if (attemptOneWriteFailed) {
        retryReadStarted();
        await releaseRetryReadPromise;
      }
      return base.read(path, request);
    },
    deleteSession: async chatSessionId => {
      deletedSessionIds.push(chatSessionId);
      for (const key of [...base.entries.keys()]) {
        if (key.startsWith(`${chatSessionId}:`)) base.entries.delete(key);
      }
    },
  };
  const store = new ToolOutputStore({ persistence });
  const handle = store.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'A'.repeat(50_000),
  });
  await store.flush('chat-source');

  // The first branch-owned materialization write fails, so the retry queue
  // now depends on the source-owned durable record.
  await store.aliasSessionHandles('chat-source', 'chat-branch', {
    retainedHandleIds: new Set([handle.id]),
  });
  assert.equal(persistence.entries.has(`chat-branch:${handle.id}`), false);

  // Wait until the queued retry is in flight and re-reading the source-owned
  // file, then delete the source session. The retry is not in the pending
  // queue while it runs, so deletion must still be deferred until its read
  // completes instead of firing underneath it.
  await retryReadStartedPromise;
  store.prune('chat-source');
  assert.deepEqual(deletedSessionIds, []);
  assert.equal(persistence.entries.has(`chat-source:${handle.id}`), true);

  releaseRetryRead();
  await new Promise(resolve => setTimeout(resolve, 100));
  // The retry materialized the branch-owned copy, so the deferred deletion
  // of the source session finally ran.
  assert.equal(persistence.entries.has(`chat-branch:${handle.id}`), true);
  assert.deepEqual(deletedSessionIds, ['chat-source']);

  const read = await store.readChunkAsync({ handleId: handle.id }, 'chat-branch');
  assert.equal(read?.totalChars, 50_000);
});

function storeDurableRecord(
  persistence: ReturnType<typeof createFakeToolOutputPersistence>,
  chatSessionId: string,
  handleId: string,
  content: string,
  totalChars: number,
): void {
  persistence.write({
    schemaVersion: 1,
    handleId,
    chatSessionId,
    capabilityId: 'terminal.execute',
    totalChars,
    storedChars: content.length,
    sourceTruncated: totalChars > content.length,
    preview: content,
    storedAt: 0,
    accessedAt: 0,
  }, content);
}

test('alias restore requests evicted at the pending cap are requeued once persistence installs', async () => {
  const base = createFakeToolOutputPersistence();
  const persistence: ToolOutputPersistence & { entries: typeof base.entries } = {
    ...base,
    restore: async (handleId, chatSessionId) => {
      // Only the pair stalls with a durable record; every other request finds
      // nothing (dropped, not re-queued) once it gets to run.
      if (chatSessionId === 'chat-source-1') return base.restore(handleId, chatSessionId);
      return null;
    },
  };
  storeDurableRecord(persistence, 'chat-source-1', 'h1', 'persisted content', 16);

  const store = new ToolOutputStore();
  // No persistence is installed yet, so every alias pass defers its restore
  // request; adding one pair beyond the cap stalls the oldest request while
  // keeping its source→branch relationship instead of dropping it silently.
  for (let index = 1; index <= TOOL_OUTPUT_MAX_PENDING_ALIAS_RESTORES + 1; index += 1) {
    await store.aliasSessionHandles(`chat-source-${index}`, `chat-branch-${index}`, {
      retainedHandleIds: new Set([`h${index}`]),
    });
  }
  assert.equal(await store.readChunkAsync({ handleId: 'h1' }, 'chat-branch-1'), null);

  // Installing working persistence repairs even the stalled request: the
  // branch can read the retained output again.
  store.setPersistence(persistence);
  await new Promise(resolve => setTimeout(
    resolve,
    TOOL_OUTPUT_ALIAS_MATERIALIZATION_RETRY_DELAY_MS * 6 + 100,
  ));
  const restored = await store.readChunkAsync({ handleId: 'h1' }, 'chat-branch-1');
  assert.equal(restored?.content, 'persisted content');
  assert.ok(persistence.entries.has('chat-branch-1:h1'));
  // The branch never had a durable record for the other pairs' handles.
  assert.equal(await store.readChunkAsync({ handleId: 'h2' }, 'chat-branch-2'), null);
});

test('alias restore requests stalled past the cap are not requeued for a pruned source', async () => {
  const persistence = createFakeToolOutputPersistence();
  storeDurableRecord(persistence, 'chat-source-1', 'h1', 'persisted content', 16);

  const store = new ToolOutputStore();
  for (let index = 1; index <= TOOL_OUTPUT_MAX_PENDING_ALIAS_RESTORES + 1; index += 1) {
    await store.aliasSessionHandles(`chat-source-${index}`, `chat-branch-${index}`, {
      retainedHandleIds: new Set([`h${index}`]),
    });
  }
  // Pruning the stalled request's source deletes the durable records it would
  // have to restore from, so the request is not requeued: restore would fail
  // permanently for that chat.
  store.prune('chat-source-1');

  store.setPersistence(persistence);
  await new Promise(resolve => setTimeout(
    resolve,
    TOOL_OUTPUT_ALIAS_MATERIALIZATION_RETRY_DELAY_MS * 4 + 100,
  ));
  assert.equal(store.get('h1', 'chat-branch-1'), undefined);
  assert.equal(await store.readChunkAsync({ handleId: 'h1' }, 'chat-branch-1'), null);
});

test('pruning a source materializes its stalled alias restore requests before deleting', async () => {
  const base = createFakeToolOutputPersistence();
  const deletedSessionIds: string[] = [];
  let restoreHealthy = false;
  const persistence: ToolOutputPersistence & { entries: typeof base.entries } = {
    ...base,
    restore: async (handleId, chatSessionId) => {
      if (!restoreHealthy) throw new Error('temporarily unavailable');
      return base.restore(handleId, chatSessionId);
    },
    deleteSession: async chatSessionId => {
      deletedSessionIds.push(chatSessionId);
    },
  };
  storeDurableRecord(persistence, 'chat-source-1', 'h1', 'persisted content', 16);

  const store = new ToolOutputStore({ persistence });
  // While restore rejects transiently, every alias pass defers its restore
  // request into the pending queue; the 51st pair evicts the oldest request
  // (chat-source-1 → chat-branch-1) into the stalled queue while keeping its
  // source→branch relationship recoverable.
  for (let index = 1; index <= TOOL_OUTPUT_MAX_PENDING_ALIAS_RESTORES + 1; index += 1) {
    await store.aliasSessionHandles(`chat-source-${index}`, `chat-branch-${index}`, {
      retainedHandleIds: new Set([`h${index}`]),
    });
  }

  // Restore turns healthy and the stalled request's source is pruned: its
  // branch-owned durable copy must be materialized while the source's durable
  // records are still alive — deleting first, then discarding the stall via
  // the deny filter, would leave the branch's retained reference unreadable
  // forever.
  restoreHealthy = true;
  store.prune('chat-source-1');
  await store.getSessionDeletionPromise('chat-source-1');
  assert.deepEqual(deletedSessionIds, ['chat-source-1']);

  const read = await store.readChunkAsync({ handleId: 'h1' }, 'chat-branch-1');
  assert.equal(read?.content, 'persisted content');
  assert.ok(persistence.entries.has('chat-branch-1:h1'));
});

test('alias restore requests staged past every queue are never dropped outright', async () => {
  const base = createFakeToolOutputPersistence();
  const persistence: ToolOutputPersistence & { entries: typeof base.entries } = {
    ...base,
    restore: async (handleId, chatSessionId) => {
      // Only the deeply staged pair stalls with a durable record; every other
      // request finds nothing (dropped, not re-queued) once it gets to run.
      if (chatSessionId === 'chat-source-1') return base.restore(handleId, chatSessionId);
      return null;
    },
  };
  storeDurableRecord(persistence, 'chat-source-1', 'h1', 'persisted content', 16);

  const store = new ToolOutputStore();
  // More source/branch pairs than the pending cap and the staging queue could
  // ever hold at once: the oldest request (chat-source-1 → chat-branch-1) ends
  // up staged behind both. Dropping staged overflow would silently discard the
  // pair, leaving a branch whose retained reference can never resolve again —
  // so the staging queue must retain it until persistence is repaired.
  for (let index = 1; index <= TOOL_OUTPUT_MAX_PENDING_ALIAS_RESTORES * 2 + 1; index += 1) {
    await store.aliasSessionHandles(`chat-source-${index}`, `chat-branch-${index}`, {
      retainedHandleIds: new Set([`h${index}`]),
    });
  }

  // Installing working persistence repairs even the deeply staged request.
  store.setPersistence(persistence);
  await new Promise(resolve => setTimeout(
    resolve,
    TOOL_OUTPUT_ALIAS_MATERIALIZATION_RETRY_DELAY_MS * 8 + 100,
  ));
  const restored = await store.readChunkAsync({ handleId: 'h1' }, 'chat-branch-1');
  assert.equal(restored?.content, 'persisted content');
  assert.ok(persistence.entries.has('chat-branch-1:h1'));
});

test('a branch alias restored after a restart keeps its durable record through cache-limit eviction', async () => {
  // `materializedAliasHandles`/`materializedAliasKeys` die with the process.
  // The persisted records therefore carry an alias marker, and restoring an
  // alias after a restart must re-arm the eviction protection from it:
  // otherwise cache-pressure eviction would treat the fresh handle object as
  // an ordinary one and delete the branch-owned record that the branch's
  // retained prefix still references, making the handle permanently unreadable.
  const base = createFakeToolOutputPersistence();
  const persistence: ToolOutputPersistence & { entries: typeof base.entries } = {
    ...base,
    delete: async path => {
      for (const [key, entry] of base.entries) {
        if (entry.path === path) base.entries.delete(key);
      }
    },
  };
  const store = new ToolOutputStore({ persistence, maxHandlesPerSession: 2, now: () => 10_000 });

  const handle = store.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'source output for the branch',
  });
  await store.flush('chat-source');
  await store.aliasSessionHandles('chat-source', 'chat-branch', {
    retainedHandleIds: new Set([handle.id]),
  });
  const branchEntry = persistence.entries.get(`chat-branch:${handle.id}`);
  assert.ok(branchEntry);
  assert.equal(branchEntry.record.aliased, true);

  // Simulate a restart: a brand-new store over the same durable records.
  const afterRestart = new ToolOutputStore({ persistence, maxHandlesPerSession: 1, now: () => 10_000 });
  const restored = await afterRestart.readChunkAsync({ handleId: handle.id }, 'chat-branch');
  assert.equal(restored?.content, 'source output for the branch');

  // Cache pressure evicts the restored alias object again; the branch-owned
  // record must survive, and a later reread must restore it once more.
  afterRestart.store({ chatSessionId: 'chat-branch', capabilityId: 'terminal.execute', content: 'branch-a' });
  assert.ok(persistence.entries.has(`chat-branch:${handle.id}`));
  const reread = await afterRestart.readChunkAsync({ handleId: handle.id }, 'chat-branch');
  assert.equal(reread?.content, 'source output for the branch');
});

test('pruning a branch chat clears its durable-alias keys', async () => {
  const persistence = createFakeToolOutputPersistence();
  const store = new ToolOutputStore({ persistence });
  const handle = store.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'A'.repeat(50_000),
  });
  await store.flush('chat-source');

  await store.aliasSessionHandles('chat-source', 'chat-branch', {
    retainedHandleIds: new Set([handle.id]),
  });
  assert.ok(persistence.entries.has(`chat-branch:${handle.id}`));
  assert.ok(store.getLifecycleMetadataStatsForTests().materializedAliasKeys > 0);

  // Deleting the branch chat must reclaim its durable-alias keys; leaving
  // them behind would grow the runtime set for the app's lifetime with every
  // create-and-delete undo branch. Ordinary cache-limit eviction keeps them
  // (they guard the branch-owned durable copy), but a chat-session cleanup
  // never needs them again.
  store.prune('chat-branch');
  assert.equal(store.getLifecycleMetadataStatsForTests().materializedAliasKeys, 0);
  // The source chat's durable record is untouched by the branch's prune.
  assert.ok(persistence.entries.has(`chat-source:${handle.id}`));
});

test('a restored branch alias stays restorable after another cache-limit eviction', async () => {
  // A materialized alias evicted by the session cap keeps its branch-owned
  // durable record (see `evictHandle`). Restoring it builds a fresh handle
  // object, so a further cache-limit eviction must not mistake that object for
  // an ordinary one and delete the record — the branch's retained prefix still
  // references the handle, and a second delete would make it permanently
  // unreadable with no way to rebuild the manifest.
  let now = 10_000;
  const base = createFakeToolOutputPersistence();
  // Unlike the default fake, deletes actually destroy the record so the
  // assertions below observe eviction-driven deletions.
  const persistence: ToolOutputPersistence & { entries: typeof base.entries } = {
    ...base,
    delete: async path => {
      for (const [key, entry] of base.entries) {
        if (entry.path === path) base.entries.delete(key);
      }
    },
  };
  const store = new ToolOutputStore({
    persistence,
    maxHandlesPerSession: 2,
    ttlMs: 1_000,
    now: () => now,
  });

  const expired = store.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'expired-first-',
  });
  await store.flush('chat-source');
  now = 12_000;
  assert.equal(store.get(expired.id, 'chat-source'), undefined);
  const fresh1 = store.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'fresh-second-output',
  });
  now = 12_001;
  const fresh2 = store.store({
    chatSessionId: 'chat-source',
    capabilityId: 'terminal.execute',
    content: 'fresh-third-output',
  });

  now = 12_002;
  await store.aliasSessionHandles('chat-source', 'chat-branch', {
    retainedHandleIds: new Set([fresh1.id, fresh2.id, expired.id]),
  });
  // The branch's per-session cap evicts the freshly materialized fresh1 alias;
  // its branch-owned durable record must survive (previous behavior).
  assert.ok(persistence.entries.has(`chat-branch:${fresh1.id}`));

  // Reading the evicted alias restores it as a new handle object.
  const restored = await store.readChunkAsync({ handleId: fresh1.id }, 'chat-branch');
  assert.equal(restored?.content, 'fresh-second-output');
  assert.ok([store.get(fresh1.id, 'chat-branch')].every(Boolean));

  // More cache pressure evicts the restored alias object again: the record
  // must survive, and the branch must still be able to restore it afterwards.
  now = 13_000;
  store.store({ chatSessionId: 'chat-branch', capabilityId: 'terminal.execute', content: 'branch-a' });
  store.store({ chatSessionId: 'chat-branch', capabilityId: 'terminal.execute', content: 'branch-b' });
  assert.ok(persistence.entries.has(`chat-branch:${fresh1.id}`));
  const reread = await store.readChunkAsync({ handleId: fresh1.id }, 'chat-branch');
  assert.equal(reread?.content, 'fresh-second-output');
});
