import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jsonSchema, tool } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { processCattyStream, shouldEmitAgentEventsForStreamChunk } from './turnDrivers/cattyStreamProcessor';
import type { CattyToolsBundle } from './capabilityTools';
import { createInitialCattyRuntimeContext } from './cattyRuntimeContext';
import type { ChatMessage } from '../types';

describe('shouldEmitAgentEventsForStreamChunk', () => {
  it('suppresses trace events for SDK internal stream-state errors', () => {
    assert.equal(
      shouldEmitAgentEventsForStreamChunk({
        type: 'error',
        error: new Error('reasoning part abc not found'),
      }),
      false,
    );
  });

  it('still emits trace events for real stream errors', () => {
    assert.equal(
      shouldEmitAgentEventsForStreamChunk({
        type: 'error',
        error: new Error('Provider returned HTTP 500'),
      }),
      true,
    );
    assert.equal(
      shouldEmitAgentEventsForStreamChunk({ type: 'text-delta', text: 'hi' }),
      true,
    );
  });
});

describe('processCattyStream reasoning continuation', () => {
  it('persists reasoning encrypted content delivered on reasoning-end', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'reasoning-start',
              id: 'r1',
              providerMetadata: { openai: { itemId: 'rs_1' } },
            },
            {
              type: 'reasoning-delta',
              id: 'r1',
              delta: 'thinking',
              providerMetadata: { openai: { itemId: 'rs_1' } },
            },
            {
              type: 'reasoning-end',
              id: 'r1',
              providerMetadata: {
                openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc-abc' },
              },
            },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            },
          ],
        }),
      }),
    });

    const messages = new Map<string, ChatMessage>();
    messages.set('assistant-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      timestamp: 0,
    });
    const ui = {
      addMessageToSession: (sessionId: string, message: ChatMessage) => {
        messages.set(message.id, message);
      },
      updateMessageById: (sessionId: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => {
        const message = messages.get(messageId);
        if (message) messages.set(messageId, updater(message));
      },
    };

    await processCattyStream({
      streamSessionId: 'session-1',
      model,
      systemPrompt: 'test',
      toolsBundle: { tools: {}, toolsContext: {} },
      sdkMessages: [{ role: 'user', content: 'hello' }],
      signal: new AbortController().signal,
      currentAssistantMsgId: 'assistant-1',
      maxIterations: 1,
      runtimeContext: createInitialCattyRuntimeContext({
        chatSessionId: 'session-1',
        turnId: 'turn-1',
        permissionMode: 'auto',
        scopeType: 'terminal',
      }),
      ui,
    });

    const continuation = messages.get('assistant-1')?.providerContinuation;
    const encryptedContent = continuation?.reasoningParts?.at(-1)?.providerOptions?.openai
      ?.reasoningEncryptedContent;
    assert.equal(encryptedContent, 'enc-abc');
    assert.match(continuation?.reasoningParts?.map(part => part.text).join('') ?? '', /thinking/);
  });
});

describe('processCattyStream iteration limit', () => {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };

  async function run(t: import('node:test').TestContext, replies: ('poll' | 'summary')[], maxIterations: number) {
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancelRaf = globalThis.cancelAnimationFrame;
    t.after(() => {
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancelRaf;
    });
    globalThis.requestAnimationFrame = callback => setTimeout(() => callback(0), 0) as unknown as number;
    globalThis.cancelAnimationFrame = id => clearTimeout(id);

    const messages: ChatMessage[] = [{ id: 'assistant-1', role: 'assistant', content: '', timestamp: 0 }];
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const reply = replies[calls++];
        assert.ok(reply, 'unexpected extra model step');
        return {
          stream: simulateReadableStream({ chunks: [
            { type: 'stream-start', warnings: [] },
            ...(reply === 'poll' ? [{
              type: 'tool-call' as const,
              toolCallId: `poll-${calls}`,
              toolName: 'terminal_poll',
              input: '{"jobId":"job-1"}',
            }] : [
              { type: 'text-start' as const, id: 'summary' },
              { type: 'text-delta' as const, id: 'summary', delta: 'The job completed.' },
              { type: 'text-end' as const, id: 'summary' },
            ]),
            { type: 'finish', finishReason: { unified: reply === 'poll' ? 'tool-calls' : 'stop', raw: undefined }, usage },
          ] }),
        };
      },
    });
    await processCattyStream({
      streamSessionId: 'session-1', model, systemPrompt: 'test',
      toolsBundle: {
        tools: {
          terminal_poll: tool({
            inputSchema: jsonSchema<{ jobId: string }>({
              type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'],
            }),
            execute: async ({ jobId }) => ({ jobId, status: 'running', output: 'buffered output' }),
          }),
        } as unknown as CattyToolsBundle['tools'],
        toolsContext: {},
      },
      sdkMessages: [{ role: 'user', content: 'Check the job' }],
      signal: new AbortController().signal,
      currentAssistantMsgId: 'assistant-1', maxIterations,
      runtimeContext: createInitialCattyRuntimeContext({
        chatSessionId: 'session-1', turnId: 'turn-1', permissionMode: 'auto', scopeType: 'terminal',
      }),
      ui: {
        addMessageToSession: (sessionId, message) => {
          assert.equal(sessionId, 'session-1');
          messages.push(message);
        },
        updateMessageById: (_sessionId, id, updater) => {
          const index = messages.findIndex(message => message.id === id);
          if (index >= 0) messages[index] = updater(messages[index]);
        },
      },
    });
    return { messages, calls };
  }

  it('adds a non-error assistant notice after terminal_poll exhausts the step cap', async t => {
    const { messages, calls } = await run(t, ['poll', 'poll'], 2);
    assert.equal(calls, 2);
    assert.equal(messages.at(-2)?.role, 'tool');
    assert.match(messages.at(-2)?.toolResults?.[0].content ?? '', /job-1/);
    const notice = messages.at(-1)!;
    assert.equal(notice.role, 'assistant');
    assert.equal(notice.iterationLimit, 2);
    assert.equal(notice.errorInfo, undefined);
  });

  for (const [name, replies, maxIterations] of [
    ['natural stop before the cap', ['summary'], 2],
    ['natural stop on the last allowed step', ['summary'], 1],
    ['post-tool summary on the last allowed step', ['poll', 'summary'], 2],
  ] as const) {
    it(`does not add a limit notice for ${name}`, async t => {
      const { messages } = await run(t, [...replies], maxIterations);
      assert.equal(messages.at(-1)?.content, 'The job completed.');
      assert.ok(messages.every(message => message.iterationLimit === undefined));
    });
  }
});
