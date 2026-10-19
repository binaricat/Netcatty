import assert from 'node:assert/strict';
import test from 'node:test';
import { CattyTurnDriver } from './turnDrivers/cattyTurnDriver';
import { ToolOutputStore } from './toolOutputStore';
import { ToolResultDedup } from './toolResultDedup';
import { SessionStateStore } from './sessionState';
import type { CattyTurnInput, TurnDriverContext } from './turnDrivers/types';
import type { AgentEvent } from './types';
import type { AISession, ChatMessage, ProviderConfig } from '../types';

interface WireMessage {
  role: string;
  content: unknown;
}

interface WireRequest {
  messages: WireMessage[];
  tools?: unknown[];
  system?: Array<{ type: string; text: string; cache_control?: unknown }>;
}

type Reply = { tool: 'terminal_execute' | 'sftp_read_file' } | { text: string };

function fixture(t: test.TestContext, replies: Reply[], style: 'openai' | 'anthropic' = 'openai', terminalOutput = 'small output') {
  const originalWindow = globalThis.window;
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancelRaf = globalThis.cancelAnimationFrame;
  t.after(() => {
    globalThis.window = originalWindow;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancelRaf;
  });
  globalThis.requestAnimationFrame = callback => setTimeout(() => callback(0), 0) as unknown as number;
  globalThis.cancelAnimationFrame = id => clearTimeout(id);

  const requests: WireRequest[] = [];
  const urls: string[] = [];
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [];
  const data = new Map<string, (value: string) => void>();
  const end = new Map<string, () => void>();
  const bridge = {
    aiSetChatSessionCancelled: async () => ({ ok: true }),
    aiMcpUpdateSessions: async () => undefined,
    aiExec: async () => ({ ok: true, stdout: terminalOutput, stderr: '', exitCode: 0 }),
    aiCapability: async (_method: string, params: Record<string, unknown>) => ({
      ok: true,
      path: params.path,
      content: Array.from({ length: 2000 }, (_, i) => `log ${i}: synthetic ${String(params.path)}`).join('\n'),
    }),
    onAiStreamData: (id: string, callback: (value: string) => void) => {
      data.set(id, callback);
      return () => { data.delete(id); };
    },
    onAiStreamEnd: (id: string, callback: () => void) => {
      end.set(id, callback);
      return () => { end.delete(id); };
    },
    onAiStreamError: () => () => undefined,
    aiChatCancel: async () => true,
    aiChatStream: async (id: string, url: string, _headers: Record<string, string>, body: string) => {
      urls.push(url);
      requests.push(JSON.parse(body) as WireRequest);
      const reply = replies[requests.length - 1];
      assert.ok(reply, 'unexpected model request');
      const send = (chunk: unknown) => data.get(id)?.(JSON.stringify(chunk));
      if (style === 'anthropic') {
        send({ type: 'message_start', message: {
          id: `response-${requests.length}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
        } });
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } });
        send({ type: 'content_block_stop', index: 0 });
        send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
        send({ type: 'message_stop' });
      } else {
        const toolReply = 'tool' in reply;
        const delta = toolReply ? {
          role: 'assistant',
          tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: {
            name: reply.tool,
            arguments: JSON.stringify(reply.tool === 'terminal_execute'
              ? { sessionId: 'terminal-1', command: `printf audit-${requests.length}` }
              : { sessionId: 'terminal-1', path: `/fixture/log-${requests.length}` }),
          } }],
        } : { role: 'assistant', content: reply.text };
        send({ id: 'response', object: 'chat.completion.chunk', created: 0, model: 'test-model',
          choices: [{ index: 0, delta, finish_reason: null }] });
        send({ id: 'response', object: 'chat.completion.chunk', created: 0, model: 'test-model',
          choices: [{ index: 0, delta: {}, finish_reason: toolReply ? 'tool_calls' : 'stop' }] });
        send({ id: 'response', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [],
          usage: { prompt_tokens: 1000, completion_tokens: 1, total_tokens: 1001,
            prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 } });
        data.get(id)?.('[DONE]');
      }
      end.get(id)?.();
      return { ok: true, statusCode: 200 };
    },
  };
  globalThis.window = { netcatty: bridge } as unknown as Window & typeof globalThis;
  const store = new ToolOutputStore();
  const dedup = new ToolResultDedup();
  const state = new SessionStateStore();
  const provider: ProviderConfig = {
    id: 'fixture', providerId: 'custom', name: 'Fixture', enabled: true, style,
    defaultModel: style === 'anthropic' ? 'claude-sonnet-4-5' : 'test-model',
    baseURL: style === 'anthropic' ? 'https://api.anthropic.com' : 'https://provider.example.test/v1', apiKey: 'not-a-real-key',
  };
  let turnNumber = 0;
  return {
    requests, urls, events, messages, provider,
    async turn(maxIterations = 1) {
      turnNumber += 1;
      const history = structuredClone(messages);
      const userText = `Audit round ${turnNumber}`;
      const assistantId = `assistant-${turnNumber}`;
      messages.push({ id: `user-${turnNumber}`, role: 'user', content: userText, timestamp: turnNumber },
        { id: assistantId, role: 'assistant', content: '', timestamp: turnNumber });
      const currentSession: AISession = {
        id: 'chat-1', title: 'Fixture', agentId: 'catty', scope: { type: 'terminal', targetId: 'terminal-1' },
        createdAt: 0, updatedAt: turnNumber, messages: history,
      };
      const signal = new AbortController().signal;
      const input: CattyTurnInput = {
        backend: 'catty', chatSessionId: 'chat-1', sendScopeKey: 'chat-1', userText, signal,
        currentSession, assistantMsgId: assistantId, maxIterations, bridge,
        context: {
          activeProvider: provider, activeModelId: provider.defaultModel!, scopeType: 'terminal', scopeLabel: 'Fixture',
          globalPermissionMode: 'auto', commandBlocklist: [], autoTitleSession: () => undefined,
          terminalSessions: [{ sessionId: 'terminal-1', hostname: 'fixture.example.test', label: 'Fixture', connected: true }],
        },
        ui: {
          addMessageToSession: (_session, message) => { messages.push(message); },
          updateMessageById: (_session, id, update) => {
            const index = messages.findIndex(message => message.id === id);
            if (index >= 0) messages[index] = update(messages[index]);
          },
          updateLastMessage: () => undefined,
          reportStreamError: (_session, _signal, error) => { throw error; },
          setStreamingForScope: () => undefined,
        },
      };
      const context: TurnDriverContext = {
        turnId: `turn-${turnNumber}`, chatSessionId: 'chat-1', sessionId: 'chat-1', backend: 'catty', signal,
        emit: event => { events.push({
          ...event, sessionId: 'chat-1', chatSessionId: 'chat-1', backend: 'catty', timestamp: Date.now(),
        } as AgentEvent); }, toolOutputStore: store, toolResultDedup: dedup, sessionStateStore: state,
      };
      dedup.beginTurn();
      await new CattyTurnDriver().run(input, context);
    },
  };
}

function assertRequestPrefix(previous: WireRequest, next: WireRequest) {
  assert.deepEqual(next.messages.slice(0, previous.messages.length), previous.messages,
    'already-sent conversation must remain an exact prefix');
  assert.deepEqual(next.tools, previous.tools);
}

test('Catty preserves the request prefix across six ordinary turns', async t => {
  const f = fixture(t, Array.from({ length: 6 }, () => ({ text: 'OK' })));
  for (let i = 0; i < 6; i += 1) await f.turn();
  assert.equal(f.requests.length, 6);
  for (let i = 1; i < f.requests.length; i += 1) assertRequestPrefix(f.requests[i - 1], f.requests[i]);
});

test('Catty replays completed small commands without rewriting their results', async t => {
  const f = fixture(t, Array.from({ length: 6 }, () => [
    { tool: 'terminal_execute' as const }, { text: 'OK' },
  ]).flat());
  for (let i = 0; i < 6; i += 1) await f.turn(2);
  assert.equal(f.requests.length, 12);
  for (let i = 1; i < f.requests.length; i += 1) assertRequestPrefix(f.requests[i - 1], f.requests[i]);
  assert.equal(f.messages.at(-1)?.usage?.cachedInputTokens, 1800, 'usage includes both model steps');
  assert.doesNotMatch(JSON.stringify(f.requests), /cache_control/, 'OpenAI-compatible requests use implicit caching');
});

test('Catty keeps large-output handles without replacing the conversation prefix', async t => {
  const f = fixture(t, [{ tool: 'sftp_read_file' }, { tool: 'sftp_read_file' }, { text: 'OK' }]);
  await f.turn(3);
  assert.equal(f.requests.length, 3);
  for (let i = 1; i < f.requests.length; i += 1) assertRequestPrefix(f.requests[i - 1], f.requests[i]);
  assert.match(JSON.stringify(f.requests.at(-1)), /tool output handle:/);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /Tool output handles available/);
});

test('Catty preserves large-output history across consecutive user turns', async t => {
  const f = fixture(t, Array.from({ length: 6 }, () => [
    { tool: 'sftp_read_file' as const }, { text: 'OK' },
  ]).flat());
  for (let i = 0; i < 6; i += 1) await f.turn(2);
  assert.equal(f.requests.length, 12);
  for (let i = 1; i < f.requests.length; i += 1) assertRequestPrefix(f.requests[i - 1], f.requests[i]);
});

test('Catty preserves large terminal results across consecutive user turns', async t => {
  const f = fixture(t, Array.from({ length: 6 }, () => [
    { tool: 'terminal_execute' as const }, { text: 'OK' },
  ]).flat(), 'openai', Array.from({ length: 14000 }, (_, i) => `synthetic log record ${i}`).join('\n'));
  for (let i = 0; i < 6; i += 1) await f.turn(2);
  assert.equal(f.requests.length, 12);
  for (let i = 1; i < f.requests.length; i += 1) assertRequestPrefix(f.requests[i - 1], f.requests[i]);
});

test('Catty keeps DeepSeek cache reads in trace and persisted assistant usage', async t => {
  const f = fixture(t, [{ text: 'OK' }]);
  await f.turn();
  const event = f.events.find(event => event.type === 'usage');
  assert.ok(event?.type === 'usage');
  assert.equal(event.cachedPromptTokens, 900);
  assert.equal(f.messages.at(-1)?.usage?.cachedInputTokens, 900);
});

test('Catty marks a stable Claude system block and the conversation tail for caching', async t => {
  const f = fixture(t, [{ text: 'OK' }], 'anthropic');
  await f.turn();
  const system = f.requests[0].system!;
  assert.ok(system.length >= 2, 'static and dynamic system context need separate boundaries');
  assert.deepEqual(system[0].cache_control, { type: 'ephemeral' });
  assert.doesNotMatch(system[0].text, /## Current Scope/);
  assert.match(system[1].text, /## Current Scope/);
  assert.match(JSON.stringify(f.requests[0].messages.at(-1)), /cache_control/);
  const event = f.events.find(event => event.type === 'usage');
  assert.ok(event?.type === 'usage');
  assert.equal(event.cachedPromptTokens, 900);
  assert.equal(f.messages.at(-1)?.usage?.cachedInputTokens, 900);
});

test('Catty does not send vendor cache extensions to an Anthropic-compatible gateway', async t => {
  const f = fixture(t, [{ text: 'OK' }], 'anthropic');
  f.provider.baseURL = 'https://gateway.example.test/anthropic';
  await f.turn();
  assert.equal(f.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(f.requests), /cache_control/);
  assert.equal(f.messages.at(-1)?.content, 'OK');
});

for (const providerId of ['openrouter', 'ollama'] as const) {
  test(`Catty respects the ${providerId} endpoint fallback with Anthropic format`, async t => {
    const f = fixture(t, [{ text: 'OK' }], 'anthropic');
    f.provider.providerId = providerId;
    f.provider.baseURL = '';
    await f.turn();
    assert.match(f.urls[0], providerId === 'openrouter' ? /^https:\/\/openrouter\.ai\// : /^http:\/\/localhost:11434\//);
    assert.doesNotMatch(JSON.stringify(f.requests), /cache_control/);
    assert.equal(f.messages.at(-1)?.content, 'OK');
  });
}
