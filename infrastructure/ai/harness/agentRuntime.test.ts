import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRuntime } from './agentRuntime';
import { TraceStore } from './traceStore';
import { SessionStateStore } from './sessionState';
import type { TurnDriver, TurnDriverContext, TurnInput } from './turnDrivers/types';

class MockTurnDriver implements TurnDriver {
  readonly backend = 'catty' as const;
  readonly runs: TurnInput[] = [];

  async run(input: TurnInput, ctx: TurnDriverContext): Promise<void> {
    this.runs.push(input);
    ctx.emit({
      id: 'model-delta-1',
      type: 'model_delta',
      text: 'hello',
    } as import('./types').AgentEvent);
    if (input.signal.aborted) return;
  }

  abort(): void {}
}

test('AgentRuntime clearChatSession releases its trace history', () => {
  const traceStore = new TraceStore();
  const runtime = new AgentRuntime({ drivers: [new MockTurnDriver()], traceStore });
  traceStore.append({
    id: 'trace-clear-1',
    type: 'turn_start',
    sessionId: 'chat-clear',
    turnId: 'turn-clear',
    startedAt: Date.now(),
  } as import('./types').AgentEvent);

  runtime.clearChatSession('chat-clear');
  assert.equal(traceStore.getEvents('chat-clear').length, 0);
  assert.equal(traceStore.getCompactions('chat-clear').length, 0);
});

test('waitForChatSessionToolOutputDeletion reports protected deletion failures', async () => {
  const runtime = new AgentRuntime({ drivers: [new MockTurnDriver()] });
  const store = runtime.getToolOutputStore('chat-delete');

  // A failed protected deletion must report `false` so the caller retries
  // through the direct cleanup path instead of leaving the durable records
  // on disk.
  store.setPersistence({
    write: async () => '/unused',
    read: async () => null,
    delete: async () => {},
    deleteSession: async () => { throw new Error('disk busy'); },
  });
  runtime.clearChatSession('chat-delete-failed');
  assert.equal(await runtime.waitForChatSessionToolOutputDeletion('chat-delete-failed'), false);

  // A successful protected deletion reports `true`.
  store.setPersistence({
    write: async () => '/unused',
    read: async () => null,
    delete: async () => {},
    deleteSession: async () => {},
  });
  runtime.clearChatSession('chat-delete-ok');
  assert.equal(await runtime.waitForChatSessionToolOutputDeletion('chat-delete-ok'), true);
});

test('AgentRuntime runTurn emits turn lifecycle and records trace', async () => {
  const traceStore = new TraceStore();
  const driver = new MockTurnDriver();
  const runtime = new AgentRuntime({ drivers: [driver], traceStore });
  const events: string[] = [];
  runtime.subscribe(event => events.push(event.type));

  const controller = new AbortController();
  const result = await runtime.runTurn({
    backend: 'catty',
    chatSessionId: 'chat-1',
    sendScopeKey: 'chat-1',
    userText: 'hi',
    signal: controller.signal,
    currentSession: undefined,
    assistantMsgId: 'assistant-1',
    context: {
      activeProvider: undefined,
      activeModelId: '',
      scopeType: 'terminal',
      globalPermissionMode: 'confirm',
      terminalSessions: [],
      autoTitleSession: () => {},
    },
    maxIterations: 5,
    ui: {
      addMessageToSession: () => {},
      updateLastMessage: () => {},
      updateMessageById: () => {},
      reportStreamError: () => {},
      setStreamingForScope: () => {},
    },
  });

  assert.equal(result.reason, 'completed');
  assert.equal(driver.runs.length, 1);
  assert.deepEqual(events, ['turn_start', 'model_delta', 'turn_end']);
  assert.equal(traceStore.getEvents('chat-1').length, 3);
});

