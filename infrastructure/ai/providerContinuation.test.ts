import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyOpenAIChatContinuationToBody,
  extractProviderContinuationFromRawChunk,
  mergeProviderContinuation,
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

test('matches continuation fields only to assistant tool-call messages', () => {
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
