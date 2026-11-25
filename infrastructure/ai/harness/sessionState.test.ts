import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionStateStore } from './sessionState.ts';

test('SessionStateStore tracks terminal commands and reinjection text', () => {
  const store = new SessionStateStore();
  store.mergeFromUserGoal('chat-1', 'Fix nginx upstream timeout');
  store.updateFromToolResult(
    'chat-1',
    'terminal_execute',
    { sessionId: 'sess-1', command: 'tail -n 100 /var/log/nginx/error.log' },
    'upstream timed out',
    false,
  );

  const text = store.toReinjectionText('chat-1');
  assert.ok(text?.includes('Fix nginx upstream timeout'));
  assert.ok(text?.includes('sess-1'));
  assert.ok(text?.includes('tail -n 100'));
});

test('SessionStateStore records tool errors as blockers', () => {
  const store = new SessionStateStore();
  store.updateFromToolResult(
    'chat-1',
    'terminal_execute',
    { sessionId: 'sess-1', command: 'systemctl restart nginx' },
    '{ "error": "Job failed" }',
    true,
  );
  const text = store.toReinjectionText('chat-1');
  assert.ok(text?.includes('Open blockers'));
});

test('SessionStateStore restores active background jobs and poll cursors', () => {
  const store = new SessionStateStore();
  store.updateFromToolResult(
    'chat-1',
    'terminal_start',
    { sessionId: 'sess-1', command: 'npm run dev' },
    JSON.stringify({ ok: true, jobId: 'job-1', status: 'running', nextOffset: 0 }),
  );
  store.updateFromToolResult(
    'chat-1',
    'terminal_poll',
    { jobId: 'job-1', offset: 0 },
    JSON.stringify({ ok: true, jobId: 'job-1', status: 'running', nextOffset: 420 }),
  );

  const state = store.get('chat-1');
  assert.equal(state.version, 1);
  assert.equal(state.activeJobs['job-1'].nextOffset, 420);
  const text = store.toReinjectionText('chat-1') ?? '';
  assert.match(text, /job-1/);
  assert.match(text, /offset=420/);
  assert.match(text, /poll the existing job/i);
  assert.match(text, /do not restart/i);
  assert.match(text, /unverified after compaction/i);
});

test('SessionStateStore drops a remembered job after poll reports it missing', () => {
  const store = new SessionStateStore();
  store.updateFromToolResult(
    'chat-1', 'terminal_start', { sessionId: 'sess-1', command: 'npm run dev' },
    JSON.stringify({ jobId: 'job-lost', status: 'running' }), false,
  );
  store.updateFromToolResult(
    'chat-1', 'terminal_poll', { jobId: 'job-lost', offset: 0 },
    JSON.stringify({ error: 'Job not found' }), true,
  );
  assert.equal(store.get('chat-1').activeJobs['job-lost'], undefined);
  assert.doesNotMatch(store.toReinjectionText('chat-1') ?? '', /Remembered terminal jobs/);
});

test('SessionStateStore preserves a running job after a transient poll error', () => {
  const store = new SessionStateStore();
  store.updateFromToolResult(
    'chat-1', 'terminal_start', { sessionId: 'sess-1', command: 'npm run dev' },
    JSON.stringify({ jobId: 'job-running', status: 'running', nextOffset: 420 }), false,
  );
  store.updateFromToolResult(
    'chat-1', 'terminal_poll', { jobId: 'job-running', offset: 420 },
    JSON.stringify({ error: 'temporary IPC timeout' }), true,
  );

  const job = store.get('chat-1').activeJobs['job-running'];
  assert.equal(job.status, 'unverified');
  assert.equal(job.nextOffset, 420);
  assert.match(store.toReinjectionText('chat-1') ?? '', /job-running/);
  assert.match(store.toReinjectionText('chat-1') ?? '', /do not restart/i);
});

test('SessionStateStore drops a job after poll confirms cancellation', () => {
  const store = new SessionStateStore();
  store.updateFromToolResult(
    'chat-1', 'terminal_start', { sessionId: 'sess-1', command: 'npm run dev' },
    JSON.stringify({ jobId: 'job-cancelled', status: 'running' }), false,
  );
  store.updateFromToolResult(
    'chat-1', 'terminal_poll', { jobId: 'job-cancelled', offset: 0 },
    JSON.stringify({ jobId: 'job-cancelled', status: 'cancelled', error: 'Cancelled' }), true,
  );

  assert.equal(store.get('chat-1').activeJobs['job-cancelled'], undefined);
});

test('SessionStateStore records the last terminal screen range read', () => {
  const store = new SessionStateStore();
  store.updateFromToolResult(
    'chat-1',
    'terminal_read_context',
    { sessionId: 'sess-1', range: 'tail', startLine: 80, maxLines: 20 },
    JSON.stringify({ ok: true, sessionId: 'sess-1', startLine: 80, endLine: 99 }),
  );

  assert.deepEqual(store.get('chat-1').terminalReadCursors['sess-1'], {
    range: 'tail',
    startLine: 80,
    endLine: 99,
  });
});

test('SessionStateStore reinjects edited files and unfinished plan items', () => {
  const store = new SessionStateStore();
  store.mergeFileChanges('chat-1', ['/repo/src/a.ts', '/repo/src/b.ts']);
  store.mergePlan('chat-1', [
    { text: 'inspect failure', completed: true },
    { text: 'run regression tests', completed: false },
  ]);

  const text = store.toReinjectionText('chat-1') ?? '';
  assert.match(text, /\/repo\/src\/a\.ts/);
  assert.match(text, /\[done\] inspect failure/);
  assert.match(text, /\[todo\] run regression tests/);
});

test('SessionStateStore evicts least-recently-used sessions beyond maxSessions', () => {
  const store = new SessionStateStore(3);
  store.mergeFromUserGoal('chat-1', 'Goal 1');
  store.mergeFromUserGoal('chat-2', 'Goal 2');
  store.mergeFromUserGoal('chat-3', 'Goal 3');

  // Read chat-1 to refresh its recency so chat-2 is evicted next
  assert.equal(store.get('chat-1').userGoal, 'Goal 1');

  store.mergeFromUserGoal('chat-4', 'Goal 4');

  assert.equal(store.get('chat-2').userGoal, undefined);
  assert.equal(store.toReinjectionText('chat-2'), undefined);
  assert.equal(store.get('chat-1').userGoal, 'Goal 1');
  assert.equal(store.get('chat-3').userGoal, 'Goal 3');
  assert.equal(store.get('chat-4').userGoal, 'Goal 4');
});
