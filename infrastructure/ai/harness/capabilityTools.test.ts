import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionQueueKeyForTests } from './capabilityTools';

describe('capabilityTools session queue keys', () => {
  it('does not queue read-only harness tools behind terminal session writes', () => {
    const key = resolveSessionQueueKeyForTests(
      {
        capabilityId: 'harness.workspace.get_session_info',
        toolName: 'workspace_get_session_info',
        policy: { write: false, bypassesApproval: true },
      },
      { sessionId: 'session-a' },
      'chat-1',
    );
    assert.equal(key, null);
  });

  it('still serializes terminal.execute on the same session', () => {
    const key = resolveSessionQueueKeyForTests(
      {
        capabilityId: 'terminal.execute',
        toolName: 'terminal_execute',
        policy: { write: true, bypassesApproval: false },
      },
      { sessionId: 'session-a', command: 'ls' },
      'chat-1',
    );
    assert.equal(key, 'chat-1:session-a');
  });
});
