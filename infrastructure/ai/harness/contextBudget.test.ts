import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeCompactionBuffer,
  computeCompactionThreshold,
  computeTotalInputTokens,
  DEFAULT_MAX_OUTPUT_TOKENS,
  shouldCompactByBudget,
} from './contextBudget.ts';
import type { ModelMessage } from 'ai';

test('computeCompactionThreshold reserves output and buffer', () => {
  const threshold = computeCompactionThreshold({
    contextWindow: 128_000,
    maxOutputTokens: 4096,
  });
  const buffer = computeCompactionBuffer(128_000, 4096);
  assert.equal(threshold, 128_000 - 4096 - buffer - 150);
  assert.ok(threshold < 128_000 * 0.85);
});

test('shouldCompactByBudget triggers when total input exceeds threshold', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'x'.repeat(400_000) }];
  assert.equal(shouldCompactByBudget({
    messages,
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    providerId: 'openai',
  }), true);
});

test('computeTotalInputTokens includes system and tool names', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }];
  const withExtras = computeTotalInputTokens({
    messages,
    systemPrompt: 'system prompt',
    toolNames: ['terminal_execute', 'sftp_read'],
    providerId: 'anthropic',
  });
  const base = computeTotalInputTokens({ messages, providerId: 'anthropic' });
  assert.ok(withExtras > base);
});

test('computeCompactionThreshold keeps a reasonable threshold for small context windows', () => {
  const threshold8k = computeCompactionThreshold({
    contextWindow: 8_192,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });
  assert.ok(threshold8k > 1_000);
  assert.ok(threshold8k < 8_192 * 0.85);

  const threshold4k = computeCompactionThreshold({
    contextWindow: 4_096,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });
  assert.ok(threshold4k > 500);
  assert.ok(threshold4k < 4_096 * 0.85);
});
