import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_COMMAND_BLOCKLIST } from '../types';
import { executeTerminalExecute } from './toolExecutors';

function createDeps(shellType?: string) {
  const calls: Array<{ sessionId: string; command: string }> = [];
  return {
    calls,
    deps: {
      bridge: {
        async aiExec(sessionId: string, command: string) {
          calls.push({ sessionId, command });
          return { ok: true, stdout: 'ok', stderr: '', exitCode: 0 };
        },
      },
      context: {
        sessions: [{
          sessionId: 'ssh-ps',
          hostId: 'host-1',
          hostname: 'windows.example',
          label: 'Windows',
          protocol: 'ssh',
          shellType,
          connected: true,
        }],
      },
      commandBlocklist: DEFAULT_COMMAND_BLOCKLIST,
      permissionMode: 'auto' as const,
    },
  };
}

test('unknown remote shell defers shell-specific defaults to the live bridge', async () => {
  const { deps, calls } = createDeps();
  const command = 'Write-Host "now: $(Get-Date)"';
  const result = await executeTerminalExecute(deps, { sessionId: 'ssh-ps', command });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ sessionId: 'ssh-ps', command }]);
});

test('known POSIX shell still blocks command substitution before IPC', async () => {
  const { deps, calls } = createDeps('posix');
  const result = await executeTerminalExecute(deps, {
    sessionId: 'ssh-ps',
    command: 'echo $(whoami)',
  });

  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});
