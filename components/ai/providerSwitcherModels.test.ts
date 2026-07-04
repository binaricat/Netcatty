import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProviderConfig } from '../../infrastructure/ai/types';
import { buildProviderModelOptions } from './providerSwitcherModels';

function makeProvider(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: 'provider-1',
    providerId: 'custom',
    name: 'Provider',
    enabled: true,
    ...overrides,
  };
}

test('provider model options include preset models when no default model is configured', () => {
  const provider = makeProvider({
    providerId: 'deepseek',
    name: 'DeepSeek',
  });

  const options = buildProviderModelOptions(provider);

  assert.equal(options[0]?.id, 'deepseek-v4-flash');
  assert.ok(options.some((option) => option.id === 'deepseek-chat'));
});

test('provider model options merge fetched, remembered, default, and preset models without duplicates', () => {
  const provider = makeProvider({
    providerId: 'qwen',
    name: 'Qwen',
    defaultModel: 'qwen3.7-plus',
    modelContextWindows: {
      'qwen3-coder-plus': 131072,
    },
  });

  const options = buildProviderModelOptions(provider, [
    { id: 'qwen3.6-plus', name: 'Qwen 3.6 Plus' },
    { id: 'qwen3.7-plus', name: 'Duplicate default' },
  ]);

  assert.deepEqual(
    options.slice(0, 4).map((option) => option.id),
    ['qwen3.7-plus', 'qwen3.6-plus', 'qwen3-coder-plus', 'qwen3.7-max'],
  );
  assert.equal(options.find((option) => option.id === 'qwen3.6-plus')?.name, 'Qwen 3.6 Plus');
  assert.equal(options.filter((option) => option.id === 'qwen3.7-plus').length, 1);
});
