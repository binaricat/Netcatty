import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import { pruneStaleToolContext } from './staleContextPruner.ts';

test('pruneStaleToolContext supersedes older sftp reads for same path', () => {
  const messages: ModelMessage[] = [
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'sftp_read',
        input: { sessionId: 'host-a', path: '/etc/nginx/nginx.conf' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'sftp_read',
        output: { type: 'text', value: 'old config body' },
      }],
    },
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'c2',
        toolName: 'sftp_read',
        input: { sessionId: 'host-a', path: '/etc/nginx/nginx.conf' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'c2',
        toolName: 'sftp_read',
        output: { type: 'text', value: 'new config body' },
      }],
    },
  ];

  const result = pruneStaleToolContext(messages, { underBudgetPressure: true });
  assert.equal(result.didAdjust, true);
  const serialized = JSON.stringify(result.messages);
  assert.match(serialized, /superseded read/);
  assert.match(serialized, /new config body/);
});

test('pruneStaleToolContext supersedes older sftp_read_file reads for same path', () => {
  const messages: ModelMessage[] = [
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'sftp_read_file',
        input: { sessionId: 'host-a', path: '/etc/nginx/nginx.conf' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'sftp_read_file',
        output: { type: 'text', value: 'old config body' },
      }],
    },
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'c2',
        toolName: 'sftp_read_file',
        input: { sessionId: 'host-a', path: '/etc/nginx/nginx.conf' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'c2',
        toolName: 'sftp_read_file',
        output: { type: 'text', value: 'new config body' },
      }],
    },
  ];

  const result = pruneStaleToolContext(messages, { underBudgetPressure: true });
  assert.equal(result.didAdjust, true);
  const serialized = JSON.stringify(result.messages);
  assert.match(serialized, /superseded read/);
  assert.match(serialized, /new config body/);
});

test('pruneStaleToolContext keeps sftp reads for same path on different sessions', () => {
  const messages: ModelMessage[] = [
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'sftp_read_file',
        input: { sessionId: 'host-a', path: '/etc/nginx/nginx.conf' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'sftp_read_file',
        output: { type: 'text', value: 'host-a config' },
      }],
    },
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'c2',
        toolName: 'sftp_read_file',
        input: { sessionId: 'host-b', path: '/etc/nginx/nginx.conf' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'c2',
        toolName: 'sftp_read_file',
        output: { type: 'text', value: 'host-b config' },
      }],
    },
  ];

  const result = pruneStaleToolContext(messages, { underBudgetPressure: true });
  assert.equal(result.didAdjust, false);
  const serialized = JSON.stringify(result.messages);
  assert.match(serialized, /host-a config/);
  assert.match(serialized, /host-b config/);
  assert.doesNotMatch(serialized, /superseded read/);
});

function terminalExecutePair(
  callId: string,
  sessionId: string,
  command: string,
  output: string,
): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: callId,
        toolName: 'terminal_execute',
        input: { sessionId, command },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        toolName: 'terminal_execute',
        output: { type: 'text', value: output },
      }],
    },
  ];
}

test('pruneStaleToolContext keeps last two terminal outputs per session', () => {
  const messages: ModelMessage[] = [
    ...terminalExecutePair('t1', 'sess-1', 'uptime', 'uptime-1'),
    ...terminalExecutePair('t2', 'sess-1', 'df -h', 'df-2'),
    ...terminalExecutePair('t3', 'sess-1', 'free -m', 'free-3'),
  ];

  const result = pruneStaleToolContext(messages, { underBudgetPressure: true });
  assert.equal(result.didAdjust, true);
  const serialized = JSON.stringify(result.messages);
  assert.match(serialized, /df-2/);
  assert.match(serialized, /free-3/);
  assert.doesNotMatch(serialized, /uptime-1/);
});

