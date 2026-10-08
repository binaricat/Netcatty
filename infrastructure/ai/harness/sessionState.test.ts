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

test('SessionStateStore rebuilds fork state from the retained prefix only', () => {
  const store = new SessionStateStore();
  // Pre-populate state derived from turns discarded by the branch: rebuild
  // must clear it instead of copying the source's latest state.
  store.mergeFromUserGoal('chat-fork', 'Older goal from a discarded turn');
  store.updateFromToolResult(
    'chat-fork',
    'terminal_start',
    { sessionId: 'sess-9', command: 'npm run build' },
    JSON.stringify({ jobId: 'discarded-job', status: 'running', nextOffset: 99 }),
  );

  store.rebuildFromMessages('chat-fork', [
    {
      role: 'user',
      content: 'Run the dev server and watch nginx for errors',
    },
    {
      role: 'assistant',
      content: 'I decided to tail the nginx error log on the edge host.',
      toolCalls: [
        { id: 'call-1', name: 'terminal_execute', arguments: { sessionId: 'sess-1', command: 'tail -f /var/log/nginx/error.log' } },
        { id: 'call-2', name: 'terminal_start', arguments: { sessionId: 'sess-1', command: 'npm run dev' } },
      ],
    },
    {
      role: 'tool',
      content: 'upstream timed out',
      toolResults: [{ toolCallId: 'call-1', content: 'upstream timed out', isError: true }],
    },
    {
      role: 'tool',
      content: JSON.stringify({ jobId: 'job-1', status: 'running', nextOffset: 0 }),
      toolResults: [{ toolCallId: 'call-2', content: JSON.stringify({ jobId: 'job-1', status: 'running', nextOffset: 0 }) }],
    },
    {
      role: 'tool',
      content: JSON.stringify({ jobId: 'job-1', status: 'running', nextOffset: 420 }),
      toolResults: [{ toolCallId: 'call-3', content: JSON.stringify({ jobId: 'job-1', status: 'running', nextOffset: 420 }), toolName: 'terminal_poll' }],
    },
  ]);

  const text = store.toReinjectionText('chat-fork') ?? '';
  assert.ok(text.includes('Run the dev server'));
  assert.ok(!text.includes('Older goal from a discarded turn'));
  assert.ok(!text.includes('discarded-job'));
  assert.ok(text.includes('edge host'));
  // The background job survives with the replayed poll offset and the
  // reinjected "keep polling" instruction.
  assert.equal(store.get('chat-fork').activeJobs['job-1'].nextOffset, 420);
  assert.match(text, /offset=420/);
  // The failed tail surfaces as an open blocker, as it does live.
  assert.match(text, /Open blockers/);
});

test('SessionStateStore rebuild pairs repeated pending calls with the nearest preceding call', () => {
  const store = new SessionStateStore();
  // A provider can emit several unresolved calls carrying the same id before
  // their results arrive; the rebuild keeps them distinct and pairs each
  // result with the nearest preceding call, as the historical replay maps do.
  // terminal_execute records activeHosts while terminal_poll drives the job
  // offset, so the pairing order is observable end-state.
  store.rebuildFromMessages('chat-fork', [
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call-dup', name: 'terminal_execute', arguments: { sessionId: 'sess-1', command: 'tail -f /var/log/nginx/error.log' } },
        { id: 'call-dup', name: 'terminal_poll', arguments: { jobId: 'job-1' } },
      ],
    },
    {
      role: 'tool',
      content: JSON.stringify({ jobId: 'job-1', status: 'running', nextOffset: 0 }),
      toolResults: [{ toolCallId: 'call-dup', content: JSON.stringify({ jobId: 'job-1', status: 'running', nextOffset: 0 }) }],
    },
    {
      role: 'tool',
      content: JSON.stringify({ jobId: 'job-1', status: 'running', nextOffset: 420 }),
      toolResults: [{ toolCallId: 'call-dup', content: JSON.stringify({ jobId: 'job-1', status: 'running', nextOffset: 420 }) }],
    },
  ]);

  // The first result pairs with the nearest call (terminal_poll, whose args
  // carry the poll offset) and the second with terminal_execute, which only
  // records the active host; collapsing either way would lose one side.
  assert.equal(store.get('chat-fork').activeJobs['job-1'].nextOffset, 0);
  assert.equal(store.get('chat-fork').activeHosts['sess-1'].lastCommand, 'tail -f /var/log/nginx/error.log');
});

test('SessionStateStore rebuild replays plan and completed file-change activities', () => {
  const store = new SessionStateStore();
  store.rebuildFromMessages('chat-fork', [
    {
      role: 'assistant',
      content: '',
      agentActivities: [
        {
          id: 'act-1',
          type: 'plan_update',
          status: 'completed',
          items: [
            { text: 'inspect failure', completed: true },
            { text: 'run regression tests', completed: false },
          ],
        },
      ],
    },
    {
      role: 'assistant',
      content: '',
      agentActivities: [
        {
          id: 'act-2',
          type: 'file_change',
          status: 'completed',
          changes: [{ path: '/repo/src/a.ts', kind: 'update' }, { path: '/repo/src/b.ts', kind: 'add' }],
        },
      ],
    },
    {
      role: 'user',
      content: 'Continue fixing the failing test',
    },
  ]);

  const text = store.toReinjectionText('chat-fork') ?? '';
  assert.match(text, /\[done\] inspect failure/);
  assert.match(text, /\[todo\] run regression tests/);
  assert.match(text, /\/repo\/src\/a\.ts/);
  assert.match(text, /\/repo\/src\/b\.ts/);
});
