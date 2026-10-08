import assert from 'node:assert/strict';
import test from 'node:test';

import type { AISession, ChatMessage } from '../infrastructure/ai/types.ts';
import {
  buildUndoLastTurnBranch,
  collectRetainedToolOutputHandleIds,
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

test('collectRetainedToolOutputHandleIds scans structured tool-call arguments and compaction', () => {
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'read the tail please', timestamp: 1 },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 2,
      // A failed read whose error result does not echo the requested id:
      // the call arguments are the only surviving reference to the handle.
      toolCalls: [
        {
          id: 'call-1',
          name: 'tool_output_read',
          arguments: { handleId: 'tool-output-arg-1', options: { head: 1 } },
        },
      ],
      toolResults: [{ toolCallId: 'call-1', content: 'error: handle not found' }],
    },
    { id: 'a2', role: 'assistant', content: 'archived handleId=tool-output-inline-1', timestamp: 3 },
  ];
  const ids = collectRetainedToolOutputHandleIds(
    messages,
    { summary: 'summary with handleId=tool-output-compaction-1', compactedMessageCount: 1 },
  );
  assert.ok(ids.has('tool-output-arg-1'));
  assert.ok(ids.has('tool-output-inline-1'));
  assert.ok(ids.has('tool-output-compaction-1'));

  // No tool calls and no embedded references: nothing collected.
  assert.deepEqual(
    collectRetainedToolOutputHandleIds([{ id: 'u', role: 'user', content: 'plain', timestamp: 4 }]),
    new Set(),
  );
});

test('buildUndoLastTurnBranch restores the undone turn selected user skills', () => {
  const source = session([
    user('first'),
    assistant('answer'),
    { ...user('undo me'), selectedUserSkillSlugs: ['web-search', 'notes-writer'] },
    assistant('bad answer'),
  ]);
  const result = buildUndoLastTurnBranch(source, { newId: 'chat-2', now: 42 });
  assert.ok(result);
  assert.deepEqual(result.restored.selectedUserSkillSlugs, ['web-search', 'notes-writer']);
  // Original session untouched (non-destructive).
  assert.deepEqual(source.messages[2]?.selectedUserSkillSlugs, ['web-search', 'notes-writer']);
});

test('buildUndoLastTurnBranch restores no skill slugs for a plain turn', () => {
  const source = session([user('first'), assistant('answer'), user('undo me'), assistant('ok')]);
  const result = buildUndoLastTurnBranch(source, { newId: 'chat-2', now: 42 });
  assert.ok(result);
  assert.deepEqual(result.restored.selectedUserSkillSlugs, []);
});

test('buildUndoLastTurnBranch returns null when no undo boundary exists', () => {
  assert.equal(
    buildUndoLastTurnBranch(session([assistant('only answer')]), { newId: 'x', now: 1 }),
    null,
  );
});

test('buildUndoLastTurnBranch resets the title when undo removes the first turn', () => {
  // Undoing the first turn leaves the branch with no user message at all, so
  // the inherited title was derived from the removed prompt and would stay
  // stale forever (auto-titling only runs for untitled/New Chat sessions).
  const source = session([user('first prompt'), assistant('reply')], { title: 'first prompt' });
  const result = buildUndoLastTurnBranch(source, { newId: 'chat-branch', now: 100 });
  assert.ok(result);
  assert.equal(result?.session.messages.length, 0);
  assert.equal(result?.restored.text, 'first prompt');
  assert.equal(result?.session.title, 'New Chat');
});

test('buildUndoLastTurnBranch keeps the title when a user message is retained', () => {
  const source = session(
    [user('first prompt'), assistant('reply'), user('second prompt'), assistant('reply2')],
    { title: 'renamed by user' },
  );
  const result = buildUndoLastTurnBranch(source, { newId: 'chat-branch', now: 100 });
  assert.ok(result);
  assert.equal(result?.session.messages.length, 2);
  assert.equal(result?.restored.text, 'second prompt');
  // The retained prefix still contains a user message, so the source title
  // keeps describing the branch's conversation.
  assert.equal(result?.session.title, 'renamed by user');
});
