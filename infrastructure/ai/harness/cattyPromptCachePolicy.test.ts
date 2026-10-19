import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import { createCattyPromptCache } from './cattyPromptCache';

test('leaves implicit-cache protocols unchanged', () => {
  for (const provider of ['openai.chat', 'openai.responses', 'google.generative-ai']) {
    const cache = createCattyPromptCache('instructions', provider);
    const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }];
    assert.equal(cache.instructions, 'instructions');
    assert.equal(cache.prepareMessages(messages), messages);
  }
});

test('Claude markers stay bounded across tool steps without changing signed reasoning', () => {
  const cache = createCattyPromptCache('static\n\n## Current Scope\nvolatile', 'anthropic.messages', { baseURL: 'https://api.anthropic.com' });
  const reasoning = { type: 'reasoning' as const, text: 'thinking',
    providerOptions: { anthropic: { signature: 'signed-value' } } };
  let messages: ModelMessage[] = [{ role: 'user', content: 'hello' }];
  for (let step = 0; step < 30; step += 1) {
    messages = cache.prepareMessages(messages);
    const marked = messages.filter(message => message.providerOptions?.anthropic?.cacheControl);
    assert.ok(marked.length <= 2);
    messages.push({ role: 'assistant', content: [reasoning, { type: 'text', text: 'result' }] });
    messages.push({ role: 'user', content: `next-${step}` });
  }
  for (const message of messages) {
    if (message.role === 'assistant') assert.equal(message.content[0], reasoning);
  }
  assert.ok(Array.isArray(cache.instructions));
  assert.deepEqual(cache.instructions[0].providerOptions?.anthropic?.cacheControl, { type: 'ephemeral' });
});

test('only the official HTTPS Anthropic endpoint enables vendor cache markers', () => {
  for (const baseURL of ['https://proxy.example.test/v1', 'http://api.anthropic.com', 'https://api.anthropic.com.example.test', 'invalid']) {
    const cache = createCattyPromptCache('instructions', 'anthropic.messages', { baseURL });
    assert.equal(cache.enabled, false);
  }
  assert.equal(createCattyPromptCache('instructions', 'anthropic.messages').enabled, false);
  assert.equal(createCattyPromptCache('instructions', 'anthropic.messages', {}).enabled, true);
  assert.equal(createCattyPromptCache('instructions', 'anthropic.messages', { baseURL: 'https://api.anthropic.com/v1' }).enabled, true);
});
