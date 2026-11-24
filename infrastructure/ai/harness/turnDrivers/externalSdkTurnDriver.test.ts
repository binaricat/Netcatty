import test from 'node:test';
import assert from 'node:assert/strict';
import type { AISession, AgentActivity, ChatMessage, ExternalAgentConfig } from '../../types';
import { SessionStateStore } from '../sessionState';
import { ToolOutputStore } from '../toolOutputStore';
import { ToolResultDedup } from '../toolResultDedup';
import { externalSdkTurnDriver, localizeSdkAgentMessage } from './externalSdkTurnDriver';
import { resolveEstimatedUsageFallback, upsertAgentActivity } from './externalSdkEventState';
import type { TurnUiCallbacks } from './types';

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error('condition not reached');
}

test('OpenCode 2 error keys are localized and other errors stay unchanged', () => {
  const translate = (key: string) => key === 'ai.opencode.v2.startupTimeout' ? '未能及时就绪' : key;
  assert.equal(
    localizeSdkAgentMessage('ai.opencode.v2.startupTimeout', translate),
    '未能及时就绪',
  );
  assert.equal(localizeSdkAgentMessage('server password hunter2', translate), 'server password hunter2');
  assert.equal(localizeSdkAgentMessage('ai.opencode.v2.startupTimeout'), 'ai.opencode.v2.startupTimeout');
});

test('upsertAgentActivity replaces streaming updates by stable item id', () => {
  const running: AgentActivity = {
    id: 'plan-1',
    type: 'plan_update',
    status: 'running',
    items: [{ text: 'Map events', completed: false }],
  };
  const completed: AgentActivity = {
    ...running,
    status: 'completed',
    items: [{ text: 'Map events', completed: true }],
  };

  const first = upsertAgentActivity(undefined, running);
  const second = upsertAgentActivity(first, completed);

  assert.equal(second.length, 1);
  assert.deepEqual(second[0], completed);
});

test('upsertAgentActivity preserves the order of unrelated activities', () => {
  const search: AgentActivity = {
    id: 'search-1',
    type: 'web_search',
    status: 'completed',
    query: 'Codex events',
  };
  const warning: AgentActivity = {
    id: 'warning-1',
    type: 'warning',
    status: 'completed',
    message: 'Search result unavailable',
  };

  assert.deepEqual(upsertAgentActivity([search], warning), [search, warning]);
});

test('estimated usage is used only when the SDK did not report actual usage', () => {
  assert.deepEqual(resolveEstimatedUsageFallback('12345678', false), {
    inputTokens: 2,
    outputTokens: 0,
    totalTokens: 2,
    estimated: true,
  });
  assert.equal(resolveEstimatedUsageFallback('12345678', true), null);
});

