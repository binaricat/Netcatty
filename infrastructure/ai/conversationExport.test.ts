import test from 'node:test';
import assert from 'node:assert/strict';

import type { AISession } from './types';
import { exportAsJSON, exportAsMarkdown, exportAsPlainText } from './conversationExport';

const session: AISession = {
  id: 'chat-1',
  title: 'Secrets',
  agentId: 'catty',
  scope: { type: 'global' },
  createdAt: 1,
  updatedAt: 2,
  messages: [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: [
        {
          id: 'call-1',
          name: 'vault_hosts_create',
          arguments: {
            hosts: JSON.stringify([
              {
                hostname: 'secret.example.com',
                password: 'pw-secret',
                telnetPassword: 'tn-secret',
              },
            ]),
          },
        },
      ],
    },
  ],
};

test('conversation exports mask secret host tool arguments', () => {
  const exported = [
    exportAsMarkdown(session),
    exportAsPlainText(session),
    exportAsJSON(session),
  ].join('\n');

  assert.doesNotMatch(exported, /pw-secret|tn-secret/);
  assert.match(exported, /REDACTED/);
});
