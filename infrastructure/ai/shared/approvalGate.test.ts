import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { globalTraceStore } from '../harness/traceStore';
import { requestApproval, resolveApproval } from './approvalGate';

describe('requestApproval trace events', () => {
  it('masks asset secrets before appending approval_requested trace events', async () => {
    const chatSessionId = 'chat-approval-secret';
    const toolCallId = 'call-approval-secret';
    globalTraceStore.clear(chatSessionId);

    const pending = requestApproval(
      toolCallId,
      'asset_add',
      {
        hosts: JSON.stringify([
          {
            hostname: 'asset.example.com',
            password: 'pw-secret',
            notes: 'note-secret',
          },
        ]),
      },
      chatSessionId,
      1000,
    );

    const requested = globalTraceStore.getEvents(chatSessionId)
      .find((event) => event.type === 'approval_requested');

    resolveApproval(toolCallId, false);
    await pending;

    assert.ok(requested, 'approval_requested event should be recorded');
    const serialized = JSON.stringify((requested as { args?: unknown }).args);
    assert.doesNotMatch(serialized, /pw-secret|note-secret/);
    assert.match(serialized, /REDACTED/);

    globalTraceStore.clear(chatSessionId);
  });
});
