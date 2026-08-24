import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearProviderModelCatalogCache,
  fetchProviderModelCatalog,
  providerModelCacheKey,
  resolveProviderDiscoveryBaseURL,
  seedProviderModelCatalog,
} from './cattyProviderModels';
import type { ProviderConfig } from './types';

const provider: ProviderConfig = {
  id: 'p1',
  providerId: 'deepseek',
  name: 'DeepSeek',
  defaultModel: 'deepseek-chat',
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: 'test-key',
  enabled: true,
};

test('resolveProviderDiscoveryBaseURL falls back to the built-in preset host', () => {
  assert.equal(
    resolveProviderDiscoveryBaseURL({
      id: 'openai-1',
      providerId: 'openai',
      name: 'OpenAI',
      enabled: true,
    }),
    'https://api.openai.com/v1',
  );
  assert.equal(
    resolveProviderDiscoveryBaseURL({
      id: 'ollama-1',
      providerId: 'ollama',
      name: 'Ollama',
      enabled: true,
      baseURL: 'https://ollama.com',
    }),
    'https://ollama.com/v1',
  );
});

test('fetchProviderModelCatalog discovers models when baseURL is omitted', async () => {
  clearProviderModelCatalogCache();
  const requested: string[] = [];
  const catalog = await fetchProviderModelCatalog(
    {
      id: 'openai-legacy',
      providerId: 'openai',
      name: 'OpenAI',
      defaultModel: 'gpt-4o',
      apiKey: 'sk-test',
      enabled: true,
    },
    {
      aiFetch: async (url) => {
        requested.push(url);
        return {
          ok: true,
          data: JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-5.5', context_length: 200000 }] }),
        };
      },
    },
  );
  assert.deepEqual(requested, ['https://api.openai.com/v1/models']);
  assert.equal(catalog.fetched, true);
  assert.ok(catalog.models.some((model) => model.id === 'gpt-5.5'));
  assert.equal(catalog.models.find((model) => model.id === 'gpt-5.5')?.contextWindow, 200000);
});

test('providerModelCacheKey changes when the stored API key changes', () => {
  const base = { ...provider };
  const before = providerModelCacheKey({ ...base, apiKey: 'enc-old' });
  const after = providerModelCacheKey({ ...base, apiKey: 'enc-new' });
  const empty = providerModelCacheKey({ ...base, apiKey: undefined });
  assert.notEqual(before, after);
  assert.notEqual(before, empty);
});

test('seedProviderModelCatalog includes the default and curated models', () => {
  const seed = seedProviderModelCatalog(provider);
  assert.equal(seed.fetched, false);
  assert.ok(seed.models.some((model) => model.id === 'deepseek-chat'));
  assert.ok(seed.models.some((model) => model.id === 'deepseek-v4-pro'));
});

test('fetchProviderModelCatalog merges discovered models and caches them', async () => {
  clearProviderModelCatalogCache();
  const catalog = await fetchProviderModelCatalog(provider, {
    aiFetch: async () => ({
      ok: true,
      data: JSON.stringify({ data: [{ id: 'deepseek-reasoner', name: 'Reasoner' }] }),
    }),
  });
  assert.equal(catalog.fetched, true);
  assert.ok(catalog.models.some((model) => model.id === 'deepseek-reasoner'));
  assert.ok(catalog.models.some((model) => model.id === 'deepseek-chat'));

  const cached = await fetchProviderModelCatalog(provider, {
    aiFetch: async () => {
      throw new Error('should not refetch');
    },
  });
  assert.equal(cached.fetched, true);
  assert.ok(cached.models.some((model) => model.id === 'deepseek-reasoner'));
});

test('fetchProviderModelCatalog appends /v1 when listing Ollama Cloud from a bare origin', async () => {
  clearProviderModelCatalogCache();
  const requested: string[] = [];
  const catalog = await fetchProviderModelCatalog(
    {
      id: 'ollama-cloud',
      providerId: 'ollama',
      name: 'Ollama',
      defaultModel: 'deepseek-v4-flash:0731',
      baseURL: 'https://ollama.com',
      apiKey: 'cloud-key',
      enabled: true,
    },
    {
      aiFetch: async (url) => {
        requested.push(url);
        return {
          ok: true,
          data: JSON.stringify({ data: [{ id: 'deepseek-v4-flash:0731' }] }),
        };
      },
    },
  );
  assert.deepEqual(requested, ['https://ollama.com/v1/models']);
  assert.equal(catalog.fetched, true);
  assert.ok(catalog.models.some((model) => model.id === 'deepseek-v4-flash:0731'));
});
