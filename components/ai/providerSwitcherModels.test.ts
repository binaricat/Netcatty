import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProviderConfig } from '../../infrastructure/ai/types';
import {
  buildProviderModelCatalogRequestKey,
  buildProviderModelOptions,
  getProviderModelDiscoveryConfig,
  mergeProviderModelContextWindow,
  shouldLoadProviderModelCatalog,
} from './providerSwitcherModels';

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

test('provider model options preserve remembered and fetched context windows', () => {
  const provider = makeProvider({
    providerId: 'custom',
    defaultModel: 'known-model',
    modelContextWindows: {
      'known-model': 32768,
    },
  });

  const options = buildProviderModelOptions(provider, [
    { id: 'fetched-model', contextWindow: 65536 },
  ]);

  assert.equal(options.find((option) => option.id === 'known-model')?.contextWindow, 32768);
  assert.equal(options.find((option) => option.id === 'fetched-model')?.contextWindow, 65536);
});

test('provider model catalog does not auto-retry a failed request until forced or config changes', () => {
  const provider = makeProvider({
    id: 'qwen-1',
    providerId: 'qwen',
    apiKey: 'enc:v1:first',
  });
  const discovery = getProviderModelDiscoveryConfig(provider);
  const requestKey = buildProviderModelCatalogRequestKey(provider, discovery);

  assert.equal(
    shouldLoadProviderModelCatalog({ status: 'error', requestKey }, requestKey),
    false,
  );
  assert.equal(
    shouldLoadProviderModelCatalog({ status: 'error', requestKey }, requestKey, true),
    true,
  );

  const changedKey = buildProviderModelCatalogRequestKey(
    { ...provider, apiKey: 'enc:v1:second' },
    discovery,
  );
  assert.equal(
    shouldLoadProviderModelCatalog({ status: 'error', requestKey }, changedKey),
    true,
  );
});

test('provider model context windows merge only valid selected model metadata', () => {
  assert.deepEqual(
    mergeProviderModelContextWindow({ existing: 8192 }, { id: 'qwen3.6-plus', contextWindow: 131072 }),
    { existing: 8192, 'qwen3.6-plus': 131072 },
  );
  assert.deepEqual(
    mergeProviderModelContextWindow({ existing: 8192 }, { id: 'bad-model' }),
    { existing: 8192 },
  );
});
