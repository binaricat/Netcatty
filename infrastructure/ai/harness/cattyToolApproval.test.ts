import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCattyToolApproval } from './cattyToolApproval';

describe('buildCattyToolApproval', () => {
  it('auto-approves read-only tools', async () => {
    const approval = buildCattyToolApproval({ permissionMode: 'confirm', chatSessionId: 'chat-1' });
    const result = await approval({
      toolCall: {
        toolCallId: 'call-1',
        toolName: 'terminal_read_context',
        input: { range: 'viewport' },
      },
    } as Parameters<typeof approval>[0]);
    assert.equal(result, undefined);
  });

  it('allows observer-bypass write tools in observer mode', async () => {
    const approval = buildCattyToolApproval({ permissionMode: 'observer', chatSessionId: 'chat-1' });
    const result = await approval({
      toolCall: {
        toolCallId: 'call-stop',
        toolName: 'terminal_stop',
        input: { jobId: 'job-1' },
      },
    } as Parameters<typeof approval>[0]);
    assert.equal(result, undefined);
  });

  it('denies write tools in observer mode', async () => {
    const approval = buildCattyToolApproval({ permissionMode: 'observer', chatSessionId: 'chat-1' });
    const result = await approval({
      toolCall: {
        toolCallId: 'call-2',
        toolName: 'sftp_write_file',
        input: { path: '/tmp/x', content: 'hi' },
      },
    } as Parameters<typeof approval>[0]);
    assert.deepEqual(result, {
      type: 'denied',
      reason: 'Observer mode blocks write operations.',
    });
  });

  it('auto-approves write tools in auto mode', async () => {
    const approval = buildCattyToolApproval({ permissionMode: 'auto', chatSessionId: 'chat-1' });
    const result = await approval({
      toolCall: {
        toolCallId: 'call-3',
        toolName: 'sftp_write_file',
        input: { path: '/tmp/x', content: 'hi' },
      },
    } as Parameters<typeof approval>[0]);
    assert.equal(result, undefined);
  });

  it('awaits user approval in confirm mode for write tools', async () => {
    let approvalRequested = false;
    const approval = buildCattyToolApproval({
      permissionMode: 'confirm',
      chatSessionId: 'chat-1',
      requestApproval: async (toolCallId, toolName) => {
        approvalRequested = true;
        assert.equal(toolCallId, 'call-4');
        assert.equal(toolName, 'sftp_write_file');
        return true;
      },
    });
    const result = await approval({
      toolCall: {
        toolCallId: 'call-4',
        toolName: 'sftp_write_file',
        input: { path: '/tmp/x', content: 'hi' },
      },
    } as Parameters<typeof approval>[0]);
    assert.equal(approvalRequested, true);
    assert.deepEqual(result, { type: 'approved' });
  });

  it('returns denied when confirm-mode approval is rejected', async () => {
    const approval = buildCattyToolApproval({
      permissionMode: 'confirm',
      chatSessionId: 'chat-1',
      requestApproval: async () => false,
    });
    const result = await approval({
      toolCall: {
        toolCallId: 'call-5',
        toolName: 'sftp_write_file',
        input: { path: '/tmp/x', content: 'hi' },
      },
    } as Parameters<typeof approval>[0]);
    assert.deepEqual(result, {
      type: 'denied',
      reason: 'User denied tool execution.',
    });
  });
});
