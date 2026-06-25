import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentEvent } from './agentEvent';
import {
  appendAgentEvent,
  projectAgentEventsToMessages,
  trimAgentTrace,
} from './traceStore';
import type { AgentEvent } from './agentEvent';

function event<T extends AgentEvent['type']>(
  input: Omit<Extract<AgentEvent, { type: T }>, 'id' | 'timestamp'> & {
    id: string;
    timestamp: number;
  },
): Extract<AgentEvent, { type: T }> {
  return createAgentEvent(input);
}

test('projectAgentEventsToMessages rebuilds a turn from unified events', () => {
  const events: AgentEvent[] = [
    event({
      id: 'e1',
      timestamp: 1,
      type: 'turn_start',
      sessionId: 's1',
      source: 'catty',
      agentId: 'catty',
      prompt: 'check disk',
    }),
    event({
      id: 'e2',
      timestamp: 2,
      type: 'reasoning_delta',
      sessionId: 's1',
      source: 'catty',
      delta: 'Need df.',
      phase: 'delta',
    }),
    event({
      id: 'e3',
      timestamp: 3,
      type: 'model_delta',
      sessionId: 's1',
      source: 'catty',
      delta: 'Running df...',
    }),
    event({
      id: 'e4',
      timestamp: 4,
      type: 'tool_call',
      sessionId: 's1',
      source: 'catty',
      toolCallId: 'tc1',
      toolName: 'terminal_execute',
      args: { command: 'df -h' },
    }),
    event({
      id: 'e5',
      timestamp: 5,
      type: 'approval_requested',
      sessionId: 's1',
      source: 'catty',
      approvalId: 'tc1',
      toolCallId: 'tc1',
      toolName: 'terminal_execute',
      args: { command: 'df -h' },
    }),
    event({
      id: 'e6',
      timestamp: 6,
      type: 'approval_resolved',
      sessionId: 's1',
      source: 'catty',
      approvalId: 'tc1',
      toolCallId: 'tc1',
      approved: true,
      resolution: 'approved',
    }),
    event({
      id: 'e7',
      timestamp: 7,
      type: 'tool_result',
      sessionId: 's1',
      source: 'catty',
      toolCallId: 'tc1',
      toolName: 'terminal_execute',
      output: '/dev/sda1 50%',
    }),
    event({
      id: 'e8',
      timestamp: 8,
      type: 'model_delta',
      sessionId: 's1',
      source: 'catty',
      delta: 'Disk usage is fine.',
    }),
    event({
      id: 'e9',
      timestamp: 9,
      type: 'usage',
      sessionId: 's1',
      source: 'catty',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    }),
    event({
      id: 'e10',
      timestamp: 10,
      type: 'turn_end',
      sessionId: 's1',
      source: 'catty',
      status: 'completed',
    }),
  ];

  const messages = projectAgentEventsToMessages(events);

  assert.equal(messages.length, 4);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'check disk');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].thinking, 'Need df.');
  assert.equal(messages[1].content, 'Running df...');
  assert.deepEqual(messages[1].toolCalls, [{
    id: 'tc1',
    name: 'terminal_execute',
    arguments: { command: 'df -h' },
  }]);
  assert.equal(messages[1].pendingApproval?.status, 'approved');
  assert.equal(messages[2].role, 'tool');
  assert.equal(messages[2].toolResults?.[0].content, '/dev/sda1 50%');
  assert.equal(messages[3].role, 'assistant');
  assert.equal(messages[3].content, 'Disk usage is fine.');
});

test('appendAgentEvent and trimAgentTrace enforce a bounded append-only trace', () => {
  const first = event({
    id: 'e1',
    timestamp: 1,
    type: 'model_delta',
    sessionId: 's1',
    source: 'external_sdk',
    delta: 'a',
  });
  const second = event({
    id: 'e2',
    timestamp: 2,
    type: 'model_delta',
    sessionId: 's1',
    source: 'external_sdk',
    delta: 'b',
  });
  const third = event({
    id: 'e3',
    timestamp: 3,
    type: 'model_delta',
    sessionId: 's1',
    source: 'external_sdk',
    delta: 'c',
  });

  const trace = appendAgentEvent(appendAgentEvent([first], second, 2), third, 2);

  assert.deepEqual(trace.map(item => item.id), ['e2', 'e3']);
  assert.deepEqual(trimAgentTrace(trace, 1).map(item => item.id), ['e3']);
});