test('AgentRuntime records session state from tool call and result events', async () => {
  class ToolTurnDriver implements TurnDriver {
    readonly backend = 'catty' as const;
    async run(_input: TurnInput, ctx: TurnDriverContext): Promise<void> {
      ctx.emit({
        id: 'secret-call',
        type: 'tool_call',
        toolCallId: 'call-secret',
        toolName: 'terminal_execute',
        args: { sessionId: 'sess-1', command: 'curl -H "Authorization: Bearer secret_token_123456" https://example.test --password swordfish' },
      } as import('./types').AgentEvent);
      ctx.emit({
        id: 'tool-call-1',
        type: 'tool_call',
        toolCallId: 'call-1',
        toolName: 'terminal_execute',
        args: { sessionId: 'sess-1', command: 'uptime' },
      } as import('./types').AgentEvent);
      ctx.emit({
        id: 'tool-result-1',
        type: 'tool_result',
        toolCallId: 'call-1',
        result: 'ok',
        isError: false,
      } as import('./types').AgentEvent);
    }
    abort(): void {}
  }

  const sessionStateStore = new SessionStateStore();
  const runtime = new AgentRuntime({ drivers: [new ToolTurnDriver()], sessionStateStore });
  await runtime.runTurn({
    backend: 'catty',
    chatSessionId: 'chat-tool',
    sendScopeKey: 'chat-tool',
    userText: 'check uptime',
    signal: new AbortController().signal,
    currentSession: undefined,
    assistantMsgId: 'assistant-1',
    context: {
      activeProvider: undefined,
      activeModelId: '',
      scopeType: 'terminal',
      globalPermissionMode: 'confirm',
      terminalSessions: [],
      autoTitleSession: () => {},
    },
    maxIterations: 5,
    ui: {
      addMessageToSession: () => {},
      updateLastMessage: () => {},
      updateMessageById: () => {},
      reportStreamError: () => {},
      setStreamingForScope: () => {},
    },
  });

  const text = sessionStateStore.toReinjectionText('chat-tool');
  assert.ok(text?.includes('uptime'));
  assert.ok(text?.includes('check uptime'));
});

test('AgentRuntime keeps terminal output when session close reports failure', async () => {
  class FailedCloseDriver implements TurnDriver {
    readonly backend = 'external-sdk' as const;
    async run(_input: TurnInput, ctx: TurnDriverContext): Promise<void> {
      ctx.emit({
        id: 'close-call',
        type: 'tool_call',
        toolCallId: 'close-1',
        toolName: 'session_close',
        args: { sessionId: 'terminal-still-open' },
      } as import('./types').AgentEvent);
      ctx.emit({
        id: 'close-result',
        type: 'tool_result',
        toolCallId: 'close-1',
        result: JSON.stringify({ ok: false, error: 'close rejected' }),
        isError: false,
      } as import('./types').AgentEvent);
    }
    abort(): void {}
  }

  const runtime = new AgentRuntime({ drivers: [new FailedCloseDriver()] });
  const store = runtime.getToolOutputStore('chat-close-failed');
  const handle = store.store({
    chatSessionId: 'chat-close-failed',
    capabilityId: 'terminal.execute',
    sessionId: 'terminal-still-open',
    content: 'keep me',
  });
  await runtime.runTurn({
    backend: 'external-sdk',
    chatSessionId: 'chat-close-failed',
    sendScopeKey: 'chat-close-failed',
    userText: 'close it',
    signal: new AbortController().signal,
    currentSession: undefined,
    assistantMsgId: 'assistant-close-failed',
    context: {
      activeProvider: undefined,
      activeModelId: '',
      scopeType: 'terminal',
      globalPermissionMode: 'confirm',
      terminalSessions: [],
      autoTitleSession: () => {},
    },
    maxIterations: 5,
    ui: {
      addMessageToSession: () => {},
      updateLastMessage: () => {},
      updateMessageById: () => {},
      reportStreamError: () => {},
      setStreamingForScope: () => {},
    },
  });

  assert.ok(store.get(handle.id, 'chat-close-failed'));
});

test('AgentRuntime redacts secrets before trace and listener fan-out', async () => {
  class SecretDriver implements TurnDriver {
    readonly backend = 'catty' as const;
    async run(_input: TurnInput, ctx: TurnDriverContext): Promise<void> {
      ctx.emit({
        id: 'secret-result',
        type: 'tool_result',
        toolCallId: 'call-secret',
        toolName: 'terminal_execute',
        result: 'API_TOKEN=tok_live_1234567890',
      } as import('./types').AgentEvent);
    }
  }
  const traceStore = new TraceStore();
  const runtime = new AgentRuntime({ drivers: [new SecretDriver()], traceStore });
  const heard: string[] = [];
  runtime.subscribe(event => {
    if (event.type === 'tool_result') heard.push(event.result);
  });
  await runtime.runTurn({
    backend: 'catty',
    chatSessionId: 'chat-secret',
    sendScopeKey: 'chat-secret',
    userText: 'check',
    signal: new AbortController().signal,
    assistantMsgId: 'assistant-1',
    context: {
      activeProvider: undefined,
      activeModelId: '',
      scopeType: 'terminal',
      globalPermissionMode: 'confirm',
      terminalSessions: [],
      autoTitleSession: () => {},
    },
    maxIterations: 1,
    ui: {
      addMessageToSession: () => {}, updateLastMessage: () => {}, updateMessageById: () => {},
      reportStreamError: () => {}, setStreamingForScope: () => {},
    },
  });

  assert.doesNotMatch(JSON.stringify(traceStore.exportTrace('chat-secret')), /tok_live/);
  assert.doesNotMatch(JSON.stringify(traceStore.exportTrace('chat-secret')), /secret_token|swordfish/);
  assert.deepEqual(heard, ['API_TOKEN=[REDACTED]']);
});

