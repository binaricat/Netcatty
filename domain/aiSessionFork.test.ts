import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildForkTitle,
  canForkFromMessage,
  getForkableMessageIds,
  planSessionFork,
  stripMessageContinuationState,
} from './aiSessionFork.ts';

import type { ForkMessage } from './aiSessionFork.ts';

let nextId = 0;
const msg = (overrides: Partial<ForkMessage>): ForkMessage => ({
  id: `m${nextId++}`,
  role: 'assistant',
  content: '',
  timestamp: 0,
  ...overrides,
} as ForkMessage);

const session = (messages: ForkMessage[], contextCompaction?: { summary: string; compactedMessageCount: number }) => ({
  title: 'Debug deploy',
  messages,
  contextCompaction,
});

test('planSessionFork keeps the original untouched and plans a copy through the boundary', () => {
  const user = msg({ role: 'user', content: 'run tests' });
  const assistant = msg({ content: 'done, all green' });
  const source = session([user, assistant]);
  const plan = planSessionFork(source, assistant.id);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.boundaryIndex, 1);
  assert.deepEqual(plan.messages, [user, assistant]);
  assert.equal(plan.title, 'Debug deploy (fork)');
});

test('planSessionFork rejects non-assistant and missing boundaries', () => {
  const source = session([
    msg({ role: 'user', content: 'hi' }),
  ]);
  assert.deepEqual(planSessionFork(source, source.messages[0].id), { ok: false, reason: 'not-assistant' });
  assert.deepEqual(planSessionFork(source, 'missing'), { ok: false, reason: 'message-not-found' });
});

test('planSessionFork rejects failed, cancelled, running, and streaming boundaries', () => {
  for (const executionStatus of ['failed', 'cancelled', 'running', 'pending']) {
    const source = session([msg({ content: 'x', executionStatus })]);
    assert.deepEqual(planSessionFork(source, source.messages[0].id), {
      ok: false,
      reason: 'not-completed',
    });
  }
  const streamingSource = session([msg({ statusText: 'Waiting for response…' })]);
  assert.deepEqual(planSessionFork(streamingSource, streamingSource.messages[0].id), {
    ok: false,
    reason: 'not-completed',
  });
  const failedSource = session([msg({ errorInfo: { type: 'provider', message: 'boom', retryable: true } })]);
  assert.deepEqual(planSessionFork(failedSource, failedSource.messages[0].id), {
    ok: false,
    reason: 'not-completed',
  });
  const pendingSource = session([msg({ pendingApproval: {} })]);
  assert.deepEqual(planSessionFork(pendingSource, pendingSource.messages[0].id), {
    ok: false,
    reason: 'not-completed',
  });
});

test('planSessionFork rejects boundaries with dangling tool calls', () => {
  const source = session([
    msg({ role: 'user', content: 'hi' }),
    msg({ content: '', toolCalls: [{ id: 'call-1' }] }),
    msg({ content: '', toolCalls: [{ id: 'call-2' }] }),
    msg({
      role: 'tool',
      content: 'ok',
      toolResults: [{ toolCallId: 'call-1', content: 'out' }],
    }),
    msg({ content: 'final answer' }),
  ]);
  // call-2 never got a result inside the retained prefix
  assert.deepEqual(planSessionFork(source, source.messages[4].id), {
    ok: false,
    reason: 'dangling-tool-call',
  });
  // forking at the tool-issuing assistant turns is not possible anyway
  assert.deepEqual(planSessionFork(source, source.messages[2].id), {
    ok: false,
    reason: 'dangling-tool-call',
  });
});

test('planSessionFork forks at the first turn boundary after results resolve', () => {
  const source = session([
    msg({ role: 'user', content: 'hi' }),
    msg({ role: 'assistant', content: '', toolCalls: [{ id: 'call-1' }] }),
    msg({ role: 'tool', content: 'ok', toolResults: [{ toolCallId: 'call-1', content: 'out' }] }),
    msg({ role: 'assistant', content: 'all done' }),
  ]);
  assert.deepEqual(planSessionFork(source, source.messages[1].id), {
    ok: false,
    reason: 'dangling-tool-call',
  });
  const plan = planSessionFork(source, source.messages[3].id);
  assert.equal(plan.ok, true);
});

