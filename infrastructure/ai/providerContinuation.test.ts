import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyOpenAIChatContinuationToBody,
  extractProviderContinuationFromRawChunk,
  getOpenAIChatAssistantFieldsForHistoryMessage,
  isProviderContinuationForSource,
  mergeProviderContinuation,
  normalizeProviderContinuationOptions,
  rawOpenAIChatChunkHasToolCalls,
  withProviderContinuationSource,
} from './providerContinuation';

test('extracts OpenAI-compatible reasoning deltas from raw provider chunks', () => {
  const first = extractProviderContinuationFromRawChunk({
    choices: [
      {
        delta: {
          reasoning_content: 'check ',
        },
      },
    ],
  });
  const second = extractProviderContinuationFromRawChunk({
    choices: [
      {
        delta: {
          reasoning_content: 'tools',
        },
      },
    ],
  });

  const merged = mergeProviderContinuation(first, second);

  assert.equal(merged?.openAIChatAssistantFields?.reasoning_content, 'check tools');
  assert.deepEqual(merged?.reasoningParts, [{ text: 'check tools' }]);
});

test('patches OpenAI-compatible assistant tool-call messages with saved continuation fields', () => {
  const body = JSON.stringify({
    model: 'deepseek-v4-flash',
    stream: true,
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'inspect the host' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'run_command', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    ],
  });

  const patched = JSON.parse(
    applyOpenAIChatContinuationToBody(body, [
      { reasoning_content: 'need shell context' },
    ]),
  );

  assert.equal(patched.messages[2].reasoning_content, 'need shell context');
});

test('patches the final assistant message after a tool result with saved continuation fields', () => {
  const body = JSON.stringify({
    model: 'deepseek-v4-flash',
    stream: true,
    messages: [
      { role: 'user', content: 'inspect the host' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'run_command', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      { role: 'assistant', content: 'host is healthy' },
      { role: 'user', content: 'continue' },
    ],
  });

  const patched = JSON.parse(
    applyOpenAIChatContinuationToBody(body, [
      { reasoning_content: 'need shell context' },
      { reasoning_content: 'summarize result' },
    ]),
  );

  assert.equal(patched.messages[1].reasoning_content, 'need shell context');
  assert.equal(patched.messages[3].reasoning_content, 'summarize result');
});

test('rebuilds OpenAI-compatible continuation fields from saved thinking for legacy history', () => {
  const source = { providerConfigId: 'deepseek-custom', providerType: 'custom', modelId: 'deepseek-v4-flash' };

  assert.deepEqual(
    getOpenAIChatAssistantFieldsForHistoryMessage(
      {
        thinking: 'legacy visible reasoning',
        providerId: 'custom',
        model: 'deepseek-v4-flash',
      },
      source,
    ),
    { reasoning_content: 'legacy visible reasoning' },
  );
});

test('does not rebuild continuation fields from thinking when provider or model differs', () => {
  const source = { providerConfigId: 'deepseek-custom', providerType: 'custom', modelId: 'deepseek-v4-flash' };

  assert.equal(
    getOpenAIChatAssistantFieldsForHistoryMessage(
      {
        thinking: 'other provider reasoning',
        providerId: 'openai',
        model: 'deepseek-v4-flash',
      },
      source,
    ),
    undefined,
  );
  assert.equal(
    getOpenAIChatAssistantFieldsForHistoryMessage(
      {
        thinking: 'other model reasoning',
        providerId: 'custom',
        model: 'another-model',
      },
      source,
    ),
    undefined,
  );
  assert.equal(
    getOpenAIChatAssistantFieldsForHistoryMessage(
      {
        thinking: 'missing provider metadata',
        model: 'deepseek-v4-flash',
      },
      source,
    ),
    undefined,
  );
  assert.equal(
    getOpenAIChatAssistantFieldsForHistoryMessage(
      {
        thinking: 'missing model metadata',
        providerId: 'custom',
      },
      source,
    ),
    undefined,
  );
});

test('detects OpenAI-compatible tool calls in raw chunks', () => {
  assert.equal(rawOpenAIChatChunkHasToolCalls({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'run_command', arguments: '{}' },
            },
          ],
        },
      },
    ],
  }), true);

  assert.equal(rawOpenAIChatChunkHasToolCalls({
    choices: [{ delta: { reasoning_content: 'think' } }],
  }), false);
  assert.equal(rawOpenAIChatChunkHasToolCalls('[DONE]'), false);
});

test('merges provider reasoning metadata into the reasoning part it belongs to', () => {
  const merged = mergeProviderContinuation(
    { reasoningParts: [{ text: 'consider options' }] },
    { reasoningParts: [{ text: '', providerOptions: { anthropic: { signature: 'sig-1' } } }] },
  );

  assert.deepEqual(merged?.reasoningParts, [
    {
      text: 'consider options',
      providerOptions: { anthropic: { signature: 'sig-1' } },
    },
  ]);
});

