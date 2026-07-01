import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSdkRuntimeModelCache,
  modelPresetsContainId,
  normalizeSdkRuntimeModelPresets,
  shouldAdoptSdkCurrentModel,
  shouldLoadSdkRuntimeModels,
  shouldUseStoredAgentModel,
} from './AIChatSidePanelHelpers';
import type { AgentModelPreset, ExternalAgentConfig } from '../infrastructure/ai/types';

test('modelPresetsContainId matches plain and thinking-level model ids', () => {
  const presets: AgentModelPreset[] = [
    { id: 'gpt-5.5', name: 'GPT-5.5', thinkingLevels: ['low', 'high'] },
    { id: 'claude-sonnet', name: 'Claude Sonnet' },
  ];

  assert.equal(modelPresetsContainId(presets, 'gpt-5.5/high'), true);
  assert.equal(modelPresetsContainId(presets, 'claude-sonnet'), true);
  assert.equal(modelPresetsContainId(presets, 'gpt-5.5/medium'), false);
});

test('shouldLoadSdkRuntimeModels includes SDK agents with model catalogs', () => {
  const agent = (sdkBackend: string): ExternalAgentConfig => ({
    id: `discovered_${sdkBackend}`,
    name: sdkBackend,
    command: sdkBackend,
    enabled: true,
    sdkBackend,
  });

  assert.equal(shouldLoadSdkRuntimeModels(agent('claude')), true);
  assert.equal(shouldLoadSdkRuntimeModels(agent('copilot')), true);
  assert.equal(shouldLoadSdkRuntimeModels(agent('codebuddy')), true);
  assert.equal(shouldLoadSdkRuntimeModels(agent('opencode')), true);
  assert.equal(shouldLoadSdkRuntimeModels(agent('codex')), false);
  assert.equal(shouldLoadSdkRuntimeModels(undefined), false);
});

test('shouldAdoptSdkCurrentModel keeps SDK defaults when no runtime list is returned', () => {
  assert.equal(shouldAdoptSdkCurrentModel('openai/gpt-5.1', undefined, []), true);
  assert.equal(shouldAdoptSdkCurrentModel('openai/gpt-5.1', 'openai/gpt-5.1', []), true);
  assert.equal(
    shouldAdoptSdkCurrentModel('openai/gpt-5.1', 'anthropic/claude-sonnet', [
      { id: 'anthropic/claude-sonnet', name: 'Claude' },
    ]),
    false,
  );
  assert.equal(shouldAdoptSdkCurrentModel(null, undefined, []), false);
});

test('normalizeSdkRuntimeModelPresets preserves SDK current model without a catalog', () => {
  assert.deepEqual(normalizeSdkRuntimeModelPresets([], 'custom/provider-model'), [
    { id: 'custom/provider-model', name: 'custom/provider-model' },
  ]);
  assert.deepEqual(normalizeSdkRuntimeModelPresets([], null), []);
  assert.deepEqual(
    normalizeSdkRuntimeModelPresets([{ id: 'openai/gpt-5.1', name: 'GPT-5.1' }], 'custom/provider-model'),
    [{ id: 'openai/gpt-5.1', name: 'GPT-5.1' }],
  );
});

test('shouldUseStoredAgentModel trusts SDK defaults when no runtime list is returned', () => {
  const opencodeAgent: ExternalAgentConfig = {
    id: 'managed_opencode',
    name: 'OpenCode',
    command: 'opencode',
    enabled: true,
    sdkBackend: 'opencode',
  };

  assert.equal(shouldUseStoredAgentModel('openai/gpt-5.1', [], opencodeAgent), true);
  assert.equal(shouldUseStoredAgentModel('openai/gpt-5.1', [], undefined), false);
  assert.equal(
    shouldUseStoredAgentModel('anthropic/claude-sonnet', [
      { id: 'anthropic/claude-sonnet', name: 'Claude' },
    ], opencodeAgent),
    true,
  );
  assert.equal(
    shouldUseStoredAgentModel('openai/gpt-5.1', [
      { id: 'anthropic/claude-sonnet', name: 'Claude' },
    ], opencodeAgent),
    false,
  );
});

