import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import { prepareTurnContext, prepareStepContext } from './contextManager.ts';
import { TraceStore } from './traceStore.ts';
import { ToolOutputStore } from './toolOutputStore.ts';
import { createInitialCattyRuntimeContext } from './cattyRuntimeContext.ts';

test('normal turn and step preparation preserve exact user literals alongside noisy tool output', async () => {
  const literal = "printf '%s\\n' 'CANONICAL_GUI_" + 'x'.repeat(1200) + "_END'";
  const content = `Execute exactly: ${literal}\n\n\n\n${'keep this line\n'.repeat(5)}`;
  for (const userContent of [content, [{ type: 'text' as const, text: content }]]) {
    const messages: ModelMessage[] = [
      { role: 'user', content: userContent },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'noise', toolName: 'terminal_execute', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'noise', toolName: 'terminal_execute', output: { type: 'text', value: 'log '.repeat(10000) } }] },
    ];
    const turn = await prepareTurnContext({ messages, backend: 'catty', contextWindow: 1_300_000, trigger: 'pre-turn' });
    const step = await prepareStepContext({ messages: turn.messages, contextWindow: 1_300_000, stepNumber: 0 });
    for (const prepared of [turn, step]) {
      assert.deepEqual(prepared.messages.find(message => message.role === 'user')?.content, userContent);
      assert.ok(JSON.stringify(prepared.messages).length < JSON.stringify(messages).length);
    }
  }
});

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

test('prepareTurnContext skips reinjection when no compaction occurred', async () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'List running containers on prod-web-01.' },
    { role: 'assistant', content: 'I will check docker ps.' },
  ];

  const events: string[] = [];
  const prepared = await prepareTurnContext({
    messages,
    backend: 'catty',
    contextWindow: 128_000,
    trigger: 'pre-turn',
    sessionId: 'chat-no-compact',
    onEvent: (event) => {
      if (event.type === 'compaction') events.push(event.trace.trigger);
    },
    reinjection: {
      permissionMode: 'confirm',
      userGoal: 'List running containers on prod-web-01.',
    },
  });

  assert.equal(prepared.didAdjust, false);
  assert.equal(events.length, 0);
  const serialized = JSON.stringify(prepared.messages);
  assert.doesNotMatch(serialized, /Netcatty session context/);
  assert.doesNotMatch(serialized, /Permission mode: confirm/);
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

test('TraceStore bounds compaction history independently from events', () => {
  const store = new TraceStore(20, 3);
  for (let index = 0; index < 10; index += 1) {
    store.append({
      id: `compaction-${index}`,
      type: 'compaction',
      sessionId: 'chat-bounded-compactions',
      trace: { trigger: 'force' },
    } as import('./types').AgentEvent);
  }
  assert.equal(store.getCompactions('chat-bounded-compactions').length, 3);
});

test('prepareStepContext replaces prior step handle notices under v7 carry-forward semantics', async () => {
  const store = new ToolOutputStore();
  store.store({
    chatSessionId: 'chat-4',
    capabilityId: 'sftp.read',
    content: 'large payload',
  });
  const runtimeContext = createInitialCattyRuntimeContext({
    chatSessionId: 'chat-4',
    turnId: 'turn-1',
    permissionMode: 'confirm',
    scopeType: 'terminal',
  });
  const priorNotice: ModelMessage = {
    role: 'user',
    content: '[step 1] Tool output handles available: tool-output-old',
  };
  const prepared = await prepareStepContext({
    messages: [priorNotice, { role: 'user', content: 'continue' }],
    stepNumber: 2,
    sessionId: 'chat-4',
    chatSessionId: 'chat-4',
    toolOutputStore: store,
    runtimeContext,
  });

  const notices = prepared.messages.filter(
    (message) => message.role === 'user'
      && typeof message.content === 'string'
      && message.content.includes('Tool output handles available'),
  );
  assert.equal(notices.length, 1);
  assert.match(String(notices[0]?.content), /\[step 2\]/);
  assert.doesNotMatch(String(notices[0]?.content), /tool-output-old/);
});

