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

describe('processCattyStream rAF reasoning batching', () => {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: 1 },
  };

  function installControlledRaf(t: import('node:test').TestContext) {
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancelRaf = globalThis.cancelAnimationFrame;
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    let scheduledCount = 0;
    let cancelledCount = 0;

    globalThis.requestAnimationFrame = callback => {
      const id = nextId++;
      scheduledCount += 1;
      frames.set(id, callback);
      return id;
    };
    globalThis.cancelAnimationFrame = id => {
      if (frames.delete(id)) cancelledCount += 1;
    };

    t.after(() => {
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancelRaf;
    });

    return {
      flushFrames: () => {
        const pending = [...frames.entries()];
        frames.clear();
        for (const [, cb] of pending) cb(0);
        return pending.length;
      },
      getPendingCount: () => frames.size,
      getScheduledCount: () => scheduledCount,
      getCancelledCount: () => cancelledCount,
    };
  }

  it('coalesces rapid reasoning-delta chunks within a frame into one UI update', async t => {
    const raf = installControlledRaf(t);
    let controller!: ReadableStreamDefaultController<Record<string, unknown>>;
    const stream = new ReadableStream<Record<string, unknown>>({
      start(c) {
        controller = c;
      },
    });

    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: stream as unknown as ReadableStream<never> }),
    });

    const messages = new Map<string, ChatMessage>([
      ['assistant-1', { id: 'assistant-1', role: 'assistant', content: '', timestamp: 0 }],
    ]);
    let reasoningUpdateCalls = 0;

    const runPromise = processCattyStream({
      streamSessionId: 'session-1',
      model,
      systemPrompt: 'test',
      toolsBundle: { tools: {}, toolsContext: {} },
      sdkMessages: [{ role: 'user', content: 'think' }],
      signal: new AbortController().signal,
      currentAssistantMsgId: 'assistant-1',
      maxIterations: 1,
      runtimeContext: createInitialCattyRuntimeContext({
        chatSessionId: 'session-1',
        turnId: 'turn-1',
        permissionMode: 'auto',
        scopeType: 'terminal',
      }),
      ui: {
        addMessageToSession: (_sid, msg) => { messages.set(msg.id, msg); },
        updateMessageById: (_sid, id, updater) => {
          const prev = messages.get(id);
          if (!prev) return;
          const next = updater(prev);
          if (next.thinking !== prev.thinking) reasoningUpdateCalls += 1;
          messages.set(id, next);
        },
      },
    });

    controller.enqueue({ type: 'stream-start', warnings: [] });
    controller.enqueue({
      type: 'reasoning-start',
      id: 'r1',
      providerMetadata: { openai: { itemId: 'rs_1' } },
    });
    for (let i = 0; i < 20; i += 1) {
      controller.enqueue({
        type: 'reasoning-delta',
        id: 'r1',
        delta: `tok${i} `,
        providerMetadata: { openai: { itemId: 'rs_1' } },
      });
    }

    // Give the reader loop microtasks to drain all 20 chunks before the frame fires.
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(reasoningUpdateCalls, 0, 'reasoning chunks must be buffered until rAF');
    assert.equal(raf.getPendingCount(), 1, 'multiple chunks must share a single rAF');

    raf.flushFrames();
    assert.equal(reasoningUpdateCalls, 1, 'all 20 reasoning deltas must flush in one UI update');
    const expectedThinking = Array.from({ length: 20 }, (_, i) => `tok${i} `).join('');
    assert.equal(messages.get('assistant-1')?.thinking, expectedThinking);
    assert.equal(
      messages.get('assistant-1')?.providerContinuation?.reasoningParts?.length,
      1,
      'coalesced reasoning deltas with identical metadata must merge into one reasoningPart',
    );

    controller.enqueue({
      type: 'reasoning-end',
      id: 'r1',
      providerMetadata: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc-xyz' } },
    });
    controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage });
    controller.close();
    await runPromise;

    assert.equal(
      messages.get('assistant-1')?.providerContinuation?.reasoningParts?.at(-1)?.providerOptions?.openai
        ?.reasoningEncryptedContent,
      'enc-xyz',
    );
    assert.equal(raf.getPendingCount(), 0);
  });

  it('coalesces rapid OpenAI raw reasoning_content chunks within a frame into one UI update', async t => {
    const raf = installControlledRaf(t);
    let controller!: ReadableStreamDefaultController<Record<string, unknown>>;
    const stream = new ReadableStream<Record<string, unknown>>({
      start(c) {
        controller = c;
      },
    });

    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: stream as unknown as ReadableStream<never> }),
    });

    const messages = new Map<string, ChatMessage>([
      ['assistant-1', { id: 'assistant-1', role: 'assistant', content: '', timestamp: 0 }],
    ]);
    let reasoningUpdateCalls = 0;

    const runPromise = processCattyStream({
      streamSessionId: 'session-1',
      model,
      systemPrompt: 'test',
      toolsBundle: { tools: {}, toolsContext: {} },
      sdkMessages: [{ role: 'user', content: 'think' }],
      signal: new AbortController().signal,
      currentAssistantMsgId: 'assistant-1',
      maxIterations: 1,
      runtimeContext: createInitialCattyRuntimeContext({
        chatSessionId: 'session-1',
        turnId: 'turn-1',
        permissionMode: 'auto',
        scopeType: 'terminal',
      }),
      ui: {
        addMessageToSession: (_sid, msg) => { messages.set(msg.id, msg); },
        updateMessageById: (_sid, id, updater) => {
          const prev = messages.get(id);
          if (!prev) return;
          const next = updater(prev);
          if (next.thinking !== prev.thinking) reasoningUpdateCalls += 1;
          messages.set(id, next);
        },
      },
    });

    controller.enqueue({ type: 'stream-start', warnings: [] });
    for (let i = 0; i < 15; i += 1) {
      controller.enqueue({
        type: 'raw',
        rawValue: { choices: [{ delta: { reasoning_content: `r${i}-` } }] },
      });
    }

    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(reasoningUpdateCalls, 0, 'raw reasoning chunks must be buffered until rAF');
    assert.equal(raf.getPendingCount(), 1);

    raf.flushFrames();
    assert.equal(reasoningUpdateCalls, 1, 'all 15 raw reasoning chunks must flush in one UI update');
    const expected = Array.from({ length: 15 }, (_, i) => `r${i}-`).join('');
    assert.equal(messages.get('assistant-1')?.thinking, expected);
    assert.equal(
      messages.get('assistant-1')?.providerContinuation?.openAIChatAssistantFields?.reasoning_content,
      expected,
    );
    assert.equal(
      messages.get('assistant-1')?.providerContinuation?.reasoningParts?.map(p => p.text).join(''),
      expected,
    );

    controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage });
    controller.close();
    await runPromise;
    assert.equal(raf.getPendingCount(), 0);
  });

  it('flushes buffered reasoning strictly before reasoning-end ciphertext, text-delta, tool-call, and finish', async t => {
    const raf = installControlledRaf(t);
    let step = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        step += 1;
        if (step === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                { type: 'reasoning-start', id: 'r1', providerMetadata: { openai: { itemId: 'rs_1' } } },
                { type: 'reasoning-delta', id: 'r1', delta: 'step1-', providerMetadata: { openai: { itemId: 'rs_1' } } },
                { type: 'reasoning-delta', id: 'r1', delta: 'plan', providerMetadata: { openai: { itemId: 'rs_1' } } },
                {
                  type: 'reasoning-end',
                  id: 'r1',
                  providerMetadata: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc-step1' } },
                },
                { type: 'tool-call', toolCallId: 'tc-1', toolName: 'ping', input: '{}' },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'reasoning-start', id: 'r2' },
              { type: 'reasoning-delta', id: 'r2', delta: 'step2-' },
              { type: 'reasoning-delta', id: 'r2', delta: 'verify' },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'Final answer' },
              { type: 'text-end', id: 't1' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
            ],
          }),
        };
      },
    });

    const messages: ChatMessage[] = [
      { id: 'assistant-1', role: 'assistant', content: '', timestamp: 0 },
    ];
    const events: string[] = [];

    await processCattyStream({
      streamSessionId: 'session-1',
      model,
      systemPrompt: 'test',
      toolsBundle: {
        tools: {
          ping: tool({
            inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
            execute: async () => ({ ok: true }),
          }),
        } as unknown as CattyToolsBundle['tools'],
        toolsContext: {},
      },
      sdkMessages: [{ role: 'user', content: 'run' }],
      signal: new AbortController().signal,
      currentAssistantMsgId: 'assistant-1',
      maxIterations: 2,
      runtimeContext: createInitialCattyRuntimeContext({
        chatSessionId: 'session-1',
        turnId: 'turn-1',
        permissionMode: 'auto',
        scopeType: 'terminal',
      }),
      ui: {
        addMessageToSession: (_sid, msg) => {
          messages.push(msg);
          events.push(`add:${msg.role}`);
        },
        updateMessageById: (_sid, id, updater) => {
          const index = messages.findIndex(m => m.id === id);
          if (index < 0) return;
          const prev = messages[index];
          const next = updater(prev);
          messages[index] = next;
          if (next.thinking !== prev.thinking) events.push(`thinking:${next.thinking}`);
          if (
            next.providerContinuation?.reasoningParts?.at(-1)?.providerOptions?.openai?.reasoningEncryptedContent
            && !prev.providerContinuation?.reasoningParts?.at(-1)?.providerOptions?.openai?.reasoningEncryptedContent
          ) {
            events.push('encrypted');
          }
          if ((next.toolCalls?.length ?? 0) > (prev.toolCalls?.length ?? 0)) events.push('tool-call');
          if (next.content !== prev.content) events.push(`text:${next.content}`);
          if (next.usage && !prev.usage) events.push('usage');
        },
      },
    });

    // Note: controlled rAF was NEVER manually flushed — every boundary flushed synchronously in strict order!
    assert.deepEqual(events, [
      'thinking:step1-plan',
      'encrypted',
      'tool-call',
      'add:tool',
      'add:assistant',
      'thinking:step2-verify',
      'text:Final answer',
      'usage',
    ]);
    assert.equal(
      messages[0].providerContinuation?.reasoningParts?.at(-1)?.providerOptions?.openai?.reasoningEncryptedContent,
      'enc-step1',
    );
    assert.equal(messages.at(-1)?.thinking, 'step2-verify');
    assert.equal(messages.at(-1)?.content, 'Final answer');
    assert.equal(raf.getPendingCount(), 0);
  });

  it('flushes buffered reasoning and cancels pending rAF on stream error', async t => {
    const raf = installControlledRaf(t);
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'reasoning-start', id: 'r1' },
            { type: 'reasoning-delta', id: 'r1', delta: 'partial ' },
            { type: 'reasoning-delta', id: 'r1', delta: 'thought' },
            { type: 'error', error: new Error('upstream 502') },
          ],
        }),
      }),
    });

    const messages: ChatMessage[] = [
      { id: 'assistant-1', role: 'assistant', content: '', timestamp: 0 },
    ];

    await processCattyStream({
      streamSessionId: 'session-1',
      model,
      systemPrompt: 'test',
      toolsBundle: { tools: {}, toolsContext: {} },
      sdkMessages: [{ role: 'user', content: 'err' }],
      signal: new AbortController().signal,
      currentAssistantMsgId: 'assistant-1',
      maxIterations: 1,
      runtimeContext: createInitialCattyRuntimeContext({
        chatSessionId: 'session-1',
        turnId: 'turn-1',
        permissionMode: 'auto',
        scopeType: 'terminal',
      }),
      ui: {
        addMessageToSession: (_sid, msg) => { messages.push(msg); },
        updateMessageById: (_sid, id, updater) => {
          const index = messages.findIndex(m => m.id === id);
          if (index >= 0) messages[index] = updater(messages[index]);
        },
      },
    });

    assert.equal(messages[0].thinking, 'partial thought');
    assert.ok(messages.at(-1)?.errorInfo, 'error message should be appended after reasoning flush');
    assert.equal(raf.getPendingCount(), 0);
    assert.ok(raf.getCancelledCount() >= 1);
  });
});
