import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildForkTitle,
  canForkFromMessage,
  collectForkHandleIds,
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

test('stripMessageContinuationState keeps untouched references stable', () => {
  const plain = msg({ content: 'x' });
  assert.equal(stripMessageContinuationState(plain), plain);
  const withStatusText = msg({ content: 'x', statusText: 'streaming…' });
  assert.notEqual(stripMessageContinuationState(withStatusText), withStatusText);
  const withPendingApproval = msg({ content: 'x', pendingApproval: {} });
  assert.notEqual(stripMessageContinuationState(withPendingApproval), withPendingApproval);
  const continuationOnly = msg({ content: 'x', providerContinuation: {} });
  assert.equal(stripMessageContinuationState(continuationOnly), continuationOnly);
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

test('collectForkHandleIds also scans a carried-over compaction summary', () => {
  const messages: ForkMessage[] = [
    msg({ role: 'user', content: 'continue from the summary' }),
    msg({ content: 'noted, handleId=tool-output-abc123 is the live one' }),
  ];
  const summary = 'Earlier turn archived locally: handleId=tool-output-xyz789. '
    + 'Uses handleId=tool-output-abc123 again.';
  assert.deepEqual(
    collectForkHandleIds(messages, summary),
    ['tool-output-abc123', 'tool-output-xyz789'],
  );
  // No summary: unchanged behavior.
  assert.deepEqual(collectForkHandleIds(messages), ['tool-output-abc123']);
});
