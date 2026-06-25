import test from 'node:test';
import assert from 'node:assert/strict';

import { executeTerminalExecute, type ToolDeps } from './shared/toolExecutors';
import { APPROVAL_DENIAL_REASONS } from './shared/approvalPolicy';

function makeDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    bridge: {
      aiExec: async () => ({ ok: true, stdout: 'ok\n', stderr: '', exitCode: 0 }),
    } as ToolDeps['bridge'],
    context: {
      workspaceId: 'workspace-1',
      workspaceName: 'Workspace',
      sessions: [{
        sessionId: 'sess-1',
        hostId: 'host-1',
        hostname: 'host.example',
        label: 'Host',
        protocol: 'ssh',
        connected: true,
      }],
    },
    commandBlocklist: [],
    permissionMode: 'autonomous',
    chatSessionId: 'chat-1',
    ...overrides,
  };
}

test('Catty terminal executor reports observer_denied in observer mode', async () => {
  const result = await executeTerminalExecute(makeDeps({ permissionMode: 'observer' }), {
    sessionId: 'sess-1',
    command: 'pwd',
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.denialReason, APPROVAL_DENIAL_REASONS.OBSERVER_DENIED);
    assert.match(result.error, /observer/i);
  }
});

test('Catty terminal executor reports policy_denied for command blocklist matches', async () => {
  const result = await executeTerminalExecute(makeDeps({ commandBlocklist: ['rm\\s+-rf'] }), {
    sessionId: 'sess-1',
    command: 'rm -rf /tmp/example',
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.denialReason, APPROVAL_DENIAL_REASONS.POLICY_DENIED);
    assert.match(result.error, /safety policy/i);
  }
});

test('Catty terminal executor runs allowed commands in autonomous mode', async () => {
  const result = await executeTerminalExecute(makeDeps({ permissionMode: 'autonomous' }), {
    sessionId: 'sess-1',
    command: 'pwd',
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.data, {
      stdout: 'ok\n',
      stderr: '',
      exitCode: 0,
    });
  }
});