test('plan updates replace the same activity across tool message boundaries', async () => {
  let onEvent: ((event: Record<string, unknown>) => void) | undefined;
  let onDone: (() => void) | undefined;
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    onAiSdkAgentEvent: (_requestId, callback) => {
      onEvent = callback as (event: Record<string, unknown>) => void;
      return () => {};
    },
    onAiSdkAgentDone: (_requestId, callback) => {
      onDone = callback as () => void;
      return () => {};
    },
    onAiSdkAgentError: () => () => {},
    aiSdkAgentCancel: async () => ({ ok: true }),
    aiSdkAgentStream: async () => {
      queueMicrotask(() => {
        onEvent?.({
          type: 'plan-update',
          itemId: 'plan-1',
          status: 'running',
          items: [{ text: 'Run command', completed: false }],
        });
        onEvent?.({
          type: 'tool-call',
          toolName: 'shell',
          toolCallId: 'tool-1',
          args: { command: 'true' },
        });
        onEvent?.({
          type: 'tool-result',
          toolName: 'shell',
          toolCallId: 'tool-1',
          output: 'ok',
        });
        onEvent?.({
          type: 'plan-update',
          itemId: 'plan-1',
          status: 'completed',
          items: [{ text: 'Run command', completed: true }],
        });
        onEvent?.({ type: 'hook', hookEvent: 'PostCompact' });
        onDone?.();
      });
      return { ok: true };
    },
  };

  const session: AISession = {
    id: 'chat-1',
    title: 'Test',
    agentId: 'codex',
    scope: { type: 'global' },
    messages: [{ id: 'assistant-1', role: 'assistant', content: '', timestamp: 1 }],
    createdAt: 1,
    updatedAt: 1,
  };
  const ui: TurnUiCallbacks = {
    addMessageToSession: (_sessionId, message) => {
      session.messages.push(message);
    },
    updateLastMessage: (_sessionId, updater) => {
      const lastIndex = session.messages.length - 1;
      session.messages[lastIndex] = updater(session.messages[lastIndex]);
    },
    updateMessageById: (_sessionId, messageId, updater) => {
      const messageIndex = session.messages.findIndex((message) => message.id === messageId);
      if (messageIndex >= 0) {
        session.messages[messageIndex] = updater(session.messages[messageIndex]);
      }
    },
    reportStreamError: () => {},
    setStreamingForScope: () => {},
    getLatestSession: () => session,
    translate: (key) => key === 'ai.chat.contextCompacted' ? 'Context compacted (localized)' : key,
  };
  const agentConfig: ExternalAgentConfig = {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    enabled: true,
    sdkBackend: 'codex',
  };
  const controller = new AbortController();

  await externalSdkTurnDriver.run({
    backend: 'external-sdk',
    chatSessionId: session.id,
    assistantMsgId: 'assistant-1',
    userText: 'Run the plan',
    signal: controller.signal,
    agentConfig,
    attachedImages: [],
    context: {
      terminalSessions: [],
      providers: [],
      toolIntegrationMode: 'mcp',
      selectedUserSkillSlugs: [],
      permissionMode: 'confirm',
    },
    bridge,
    ui,
  }, {
    turnId: 'turn-1',
    chatSessionId: session.id,
    sessionId: session.id,
    backend: 'external-sdk',
    signal: controller.signal,
    emit: () => {},
    toolOutputStore: new ToolOutputStore(),
    toolResultDedup: new ToolResultDedup(),
    sessionStateStore: new SessionStateStore(),
  });

  const planActivities = session.messages
    .flatMap((message: ChatMessage) => message.agentActivities ?? [])
    .filter((activity) => activity.id === 'plan-1');

  assert.equal(planActivities.length, 1);
  assert.equal(planActivities[0].status, 'completed');
  assert.deepEqual(planActivities[0].type === 'plan_update' ? planActivities[0].items : [], [
    { text: 'Run command', completed: true },
  ]);
  assert.equal(
    session.messages.findLast(message => message.role === 'assistant')?.statusText,
    'Context compacted (localized)',
  );
});

