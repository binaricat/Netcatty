import assert from 'node:assert/strict';
import test from 'node:test';

import type { AISession, ChatMessage } from '../infrastructure/ai/types.ts';
import {
  createBranchedSession,
  getBranchBoundary,
  type AISessionBranchBoundary,
} from './aiSessionBranch.ts';

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

test('getBranchBoundary resolves only completed assistant turn ends', () => {
  const source = session([
    message('u1', 'user'),
    message('a1', 'assistant', { content: 'First answer.' }),
    message('u2', 'user'),
    message('a2', 'assistant', { content: 'Second answer.' }),
  ]);

  assert.deepEqual(
    getBranchBoundary(source, { kind: 'after-turn', assistantMessageId: 'a1' }),
    { messageCount: 2 },
  );
  assert.deepEqual(
    getBranchBoundary(source, { kind: 'after-turn', assistantMessageId: 'a2' }),
    { messageCount: 4 },
  );
  assert.equal(
    getBranchBoundary(source, { kind: 'after-turn', assistantMessageId: 'u1' }),
    null,
  );

  const interrupted = session([
    message('u1', 'user'),
    message('a1', 'assistant', { content: 'Partial', executionStatus: 'running' }),
  ]);
  assert.equal(
    getBranchBoundary(interrupted, { kind: 'after-turn', assistantMessageId: 'a1' }),
    null,
  );
});

test('getBranchBoundary rejects assistants before their tool results and accepts the final assistant', () => {
  const source = session(completeToolTurn());

  assert.equal(
    getBranchBoundary(source, { kind: 'after-turn', assistantMessageId: 'a1' }),
    null,
  );
  assert.deepEqual(
    getBranchBoundary(source, { kind: 'after-turn', assistantMessageId: 'a2' }),
    { messageCount: 4 },
  );

  const dangling = session(completeToolTurn().slice(0, 2));
  assert.equal(
    getBranchBoundary(dangling, { kind: 'after-turn', assistantMessageId: 'a1' }),
    null,
  );
});

test('getBranchBoundary accepts paired tool results embedded on assistant messages', () => {
  const source = session([
    message('u1', 'user'),
    message('a1', 'assistant', {
      content: 'Done inline.',
      toolCalls: [{ id: 'inline-call', name: 'read', arguments: {} }],
      toolResults: [{ toolCallId: 'inline-call', content: 'inline result' }],
      executionStatus: 'completed',
    }),
  ]);

  assert.deepEqual(
    getBranchBoundary(source, { kind: 'after-turn', assistantMessageId: 'a1' }),
    { messageCount: 2 },
  );

  let idIndex = 0;
  const branch = createBranchedSession(source, { messageCount: 2 }, 500, () => `id-${idIndex++}`);
  const branchedCallId = branch.messages[1].toolCalls?.[0]?.id;
  assert.ok(branchedCallId);
  assert.notEqual(branchedCallId, 'inline-call');
  assert.equal(branch.messages[1].toolResults?.[0]?.toolCallId, branchedCallId);
});

test('createBranchedSession remaps reused tool-call ids to their nearest results', () => {
  const source = session([
    message('u1', 'user'),
    message('a1', 'assistant', {
      content: 'First call.',
      toolCalls: [{ id: 'reused', name: 'read', arguments: { path: 'one' } }],
      executionStatus: 'completed',
    }),
    message('t1', 'tool', {
      content: '',
      toolResults: [{ toolCallId: 'reused', content: 'one' }],
    }),
    message('a2', 'assistant', {
      content: 'Second call.',
      toolCalls: [{ id: 'reused', name: 'read', arguments: { path: 'two' } }],
      executionStatus: 'completed',
    }),
    message('t2', 'tool', {
      content: '',
      toolResults: [{ toolCallId: 'reused', content: 'two' }],
    }),
    message('a3', 'assistant', { content: 'Complete.' }),
  ]);
  const boundary = getBranchBoundary(source, { kind: 'after-turn', assistantMessageId: 'a3' });
  assert.ok(boundary);

  const branch = createBranchedSession(source, boundary, 500, () => 'branch-id');
  const firstCallId = branch.messages[1].toolCalls?.[0]?.id;
  const secondCallId = branch.messages[3].toolCalls?.[0]?.id;
  assert.ok(firstCallId);
  assert.ok(secondCallId);
  assert.notEqual(firstCallId, secondCallId);
  assert.equal(branch.messages[2].toolResults?.[0]?.toolCallId, firstCallId);
  assert.equal(branch.messages[4].toolResults?.[0]?.toolCallId, secondCallId);
});

