import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import { prepareTurnContext, extractLatestUserGoal } from './contextManager';

const fixtureMessages: ModelMessage[] = [
  { role: 'user', content: 'Deploy nginx on prod-web-01 and verify port 443.' },
  { role: 'assistant', content: 'I will check the server first.' },
  { role: 'user', content: 'Command failed: systemctl restart nginx returned exit code 1.' },
  { role: 'assistant', content: 'The error log shows missing ssl_certificate path.' },
];

test('context replay compaction retains user goal and recent tail', async () => {
  const goal = extractLatestUserGoal(fixtureMessages);
  assert.ok(goal?.includes('Command failed'));

  const prepared = await prepareTurnContext({
    messages: [...fixtureMessages],
    backend: 'catty',
    contextWindow: 500,
    reservedTokens: 100,
    trigger: 'force',
    force: true,
    protectRecentMessages: 2,
    providerId: 'anthropic',
    reinjection: {
      userGoal: goal,
      permissionMode: 'confirm',
      sessionStateText: 'User goal: Deploy nginx\nActive hosts: sess-1 (last: systemctl status nginx)',
    },
  });

  assert.equal(prepared.didAdjust, true);
  assert.ok(prepared.messages.length <= fixtureMessages.length + 1);
  const joined = JSON.stringify(prepared.messages);
  assert.match(joined, /Deploy nginx|Command failed|ssl_certificate/);
  assert.ok(prepared.trace?.estimatorKind);
});