test('accepted steering persists a user bubble and routes buffered output to a continuation', async () => {
  let onEvent: ((event: Record<string, unknown>) => void) | undefined;
  let onDone: (() => void) | undefined;
  let releaseSteer: (() => void) | undefined;
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    onAiSdkAgentEvent: (_requestId, callback) => {
      onEvent = callback as (event: Record<string, unknown>) => void;
      return () => {};
    },
    onAiSdkAgentDone: (_requestId, callback) => {
      onDone = callback as () => void;
      return () => {};
    },
    onAiSdkAgentError: () => () => {},
    aiSdkAgentCancel: async () => ({ ok: true }),
    aiSdkAgentStream: async () => ({ ok: true }),
    aiSdkAgentSteer: async () => {
      onEvent?.({ type: 'text-delta', textDelta: 'after steer' });
      await new Promise<void>(resolve => { releaseSteer = resolve; });
      return { status: 'accepted' };
    },
  };
  const session: AISession = {
    id: 'chat-steer',
    title: 'Steer',
    agentId: 'codex',
    scope: { type: 'global' },
    messages: [{ id: 'assistant-initial', role: 'assistant', content: '', timestamp: 1 }],
    createdAt: 1,
    updatedAt: 1,
  };
  const ui: TurnUiCallbacks = {
    addMessageToSession: (_sessionId, message) => session.messages.push(message),
    updateLastMessage: () => { throw new Error('steering must not update the last message implicitly'); },
    updateMessageById: (_sessionId, messageId, updater) => {
      const index = session.messages.findIndex(message => message.id === messageId);
      if (index >= 0) session.messages[index] = updater(session.messages[index]);
    },
    reportStreamError: () => {},
    setStreamingForScope: () => {},
    getLatestSession: () => session,
  };
  const controller = new AbortController();
  const run = externalSdkTurnDriver.run({
    backend: 'external-sdk',
    chatSessionId: session.id,
    assistantMsgId: 'assistant-initial',
    userText: 'initial prompt',
    signal: controller.signal,
    agentConfig: {
      id: 'codex',
      name: 'Codex',
      command: 'codex',
      enabled: true,
      sdkBackend: 'codex',
      codexRuntime: 'app-server',
    },
    attachedImages: [],
    context: {
      terminalSessions: [],
      providers: [],
      toolIntegrationMode: 'mcp',
      selectedUserSkillSlugs: [],
      permissionMode: 'confirm',
    },
    bridge,
    ui,
  }, {
    turnId: 'turn-steer',
    chatSessionId: session.id,
    sessionId: session.id,
    backend: 'external-sdk',
    signal: controller.signal,
    emit: () => {},
    toolOutputStore: new ToolOutputStore(),
    toolResultDedup: new ToolResultDedup(),
    sessionStateStore: new SessionStateStore(),
  });
  await waitFor(() => Boolean(onEvent));
  onEvent?.({ type: 'text-delta', textDelta: 'before steer' });

  const steer = externalSdkTurnDriver.steer({
    chatSessionId: session.id,
    userMessageId: 'user-steer',
    userText: 'change direction',
    prompt: 'change direction',
    attachments: [],
    attachedImages: [],
  });
  await waitFor(() => Boolean(releaseSteer));
  assert.equal(session.messages.length, 1);
  releaseSteer?.();
  const result = await steer;

  assert.equal(result.status, 'accepted');
  assert.deepEqual(session.messages.map(message => message.role), ['assistant', 'user', 'assistant']);
  assert.equal(session.messages[0].content, 'before steer');
  assert.equal(session.messages[1].content, 'change direction');
  assert.equal(session.messages[2].content, 'after steer');

  onDone?.();
  await run;
});

