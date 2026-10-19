import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOpenAIChatCacheUsage } from './openAIChatCacheUsage';

test('adapts documented DeepSeek cache usage while preserving the rest of the response', () => {
  const response = { choices: [], usage: {
    prompt_tokens: 1000, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100,
    prompt_tokens_details: { other: 1 }, completion_tokens: 5,
  } };
  const parsed = JSON.parse(normalizeOpenAIChatCacheUsage(JSON.stringify(response)));
  assert.deepEqual(parsed, {
    ...response, usage: { ...response.usage, prompt_tokens_details: { other: 1, cached_tokens: 900 } },
  });
});

test('preserves standard usage and rejects invalid cache counts without breaking stream data', () => {
  for (const hit of [-1, 1.5, '900', 1001, null]) {
    const data = JSON.stringify({ usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: hit } });
    assert.equal(normalizeOpenAIChatCacheUsage(data), data);
  }
  for (const data of ['[DONE]', 'not JSON', '{"usage":null}', '{"type":"message_start"}']) {
    assert.equal(normalizeOpenAIChatCacheUsage(data), data);
  }
  const data = JSON.stringify({ usage: {
    prompt_tokens: 1000, prompt_cache_hit_tokens: 900, prompt_tokens_details: { cached_tokens: 0 },
  } });
  assert.equal(normalizeOpenAIChatCacheUsage(data), data);
});
