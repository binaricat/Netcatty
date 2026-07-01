import assert from 'node:assert/strict';
import test from 'node:test';
import {
  setScriptRuns,
  waitForScriptRun,
} from './scriptAutomationCoordinator.ts';

test('waitForScriptRun resolves when run is already completed on subscribe', async () => {
  const runId = 'run-already-done';
  setScriptRuns([{
    runId,
    scriptId: 's1',
    sessionId: 'sess1',
    status: 'completed',
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    logs: [],
  }]);

  const run = await waitForScriptRun(runId, { timeoutMs: 5000 });
  assert.equal(run.runId, runId);
  assert.equal(run.status, 'completed');
});

test('waitForScriptRun rejects when run already failed on subscribe', async () => {
  const runId = 'run-already-failed';
  setScriptRuns([{
    runId,
    sessionId: 'sess1',
    status: 'failed',
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    error: 'boom',
    logs: [],
  }]);

  await assert.rejects(
    () => waitForScriptRun(runId, { timeoutMs: 5000 }),
    /boom/,
  );
});