test('accepted steering keeps buffered results for existing tool calls on their original assistant message', async () => {
  let onEvent: ((event: Record<string, unknown>) => void) | undefined;
  let onDone: (() => void) | undefined;
  let releaseSteer: (() => void) | undefined;
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    onAiSdkAgentEvent: (_requestId, callback) => {
      onEvent = callback as (event: Record<string, unknown>) => void;
      return () => {};
    },
    onAiSdkAgentDone: (_requestId, callback) => {
      onDone = callback as () => void;
      return () => {};
    },
    onAiSdkAgentError: () => () => {},
    aiSdkAgentCancel: async () => ({ ok: true }),
    aiSdkAgentStream: async () => ({ ok: true }),
    aiSdkAgentSteer: async () => {
      onEvent?.({
        type: 'tool-result',
        toolName: 'shell',
        toolCallId: 'tool-before-steer',
        output: 'completed before steer acceptance',
      });
      await new Promise<void>(resolve => { releaseSteer = resolve; });
      return { status: 'accepted' };
    },
  };
  const session: AISession = {
    id: 'chat-steer-tool-result',
    title: 'Steer tool result',
    agentId: 'codex',
    scope: { type: 'global' },
    messages: [{ id: 'assistant-initial', role: 'assistant', content: '', timestamp: 1 }],
    createdAt: 1,
    updatedAt: 1,
  };
  const ui: TurnUiCallbacks = {
    addMessageToSession: (_sessionId, message) => session.messages.push(message),
    updateLastMessage: () => { throw new Error('steering must not update the last message implicitly'); },
    updateMessageById: (_sessionId, messageId, updater) => {
      const index = session.messages.findIndex(message => message.id === messageId);
      if (index >= 0) session.messages[index] = updater(session.messages[index]);
    },
    reportStreamError: () => {},
    setStreamingForScope: () => {},
    getLatestSession: () => session,
  };
  const controller = new AbortController();
  const run = externalSdkTurnDriver.run({
    backend: 'external-sdk',
    chatSessionId: session.id,
    assistantMsgId: 'assistant-initial',
    userText: 'initial prompt',
    signal: controller.signal,
    agentConfig: {
      id: 'codex', name: 'Codex', command: 'codex', enabled: true,
      sdkBackend: 'codex', codexRuntime: 'app-server',
    },
    attachedImages: [],
    context: {
      terminalSessions: [], providers: [], toolIntegrationMode: 'mcp',
      selectedUserSkillSlugs: [], permissionMode: 'confirm',
    },
    bridge,
    ui,
  }, {
    turnId: 'turn-steer-tool-result', chatSessionId: session.id, sessionId: session.id,
    backend: 'external-sdk', signal: controller.signal, emit: () => {},
    toolOutputStore: new ToolOutputStore(), toolResultDedup: new ToolResultDedup(),
    sessionStateStore: new SessionStateStore(),
  });
  await waitFor(() => Boolean(onEvent));
  onEvent?.({
    type: 'tool-call',
    toolName: 'shell',
    toolCallId: 'tool-before-steer',
    args: { command: 'sleep 1' },
  });
  assert.equal(session.messages[0].executionStatus, 'running');

  const steer = externalSdkTurnDriver.steer({
    chatSessionId: session.id,
    userMessageId: 'user-steer-tool-result',
    userText: 'change direction',
    prompt: 'change direction',
    attachments: [],
    attachedImages: [],
  });
  await waitFor(() => Boolean(releaseSteer));
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0].executionStatus, 'running');

  releaseSteer?.();
  const result = await steer;

  assert.equal(result.status, 'accepted');
  assert.deepEqual(
    session.messages.map(message => message.role),
    ['assistant', 'tool', 'user', 'assistant'],
  );
  assert.equal(session.messages[0].executionStatus, 'completed');
  assert.equal(session.messages[0].toolCalls?.[0]?.id, 'tool-before-steer');
  assert.equal(session.messages[1].toolResults?.[0]?.toolCallId, 'tool-before-steer');
  assert.equal(session.messages[2].content, 'change direction');
  assert.equal(session.messages[3].content, '');

  onEvent?.({ type: 'text-delta', textDelta: 'continued after steer' });
  // Text deltas are rAF-batched like Catty; wait one frame before asserting.
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
  assert.equal(session.messages[3].content, 'continued after steer');

  onDone?.();
  await run;
});

test('failed steering keeps buffered output on the original assistant message', async () => {
  let onEvent: ((event: Record<string, unknown>) => void) | undefined;
  let onDone: (() => void) | undefined;
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    onAiSdkAgentEvent: (_requestId, callback) => {
      onEvent = callback as (event: Record<string, unknown>) => void;
      return () => {};
    },
    onAiSdkAgentDone: (_requestId, callback) => {
      onDone = callback as () => void;
      return () => {};
    },
    onAiSdkAgentError: () => () => {},
    aiSdkAgentCancel: async () => ({ ok: true }),
    aiSdkAgentStream: async () => ({ ok: true }),
    aiSdkAgentSteer: async () => {
      onEvent?.({ type: 'text-delta', textDelta: 'kept output' });
      return { status: 'not-steerable', turnKind: 'compact' };
    },
  };
  const session: AISession = {
    id: 'chat-steer-failed',
    title: 'Steer failed',
    agentId: 'codex',
    scope: { type: 'global' },
    messages: [{ id: 'assistant-initial', role: 'assistant', content: '', timestamp: 1 }],
    createdAt: 1,
    updatedAt: 1,
  };
  const ui: TurnUiCallbacks = {
    addMessageToSession: (_sessionId, message) => session.messages.push(message),
    updateLastMessage: () => { throw new Error('steering must not update the last message implicitly'); },
    updateMessageById: (_sessionId, messageId, updater) => {
      const index = session.messages.findIndex(message => message.id === messageId);
      if (index >= 0) session.messages[index] = updater(session.messages[index]);
    },
    reportStreamError: () => {},
    setStreamingForScope: () => {},
  };
  const controller = new AbortController();
  const run = externalSdkTurnDriver.run({
    backend: 'external-sdk',
    chatSessionId: session.id,
    assistantMsgId: 'assistant-initial',
    userText: 'initial prompt',
    signal: controller.signal,
    agentConfig: {
      id: 'codex', name: 'Codex', command: 'codex', enabled: true,
      sdkBackend: 'codex', codexRuntime: 'app-server',
    },
    attachedImages: [],
    context: {
      terminalSessions: [], providers: [], toolIntegrationMode: 'mcp',
      selectedUserSkillSlugs: [], permissionMode: 'confirm',
    },
    bridge,
    ui,
  }, {
    turnId: 'turn-steer-failed', chatSessionId: session.id, sessionId: session.id,
    backend: 'external-sdk', signal: controller.signal, emit: () => {},
    toolOutputStore: new ToolOutputStore(), toolResultDedup: new ToolResultDedup(),
    sessionStateStore: new SessionStateStore(),
  });
  await waitFor(() => Boolean(onEvent));
  const result = await externalSdkTurnDriver.steer({
    chatSessionId: session.id,
    userMessageId: 'user-not-added',
    userText: 'cannot apply',
    prompt: 'cannot apply',
    attachments: [],
    attachedImages: [],
  });

  assert.deepEqual(result, { status: 'not-steerable', turnKind: 'compact' });
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0].content, 'kept output');
  onDone?.();
  await run;
});

