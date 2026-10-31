import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';

import {
  hasAnthropicThinkingSignature,
  providerAllowsAnthropicSignedThinkingRemoval,
  stripAnthropicSignedReasoningParts,
} from './anthropicThinkingBinding.ts';

function assistantWithParts(parts: unknown[]): ModelMessage {
  return { role: 'assistant', content: parts } as ModelMessage;
}

test('stripAnthropicSignedReasoningParts drops only signed anthropic reasoning', () => {
  const input: ModelMessage[] = [
    { role: 'user', content: 'hi' },
    assistantWithParts([
      { type: 'reasoning', text: 'signed', providerOptions: { anthropic: { signature: 'sig-1' } } },
      { type: 'reasoning', text: 'unsigned' },
      { type: 'text', text: 'hello' },
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'terminal_execute',
        input: { command: 'ls' },
      },
    ]),
    assistantWithParts([
      { type: 'reasoning', text: 'also signed', providerOptions: { anthropic: { signature: 'sig-2' } } },
      { type: 'text', text: 'done' },
    ]),
  ];

  const { messages, didStrip } = stripAnthropicSignedReasoningParts(input);

  assert.equal(didStrip, true);
  assert.equal(messages[0], input[0], 'unchanged messages stay same reference');
  assert.notEqual(messages[1], input[1], 'changed assistant gets new object');
  assert.deepEqual(
    (messages[1].content as { type: string; text?: string }[]).map((p) => [p.type, p.text]),
    [
      ['reasoning', 'unsigned'],
      ['text', 'hello'],
      ['tool-call', undefined],
    ],
  );
  assert.deepEqual(
    (messages[2].content as { type: string; text?: string }[]).map((p) => [p.type, p.text]),
    [['text', 'done']],
  );
  // Input not mutated
  assert.equal((input[1].content as unknown[]).length, 4);
});

test('stripAnthropicSignedReasoningParts leaves unsigned / empty-signature alone', () => {
  const input: ModelMessage[] = [
    assistantWithParts([
      { type: 'reasoning', text: 'plain' },
      { type: 'reasoning', text: 'empty sig', providerOptions: { anthropic: { signature: '' } } },
      { type: 'reasoning', text: 'other provider', providerOptions: { openai: { itemId: 'rs_1' } } },
      { type: 'text', text: 'ok' },
    ]),
  ];
  const { messages, didStrip } = stripAnthropicSignedReasoningParts(input);
  assert.equal(didStrip, false);
  assert.equal(messages, input);
});

test('stripAnthropicSignedReasoningParts ignores non-array assistant content', () => {
  const input: ModelMessage[] = [
    { role: 'assistant', content: 'plain string' },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 't', output: { type: 'text', value: 'x' } }] } as ModelMessage,
  ];
  const { messages, didStrip } = stripAnthropicSignedReasoningParts(input);
  assert.equal(didStrip, false);
  assert.equal(messages, input);
});

test('hasAnthropicThinkingSignature matches non-empty anthropic.signature', () => {
  assert.equal(hasAnthropicThinkingSignature({
    providerOptions: { anthropic: { signature: 'abc' } },
  }), true);
  assert.equal(hasAnthropicThinkingSignature({
    providerOptions: { anthropic: { signature: '' } },
  }), false);
  assert.equal(hasAnthropicThinkingSignature({ providerOptions: {} }), false);
  assert.equal(hasAnthropicThinkingSignature({}), false);
});

test('prepareStep strip condition: signed after long tool_result + didAdjust → no signatures remain', () => {
  // Mirrors the long-chat path: prepareStepContext mutates an earlier
  // tool_result (didAdjust=true) while a later assistant still carries a
  // signed thinking block. After the strip helper runs, no anthropic.signature
  // may remain on the retained tail.
  const longToolResult = 'x'.repeat(5000);
  const messages: ModelMessage[] = [
    assistantWithParts([
      { type: 'reasoning', text: 'plan', providerOptions: { anthropic: { signature: 'bound-to-prefix' } } },
      { type: 'text', text: 'running' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'terminal_execute', input: { command: 'cat big' } },
    ]),
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'terminal_execute',
        output: { type: 'text', value: longToolResult },
      }],
    } as ModelMessage,
    assistantWithParts([
      { type: 'reasoning', text: 'after tool', providerOptions: { anthropic: { signature: 'later-sig' } } },
      { type: 'text', text: 'done' },
    ]),
  ];

  // Simulate the turn-driver wiring: when didAdjust and provider allows
  // removal, strip before returning (official Anthropic).
  const didAdjust = true;
  const preserveAnthropicThinkingReplay = true;
  const allowStripSignedThinking = true;
  let stepMessages = messages;
  if (preserveAnthropicThinkingReplay && didAdjust && allowStripSignedThinking) {
    stepMessages = stripAnthropicSignedReasoningParts(stepMessages).messages;
  }

  for (const message of stepMessages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content as { type?: string; providerOptions?: { anthropic?: { signature?: string } } }[]) {
      if (part.type === 'reasoning') {
        assert.equal(
          part.providerOptions?.anthropic?.signature,
          undefined,
          'no anthropic.signature may remain after strip-on-didAdjust',
        );
      }
    }
  }
  // Unsigned-looking text / tool-call parts still present
  const first = stepMessages[0].content as { type: string }[];
  assert.deepEqual(first.map((p) => p.type), ['text', 'tool-call']);
});

test('providerAllowsAnthropicSignedThinkingRemoval is false for DeepSeek identities', () => {
  assert.equal(providerAllowsAnthropicSignedThinkingRemoval({ providerId: 'deepseek' }), false);
  assert.equal(providerAllowsAnthropicSignedThinkingRemoval({
    providerId: 'custom',
    baseURL: 'https://api.deepseek.com/anthropic',
  }), false);
  assert.equal(providerAllowsAnthropicSignedThinkingRemoval(
    { providerId: 'anthropic' },
    'deepseek-v4-flash',
  ), false);
  assert.equal(providerAllowsAnthropicSignedThinkingRemoval({
    providerId: 'custom',
    defaultModel: 'DeepSeek-V3',
  }), false);
  assert.equal(providerAllowsAnthropicSignedThinkingRemoval({
    providerId: 'anthropic',
    defaultModel: 'claude-opus-4-5',
  }), true);
  assert.equal(providerAllowsAnthropicSignedThinkingRemoval({
    providerId: 'anthropic',
    baseURL: 'https://api.anthropic.com',
  }, 'claude-sonnet-4'), true);
});

test('prepareStep strip is skipped when provider forbids thinking removal (DeepSeek)', () => {
  const messages: ModelMessage[] = [
    assistantWithParts([
      { type: 'reasoning', text: 'plan', providerOptions: { anthropic: { signature: 'keep-me' } } },
      { type: 'text', text: 'running' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'terminal_execute', input: { command: 'ls' } },
    ]),
  ];
  const didAdjust = true;
  const preserveAnthropicThinkingReplay = true;
  const allowStripSignedThinking = providerAllowsAnthropicSignedThinkingRemoval(
    { providerId: 'deepseek' },
    'deepseek-v4-flash',
  );
  let stepMessages = messages;
  if (preserveAnthropicThinkingReplay && didAdjust && allowStripSignedThinking) {
    stepMessages = stripAnthropicSignedReasoningParts(stepMessages).messages;
  }
  assert.equal(allowStripSignedThinking, false);
  assert.equal(stepMessages, messages);
  const first = stepMessages[0].content as { type: string; providerOptions?: { anthropic?: { signature?: string } } }[];
  assert.equal(first[0].providerOptions?.anthropic?.signature, 'keep-me');
});