test('getBranchBoundary rejects orphan and mismatched tool results', () => {
  const orphan = session([
    message('u1', 'user'),
    message('t1', 'tool', {
      content: '',
      toolResults: [{ toolCallId: 'missing', content: 'orphan' }],
    }),
    message('a1', 'assistant', { content: 'Answer.' }),
  ]);
  assert.equal(
    getBranchBoundary(orphan, { kind: 'after-turn', assistantMessageId: 'a1' }),
    null,
  );

  const mismatched = session([
    message('u1', 'user'),
    message('a1', 'assistant', {
      content: 'Checking.',
      toolCalls: [{ id: 'call-1', name: 'read', arguments: {} }],
      executionStatus: 'completed',
    }),
    message('t1', 'tool', {
      content: '',
      toolResults: [{ toolCallId: 'other-call', content: 'wrong' }],
    }),
    message('a2', 'assistant', { content: 'Answer.' }),
  ]);
  assert.equal(
    getBranchBoundary(mismatched, { kind: 'after-turn', assistantMessageId: 'a2' }),
    null,
  );
});

test('before-latest-turn restores the latest user prompt as a draft', () => {
  const attachment = {
    base64Data: 'aGVsbG8=',
    mediaType: 'text/plain',
    filename: 'note.txt',
  };
  const source = session([
    message('u1', 'user'),
    message('a1', 'assistant', { content: 'First answer.' }),
    message('u2', 'user', { content: 'Try another approach', attachments: [attachment] }),
    ...completeToolTurn().slice(1),
  ]);

  assert.deepEqual(
    getBranchBoundary(source, { kind: 'before-latest-turn' }),
    {
      messageCount: 2,
      userDraft: {
        content: 'Try another approach',
        attachments: [attachment],
      },
    },
  );
});

test('before-latest-turn can undo the first turn to an empty branch', () => {
  const source = session([
    message('u1', 'user', { content: 'Initial prompt' }),
    message('a1', 'assistant', { content: 'Initial answer' }),
  ]);

  assert.deepEqual(
    getBranchBoundary(source, { kind: 'before-latest-turn' }),
    {
      messageCount: 0,
      userDraft: { content: 'Initial prompt' },
    },
  );
});

test('before-latest-turn rejects partial latest turns and invalid preceding history', () => {
  const partial = session([
    message('u1', 'user'),
    message('a1', 'assistant', { content: 'First answer.' }),
    message('u2', 'user'),
  ]);
  assert.equal(getBranchBoundary(partial, { kind: 'before-latest-turn' }), null);

  const unsafePrevious = session([
    message('u1', 'user'),
    message('a1', 'assistant', {
      content: 'Started a tool.',
      toolCalls: [{ id: 'call-1', name: 'write', arguments: {} }],
      executionStatus: 'completed',
    }),
    message('u2', 'user'),
    message('a2', 'assistant', { content: 'Latest answer.' }),
  ]);
  assert.equal(getBranchBoundary(unsafePrevious, { kind: 'before-latest-turn' }), null);
});

