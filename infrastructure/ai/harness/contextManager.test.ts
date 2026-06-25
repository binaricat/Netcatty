import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import { prepareTurnContext } from './contextManager.ts';
import { TraceStore } from './traceStore.ts';

test('prepareTurnContext applies typed compression before LLM summarize threshold', async () => {
  const longOutput = 'line\n'.repeat(20_000);
  const messages: ModelMessage[] = [
    {
      role: 'user',
      content: 'Check nginx error logs on prod-web-01 and summarize failures.',
    },
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'terminal_execute',
        input: { sessionId: 'sess-1', command: 'tail -n 500 /var/log/nginx/error.log' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'terminal_execute',
        output: { type: 'text', value: longOutput },
      }],
    },
    {
      role: 'assistant',
      content: 'Found repeated upstream timeout errors.',
    },
    {
      role: 'user',
      content: 'Fix only the upstream timeout issue, do not restart nginx yet.',
    },
  ];

  const traces: string[] = [];
  const prepared = await prepareTurnContext({
    messages,
    backend: 'catty',
    contextWindow: 128_000,
    trigger: 'pre-turn',
    sessionId: 'chat-1',
    onEvent: (event) => {
      if (event.type === 'compaction') traces.push(event.trace.trigger);
    },
    reinjection: {
      permissionMode: 'confirm',
      userGoal: 'Fix upstream timeout without restarting nginx.',
    },
  });

  assert.ok(prepared.messages.length >= messages.length);
  const serialized = JSON.stringify(prepared.messages);
  assert.match(serialized, /Fix only the upstream timeout issue/);
  assert.match(serialized, /Permission mode: confirm/);
  assert.ok(serialized.length < JSON.stringify(messages).length);
});

test('prepareTurnContext force trigger retains recent user goal in replay', async () => {
  const messages: ModelMessage[] = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: index === 38
      ? 'SSH into db-01 and inspect /var/log/postgresql/postgresql.log for crash signatures.'
      : `filler message ${index}`,
  })) as ModelMessage[];

  const prepared = await prepareTurnContext({
    messages,
    backend: 'catty',
    contextWindow: 128_000,
    trigger: 'force',
    force: true,
    sessionId: 'chat-2',
  });

  const serialized = JSON.stringify(prepared.messages);
  assert.match(serialized, /SSH into db-01/);
  assert.match(serialized, /postgresql\.log/);
});

test('TraceStore records compaction events for export', async () => {
  const store = new TraceStore();
  await prepareTurnContext({
    messages: [{ role: 'user', content: 'x'.repeat(500_000) }],
    backend: 'catty',
    contextWindow: 1000,
    trigger: 'force',
    force: true,
    sessionId: 'chat-3',
    onEvent: (event) => store.append(event),
  });

  const exported = store.exportTrace('chat-3');
  assert.ok(exported.compactions.length >= 1);
  assert.equal(exported.compactions[0]?.trigger, 'force');
});
