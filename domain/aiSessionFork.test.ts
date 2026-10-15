import assert from 'node:assert/strict';
import test from 'node:test';

import type { AISession, AISessionScope, ChatMessage } from '../infrastructure/ai/types.ts';
import { buildForkedSession, resolveForkBoundary } from './aiSessionFork.ts';

function message(
  id: string,
  role: ChatMessage['role'],
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    content: `${id} content`,
    timestamp: Number(id.replace(/\D/g, '')) || 1,
    ...overrides,
  };
}

function session(
  messages: ChatMessage[],
  overrides: Partial<AISession> = {},
): AISession {
  return {
    id: 'source-session',
    title: 'Source title',
    agentId: 'catty',
    scope: { type: 'terminal', targetId: 'terminal-1', hostIds: ['host-1'] },
    messages,
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

const terminalScope: AISessionScope = { type: 'terminal', targetId: 'terminal-1', hostIds: ['host-1'] };

function completeToolTurn(): ChatMessage[] {
  return [
    message('u1', 'user'),
    message('a1', 'assistant', {
      content: 'Checking.',
      toolCalls: [{ id: 'call-1', name: 'terminal_execute', arguments: { command: 'pwd' } }],
      executionStatus: 'completed',
    }),
    message('t1', 'tool', {
      content: '',
      toolResults: [{ toolCallId: 'call-1', content: '/work' }],
      executionStatus: 'completed',
    }),
    message('a2', 'assistant', { content: 'Done.' }),
  ];
}

test('resolveForkBoundary resolves only completed turn-ending responses', () => {
  const source = session([
    message('u1', 'user'),
    message('a1', 'assistant', { content: 'First answer.' }),
    message('u2', 'user'),
    message('a2', 'assistant', { content: 'Second answer.' }),
  ]);

  assert.equal(resolveForkBoundary(source, 'a1'), 2);
  assert.equal(resolveForkBoundary(source, 'a2'), 4);
  assert.equal(resolveForkBoundary(source, 'u1'), null);
  assert.equal(resolveForkBoundary(source, 'missing'), null);

  const interrupted = session([
    message('u1', 'user'),
    message('a1', 'assistant', { content: 'Partial', executionStatus: 'running' }),
  ]);
  assert.equal(resolveForkBoundary(interrupted, 'a1'), null);
  assert.equal(
    resolveForkBoundary(
      session([message('u1', 'user'), message('a1', 'assistant', { content: 'Nope', errorInfo: { type: 'network', message: 'boom', retryable: true } })]),
      'a1',
    ),
    null,
  );
});

test('resolveForkBoundary rejects responses whose retained prefix leaves a tool call unresolved', () => {
  const source = session(completeToolTurn());

  // The tool call has no result yet inside the retained prefix.
  assert.equal(resolveForkBoundary(source, 'a1'), null);
  assert.equal(resolveForkBoundary(source, 'a2'), 4);

  const dangling = session(completeToolTurn().slice(0, 2));
  assert.equal(resolveForkBoundary(dangling, 'a1'), null);
});

test('resolveForkBoundary accepts tool results paired on the assistant message itself', () => {
  const source = session([
    message('u1', 'user'),
    message('a1', 'assistant', {
      content: 'Done inline.',
      toolCalls: [{ id: 'inline-call', name: 'read', arguments: {} }],
      toolResults: [{ toolCallId: 'inline-call', content: 'inline result' }],
      executionStatus: 'completed',
    }),
  ]);

  assert.equal(resolveForkBoundary(source, 'a1'), 2);
});

test('resolveForkBoundary rejects boundaries inside the compacted prefix', () => {
  const messages = [
    message('u1', 'user'),
    message('a1', 'assistant', { content: 'First answer.' }),
    message('u2', 'user'),
    message('a2', 'assistant', { content: 'Second answer.' }),
    message('u3', 'user'),
    message('a3', 'assistant', { content: 'Third answer.' }),
  ];

  const covered = session(messages, {
    contextCompaction: { summary: 'Earlier turns summarized.', compactedMessageCount: 2 },
  });
  assert.equal(resolveForkBoundary(covered, 'a1'), 2);
  assert.equal(resolveForkBoundary(covered, 'a2'), 4);

  const overCovering = session(messages, {
    contextCompaction: { summary: 'Summarized.', compactedMessageCount: 4 },
  });
  assert.equal(resolveForkBoundary(overCovering, 'a1'), null);
  assert.equal(resolveForkBoundary(overCovering, 'a2'), 4);

  const emptySummary = session(messages, {
    contextCompaction: { summary: '   ', compactedMessageCount: 2 },
  });
  assert.equal(resolveForkBoundary(emptySummary, 'a2'), null);
});

test('buildForkedSession keeps per-message replay metadata for the retained prefix', () => {
  const providerContinuation = {
    source: { providerConfigId: 'cfg-1', providerType: 'deepseek', modelId: 'deepseek-reasoner' },
    reasoningParts: [{ text: 'signed thinking', providerOptions: { deepseek: { signature: 'sig-1' } } }],
    toolCallProviderOptionsById: { 'call-1': { deepseek: { encrypted: 'blob-1' } } },
  };
  const source = session([
    message('u1', 'user'),
    message('a1', 'assistant', {
      content: 'Checking.',
      thinking: 'Signed thinking text',
      providerContinuation,
      toolCalls: [{ id: 'call-1', name: 'terminal_execute', arguments: { command: 'pwd' } }],
      executionStatus: 'completed',
    }),
    message('t1', 'tool', {
      content: '',
      toolResults: [{ toolCallId: 'call-1', content: '/work' }],
      executionStatus: 'completed',
    }),
    message('a2', 'assistant', { content: 'Done.' }),
  ]);

  const boundary = resolveForkBoundary(source, 'a2');
  assert.equal(boundary, 4);
  const fork = buildForkedSession(source, boundary!, {
    newId: 'forked-session',
    now: 500,
    scope: terminalScope,
  });
  assert.ok(fork);

  // The transcript replays like the source: ids, thinking and the signed
  // reasoning / tool-call options on providerContinuation are all retained.
  assert.deepEqual(fork.messages.map(entry => entry.id), ['u1', 'a1', 't1', 'a2']);
  assert.equal(fork.messages[1].toolCalls?.[0]?.id, 'call-1');
  assert.equal(fork.messages[2].toolResults?.[0]?.toolCallId, 'call-1');
  assert.equal(fork.messages[1].thinking, 'Signed thinking text');
  assert.deepEqual(fork.messages[1].providerContinuation, providerContinuation);
  assert.equal(
    fork.messages[1].providerContinuation?.toolCallProviderOptionsById?.['call-1'],
    providerContinuation.toolCallProviderOptionsById['call-1'],
  );
});

test('buildForkedSession drops session-scoped state but keeps the retained transcript', () => {
  const providerContinuation = {
    reasoningParts: [{ text: 'thinking', providerOptions: { deepseek: { signature: 'sig-with-tool-output-123' } } }],
  };
  const source = session([
    message('u1', 'user', {
      content: 'Look at handleId=tool-output-abc and tool-output-abc again',
    }),
    message('a1', 'assistant', {
      content: 'Checking handleId=tool-output-abc',
      providerContinuation,
      toolCalls: [{
        id: 'call-1',
        name: 'read_tool_output',
        arguments: { handleId: 'tool-output-abc', note: 'see tool-output-abc' },
      }],
      executionStatus: 'completed',
    }),
    message('t1', 'tool', {
      content: '',
      toolResults: [{ toolCallId: 'call-1', content: 'handleId=tool-output-abc' }],
      executionStatus: 'completed',
    }),
    message('a2', 'assistant', { content: 'Done.' }),
  ], {
    externalSessionId: 'remote-thread-9',
    contextCompaction: {
      summary: 'Read handleId=tool-output-abc earlier.',
      compactedMessageCount: 0,
    },
  });

  const boundary = resolveForkBoundary(source, 'a2');
  const fork = buildForkedSession(source, boundary!, {
    newId: 'forked-session',
    now: 500,
    scope: terminalScope,
  });
  assert.ok(fork);

  // A fork gets its own chat identity: no provider thread to resume.
  assert.notEqual(fork.id, source.id);
  assert.equal(fork.externalSessionId, undefined);
  assert.equal(fork.createdAt, 500);
  assert.equal(fork.updatedAt, 500);
  assert.equal(fork.title, source.title);

  // Tool-output handles belong to the source chat's store, so the fork must not
  // replay them as if they were resolvable.
  const notices = (value: string) => value.match(/\[output handle removed for forked session\]/g) ?? [];
  assert.equal(fork.messages[0].content.includes('tool-output-'), false);
  assert.equal(notices(fork.messages[0].content).length, 2);
  assert.equal(fork.messages[1].content.includes('tool-output-'), false);
  assert.deepEqual(fork.messages[1].toolCalls?.[0]?.arguments, {
    note: 'see [output handle removed for forked session]',
  });
  assert.equal(fork.messages[2].toolResults?.[0]?.content.includes('tool-output-'), false);
  assert.equal(fork.contextCompaction?.summary.includes('tool-output-'), false);

  // Signed reasoning is opaque replay data: it must survive byte for byte.
  assert.deepEqual(fork.messages[1].providerContinuation, providerContinuation);
  assert.equal(
    fork.messages[1].providerContinuation?.reasoningParts?.[0]?.providerOptions?.deepseek?.signature,
    'sig-with-tool-output-123',
  );

  // The source conversation is untouched.
  assert.equal(source.externalSessionId, 'remote-thread-9');
  assert.equal(source.messages[1].content, 'Checking handleId=tool-output-abc');
  assert.equal(source.messages.length, 4);
});

test('buildForkedSession scopes the fork to the requesting panel and rejects unsafe boundaries', () => {
  const source = session([
    message('u1', 'user'),
    message('a1', 'assistant', { content: 'First answer.' }),
    message('u2', 'user'),
    message('a2', 'assistant', { content: 'Second answer.' }),
  ]);
  const workspaceScope: AISessionScope = { type: 'workspace', targetId: 'workspace-1', hostIds: ['host-1'] };

  const fork = buildForkedSession(source, 4, {
    newId: 'forked-session',
    now: 500,
    scope: workspaceScope,
  });
  assert.ok(fork);
  assert.deepEqual(fork.scope, workspaceScope);

  // A workspace member can continue a chat created on an older terminal; the
  // fork still belongs to the panel it was created from.
  const inherited = session(source.messages, {
    scope: { type: 'terminal', targetId: 'terminal-old', hostIds: ['host-1'] },
  });
  const retargeted = buildForkedSession(inherited, 2, {
    newId: 'forked-session',
    now: 500,
    scope: workspaceScope,
  });
  assert.ok(retargeted);
  assert.deepEqual(retargeted.scope, workspaceScope);

  assert.equal(buildForkedSession(source, 0, { newId: 'x', now: 1, scope: terminalScope }), null);
  assert.equal(buildForkedSession(source, 5, { newId: 'x', now: 1, scope: terminalScope }), null);
  assert.equal(buildForkedSession(source, 3, { newId: 'x', now: 1, scope: terminalScope }), null);
});
