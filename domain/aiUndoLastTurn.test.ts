import assert from 'node:assert/strict';
import test from 'node:test';

import type { AISession, ChatMessage } from '../infrastructure/ai/types.ts';
import {
  buildUndoLastTurnBranch,
  hasUnresolvedToolCalls,
  resolveUndoLastTurnBoundary,
} from './aiUndoLastTurn.ts';

const user = (content: string): ChatMessage => ({
  id: `u_${content}`,
  role: 'user',
  content,
  timestamp: 1,
});
const assistant = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `a_${content}`,
  role: 'assistant',
  content,
  timestamp: 2,
  ...extra,
});
const session = (messages: ChatMessage[], extra: Partial<AISession> = {}): AISession => ({
  id: 'chat-1',
  title: 'Chat',
  agentId: 'catty',
  scope: { type: 'terminal', targetId: 't1' },
  messages,
  createdAt: 1,
  updatedAt: 2,
  ...extra,
});

test('resolveUndoLastTurnBoundary finds the last user message index', () => {
  const messages = [user('one'), assistant('reply'), user('two'), assistant('reply2')];
  assert.equal(resolveUndoLastTurnBoundary(messages), 2);
});

test('resolveUndoLastTurnBoundary returns null without a user message', () => {
  assert.equal(resolveUndoLastTurnBoundary([assistant('hello')]), null);
  assert.equal(resolveUndoLastTurnBoundary([]), null);
});

test('resolveUndoLastTurnBoundary refuses boundaries inside the compacted prefix', () => {
  const messages = [user('compacted'), assistant('x'), user('last'), assistant('y')];
  assert.equal(resolveUndoLastTurnBoundary(messages, 3), null);
  assert.equal(resolveUndoLastTurnBoundary(messages, 2), 2);
});

test('resolveUndoLastTurnBoundary refuses cuts between a tool call and its result', () => {
  // The call sits in the kept prefix while its result would be cut away.
  const split = [
    assistant('', {
      toolCalls: [{ id: 'call-1', name: 'harness.terminal.exec', arguments: {} }],
    }),
    user('again?'),
    assistant('', {
      toolResults: [{ toolCallId: 'call-1', content: 'ok' }],
    }),
  ];
  assert.equal(resolveUndoLastTurnBoundary(split), null);
  assert.ok(hasUnresolvedToolCalls(split.slice(0, 2)));
  // Result already inside the kept prefix — the boundary is safe.
  const resolved = [
    assistant('', {
      toolCalls: [{ id: 'call-1', name: 'harness.terminal.exec', arguments: {} }],
      toolResults: [{ toolCallId: 'call-1', content: 'ok' }],
    }),
    user('again?'),
    assistant('done'),
  ];
  assert.equal(hasUnresolvedToolCalls(resolved.slice(0, 1)), false);
  assert.equal(resolveUndoLastTurnBoundary(resolved), 1);
});

test('buildUndoLastTurnBranch branches before the last user turn and restores it', () => {
  const source = session([
    user('first'),
    assistant('answer'),
    user('bad prompt'),
    assistant('bad answer'),
  ]);
  const result = buildUndoLastTurnBranch(source, { newId: 'chat-2', now: 42 });
  assert.ok(result);
  assert.equal(result.session.id, 'chat-2');
  assert.deepEqual(result.session.messages.map((m) => m.content), ['first', 'answer']);
  assert.equal(result.restored.text, 'bad prompt');
  // Original session untouched (non-destructive).
  assert.equal(source.messages.length, 4);
});

test('buildUndoLastTurnBranch clears the external agent session id and keeps compaction', () => {
  const source = session(
    [user('compacted'), assistant('x'), user('last'), assistant('y')],
    {
      externalSessionId: 'prov-1',
      contextCompaction: { summary: 'summary', compactedMessageCount: 2 },
    },
  );
  const result = buildUndoLastTurnBranch(source, { newId: 'chat-2', now: 7 });
  assert.ok(result);
  assert.equal(result.session.externalSessionId, undefined);
  assert.deepEqual(result.session.contextCompaction, { summary: 'summary', compactedMessageCount: 2 });
});

test('buildUndoLastTurnBranch restores message attachments into composer uploads', () => {
  const source = session([
    user('with file'),
    assistant('ok'),
    {
      id: 'u_last',
      role: 'user',
      content: 'look at this',
      timestamp: 3,
      attachments: [
        { base64Data: 'QUJD', mediaType: 'text/plain', filename: 'notes.txt', lineCount: 3 },
      ],
    },
  ]);
  const result = buildUndoLastTurnBranch(source, { newId: 'chat-2', now: 99 });
  assert.ok(result);
  assert.deepEqual(result.restored.attachments, [
    {
      id: 'undo_99_0',
      filename: 'notes.txt',
      mediaType: 'text/plain',
      base64Data: 'QUJD',
      dataUrl: 'data:text/plain;base64,QUJD',
      lineCount: 3,
    },
  ]);
});

test('buildUndoLastTurnBranch returns null when no undo boundary exists', () => {
  assert.equal(
    buildUndoLastTurnBranch(session([assistant('only answer')]), { newId: 'x', now: 1 }),
    null,
  );
});
