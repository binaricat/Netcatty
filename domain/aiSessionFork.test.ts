import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildForkTitle,
  canForkFromMessage,
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

test('planSessionFork strips provider continuation state from retained messages', () => {
  const continuation = { provider: 'claude', threadId: 'provider-thread-1' };
  const user = msg({ role: 'user', content: 'hi', providerContinuation: continuation });
  const assistant = msg({ content: 'answer', providerContinuation: continuation, statusText: undefined });
  const source = session([user, assistant]);
  const plan = planSessionFork(source, assistant.id);
  assert.equal(plan.ok, true);
  if (plan.ok) {
    for (const message of plan.messages) {
      assert.equal(message.providerContinuation, undefined);
    }
  }
  // untouched source keeps the original objects with their continuation state
  assert.equal(source.messages[1].providerContinuation, continuation);
});

test('stripMessageContinuationState keeps untouched references stable', () => {
  const plain = msg({ content: 'x' });
  assert.equal(stripMessageContinuationState(plain), plain);
  const withContinuation = msg({ content: 'x', providerContinuation: {} });
  assert.notEqual(stripMessageContinuationState(withContinuation), withContinuation);
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
