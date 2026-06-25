import test from 'node:test';
import assert from 'node:assert/strict';

import {
  executeTerminalPoll,
  executeTerminalStart,
  executeTerminalStop,
} from './toolExecutors.ts';
import type { ToolDeps } from './toolExecutors.ts';
import type { ExecutorContext, NetcattyBridge } from '../cattyAgent/executor';

const context: ExecutorContext = {
  workspaceId: 'ws-1',
  workspaceName: 'Workspace',
  sessions: [
    {
      sessionId: 'sess-1',
      hostId: 'host-1',
      hostname: 'example.test',
      label: 'Example',
      protocol: 'ssh',
      connected: true,
    },
  ],
};

function createDeps(bridge: Partial<NetcattyBridge>, overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    bridge: {
      aiExec: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0 }),
      ...bridge,
    } as NetcattyBridge,
    context,
    permissionMode: 'autonomous',
    chatSessionId: 'chat-1',
    ...overrides,
  };
}

test('executeTerminalStart rejects observer mode before calling bridge', async () => {
  let called = false;
  const deps = createDeps({
    aiJobStart: async () => {
      called = true;
      return { ok: true };
    },
  }, { permissionMode: 'observer' });

  const result = await executeTerminalStart(deps, {
    sessionId: 'sess-1',
    command: 'npm run build',
  });

  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.match(result.error, /Observer mode/);
  }
  assert.equal(called, false);
});

test('executeTerminalStart passes chat and scoped session IDs to bridge', async () => {
  let received: unknown[] | null = null;
  const deps = createDeps({
    aiJobStart: async (...args) => {
      received = args;
      return {
        ok: true,
        jobId: 'job-1',
        sessionId: 'sess-1',
        command: 'npm run build',
        status: 'running',
        startedAt: 123,
        outputMode: 'foreground-mirrored',
        recommendedPollIntervalMs: 30000,
      };
    },
  });

  const result = await executeTerminalStart(deps, {
    sessionId: 'sess-1',
    command: 'npm run build',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(received, ['sess-1', 'npm run build', 'chat-1', ['sess-1']]);
  if (result.ok) {
    assert.equal(result.data.jobId, 'job-1');
    assert.equal(result.data.status, 'running');
  }
});

test('executeTerminalPoll passes offset and returns job snapshot', async () => {
  let received: unknown[] | null = null;
  const deps = createDeps({
    aiJobPoll: async (...args) => {
      received = args;
      return {
        ok: true,
        jobId: 'job-1',
        sessionId: 'sess-1',
        command: 'npm run build',
        status: 'running',
        completed: false,
        exitCode: null,
        error: null,
        startedAt: 123,
        updatedAt: 456,
        output: 'chunk',
        nextOffset: 99,
        totalOutputChars: 99,
        outputBaseOffset: 0,
        outputTruncated: false,
      };
    },
  });

  const result = await executeTerminalPoll(deps, { jobId: 'job-1', offset: 42 });

  assert.equal(result.ok, true);
  assert.deepEqual(received, ['job-1', 42, 'chat-1', ['sess-1']]);
  if (result.ok) {
    assert.equal(result.data.output, 'chunk');
    assert.equal(result.data.nextOffset, 99);
  }
});

test('executeTerminalStop is available even when permission mode is observer', async () => {
  let called = false;
  const deps = createDeps({
    aiJobStop: async () => {
      called = true;
      return {
        ok: true,
        jobId: 'job-1',
        sessionId: 'sess-1',
        command: 'npm run build',
        status: 'stopping',
        completed: false,
        exitCode: null,
        error: 'Cancellation requested',
        startedAt: 123,
        updatedAt: 456,
        output: '',
        nextOffset: 0,
        totalOutputChars: 0,
        outputBaseOffset: 0,
        outputTruncated: false,
      };
    },
  }, { permissionMode: 'observer' });

  const result = await executeTerminalStop(deps, { jobId: 'job-1' });

  assert.equal(result.ok, true);
  assert.equal(called, true);
});
