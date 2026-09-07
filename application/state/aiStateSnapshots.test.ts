import assert from 'node:assert/strict';
import test from 'node:test';
import type { AISession } from '../../infrastructure/ai/types';
import {
  cleanupClosedTerminalSessions,
  cleanupDeletedAIChatSessions,
  cleanupSdkAgentSessions,
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

test('writeSessionsForStorage reduces several small sessions to fit a sub-512 KB quota', async () => {
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
        role: 'user' as const,
        content: 'x'.repeat(40 * 1024),
        timestamp: index,
      }],
    ));

    assert.equal(writeSessionsForStorage(sessions), true);
    assert.ok(writes[0].length > 300 * 1024);
    assert.ok(stored);
    assert.ok(stored.length <= 300 * 1024);
    assert.ok((JSON.parse(stored) as AISession[]).length < sessions.length);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: previousLocalStorage,
    });
  }
});

test('writeSessionsForStorage makes a final attempt with only the newest session', async () => {
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
        if (value.length > 50 * 1024) {
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
        role: 'user' as const,
        content: 'x'.repeat(40 * 1024),
        timestamp: index,
      }],
    ));

    assert.equal(writeSessionsForStorage(sessions), true);
    assert.equal(writes.length, 6);
    assert.ok(stored);
    const persisted = JSON.parse(stored) as AISession[];
    assert.deepEqual(persisted.map(session => session.id), ['session-0']);
    assert.ok(stored.length <= 50 * 1024);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: previousLocalStorage,
    });
  }
});
