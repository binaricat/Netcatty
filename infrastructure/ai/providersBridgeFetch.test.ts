import assert from 'node:assert/strict';
import test from 'node:test';
import { stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';
import { createBridgeFetchForSDK, createModelFromConfig } from './sdk/providers';
import type { OpenAIChatAssistantFields } from './providerContinuation';

test('captures OpenAI-compatible reasoning_content before the tool follow-up request', async (t) => {
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
  t.after(() => {
    (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
  });

  const dataHandlers = new Map<string, (data: string) => void>();
  const endHandlers = new Map<string, () => void>();
  const sentBodies: Array<Record<string, unknown>> = [];
  const assistantFields: Array<OpenAIChatAssistantFields | undefined> = [];

  const toolCall = {
    id: 'call_1',
    type: 'function',
    function: { name: 'terminal_exec', arguments: '{}' },
  };

  (globalThis as typeof globalThis & { window?: unknown }).window = {
    netcatty: {
      aiFetch: async () => ({ ok: true, status: 200, data: '{}' }),
      aiChatCancel: async () => true,
      onAiStreamData: (requestId: string, cb: (data: string) => void) => {
        dataHandlers.set(requestId, cb);
        return () => dataHandlers.delete(requestId);
      },
      onAiStreamEnd: (requestId: string, cb: () => void) => {
        endHandlers.set(requestId, cb);
        return () => endHandlers.delete(requestId);
      },
      onAiStreamError: () => () => undefined,
      aiChatStream: async (
        requestId: string,
        _url: string,
        _headers: Record<string, string>,
        body: string,
      ) => {
        sentBodies.push(JSON.parse(body));
        if (sentBodies.length === 1) {
          const emit = dataHandlers.get(requestId);
          assert.ok(emit, 'stream data handler should be registered before aiChatStream starts');
          emit(JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'need shell ' } }] }));
          emit(JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'context' } }] }));
          emit(JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [toolCall] } }] }));
        }
        endHandlers.get(requestId)?.();
        return { ok: true, statusCode: 200, statusText: 'OK' };
      },
    },
  };

  const fetch = createBridgeFetchForSDK('deepseek-custom', {
    getOpenAIChatAssistantFields: () => assistantFields,
  });

  await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      stream: true,
      messages: [{ role: 'user', content: 'inspect the host' }],
    }),
  });

  await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      stream: true,
      messages: [
        { role: 'user', content: 'inspect the host' },
        { role: 'assistant', content: '', tool_calls: [toolCall] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      ],
    }),
  });

  const followUpBody = sentBodies[1];
  const messages = followUpBody.messages as Array<Record<string, unknown>>;
  assert.equal(messages[1].reasoning_content, 'need shell context');
});

test('does not duplicate reasoning_content when tool calls stream across chunks', async (t) => {
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
  t.after(() => {
    (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
  });

  const dataHandlers = new Map<string, (data: string) => void>();
  const endHandlers = new Map<string, () => void>();
  const sentBodies: Array<Record<string, unknown>> = [];
  const assistantFields: Array<OpenAIChatAssistantFields | undefined> = [];

  (globalThis as typeof globalThis & { window?: unknown }).window = {
    netcatty: {
      aiFetch: async () => ({ ok: true, status: 200, data: '{}' }),
      aiChatCancel: async () => true,
      onAiStreamData: (requestId: string, cb: (data: string) => void) => {
        dataHandlers.set(requestId, cb);
        return () => dataHandlers.delete(requestId);
      },
      onAiStreamEnd: (requestId: string, cb: () => void) => {
        endHandlers.set(requestId, cb);
        return () => endHandlers.delete(requestId);
      },
      onAiStreamError: () => () => undefined,
      aiChatStream: async (
        requestId: string,
        _url: string,
        _headers: Record<string, string>,
        body: string,
      ) => {
        sentBodies.push(JSON.parse(body));
        if (sentBodies.length === 1) {
          const emit = dataHandlers.get(requestId);
          assert.ok(emit, 'stream data handler should be registered before aiChatStream starts');
          emit(JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'need shell context' } }] }));
          emit(JSON.stringify({
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'terminal_exec', arguments: '' },
                }],
              },
            }],
          }));
          emit(JSON.stringify({
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  function: { arguments: '{}' },
                }],
              },
            }],
          }));
        }
        endHandlers.get(requestId)?.();
        return { ok: true, statusCode: 200, statusText: 'OK' };
      },
    },
  };

  const fetch = createBridgeFetchForSDK('deepseek-custom', {
    getOpenAIChatAssistantFields: () => assistantFields,
  });

  await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      stream: true,
      messages: [{ role: 'user', content: 'inspect the host' }],
    }),
  });

  await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      stream: true,
      messages: [
        { role: 'user', content: 'inspect the host' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'terminal_exec', arguments: '{}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      ],
    }),
  });

  const followUpBody = sentBodies[1];
  const messages = followUpBody.messages as Array<Record<string, unknown>>;
  assert.equal(messages[1].reasoning_content, 'need shell context');
});

