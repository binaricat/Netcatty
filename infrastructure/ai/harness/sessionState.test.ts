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

test('SessionStateStore copies operational state for a branched chat and keeps copies independent', () => {
  const store = new SessionStateStore();
  store.updateFromToolResult(
    'chat-source',
    'terminal_start',
    { sessionId: 'sess-1', command: 'npm run dev' },
    JSON.stringify({ jobId: 'job-1', status: 'running', nextOffset: 300 }),
    false,
  );
  store.mergeFileChanges('chat-source', ['src/a.ts']);
  store.mergePlan('chat-source', [{ text: 'step one', completed: false }]);
  store.updateFromToolResult(
    'chat-source',
    'terminal_execute',
    { sessionId: 'sess-1' },
    'boom',
    true,
  );

  store.copyState('chat-source', 'chat-branch');

  const branchReinjection = store.toReinjectionText('chat-branch');
  assert.match(branchReinjection ?? '', /job-1/);
  assert.match(branchReinjection ?? '', /offset=300/);
  assert.match(branchReinjection ?? '', /src\/a\.ts/);
  // Conversational state (plan, blockers) must not ride along with the
  // operational copy: it can only come from the retained prefix.
  assert.doesNotMatch(branchReinjection ?? '', /step one/);
  assert.doesNotMatch(branchReinjection ?? '', /terminal_execute/);
  assert.ok(store.toReinjectionText('chat-source'));

  // Updates under the branch id must not leak back into the source state.
  store.mergeFromUserGoal('chat-branch', 'new goal');
  assert.equal(store.get('chat-source').userGoal, undefined);
  assert.equal(store.get('chat-branch').userGoal, 'new goal');
  assert.deepEqual(store.get('chat-source').activeJobs['job-1'], store.get('chat-branch').activeJobs['job-1']);
  assert.notEqual(
    store.get('chat-source').activeJobs['job-1'],
    store.get('chat-branch').activeJobs['job-1'],
  );
});

test('SessionStateStore rebuilds conversational state from the retained prefix only', () => {
  const store = new SessionStateStore();
  store.copyState('chat-source', 'chat-branch');
  store.rebuildConversationalStateFromMessages('chat-branch', [
    {
      id: 'user-1',
      role: 'user',
      content: 'keep investigating the outage',
      timestamp: 1,
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Decided to restart the nginx service after checking logs',
      timestamp: 2,
      toolCalls: [
        { id: 'call-1', name: 'terminal_execute', arguments: { sessionId: 'sess-1' } },
      ],
      toolResults: [
        { toolCallId: 'call-1', toolName: 'terminal_execute', content: 'service restarted', isError: false },
        { toolCallId: 'call-2', toolName: 'terminal_execute', content: 'disk almost full', isError: true },
      ],
      agentActivities: [
        { id: 'plan-1', type: 'plan_update', status: 'running', items: [{ text: 'check disk space', completed: false }] },
      ],
    },
  ]);

  const state = store.get('chat-branch');
  assert.equal(state.userGoal, 'keep investigating the outage');
  assert.ok(state.decisions[0]?.includes('restart the nginx service'));
  assert.ok(state.blockers.some(entry => entry.startsWith('terminal_execute: disk almost full')));
  assert.deepEqual(state.planItems, [{ text: 'check disk space', completed: false }]);
});

test('SessionStateStore rebuild keeps plan and blockers from the removed turn out of the branch', () => {
  const store = new SessionStateStore();
  // State as it exists after the undone turn ran.
  store.updateFromToolResult(
    'chat-source',
    'terminal_execute',
    { sessionId: 'sess-1', command: 'deploy.sh' },
    'deploy failed',
    true,
  );
  store.mergePlan('chat-source', [
    { text: 'ship the release', completed: false },
  ]);
  store.copyState('chat-source', 'chat-branch');
  // The retained prefix contains only messages from before the undone turn
  // (and none of its plan/blocker output).
  store.rebuildConversationalStateFromMessages('chat-branch', [
    { id: 'user-1', role: 'user', content: 'prepare the release', timestamp: 1 },
    { id: 'assistant-1', role: 'assistant', content: 'Working on it', timestamp: 2 },
  ]);

  const state = store.get('chat-branch');
  assert.equal(state.userGoal, 'prepare the release');
  assert.deepEqual(state.planItems, []);
  assert.deepEqual(state.blockers, []);
  assert.doesNotMatch(store.toReinjectionText('chat-branch') ?? '', /ship the release/);
  assert.doesNotMatch(store.toReinjectionText('chat-branch') ?? '', /deploy failed/);
});
