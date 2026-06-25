import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRuntime } from './agentRuntime';
import { TraceStore } from './traceStore';
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

test('AgentRuntime stopTurn delegates to active driver', async () => {
  const driver = new MockTurnDriver();
  const runtime = new AgentRuntime({ drivers: [driver] });
  await runtime.stopTurn('chat-2');
});