test('pruneStaleToolContext omits terminal outputs per session independently', () => {
  const messages: ModelMessage[] = [
    ...terminalExecutePair('a1', 'sess-a', 'uptime', 'a-uptime'),
    ...terminalExecutePair('a2', 'sess-a', 'df -h', 'a-df'),
    ...terminalExecutePair('a3', 'sess-a', 'free -m', 'a-free'),
    ...terminalExecutePair('b1', 'sess-b', 'uptime', 'b-uptime'),
  ];

  const result = pruneStaleToolContext(messages, { underBudgetPressure: true });
  assert.equal(result.didAdjust, true);
  const serialized = JSON.stringify(result.messages);
  assert.match(serialized, /a-df/);
  assert.match(serialized, /a-free/);
  assert.match(serialized, /b-uptime/);
  assert.doesNotMatch(serialized, /a-uptime/);
});

test('pruneStaleToolContext preserves repeated sftp reads without budget pressure', () => {
  const messages: ModelMessage[] = [
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'sftp_read_file',
        input: { sessionId: 'host-a', path: '/etc/nginx/nginx.conf' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'sftp_read_file',
        output: { type: 'text', value: 'before edit' },
      }],
    },
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'c2',
        toolName: 'sftp_read_file',
        input: { sessionId: 'host-a', path: '/etc/nginx/nginx.conf' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'c2',
        toolName: 'sftp_read_file',
        output: { type: 'text', value: 'after edit' },
      }],
    },
  ];

  const result = pruneStaleToolContext(messages);
  assert.equal(result.didAdjust, false);
  const serialized = JSON.stringify(result.messages);
  assert.match(serialized, /before edit/);
  assert.match(serialized, /after edit/);
  assert.doesNotMatch(serialized, /superseded read/);
});

test('pruneStaleToolContext keeps last successful read when a later read fails', () => {
  const messages: ModelMessage[] = [
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'sftp_read_file',
        input: { sessionId: 'host-a', path: '/etc/nginx/nginx.conf' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'sftp_read_file',
        output: { type: 'text', value: 'valid config body' },
      }],
    },
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'c2',
        toolName: 'sftp_read_file',
        input: { sessionId: 'host-a', path: '/etc/nginx/nginx.conf' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'c2',
        toolName: 'sftp_read_file',
        output: { type: 'text', value: 'Permission denied error' },
        isError: true,
      }],
    },
  ];

  const result = pruneStaleToolContext(messages, { underBudgetPressure: true });
  assert.equal(result.didAdjust, false);
  const serialized = JSON.stringify(result.messages);
  assert.match(serialized, /valid config body/);
  assert.doesNotMatch(serialized, /superseded read/);
});

test('pruneStaleToolContext keeps last successful read when a later JSON read fails', () => {
  const messages: ModelMessage[] = [
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'sftp_read_file',
        input: { sessionId: 'host-a', path: '/etc/nginx/nginx.conf' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'sftp_read_file',
        output: { type: 'text', value: 'valid config body' },
      }],
    },
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'c2',
        toolName: 'sftp_read_file',
        input: { sessionId: 'host-a', path: '/etc/nginx/nginx.conf' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'c2',
        toolName: 'sftp_read_file',
        output: { error: 'Permission denied' },
      }],
    },
  ];

  const result = pruneStaleToolContext(messages, { underBudgetPressure: true });
  assert.equal(result.didAdjust, false);
  const serialized = JSON.stringify(result.messages);
  assert.match(serialized, /valid config body/);
  assert.doesNotMatch(serialized, /superseded read/);
});

test('pruneStaleToolContext preserves terminal output without budget pressure flag', () => {
  const messages: ModelMessage[] = [
    ...terminalExecutePair('t1', 'sess-1', 'uptime', 'uptime-1'),
    ...terminalExecutePair('t2', 'sess-1', 'df -h', 'df-2'),
    ...terminalExecutePair('t3', 'sess-1', 'free -m', 'free-3'),
  ];

  const result = pruneStaleToolContext(messages);
  assert.equal(result.didAdjust, false);
  const serialized = JSON.stringify(result.messages);
  assert.match(serialized, /uptime-1/);
  assert.match(serialized, /df-2/);
  assert.match(serialized, /free-3/);
});