test('an SDK turn that ends with no output appends a visible notice instead of a silent empty bubble', async () => {
  let onDone: (() => void) | undefined;
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    onAiSdkAgentEvent: () => () => {},
    onAiSdkAgentDone: (_requestId, callback) => {
      onDone = callback as () => void;
      return () => {};
    },
    onAiSdkAgentError: () => () => {},
    aiSdkAgentCancel: async () => ({ ok: true }),
    aiSdkAgentStream: async () => {
      queueMicrotask(() => { onDone?.(); });
      return { ok: true };
    },
  };
  const session: AISession = {
    id: 'chat-empty',
    title: 'Empty',
    agentId: 'codex',
    scope: { type: 'global' },
    messages: [{ id: 'assistant-empty', role: 'assistant', content: '', timestamp: 1 }],
    createdAt: 1,
    updatedAt: 1,
  };
  const ui: TurnUiCallbacks = {
    addMessageToSession: (_sessionId, message) => { session.messages.push(message); },
    updateLastMessage: (_sessionId, updater) => {
      const lastIndex = session.messages.length - 1;
      session.messages[lastIndex] = updater(session.messages[lastIndex]);
    },
    updateMessageById: (_sessionId, messageId, updater) => {
      const index = session.messages.findIndex(message => message.id === messageId);
      if (index >= 0) session.messages[index] = updater(session.messages[index]);
    },
    reportStreamError: () => {},
    setStreamingForScope: () => {},
    getLatestSession: () => session,
    translate: (key) => key,
  };
  const agentConfig: ExternalAgentConfig = {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    enabled: true,
    sdkBackend: 'codex',
  };
  const controller = new AbortController();

  await externalSdkTurnDriver.run({
    backend: 'external-sdk',
    chatSessionId: session.id,
    assistantMsgId: 'assistant-empty',
    userText: 'Do nothing',
    signal: controller.signal,
    agentConfig,
    attachedImages: [],
    context: {
      terminalSessions: [],
      providers: [],
      toolIntegrationMode: 'mcp',
      selectedUserSkillSlugs: [],
      permissionMode: 'confirm',
    },
    bridge,
    ui,
  }, {
    turnId: 'turn-empty',
    chatSessionId: session.id,
    sessionId: session.id,
    backend: 'external-sdk',
    signal: controller.signal,
    emit: () => {},
    toolOutputStore: new ToolOutputStore(),
    toolResultDedup: new ToolResultDedup(),
    sessionStateStore: new SessionStateStore(),
  });

  const notice = session.messages.at(-1);
  assert.equal(notice?.role, 'assistant');
  assert.match(notice?.content ?? '', /finished this turn without producing output/);
});