test('normalizes provider metadata without unsafe object keys', () => {
  const unsafeMetadata = JSON.parse('{"google":{"thoughtSignature":"sig-1","__proto__":{"polluted":true},"nested":{"constructor":{"bad":true},"value":"safe"}},"__proto__":{"ignored":true}}');
  const normalized = normalizeProviderContinuationOptions(unsafeMetadata);

  assert.deepEqual(normalized, {
    google: {
      thoughtSignature: 'sig-1',
      nested: { value: 'safe' },
    },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(normalized?.google ?? {}, '__proto__'), false);
});

test('merges equivalent provider options without depending on key order', () => {
  const merged = mergeProviderContinuation(
    { reasoningParts: [{ text: 'one ', providerOptions: { google: { b: 2, a: 1 } } }] },
    { reasoningParts: [{ text: 'two', providerOptions: { google: { a: 1, b: 2 } } }] },
  );

  assert.deepEqual(merged?.reasoningParts, [
    {
      text: 'one two',
      providerOptions: { google: { b: 2, a: 1 } },
    },
  ]);
});

test('cleans nested unsafe provider option keys when merging saved data', () => {
  const unsafeOptions = JSON.parse('{"google":{"nested":{"prototype":{"bad":true},"value":"safe"}}}');
  const merged = mergeProviderContinuation(
    { reasoningParts: [{ text: 'one ', providerOptions: unsafeOptions }] },
    { reasoningParts: [{ text: 'two' }] },
  );

  assert.deepEqual(merged?.reasoningParts, [
    {
      text: 'one ',
      providerOptions: { google: { nested: { value: 'safe' } } },
    },
    { text: 'two' },
  ]);
});

test('tracks continuation source so provider switches do not replay hidden context', () => {
  const source = { providerConfigId: 'deepseek-custom', providerType: 'custom', modelId: 'deepseek-v4-flash' };
  const continuation = withProviderContinuationSource(
    { openAIChatAssistantFields: { reasoning_content: 'think' } },
    source,
  );

  assert.equal(isProviderContinuationForSource(continuation, source), true);
  assert.equal(
    isProviderContinuationForSource(continuation, {
      providerConfigId: 'openai',
      providerType: 'openai',
      modelId: 'gpt-5',
    }),
    false,
  );
});

test('drops old hidden context instead of relabeling it when sources differ', () => {
  const deepseek = { providerConfigId: 'deepseek-custom', providerType: 'custom', modelId: 'deepseek-v4-flash' };
  const openai = { providerConfigId: 'openai', providerType: 'openai', modelId: 'gpt-5' };
  const merged = mergeProviderContinuation(
    { source: deepseek, openAIChatAssistantFields: { reasoning_content: 'old' } },
    { source: openai, reasoningParts: [{ text: 'new' }] },
  );

  assert.deepEqual(merged, {
    source: openai,
    reasoningParts: [{ text: 'new' }],
  });
});

test('merges tool-call provider options by tool call id', () => {
  const merged = mergeProviderContinuation(
    { toolCallProviderOptionsById: { call_1: { google: { thoughtSignature: 'sig-1' } } } },
    { toolCallProviderOptionsById: { call_1: { google: { extra: true } } } },
  );

  assert.deepEqual(merged?.toolCallProviderOptionsById, {
    call_1: {
      google: {
        thoughtSignature: 'sig-1',
        extra: true,
      },
    },
  });
});

test('skips plain assistant messages that are not part of a tool loop', () => {
  const body = JSON.stringify({
    stream: true,
    messages: [
      { role: 'assistant', content: 'plain answer' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'run_command', arguments: '{}' },
          },
        ],
      },
    ],
  });

  const patched = JSON.parse(
    applyOpenAIChatContinuationToBody(body, [
      { reasoning_content: 'tool reasoning' },
    ]),
  );

  assert.equal(patched.messages[0].reasoning_content, undefined);
  assert.equal(patched.messages[1].reasoning_content, 'tool reasoning');
});

test('keeps assistant tool-call continuation fields aligned with message order', () => {
  const toolCall = (id: string) => ({
    id,
    type: 'function',
    function: { name: 'run_command', arguments: '{}' },
  });
  const body = JSON.stringify({
    stream: true,
    messages: [
      { role: 'assistant', content: '', tool_calls: [toolCall('call_1')] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      { role: 'assistant', content: '', tool_calls: [toolCall('call_2')] },
    ],
  });

  const patched = JSON.parse(
    applyOpenAIChatContinuationToBody(body, [
      undefined,
      { reasoning_content: 'second reasoning' },
    ]),
  );

  assert.equal(patched.messages[0].reasoning_content, undefined);
  assert.equal(patched.messages[2].reasoning_content, 'second reasoning');
});

test('leaves invalid or unchanged OpenAI-compatible request bodies alone', () => {
  assert.equal(applyOpenAIChatContinuationToBody('{', []), '{');

  const body = JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(applyOpenAIChatContinuationToBody(body, [{ reasoning_content: 'unused' }]), body);
});
