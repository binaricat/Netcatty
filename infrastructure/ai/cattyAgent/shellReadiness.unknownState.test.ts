import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createToolExecutor, type NetcattyBridge, type ExecutorContext } from './executor';

// Mirrors SHELL_READINESS_UNKNOWN_MESSAGE from
// electron/bridges/ai/shellReadinessState.cjs (kept inline to avoid a
// renderer -> electron import in this harness test).
const UNKNOWN_HINT = [
  'Shell readiness unknown (SHELL_READINESS_UNKNOWN): the terminal connection is',
  'alive but the prompt could not be recognized. The command was NOT sent — never',
  'blind-type. Read-only next steps: call get_environment or terminal_read_context,',
  're-check after the user presses Enter, reuse another idle session, or ask the',
  'user to confirm the prompt before retrying.',
].join(' ');

function makeBridge(result: Record<string, unknown>): NetcattyBridge {
  return { aiExec: async () => result } as unknown as NetcattyBridge;
}

const context: ExecutorContext = {
  sessions: [
    {
      sessionId: 's1',
      hostId: 'h1',
      hostname: 'host',
      label: 'tab',
      protocol: 'ssh',
      connected: true,
    },
  ],
};

function call(command = 'echo OK') {
  return { id: 'call-1', name: 'terminal_execute', arguments: { sessionId: 's1', command } };
}

describe('Catty Agent terminal_execute surfaces SHELL_READINESS_UNKNOWN as non-fatal (#4195)', () => {
  it('returns the actionable read-only hint WITHOUT isError (agent is not bricked)', async () => {
    const bridge = makeBridge({
      ok: false,
      error: UNKNOWN_HINT,
      code: 'SHELL_READINESS_UNKNOWN',
      stdout: '',
      stderr: '',
      exitCode: -1,
    });
    const execute = createToolExecutor(bridge, context, [], 'auto');
    const result = await execute(call());
    assert.notEqual(result.isError, true);
    assert.match(result.content, /read-only/i);
    assert.match(result.content, /NOT sent/i);
    assert.match(result.content, /get_environment|terminal_read_context/);
  });

  it('a proven-busy SHELL_NOT_READY verdict is still a hard error', async () => {
    const bridge = makeBridge({
      ok: false,
      error: 'Shell prompt is not ready; no command was sent',
      code: 'SHELL_NOT_READY',
      stdout: '',
      stderr: '',
      exitCode: -1,
    });
    const execute = createToolExecutor(bridge, context, [], 'auto');
    const result = await execute(call());
    assert.equal(result.isError, true);
  });

  it('a normal successful command is unaffected', async () => {
    const bridge = makeBridge({ ok: true, stdout: 'OK', stderr: '', exitCode: 0 });
    const execute = createToolExecutor(bridge, context, [], 'auto');
    const result = await execute(call());
    assert.notEqual(result.isError, true);
    assert.match(result.content, /OK/);
  });
});