test('planSessionFork rejects boundaries with dangling tool results', () => {
  const source = session([
    msg({ role: 'assistant', content: 'x' }),
    msg({ role: 'tool', content: 'ok', toolResults: [{ toolCallId: 'orphan', content: 'out' }] }),
    msg({ role: 'assistant', content: 'answer' }),
  ]);
  assert.deepEqual(planSessionFork(source, source.messages[2].id), {
    ok: false,
    reason: 'dangling-tool-result',
  });
});

test('planSessionFork lets the compaction summary ride along while it stays accurate', () => {
  const source = session(
    [msg({ role: 'user', content: 'hi' }), msg({ content: 'done' })],
    { summary: 'earlier talk', compactedMessageCount: 1 },
  );
  const plan = planSessionFork(source, source.messages[1].id);
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.deepEqual(plan.contextCompaction, { summary: 'earlier talk', compactedMessageCount: 1 });
  }
});

test('planSessionFork refuses when the compaction summary would cover discarded messages', () => {
  const early = msg({ content: 'early turn' });
  const source = session(
    [early, msg({ content: 'later turn' })],
    { summary: 'covers both turns', compactedMessageCount: 2 },
  );
  assert.deepEqual(planSessionFork(source, early.id), {
    ok: false,
    reason: 'compaction-covers-discarded',
  });
});

test('planSessionFork preserves provider replay metadata but strips turn state', () => {
  const continuation = { reasoningParts: [{ text: 'chain of thought' }] };
  const user = msg({ role: 'user', content: 'hi', providerContinuation: continuation, statusText: 'streaming…' });
  const assistant = msg({ content: 'answer', providerContinuation: continuation });
  const source = session([user, assistant]);
  const plan = planSessionFork(source, assistant.id);
  assert.equal(plan.ok, true);
  if (plan.ok) {
    for (const message of plan.messages) {
      assert.equal(message.providerContinuation, continuation);
      assert.equal(message.statusText, undefined);
    }
  }
  // untouched source keeps its original message objects and turn state
  assert.equal(source.messages[0].providerContinuation, continuation);
  assert.equal(source.messages[0].statusText, 'streaming…');
});

test('planSessionFork pairs repeated tool-call ids by occurrence', () => {
  const source = session([
    msg({ role: 'user', content: 'hi' }),
    msg({ role: 'assistant', content: '', toolCalls: [{ id: 'call-1' }] }),
    msg({ role: 'tool', content: 'first', toolResults: [{ toolCallId: 'call-1', content: 'out 1' }] }),
    msg({ role: 'assistant', content: '', toolCalls: [{ id: 'call-1' }] }),
    msg({ role: 'assistant', content: 'answer' }),
  ]);
  // The provider reused call-1; the second occurrence never got a result.
  assert.deepEqual(planSessionFork(source, source.messages[4].id), {
    ok: false,
    reason: 'dangling-tool-call',
  });
  const resolved = session([
    msg({ role: 'assistant', content: '', toolCalls: [{ id: 'call-1' }] }),
    msg({ role: 'tool', content: 'first', toolResults: [{ toolCallId: 'call-1', content: 'out 1' }] }),
    msg({ role: 'assistant', content: '', toolCalls: [{ id: 'call-1' }] }),
    msg({ role: 'tool', content: 'second', toolResults: [{ toolCallId: 'call-1', content: 'out 2' }] }),
    msg({ role: 'assistant', content: 'answer' }),
  ]);
  assert.equal(planSessionFork(resolved, resolved.messages[4].id).ok, true);
  // One result cannot satisfy two pending calls with the same id.
  const underResolved = session([
    msg({ role: 'assistant', content: '', toolCalls: [{ id: 'call-1' }, { id: 'call-1' }] }),
    msg({ role: 'tool', content: 'single', toolResults: [{ toolCallId: 'call-1', content: 'out' }] }),
    msg({ role: 'assistant', content: 'answer' }),
  ]);
  assert.deepEqual(planSessionFork(underResolved, underResolved.messages[2].id), {
    ok: false,
    reason: 'dangling-tool-call',
  });
});