test('prepareStepContext emits step compaction trace when over budget', async () => {
  const messages: ModelMessage[] = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: 'payload '.repeat(2_000),
  })) as ModelMessage[];

  const events: string[] = [];
  const prepared = await prepareStepContext({
    messages,
    stepNumber: 3,
    sessionId: 'chat-5',
    chatSessionId: 'chat-5',
    contextWindow: 4_000,
    reservedTokens: 500,
    maxOutputTokens: 512,
    providerId: 'anthropic',
    runtimeContext: createInitialCattyRuntimeContext({
      chatSessionId: 'chat-5',
      turnId: 'turn-2',
      permissionMode: 'confirm',
      scopeType: 'terminal',
    }),
    onEvent: (event) => {
      if (event.type === 'compaction') events.push(event.trace.trigger);
    },
  });

  assert.equal(prepared.didAdjust, true);
  assert.equal(prepared.trace?.trigger, 'step');
  assert.ok(events.includes('step'));
});

test('prepareStepContext retains handle notice after step budget guard', async () => {
  const store = new ToolOutputStore();
  store.store({
    chatSessionId: 'chat-handle',
    capabilityId: 'sftp.read',
    content: 'large payload',
  });
  const messages: ModelMessage[] = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: 'payload '.repeat(2_000),
  })) as ModelMessage[];

  const prepared = await prepareStepContext({
    messages,
    stepNumber: 2,
    sessionId: 'chat-handle',
    chatSessionId: 'chat-handle',
    contextWindow: 4_000,
    reservedTokens: 500,
    maxOutputTokens: 512,
    toolOutputStore: store,
    runtimeContext: createInitialCattyRuntimeContext({
      chatSessionId: 'chat-handle',
      turnId: 'turn-handle',
      permissionMode: 'confirm',
      scopeType: 'terminal',
    }),
  });

  const notices = prepared.messages.filter(
    (message) => message.role === 'user'
      && typeof message.content === 'string'
      && message.content.includes('Tool output handles available'),
  );
  assert.equal(notices.length, 1);
  assert.match(String(notices[0]?.content), /\[step 2\]/);
});

test('prepareStepContext never leaves orphan results from a parallel tool batch', async () => {
  const toolCallIds = ['a', 'b', 'c', 'd', 'e', 'f'];
  const messages: ModelMessage[] = [
    {
      role: 'assistant',
      content: toolCallIds.map((toolCallId) => ({
        type: 'tool-call' as const,
        toolCallId,
        toolName: 'terminal_poll',
        input: { jobId: toolCallId },
      })),
    },
    ...toolCallIds.map((toolCallId) => ({
      role: 'tool' as const,
      content: [{
        type: 'tool-result' as const,
        toolCallId,
        toolName: 'terminal_poll',
        output: { type: 'text' as const, value: `${toolCallId}:${'output '.repeat(4_000)}` },
      }],
    })),
    { role: 'user', content: 'summarize the completed jobs' },
  ];

  const prepared = await prepareStepContext({
    messages,
    stepNumber: 4,
    sessionId: 'chat-parallel',
    chatSessionId: 'chat-parallel',
    contextWindow: 8_000,
    reservedTokens: 500,
    maxOutputTokens: 512,
    runtimeContext: createInitialCattyRuntimeContext({
      chatSessionId: 'chat-parallel',
      turnId: 'turn-parallel',
      permissionMode: 'confirm',
      scopeType: 'terminal',
    }),
  });

  const knownCalls = new Set<string>();
  for (const message of prepared.messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content as Array<{ type?: string; toolCallId?: string }>) {
        if (part.type === 'tool-call' && part.toolCallId) knownCalls.add(part.toolCallId);
      }
    }
    if (message.role === 'tool' && Array.isArray(message.content)) {
      for (const part of message.content as Array<{ type?: string; toolCallId?: string }>) {
        if (part.type === 'tool-result') assert.equal(knownCalls.has(part.toolCallId ?? ''), true);
      }
    }
  }
});

test('prepareTurnContext calls summarize when over dynamic threshold', async () => {
  let summarizeCalls = 0;
  const messages: ModelMessage[] = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: 'history '.repeat(3_000),
  })) as ModelMessage[];

  const prepared = await prepareTurnContext({
    messages,
    backend: 'catty',
    contextWindow: 8_000,
    maxOutputTokens: 512,
    trigger: 'pre-turn',
    sessionId: 'chat-6',
    providerId: 'openai',
    summarize: async () => {
      summarizeCalls += 1;
      return 'summary of earlier work';
    },
  });

  assert.equal(summarizeCalls, 1);
  assert.equal(prepared.trace?.didLlmSummarize, true);
  assert.match(JSON.stringify(prepared.messages), /summary of earlier work/);
});