test('AgentRuntime stopTurn delegates to active driver', async () => {
  const driver = new MockTurnDriver();
  const runtime = new AgentRuntime({ drivers: [driver] });
  await runtime.stopTurn('chat-2');
});

test('AgentRuntime delegates steering only while a compatible turn is active', async () => {
  let releaseRun: (() => void) | undefined;
  class SteeringDriver implements TurnDriver {
    readonly backend = 'catty' as const;
    async run(): Promise<void> {
      await new Promise<void>(resolve => { releaseRun = resolve; });
    }
    async steer() {
      return { status: 'accepted' as const, assistantMessageId: 'assistant-next' };
    }
  }
  const runtime = new AgentRuntime({ drivers: [new SteeringDriver()] });
  const run = runtime.runTurn({
    backend: 'catty',
    chatSessionId: 'chat-steer',
    sendScopeKey: 'chat-steer',
    userText: 'initial',
    signal: new AbortController().signal,
    currentSession: undefined,
    assistantMsgId: 'assistant-1',
    context: {
      activeProvider: undefined,
      activeModelId: '',
      scopeType: 'terminal',
      globalPermissionMode: 'confirm',
      terminalSessions: [],
      autoTitleSession: () => {},
    },
    maxIterations: 5,
    ui: {
      addMessageToSession: () => {},
      updateLastMessage: () => {},
      updateMessageById: () => {},
      reportStreamError: () => {},
      setStreamingForScope: () => {},
    },
  });
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.deepEqual(await runtime.steerTurn({
    chatSessionId: 'chat-steer',
    userMessageId: 'user-1',
    userText: 'change',
    prompt: 'change',
    attachedImages: [],
  }), { status: 'accepted', assistantMessageId: 'assistant-next' });

  releaseRun?.();
  await run;
  assert.deepEqual(await runtime.steerTurn({
    chatSessionId: 'chat-steer',
    userMessageId: 'user-2',
    userText: 'too late',
    prompt: 'too late',
    attachedImages: [],
  }), { status: 'inactive' });
});

test('AgentRuntime runTurn rejects a concurrent start for the same session', async () => {
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  class BusyMockDriver implements TurnDriver {
    readonly backend = 'catty' as const;
    readonly runs: TurnInput[] = [];

    async run(input: TurnInput): Promise<void> {
      this.runs.push(input);
      await firstGate;
    }

    abort(): void {}
  }

  const driver = new BusyMockDriver();
  const runtime = new AgentRuntime({ drivers: [driver], traceStore: new TraceStore() });
  const ui = {
    addMessageToSession: () => {},
    updateLastMessage: () => {},
    updateMessageById: () => {},
    reportStreamError: () => {},
    setStreamingForScope: () => {},
  };

  const first = runtime.runTurn({
    backend: 'catty',
    chatSessionId: 'chat-busy',
    sendScopeKey: 'scope',
    userText: 'one',
    signal: new AbortController().signal,
    currentSession: undefined,
    assistantMsgId: 'a1',
    context: {} as never,
    maxIterations: 1,
    bridge: null,
    ui,
  });

  await assert.rejects(
    () => runtime.runTurn({
      backend: 'catty',
      chatSessionId: 'chat-busy',
      sendScopeKey: 'scope',
      userText: 'two',
      signal: new AbortController().signal,
      currentSession: undefined,
      assistantMsgId: 'a2',
      context: {} as never,
      maxIterations: 1,
      bridge: null,
      ui,
    }),
    (err: unknown) => err instanceof Error
      && (err as Error & { code?: string }).code === 'AGENT_TURN_BUSY',
  );

  releaseFirst?.();
  await first;
  assert.equal(driver.runs.length, 1);
});
