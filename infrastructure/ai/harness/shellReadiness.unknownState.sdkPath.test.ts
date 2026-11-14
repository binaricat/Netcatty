import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCattyToolsFromCatalog,
  withCattyToolContext,
} from './capabilityTools';
import { mapCattyStreamChunkToAgentEvents } from './agentEventAdapter';
import { AgentRuntime } from './agentRuntime';
import { SessionStateStore } from './sessionState';
import type { AgentEvent } from './types';
import type { TurnDriver, TurnDriverContext, TurnInput } from './turnDrivers/types';

// Reuse the #4198 fixture (infrastructure/ai/cattyAgent/
// shellReadiness.unknownState.test.ts) verbatim so the MCP path, the executor
// path and the ACTIVE Catty SDK path are asserted against the same honest,
// actionable hint.
const UNKNOWN_HINT = [
  'Shell readiness unknown (SHELL_READINESS_UNKNOWN): the terminal connection is',
  'alive but the prompt could not be recognized. The command was NOT sent — never',
  'blind-type. Read-only next steps: call get_environment or terminal_read_context,',
  're-check after the user presses Enter, reuse another idle session, or ask the',
  'user to confirm the prompt before retrying.',
].join(' ');

const BUSY_HINT = 'Shell prompt is not ready; no command was sent';
const UNKNOWN_CODE = 'SHELL_READINESS_UNKNOWN';
const CHAT = 'chat-readiness';

function bundle(result: Record<string, unknown>) {
  return createCattyToolsFromCatalog(
    { aiExec: async () => result } as never,
    {
      sessions: [{
        sessionId: 's1',
        hostId: 'h1',
        hostname: 'host',
        label: 'tab',
        protocol: 'ssh',
        connected: true,
      }],
    } as never,
    [],
    'auto',
    undefined,
    CHAT,
  );
}

async function executeTerminal(result: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { tools, toolsContext } = bundle(result);
  const execute = withCattyToolContext(
    tools.terminal_execute as unknown as { execute: (...args: never[]) => unknown },
    toolsContext.terminal_execute,
    'call-1',
  );
  return await execute.execute({ sessionId: 's1', command: 'echo OK' } as never) as unknown as Record<string, unknown>;
}

function unknownResult(): Record<string, unknown> {
  return {
    ok: false, error: UNKNOWN_HINT, code: UNKNOWN_CODE,
    stdout: '', stderr: '', exitCode: -1,
  };
}

function busyResult(): Record<string, unknown> {
  return {
    ok: false, error: BUSY_HINT, code: 'SHELL_NOT_READY',
    stdout: '', stderr: '', exitCode: -1,
  };
}

function toCattyToolResultEvent(output: Record<string, unknown>): AgentEvent {
  const events = mapCattyStreamChunkToAgentEvents(
    { type: 'tool-result', toolCallId: 'call-1', toolName: 'terminal_execute', output },
    { sessionId: CHAT, chatSessionId: CHAT },
  );
  assert.equal(events.length, 1);
  return events[0];
}

// Drive a real AgentRuntime turn with the given tool-result event, then read
// back whether SessionStateStore registered an open-session blocker. This
// exercises agentRuntime.ts:188 (event.isError || isFailedToolResult(result)),
// the exact place the old { error: ... } wrapping bricked the session.
async function reinjectionFor(output: Record<string, unknown>): Promise<string | undefined> {
  const toolResultEvent = toCattyToolResultEvent(output);
  const sessionStateStore = new SessionStateStore();
  const driver: TurnDriver = {
    backend: 'catty',
    async run(_input: TurnInput, ctx: TurnDriverContext): Promise<void> {
      ctx.emit({
        id: 'call',
        type: 'tool_call',
        toolCallId: 'call-1',
        toolName: 'terminal_execute',
        args: { sessionId: 's1', command: 'echo OK' },
      } as unknown as AgentEvent);
      ctx.emit({ ...toolResultEvent, id: 'result' } as unknown as AgentEvent);
    },
  };
  const runtime = new AgentRuntime({ drivers: [driver], sessionStateStore });
  await runtime.runTurn({
    backend: 'catty',
    chatSessionId: CHAT,
    sendScopeKey: CHAT,
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
  } as unknown as TurnInput);
  return sessionStateStore.toReinjectionText(CHAT);
}

describe('active Catty SDK path surfaces SHELL_READINESS_UNKNOWN as non-fatal (#4198 round 2)', () => {
  it('capabilityTools preserves the code + honest hint and emits NO error shape', async () => {
    const result = await executeTerminal(unknownResult());
    assert.equal(result.code, UNKNOWN_CODE);
    assert.equal('error' in result, false);
    assert.notEqual(result.ok, false);
    const text = JSON.stringify(result);
    assert.match(text, /read-only|get_environment|terminal_read_context/);
    assert.match(text, /NOT sent/i);
    const content = result.content as Array<{ type: string; text: string }> | undefined;
    assert.equal(content?.[0]?.text, UNKNOWN_HINT);
  });

  it('unknown => agentEventAdapter emits NO isError; SHELL_NOT_READY => still isError true', async () => {
    const unknownEvent = toCattyToolResultEvent(await executeTerminal(unknownResult()));
    assert.equal((unknownEvent as { isError?: boolean }).isError, false);
    const busyEvent = toCattyToolResultEvent(await executeTerminal(busyResult()));
    assert.equal((busyEvent as { isError?: boolean }).isError, true);
  });

  it('unknown registers NO open-session blocker; busy still registers one', async () => {
    const unknownText = await reinjectionFor(await executeTerminal(unknownResult()));
    assert.doesNotMatch(unknownText ?? '', /Open blockers/);
    const busyText = await reinjectionFor(await executeTerminal(busyResult()));
    assert.match(busyText ?? '', /Open blockers/);
  });

  it('defense-in-depth: a code-carrying error-shaped result stays non-error', async () => {
    // Even if a future change re-adds an `error` field, the preserved `code`
    // must keep it out of isError / the session blocker (classification guards).
    const errorShaped = { error: UNKNOWN_HINT, code: UNKNOWN_CODE };
    const event = toCattyToolResultEvent(errorShaped);
    assert.equal((event as { isError?: boolean }).isError, false);
    const text = await reinjectionFor(errorShaped);
    assert.doesNotMatch(text ?? '', /Open blockers/);
  });

  it('a proven-busy error-shaped result without the unknown code is still a hard error', async () => {
    const busyShaped = { error: BUSY_HINT, ok: false };
    const event = toCattyToolResultEvent(busyShaped);
    assert.equal((event as { isError?: boolean }).isError, true);
    const text = await reinjectionFor(busyShaped);
    assert.match(text ?? '', /Open blockers/);
  });
});
