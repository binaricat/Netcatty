import test from 'node:test';
import assert from 'node:assert/strict';

import {
  onApprovalTraceEvent,
  requestApproval,
  resolveApproval,
} from './shared/approvalGate';
import type { AgentEvent } from './agentEvent';

test('approvalGate emits approval_requested and approval_resolved trace events', async () => {
  const events: AgentEvent[] = [];
  const unsubscribe = onApprovalTraceEvent(event => events.push(event));

  const approval = requestApproval(
    'tool-approval-1',
    'terminal_execute',
    { command: 'uptime' },
    'session-1',
  );
  resolveApproval('tool-approval-1', true);

  assert.equal(await approval, true);
  unsubscribe();

  assert.deepEqual(events.map(event => event.type), ['approval_requested', 'approval_resolved']);
  assert.equal(events[0].sessionId, 'session-1');
  assert.equal(events[0].source, 'catty');
  assert.equal((events[0] as Extract<AgentEvent, { type: 'approval_requested' }>).toolName, 'terminal_execute');
  assert.equal((events[1] as Extract<AgentEvent, { type: 'approval_resolved' }>).approved, true);
  assert.equal((events[1] as Extract<AgentEvent, { type: 'approval_resolved' }>).resolution, 'approved');
});

test('approvalGate emits timeout trace events for unanswered approvals', async () => {
  const events: AgentEvent[] = [];
  const unsubscribe = onApprovalTraceEvent(event => events.push(event));

  const approval = requestApproval(
    'tool-approval-timeout',
    'terminal_execute',
    { command: 'sleep 1' },
    'session-timeout',
    1,
  );

  assert.equal(await approval, false);
  unsubscribe();

  assert.deepEqual(events.map(event => event.type), ['approval_requested', 'approval_resolved']);
  const resolved = events[1] as Extract<AgentEvent, { type: 'approval_resolved' }>;
  assert.equal(resolved.approved, false);
  assert.equal(resolved.resolution, 'timeout');
});