test('keeps captured reasoning_content aligned across consecutive tool calls', async (t) => {
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
  t.after(() => {
    (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
  });

  const dataHandlers = new Map<string, (data: string) => void>();
  const endHandlers = new Map<string, () => void>();
  const sentBodies: Array<Record<string, unknown>> = [];
  const assistantFields: Array<OpenAIChatAssistantFields | undefined> = [];
  const toolCall = (id: string) => ({
    id,
    type: 'function',
    function: { name: 'terminal_exec', arguments: '{}' },
  });

  (globalThis as typeof globalThis & { window?: unknown }).window = {
    netcatty: {
      aiFetch: async () => ({ ok: true, status: 200, data: '{}' }),
      aiChatCancel: async () => true,
      onAiStreamData: (requestId: string, cb: (data: string) => void) => {
        dataHandlers.set(requestId, cb);
        return () => dataHandlers.delete(requestId);
      },
      onAiStreamEnd: (requestId: string, cb: () => void) => {
        endHandlers.set(requestId, cb);
        return () => endHandlers.delete(requestId);
      },
      onAiStreamError: () => () => undefined,
      aiChatStream: async (
        requestId: string,
        _url: string,
        _headers: Record<string, string>,
        body: string,
      ) => {
        sentBodies.push(JSON.parse(body));
        const emit = dataHandlers.get(requestId);
        assert.ok(emit, 'stream data handler should be registered before aiChatStream starts');
        if (sentBodies.length === 1) {
          emit(JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'first tool reasoning' } }] }));
          emit(JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [toolCall('call_1')] } }] }));
        } else if (sentBodies.length === 2) {
          emit(JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'second tool reasoning' } }] }));
          emit(JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [toolCall('call_2')] } }] }));
        }
        endHandlers.get(requestId)?.();
        return { ok: true, statusCode: 200, statusText: 'OK' };
      },
    },
  };

  const fetch = createBridgeFetchForSDK('deepseek-custom', {
    getOpenAIChatAssistantFields: () => assistantFields,
  });

  await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      stream: true,
      messages: [{ role: 'user', content: 'inspect the host' }],
    }),
  });

  await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      stream: true,
      messages: [
        { role: 'user', content: 'inspect the host' },
        { role: 'assistant', content: '', tool_calls: [toolCall('call_1')] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      ],
    }),
  });

  await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      stream: true,
      messages: [
        { role: 'user', content: 'inspect the host' },
        { role: 'assistant', content: '', tool_calls: [toolCall('call_1')] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
        { role: 'assistant', content: '', tool_calls: [toolCall('call_2')] },
        { role: 'tool', tool_call_id: 'call_2', content: '{"ok":true}' },
      ],
    }),
  });

  const secondRequestMessages = sentBodies[1].messages as Array<Record<string, unknown>>;
  const thirdRequestMessages = sentBodies[2].messages as Array<Record<string, unknown>>;
  assert.equal(secondRequestMessages[1].reasoning_content, 'first tool reasoning');
  assert.equal(thirdRequestMessages[1].reasoning_content, 'first tool reasoning');
  assert.equal(thirdRequestMessages[3].reasoning_content, 'second tool reasoning');
});

test('replays reasoning_content through the SDK tool loop', async (t) => {
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
  t.after(() => {
    (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
  });

  const dataHandlers = new Map<string, (data: string) => void>();
  const endHandlers = new Map<string, () => void>();
  const sentBodies: Array<Record<string, unknown>> = [];
  const assistantFields: Array<OpenAIChatAssistantFields | undefined> = [];
  const toolCall = {
    index: 0,
    id: 'call_1',
    type: 'function',
    function: { name: 'terminal_exec', arguments: '{}' },
  };

  const emitChatChunk = (emit: (data: string) => void, delta: Record<string, unknown>, finishReason?: string) => {
    emit(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1777600000,
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    }));
  };

  (globalThis as typeof globalThis & { window?: unknown }).window = {
    netcatty: {
      aiFetch: async () => ({ ok: true, status: 200, data: '{}' }),
      aiChatCancel: async () => true,
      onAiStreamData: (requestId: string, cb: (data: string) => void) => {
        dataHandlers.set(requestId, cb);
        return () => dataHandlers.delete(requestId);
      },
      onAiStreamEnd: (requestId: string, cb: () => void) => {
        endHandlers.set(requestId, cb);
        return () => endHandlers.delete(requestId);
      },
      onAiStreamError: () => () => undefined,
      aiChatStream: async (
        requestId: string,
        _url: string,
        _headers: Record<string, string>,
        body: string,
      ) => {
        sentBodies.push(JSON.parse(body));
        const requestNumber = sentBodies.length;
        setTimeout(() => {
          const emit = dataHandlers.get(requestId);
          assert.ok(emit, 'stream data handler should be registered before aiChatStream starts');
          if (requestNumber === 1) {
            emitChatChunk(emit, { reasoning_content: 'need disk ' });
            emitChatChunk(emit, { reasoning_content: 'context' });
            emitChatChunk(emit, { tool_calls: [toolCall] });
            emitChatChunk(emit, {}, 'tool_calls');
          } else {
            emitChatChunk(emit, { reasoning_content: 'read result' });
            emitChatChunk(emit, { content: 'disk usage is 81%' });
            emitChatChunk(emit, {}, 'stop');
          }
          endHandlers.get(requestId)?.();
        }, 0);
        return { ok: true, statusCode: 200, statusText: 'OK' };
      },
    },
  };

  const model = createModelFromConfig(
    {
      id: 'deepseek-custom',
      providerId: 'custom',
      name: 'DeepSeek',
      apiKey: 'test-key',
      baseURL: 'https://api.deepseek.com',
      defaultModel: 'deepseek-v4-flash',
      enabled: true,
    },
    { getOpenAIChatAssistantFields: () => assistantFields },
  );

  const result = streamText({
    model,
    messages: [{ role: 'user', content: 'inspect disk' }],
    tools: {
      terminal_exec: tool({
        inputSchema: z.object({}),
        execute: async () => ({ ok: true }),
      }),
    },
    stopWhen: stepCountIs(2),
    includeRawChunks: true,
  });

  for await (const _chunk of result.fullStream) {
    // Drain the stream so the SDK completes the tool loop.
  }

  const followUpBody = sentBodies[1];
  const messages = followUpBody.messages as Array<Record<string, unknown>>;
  assert.equal(messages[1].reasoning_content, 'need disk context');
});
