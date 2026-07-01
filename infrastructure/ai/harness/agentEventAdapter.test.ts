import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isStepHandleNoticeMessage, mapCattyStreamChunkToAgentEvents } from './agentEventAdapter';

describe('agentEventAdapter', () => {
  it('maps tool-output-denied chunks to approval_resolved denied and tool_result', () => {
    const events = mapCattyStreamChunkToAgentEvents(
      {
        type: 'tool-output-denied',
        toolCallId: 'call-1',
        toolName: 'sftp_write_file',
      },
      { sessionId: 'chat-1', turnId: 'turn-1' },
    );
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, 'approval_resolved');
    assert.equal((events[0] as { outcome?: string }).outcome, 'denied');
    assert.equal(events[1]?.type, 'tool_result');
    assert.equal((events[1] as { isError?: boolean }).isError, true);
  });

  it('maps tool-error chunks to tool_result with isError', () => {
    const events = mapCattyStreamChunkToAgentEvents(
      {
        type: 'tool-error',
        toolCallId: 'call-2',
        toolName: 'terminal_execute',
        error: new Error('timeout'),
      },
      { sessionId: 'chat-1', turnId: 'turn-1' },
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'tool_result');
    assert.equal((events[0] as { isError?: boolean }).isError, true);
    assert.match(String((events[0] as { result?: string }).result), /timeout/);
  });

  it('maps denied tool-approval-response with nested toolCall to tool_result', () => {
    const events = mapCattyStreamChunkToAgentEvents(
      {
        type: 'tool-approval-response',
        approvalId: 'approval-1',
        approved: false,
        reason: 'Observer mode blocks write operations.',
        toolCall: {
          toolCallId: 'call-3',
          toolName: 'sftp_write_file',
          input: { path: '/tmp/x' },
        },
      },
      { sessionId: 'chat-1', turnId: 'turn-1' },
    );
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, 'approval_resolved');
    assert.equal((events[0] as { outcome?: string }).outcome, 'denied');
    assert.equal(events[1]?.type, 'tool_result');
    assert.match(String((events[1] as { result?: string }).result), /Observer mode/);
  });

  it('detects step handle notice messages for prepareStep dedup', () => {
    assert.equal(
      isStepHandleNoticeMessage('[step 2] Tool output handles available: tool-output-abc'),
      true,
    );
    assert.equal(isStepHandleNoticeMessage('regular user message'), false);
  });
});
