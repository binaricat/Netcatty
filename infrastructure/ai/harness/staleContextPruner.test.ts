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

test('pruneStaleToolContext supersedes repeated terminal polls and context reads', () => {
  const pair = (callId: string, toolName: string, input: Record<string, unknown>, output: string): ModelMessage[] => [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: callId, toolName, input }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        toolName,
        output: { type: 'text', value: output },
      }],
    },
  ];
  const messages: ModelMessage[] = [
    ...pair('p1', 'terminal_poll', { jobId: 'job-1', offset: 0 }, 'old poll'),
    ...pair('p2', 'terminal_poll', { jobId: 'job-1', offset: 0 }, 'new poll'),
    ...pair('r1', 'terminal_read_context', { sessionId: 's1', range: 'tail', maxLines: 20 }, 'old screen'),
    ...pair('r2', 'terminal_read_context', { sessionId: 's1', range: 'tail', maxLines: 20 }, 'new screen'),
  ];

  const result = pruneStaleToolContext(messages, { underBudgetPressure: true });
  const serialized = JSON.stringify(result.messages);
  assert.equal(result.didAdjust, true);
  assert.doesNotMatch(serialized, /old poll|old screen/);
  assert.match(serialized, /new poll/);
  assert.match(serialized, /new screen/);
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

test('pruneStaleToolContext tiers generic old tool results while protecting recent turns', () => {
  const messages: ModelMessage[] = [];
  for (let turn = 0; turn < 12; turn += 1) {
    const callId = `call-${turn}`;
    messages.push(
      { role: 'user', content: `turn ${turn}` },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: callId, toolName: 'custom_read', input: { turn } }],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          toolName: 'custom_read',
          output: { type: 'text', value: `result-${turn}-${'x'.repeat(5_000)}-tail-${turn}` },
        }],
      },
    );
  }

  const result = pruneStaleToolContext(messages, { underBudgetPressure: true });
  const serialized = JSON.stringify(result.messages);
  assert.match(serialized, /older tool result omitted/);
  assert.match(serialized, /tool result shortened/);
  assert.match(serialized, /result-11-/);
  assert.match(serialized, /tail-11/);
});

test('pruneStaleToolContext retains old successful write outcomes', () => {
  const messages: ModelMessage[] = [
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'write-1',
        toolName: 'sftp_write',
        input: { sessionId: 'sess-1', path: '/etc/app.conf', content: 'enabled=true' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'write-1',
        toolName: 'sftp_write',
        output: { type: 'text', value: 'write succeeded: /etc/app.conf' },
      }],
    },
    ...Array.from({ length: 11 }, (_, index) => ({ role: 'user' as const, content: `later ${index}` })),
  ];

  const result = pruneStaleToolContext(messages, { underBudgetPressure: true });
  const serialized = JSON.stringify(result.messages);
  assert.match(serialized, /write succeeded: \/etc\/app\.conf/);
  assert.doesNotMatch(serialized, /older tool result omitted/);
});

test('pruneStaleToolContext redacts commands in old terminal placeholders', () => {
  const messages: ModelMessage[] = [
    ...terminalExecutePair('t1', 'sess-1', 'curl --password swordfish', 'old-output'),
    ...terminalExecutePair('t2', 'sess-1', 'uptime', 'newer-output'),
    ...terminalExecutePair('t3', 'sess-1', 'df -h', 'latest-output'),
  ];
  const result = pruneStaleToolContext(messages, { underBudgetPressure: true });
  const serialized = JSON.stringify(result.messages);
  assert.doesNotMatch(serialized, /swordfish/);
  assert.match(serialized, /REDACTED/);
});

test('pruneStaleToolContext unconditionally enforces rolling 2-frame cap on remote screen images', () => {
  const nativeScreenResult = (callId: string, capturedAt: number, data: string): ModelMessage[] => [
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: callId,
        toolName: 'remote_desktop_read_screen',
        input: { sessionId: 'rdp-1' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        toolName: 'remote_desktop_read_screen',
        output: {
          type: 'content',
          value: [
            {
              type: 'text',
              text: JSON.stringify({ ok: true, sessionId: 'rdp-1', capturedAt }),
            },
            {
              type: 'file',
              mediaType: 'image/jpeg',
              data: { type: 'data', data },
              filename: 'remote-screen.jpg',
            },
          ],
        },
      }],
    } as unknown as ModelMessage,
  ];

  const syntheticScreenUser = (capturedAt: number, data: string): ModelMessage => ({
    role: 'user',
    content: [
      {
        type: 'text',
        text: `[Captured remote desktop frame: sessionId=rdp-1, protocol=rdp, resolution=1280x720, capturedAt=${capturedAt}]`,
      },
      {
        type: 'file',
        data,
        mediaType: 'image/jpeg',
        filename: 'remote-screen.jpg',
      },
    ],
  });

  const messages: ModelMessage[] = [
    // Normal user-attached image must NOT be pruned by the rolling screen-read cap.
    {
      role: 'user',
      content: [
        { type: 'text', text: 'check this user screenshot' },
        { type: 'file', data: 'USER_UPLOAD_KEEP', mediaType: 'image/png', filename: 'manual.png' },
      ],
    },
    ...nativeScreenResult('s1', 1001, 'FRAME_ONE_DROP'),
    syntheticScreenUser(1002, 'FRAME_TWO_DROP'),
    ...nativeScreenResult('s3', 1003, 'FRAME_THREE_KEEP'),
    syntheticScreenUser(1004, 'FRAME_FOUR_KEEP'),
  ];

  // Note: underBudgetPressure is FALSE — rolling 2-frame cap runs unconditionally.
  const result = pruneStaleToolContext(messages);
  assert.equal(result.didAdjust, true);
  const serialized = JSON.stringify(result.messages);
  assert.match(serialized, /USER_UPLOAD_KEEP/);
  assert.doesNotMatch(serialized, /FRAME_ONE_DROP/);
  assert.doesNotMatch(serialized, /FRAME_TWO_DROP/);
  assert.match(serialized, /earlier remote desktop screenshot omitted: sessionId=rdp-1, capturedAt=1001/);
  assert.match(serialized, /earlier remote desktop screenshot omitted: sessionId=rdp-1, capturedAt=1002/);
  assert.match(serialized, /FRAME_THREE_KEEP/);
  assert.match(serialized, /FRAME_FOUR_KEEP/);
});