test('compaction must be valid and entirely retained by the branch boundary', () => {
  const messages = [
    message('u1', 'user'),
    message('a1', 'assistant', { content: 'First answer.' }),
    message('u2', 'user'),
    message('a2', 'assistant', { content: 'Second answer.' }),
  ];
  const compacted = session(messages, {
    contextCompaction: { summary: 'Summary of the first turn.', compactedMessageCount: 2 },
  });

  assert.deepEqual(
    getBranchBoundary(compacted, { kind: 'after-turn', assistantMessageId: 'a1' }),
    { messageCount: 2 },
  );
  assert.equal(getBranchBoundary(compacted, { kind: 'before-latest-turn' })?.messageCount, 2);

  const crossesCompaction = session(messages, {
    contextCompaction: { summary: 'Summary includes part of latest turn.', compactedMessageCount: 3 },
  });
  assert.equal(
    getBranchBoundary(crossesCompaction, { kind: 'after-turn', assistantMessageId: 'a1' }),
    null,
  );
  assert.equal(getBranchBoundary(crossesCompaction, { kind: 'before-latest-turn' }), null);

  const splitToolExchange = session(completeToolTurn(), {
    contextCompaction: { summary: 'Ends after the tool call.', compactedMessageCount: 2 },
  });
  assert.equal(
    getBranchBoundary(splitToolExchange, { kind: 'after-turn', assistantMessageId: 'a2' }),
    null,
  );

  const invalidCount = session(messages, {
    contextCompaction: { summary: 'Invalid.', compactedMessageCount: 99 },
  });
  assert.equal(
    getBranchBoundary(invalidCount, { kind: 'after-turn', assistantMessageId: 'a2' }),
    null,
  );

  const emptySummary = session(messages, {
    contextCompaction: { summary: '   ', compactedMessageCount: 2 },
  });
  assert.equal(
    getBranchBoundary(emptySummary, { kind: 'after-turn', assistantMessageId: 'a2' }),
    null,
  );
});

test('createBranchedSession copies portable state and strips continuation state and output handles', () => {
  const source = session([
    message('u1', 'user', {
      content: 'Use handleId=tool-output-user-1 if needed',
      attachments: [{
        base64Data: 'tool-output-attachment-1',
        mediaType: 'text/plain',
        filename: 'tool-output-file-1.txt',
      }],
    }),
    message('a1', 'assistant', {
      content: 'Result references tool-output-plain-1',
      providerContinuation: {
        source: { providerConfigId: 'provider-1', providerType: 'openai' },
        reasoningParts: [{ text: 'secret continuation' }],
      },
      thinking: 'Visible reasoning',
    }),
  ], {
    externalSessionId: 'external-thread-1',
    contextCompaction: {
      summary: 'Archived at handleId=tool-output-summary-1',
      compactedMessageCount: 0,
    },
  });
  const boundary = getBranchBoundary(
    source,
    { kind: 'after-turn', assistantMessageId: 'a1' },
  );
  assert.ok(boundary);

  let idIndex = 0;
  const branch = createBranchedSession(source, boundary, 500, () => `branch-id-${idIndex++}`);

  assert.equal(branch.id, 'branch-id-0');
  assert.equal(branch.title, source.title);
  assert.equal(branch.agentId, source.agentId);
  assert.deepEqual(branch.scope, source.scope);
  assert.equal(branch.createdAt, 500);
  assert.equal(branch.updatedAt, 500);
  assert.equal(branch.externalSessionId, undefined);
  assert.equal(branch.messages.length, 2);
  assert.equal(new Set(branch.messages.map(entry => entry.id)).size, 2);
  assert.equal(branch.messages.some((entry, index) => entry.id === source.messages[index].id), false);
  assert.deepEqual(branch.lineage, {
    parentSessionId: source.id,
    branchedFromMessageId: 'a1',
  });
  assert.equal(branch.messages[1].providerContinuation, undefined);
  assert.equal(branch.messages[1].thinking, 'Visible reasoning');
  assert.doesNotMatch(JSON.stringify(branch), /tool-output-[A-Za-z0-9-]+/);
  assert.match(branch.messages[0].content, /output handle removed/);
  assert.match(branch.contextCompaction?.summary ?? '', /output handle removed/);

  assert.notEqual(branch.messages, source.messages);
  assert.notEqual(branch.messages[0], source.messages[0]);
  assert.notEqual(branch.scope, source.scope);
  assert.equal(source.externalSessionId, 'external-thread-1');
  assert.ok(source.messages[1].providerContinuation);
});

test('createBranchedSession rejects fabricated unsafe boundaries', () => {
  const source = session(completeToolTurn());
  const fabricated: AISessionBranchBoundary = { messageCount: 2 };

  assert.throws(
    () => createBranchedSession(source, fabricated, 500, () => 'branch-id'),
    /unsafe boundary/,
  );
});
