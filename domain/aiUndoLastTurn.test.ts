import assert from 'node:assert/strict';
import test from 'node:test';

import type { AISession, ChatMessage } from '../infrastructure/ai/types.ts';
import { ToolOutputStore } from '../infrastructure/ai/harness/toolOutputStore.ts';
import {
  buildCattySdkMessages,
  createContinuationContext,
} from '../infrastructure/ai/harness/turnDrivers/cattyMessageBuilder.ts';
import { stripAiSessionPayloadForSync } from './syncMerge.ts';
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

for (const field of ['attachments', 'images'] as const) {
  test(`undoing downloaded ${field} restores note mentions but never sends empty file content`, () => {
    const [downloaded] = stripAiSessionPayloadForSync([session([{
      ...user('Inspect the attachments'),
      [field]: [
        { base64Data: 'cGljdHVyZQ==', mediaType: 'image/png', filename: 'picture.png' },
        { base64Data: 'ZG9jdW1lbnQ=', mediaType: 'application/pdf', filename: 'document.pdf' },
        { base64Data: 'bG9n', mediaType: 'text/plain', filename: 'terminal.log', terminalSelection: true },
        { base64Data: '', mediaType: 'text/markdown', vaultNoteId: 'note-1', vaultNoteTitle: 'Runbook' },
      ],
    }, assistant('Done')])]);
    const result = buildUndoLastTurnBranch(downloaded, { newId: 'branch', now: 42 });
    assert.ok(result);
    assert.equal(result.restored.text, 'Inspect the attachments');
    assert.deepEqual(result.restored.attachments.map((attachment) => attachment.vaultNoteId), ['note-1']);

    const messages = buildCattySdkMessages({
      allMessages: result.session.messages,
      includeCurrentUserMessage: true,
      trimmed: result.restored.text,
      attachments: result.restored.attachments,
      continuationContext: createContinuationContext('provider', 'openai', 'model', false),
      chatSessionId: result.session.id,
      toolOutputStore: new ToolOutputStore(),
      fieldsByMessage: new Map(),
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.equal(typeof messages[0].content, 'string');
    assert.match(String(messages[0].content), /Inspect the attachments/);
    assert.match(String(messages[0].content), /"noteId":"note-1"/);
    assert.doesNotMatch(JSON.stringify(messages), /"type":"file"/);
  });
}

test('undo skips attachment records whose body is absent and preserves real local files', () => {
  const source = session([{
    ...user('Inspect'),
    attachments: [
      // Older downloaded metadata did not retain base64Data or an availability marker.
      JSON.parse('{"mediaType":"image/png","filename":"missing.png"}'),
      { base64Data: '', mediaType: 'application/pdf', filename: 'empty.pdf' },
      { base64Data: 'YWJj', mediaType: 'text/plain', filename: 'local.log', terminalSelection: true },
    ],
  }]);
  const result = buildUndoLastTurnBranch(source, { newId: 'branch', now: 42 });
  assert.ok(result);
  assert.equal(result.restored.attachments.length, 1);
  assert.equal(result.restored.attachments[0].filename, 'local.log');
  assert.equal(result.restored.attachments[0].base64Data, 'YWJj');
  assert.equal(result.restored.attachments[0].dataUrl, 'data:text/plain;base64,YWJj');
  assert.equal(result.restored.attachments[0].terminalSelection, true);
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

test('buildUndoLastTurnBranch keeps the title when the retained user turn is note-only', () => {
  // A note-only send persists empty user text while the mentioned note rides
  // on the attachment (its title seeded the conversation title), so a
  // blank-content retained user turn must still count as "a user message is
  // kept" and must not reset the title to the untitled placeholder.
  const noteOnlyUser: ChatMessage = {
    id: 'u_note-only',
    role: 'user',
    content: '',
    timestamp: 3,
    attachments: [{
      base64Data: '',
      mediaType: 'text/markdown',
      filename: 'plan.md',
      vaultNoteId: 'note-1',
      vaultNoteTitle: 'Deploy plan',
      previewText: '# Deploy plan',
    }],
  };
  const source = session(
    [noteOnlyUser, assistant('reply'), user('second prompt'), assistant('reply2')],
    { title: 'Deploy plan' },
  );
  const result = buildUndoLastTurnBranch(source, { newId: 'chat-branch', now: 100 });
  assert.ok(result);
  assert.equal(result?.session.title, 'Deploy plan');
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

test('undo allows a failed last reply while retaining portable replay metadata', () => {
  const continuation = { reasoningParts: [{ text: 'checked', providerOptions: { anthropic: { signature: 'signed-thinking' } } }] };
  const source = session([
    user('first'),
    assistant('first answer', { providerContinuation: continuation }),
    user('retry this request'),
    assistant('request failed', { executionStatus: 'failed' }),
  ], { externalSessionId: 'original-provider-thread' });
  const result = buildUndoLastTurnBranch(source, { newId: 'branch', now: 99 });
  assert.ok(result);
  assert.deepEqual(result.session.messages[1].providerContinuation, continuation);
  assert.equal(result.session.externalSessionId, undefined);
  assert.equal(result.restored.text, 'retry this request');
  assert.equal(source.messages.length, 4);
});

test('safe boundary does not pair a reused call ID with an earlier result', () => {
  const prefix = [
    assistant('first call', { toolCalls: [{ id: 'reused', name: 'terminal_execute', arguments: {} }] }),
    assistant('first result', { toolResults: [{ toolCallId: 'reused', content: 'done' }] }),
    assistant('second call', { toolCalls: [{ id: 'reused', name: 'terminal_execute', arguments: {} }] }),
  ];
  assert.equal(resolveUndoLastTurnBoundary([...prefix, user('latest')]), null);
  assert.equal(resolveUndoLastTurnBoundary([
    ...prefix,
    assistant('second result', { toolResults: [{ toolCallId: 'reused', content: 'done again' }] }),
    user('latest'),
  ]), 4);
});