test('stripMessageContinuationState preserves values and clears transient state', () => {
  const plain = msg({ content: 'x' });
  assert.deepEqual(stripMessageContinuationState(plain), plain);
  const withStatusText = msg({ content: 'x', statusText: 'streaming…' });
  assert.notEqual(stripMessageContinuationState(withStatusText), withStatusText);
  const withPendingApproval = msg({ content: 'x', pendingApproval: {} });
  assert.notEqual(stripMessageContinuationState(withPendingApproval), withPendingApproval);
  const continuationOnly = msg({ content: 'x', providerContinuation: {} });
  assert.deepEqual(stripMessageContinuationState(continuationOnly), continuationOnly);
});

test('buildForkTitle appends a fork marker without double-suffixing', () => {
  assert.equal(buildForkTitle('Debug deploy'), 'Debug deploy (fork)');
  assert.equal(buildForkTitle('Debug deploy (fork)'), 'Debug deploy (fork)');
  assert.equal(buildForkTitle(''), 'New Chat (fork)');
});

test('canForkFromMessage mirrors planSessionFork success', () => {
  const source = session([msg({ role: 'user', content: 'hi' }), msg({ content: 'done' })]);
  assert.equal(canForkFromMessage(source, source.messages[1].id), true);
  assert.equal(canForkFromMessage(source, source.messages[0].id), false);
  assert.equal(canForkFromMessage(source, 'nope'), false);
});

test('fork keeps output previews but removes source-only saved-output references', () => {
  const assistant = msg({ content: 'preview handleId=tool-output-abc', toolResults: [{ toolCallId: 'call', content: '{"handleId":"tool-output-xyz","preview":"retained"}' }] });
  const source = session([msg({ toolCalls: [{ id: 'call' }] }), assistant], { summary: 'archive handleId=tool-output-summary', compactedMessageCount: 1 });
  const plan = planSessionFork(source, assistant.id);
  assert.ok(plan.ok);
  assert.doesNotMatch(JSON.stringify(plan), /tool-output-/);
  assert.match(plan.messages[1].content, /preview/);
  assert.match(plan.messages[1].toolResults![0].content!, /retained/);
  assert.equal(JSON.parse(plan.messages[1].toolResults![0].content!).handleId, null);
  assert.match(source.messages[1].content, /tool-output-abc/);
});

test('fork removes source output handles only from tool_output_read arguments', () => {
  const read = msg({ toolCalls: [{ id: 'read', name: 'tool_output_read', arguments: { handleId: 'tool-output-source', offset: 12 } }] });
  const done = msg({ toolResults: [{ toolCallId: 'read', content: 'preview' }], content: 'done' });
  const source = session([read, done]);
  const plan = planSessionFork(source, done.id);
  assert.ok(plan.ok);
  assert.equal(plan.messages[0].toolCalls![0].arguments!.handleId, undefined);
  assert.equal(plan.messages[0].toolCalls![0].arguments!.offset, 12);
  assert.equal(read.toolCalls![0].arguments!.handleId, 'tool-output-source');

  const other = msg({ toolCalls: [{ id: 'other', name: 'custom_tool', arguments: { handleId: 'tool-output-not-owned-here' } }] });
  assert.deepEqual(stripMessageContinuationState(other).toolCalls, other.toolCalls);
});

test('fork refuses source output references in provider reasoning without changing signed metadata', () => {
  const continuation = { reasoningParts: [{ text: 'Read handleId=tool-output-source for details', providerOptions: { anthropic: { signature: 'valid-signature' } } }] };
  const source = session([msg({ content: 'done', providerContinuation: continuation })]);
  assert.deepEqual(planSessionFork(source, source.messages[0].id), { ok: false, reason: 'source-output-reasoning' });
  assert.equal(canForkFromMessage(source, source.messages[0].id), false);
  assert.equal(source.messages[0].providerContinuation, continuation);
  assert.equal(continuation.reasoningParts[0].text, 'Read handleId=tool-output-source for details');
});