test('SDK runtime model cache coalesces concurrent refreshes', async () => {
  const cache = createSdkRuntimeModelCache();
  let calls = 0;
  let resolveLoad!: (value: { currentModelId: string | null; models: AgentModelPreset[] }) => void;
  const load = () => {
    calls += 1;
    return new Promise<{ currentModelId: string | null; models: AgentModelPreset[] }>((resolve) => {
      resolveLoad = resolve;
    });
  };

  const first = cache.refresh('opencode:/opt/bin/opencode', load);
  const second = cache.refresh('opencode:/opt/bin/opencode', load);

  assert.equal(first, second);
  assert.equal(calls, 1);

  resolveLoad({
    currentModelId: 'openai/gpt-5.1',
    models: [{ id: 'openai/gpt-5.1', name: 'GPT-5.1' }],
  });
  assert.deepEqual(await first, {
    currentModelId: 'openai/gpt-5.1',
    models: [{ id: 'openai/gpt-5.1', name: 'GPT-5.1' }],
  });
});

test('SDK runtime model cache serves cached models while background refresh updates them', async () => {
  let now = 1_000;
  const cache = createSdkRuntimeModelCache({ now: () => now });

  await cache.refresh('opencode:/opt/bin/opencode', async () => ({
    currentModelId: 'openai/gpt-5.1',
    models: [{ id: 'openai/gpt-5.1', name: 'GPT-5.1' }],
  }));

  assert.deepEqual(cache.read('opencode:/opt/bin/opencode')?.models, [
    { id: 'openai/gpt-5.1', name: 'GPT-5.1' },
  ]);

  now = 2_000;
  const refresh = cache.refresh(
    'opencode:/opt/bin/opencode',
    async () => ({
      currentModelId: 'anthropic/claude-sonnet-4-6',
      models: [{ id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }],
    }),
    { force: true },
  );

  assert.deepEqual(cache.read('opencode:/opt/bin/opencode')?.models, [
    { id: 'openai/gpt-5.1', name: 'GPT-5.1' },
  ]);

  await refresh;
  assert.deepEqual(cache.read('opencode:/opt/bin/opencode')?.models, [
    { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  ]);
});

test('SDK runtime model cache keeps the previous catalog when a refresh fails', async () => {
  const cache = createSdkRuntimeModelCache();

  await cache.refresh('opencode:/opt/bin/opencode', async () => ({
    currentModelId: 'openai/gpt-5.1',
    models: [{ id: 'openai/gpt-5.1', name: 'GPT-5.1' }],
  }));

  await assert.rejects(
    cache.refresh(
      'opencode:/opt/bin/opencode',
      async () => {
        throw new Error('OpenCode unavailable');
      },
      { force: true },
    ),
    /OpenCode unavailable/,
  );

  assert.deepEqual(cache.read('opencode:/opt/bin/opencode')?.models, [
    { id: 'openai/gpt-5.1', name: 'GPT-5.1' },
  ]);
});

test('SDK runtime model cache ignores degraded empty catalogs', async () => {
  const cache = createSdkRuntimeModelCache();

  await cache.refresh('opencode:/opt/bin/opencode', async () => ({
    currentModelId: 'openai/gpt-5.1',
    models: [{ id: 'openai/gpt-5.1', name: 'GPT-5.1' }],
  }));

  const refreshed = await cache.refresh(
    'opencode:/opt/bin/opencode',
    async () => ({ currentModelId: null, models: [] }),
    { force: true },
  );

  assert.deepEqual(refreshed.models, [
    { id: 'openai/gpt-5.1', name: 'GPT-5.1' },
  ]);
  assert.deepEqual(cache.read('opencode:/opt/bin/opencode')?.models, [
    { id: 'openai/gpt-5.1', name: 'GPT-5.1' },
  ]);

  const emptyCache = createSdkRuntimeModelCache();
  await emptyCache.refresh('opencode:/usr/bin/opencode', async () => ({
    currentModelId: null,
    models: [],
  }));
  assert.equal(emptyCache.read('opencode:/usr/bin/opencode'), null);
});
