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
        input: { path: '/etc/nginx/nginx.conf' },
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
        input: { path: '/etc/nginx/nginx.conf' },
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

  const result = pruneStaleToolContext(messages);
  assert.equal(result.didAdjust, true);
  const serialized = JSON.stringify(result.messages);
  assert.match(serialized, /superseded read/);
  assert.match(serialized, /new config body/);
});