test('fork eligibility does not clone or scan retained message bodies', () => {
  const assistant = msg({ content: 'completed' });
  Object.defineProperty(assistant, 'content', { get() { throw new Error('eligibility should not build a transcript'); } });
  assert.equal(canForkFromMessage(session([assistant]), assistant.id), true);
});

test('one-pass fork eligibility matches clicked-boundary validation', () => {
  const messages = [
    msg({ role: 'user', content: 'start' }),
    msg({ content: 'first completed reply' }),
    msg({ toolCalls: [{ id: 'reused' }, { id: 'reused' }] }),
    msg({ role: 'tool', toolResults: [{ toolCallId: 'reused', content: 'one' }] }),
    msg({ content: 'still unresolved' }),
    msg({ role: 'tool', toolResults: [{ toolCallId: 'reused', content: 'two' }] }),
    msg({ content: 'complete exchange' }),
    msg({ executionStatus: 'failed' }),
    msg({ content: 'unsafe reasoning', providerContinuation: { reasoningParts: [{ text: 'Read tool-output-source' }] } }),
    msg({ content: 'after unsafe reasoning' }),
  ];
  for (const compactedMessageCount of [0, 3, messages.length]) {
    const source = session(messages, { summary: 'summary', compactedMessageCount });
    assert.deepEqual([...getForkableMessageIds(source)], messages.filter(message => planSessionFork(source, message.id).ok).map(message => message.id));
  }
  const orphan = session([msg({ role: 'tool', toolResults: [{ toolCallId: 'orphan' }] }), msg({ content: 'reply' })]);
  assert.equal(getForkableMessageIds(orphan).size, 0);
});

test('fork removes bare output identifiers in transcript previews while preserving JSON', () => {
  const assistant = msg({ content: 'Read tool-output-source with tool_output_read', thinking: 'Output tool-output-source is saved', toolResults: [{ toolCallId: 'call', content: '{"handleId":"tool-output-source","preview":"Read tool-output-source"}' }] });
  const plan = planSessionFork(session([msg({ toolCalls: [{ id: 'call' }] }), assistant]), assistant.id);
  assert.ok(plan.ok);
  assert.doesNotMatch(JSON.stringify(plan.messages), /tool-output-source/);
  const parsed = JSON.parse(plan.messages[1].toolResults![0].content!);
  assert.equal(parsed.handleId, null);
  assert.match(parsed.preview, /Read/);
  assert.match(assistant.content, /tool-output-source/);
});

test('fork sanitizes attachment previews without changing attachment data or identity', () => {
  const attachment = { base64Data: 'SEVMTE8=', mediaType: 'text/plain', filename: 'terminal-selection.log', terminalSelection: true, lineCount: 3, filePath: '/original/selection.log', previewText: 'Read tool-output-selection with tool_output_read' };
  const image = { base64Data: 'UE5H', mediaType: 'image/png', filename: 'original.png' };
  const user = msg({ role: 'user', content: 'Inspect', attachments: [attachment, image], images: [attachment] });
  const assistant = msg({ content: 'done' });
  const plan = planSessionFork(session([user, assistant]), assistant.id);
  assert.ok(plan.ok);
  assert.doesNotMatch(plan.messages[0].attachments![0].previewText!, /tool-output-selection/);
  assert.deepEqual({ ...plan.messages[0].attachments![0], previewText: attachment.previewText }, attachment);
  assert.equal(plan.messages[0].attachments![1], image);
  assert.doesNotMatch(plan.messages[0].images![0].previewText!, /tool-output-selection/);
  assert.equal(user.attachments![0], attachment);
  assert.equal(attachment.previewText, 'Read tool-output-selection with tool_output_read');
});

test('fork still rejects an unresolved retained call even when compaction covers it', () => {
  const unresolved = msg({ toolCalls: [{ id: 'pending' }], executionStatus: 'cancelled' });
  const done = msg({ content: 'later completed answer' });
  const source = session([unresolved, done], { summary: 'the earlier call was interrupted', compactedMessageCount: 1 });
  assert.deepEqual(planSessionFork(source, done.id), { ok: false, reason: 'dangling-tool-call' });
  assert.equal(getForkableMessageIds(source).has(done.id), false);
});
