import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCursorListModelsAgentEnv,
  buildSdkRuntimeModelCacheKey,
  canonicalizeEffortEncodedModelId,
  createSdkRuntimeModelCache,
  agentModelPresetsShallowEqual,
  mergeFallbackThinkingLevels,
  modelPresetsContainId,
  normalizeStoredAgentModelSelection,
  normalizeSdkRuntimeModelPresets,
  shouldAdoptSdkCurrentModel,
  shouldLoadSdkRuntimeModels,
  shouldUseStoredAgentModel,
} from './AIChatSidePanelHelpers';
import type { AgentModelPreset, ExternalAgentConfig } from '../infrastructure/ai/types';

test('buildCursorListModelsAgentEnv injects cli-login auth mode for list-models', () => {
  assert.deepEqual(
    buildCursorListModelsAgentEnv({
      command: '/Users/me/.local/bin/cursor-agent',
      cursorAuthMode: 'cli-login',
      env: { HOME: '/Users/me' },
    }),
    {
      HOME: '/Users/me',
      NETCATTY_CURSOR_AUTH_MODE: 'cli-login',
      NETCATTY_CURSOR_CLI_BIN: '/Users/me/.local/bin/cursor-agent',
    },
  );
});

test('buildCursorListModelsAgentEnv defaults to api-key without injecting CLI bin', () => {
  assert.deepEqual(
    buildCursorListModelsAgentEnv({
      command: 'cursor',
      env: {},
    }),
    {
      NETCATTY_CURSOR_AUTH_MODE: 'api-key',
    },
  );
  assert.deepEqual(
    buildCursorListModelsAgentEnv({
      command: 'cursor',
      cursorAuthMode: 'api-key',
    }),
    {
      NETCATTY_CURSOR_AUTH_MODE: 'api-key',
    },
  );
});

test('Cursor auth mode changes invalidate the SDK model cache key', () => {
  const base = {
    id: 'managed_cursor',
    command: '/Users/me/.local/bin/cursor-agent',
    sdkBackend: 'cursor',
  };
  const apiKey = buildSdkRuntimeModelCacheKey({
    ...base,
    cursorAuthMode: 'api-key',
  });
  const cliLogin = buildSdkRuntimeModelCacheKey({
    ...base,
    cursorAuthMode: 'cli-login',
  });
  assert.notEqual(apiKey, cliLogin);
});

test('canonicalizeEffortEncodedModelId collapses Cursor query-string effort', () => {
  assert.equal(canonicalizeEffortEncodedModelId('gpt-5?effort=low'), 'gpt-5/low');
  assert.equal(canonicalizeEffortEncodedModelId('gpt-5/high'), 'gpt-5/high');
  assert.equal(canonicalizeEffortEncodedModelId('gpt-5?effort=low&mode=fast'), 'gpt-5?effort=low&mode=fast');
});

test('mergeFallbackThinkingLevels fills missing runtime effort catalogs', () => {
  const merged = mergeFallbackThinkingLevels(
    [{ id: 'gpt-5.5', name: 'GPT-5.5' }, { id: 'auto', name: 'Auto' }],
    [{ id: 'gpt-5.5', name: 'GPT-5.5', thinkingLevels: ['low', 'medium', 'high'], defaultThinkingLevel: 'medium' }],
  );
  assert.deepEqual(merged[0]?.thinkingLevels, ['low', 'medium', 'high']);
  assert.equal(merged[0]?.defaultThinkingLevel, 'medium');
  assert.equal(merged[1]?.thinkingLevels, undefined);
  const partial = mergeFallbackThinkingLevels(
    [{ id: 'gpt-5.5', name: 'GPT-5.5', thinkingLevels: ['low'] }],
    [{ id: 'gpt-5.5', name: 'GPT-5.5', thinkingLevels: ['low', 'medium', 'high'], defaultThinkingLevel: 'medium' }],
  );
  assert.deepEqual(partial[0]?.thinkingLevels, ['low']);
  assert.deepEqual(mergeFallbackThinkingLevels([], [{ id: 'gpt-5.5', name: 'GPT-5.5' }]), []);
  const alreadyFilled = [{ id: 'gpt-5.5', name: 'GPT-5.5', thinkingLevels: ['low'] }];
  assert.equal(
    mergeFallbackThinkingLevels(
      alreadyFilled,
      [{ id: 'gpt-5.5', name: 'GPT-5.5', thinkingLevels: ['low', 'medium', 'high'] }],
    ),
    alreadyFilled,
  );
});

test('agentModelPresetsShallowEqual ignores array identity when contents match', () => {
  const left = [{ id: 'gpt-5.5', name: 'GPT-5.5', thinkingLevels: ['low', 'high'] }];
  const right = [{ id: 'gpt-5.5', name: 'GPT-5.5', thinkingLevels: ['low', 'high'] }];
  assert.equal(agentModelPresetsShallowEqual(left, right), true);
  assert.equal(
    agentModelPresetsShallowEqual(left, [{ id: 'gpt-5.5', name: 'GPT-5.5', thinkingLevels: ['high'] }]),
    false,
  );
});

test('modelPresetsContainId matches plain and thinking-level model ids', () => {
  const presets: AgentModelPreset[] = [
    { id: 'gpt-5.5', name: 'GPT-5.5', thinkingLevels: ['low', 'high'] },
    { id: 'claude-sonnet', name: 'Claude Sonnet' },
  ];

  assert.equal(modelPresetsContainId(presets, 'gpt-5.5/high'), true);
  assert.equal(modelPresetsContainId(presets, 'gpt-5.5?effort=high'), true);
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
  assert.equal(shouldLoadSdkRuntimeModels(agent('cursor')), true);
  assert.equal(shouldLoadSdkRuntimeModels(agent('codebuddy')), true);
  assert.equal(shouldLoadSdkRuntimeModels(agent('opencode')), true);
  assert.equal(shouldLoadSdkRuntimeModels(agent('grok')), true);
  assert.equal(shouldLoadSdkRuntimeModels(agent('codex')), false);
  assert.equal(shouldLoadSdkRuntimeModels({ ...agent('codex'), codexRuntime: 'app-server' }), true);
  assert.equal(shouldLoadSdkRuntimeModels(undefined), false);
});

test('Codex App Server model discovery uses a separate cache identity', () => {
  const sdk = buildSdkRuntimeModelCacheKey({
    id: 'discovered_codex',
    command: '/bin/codex',
    sdkBackend: 'codex',
    codexRuntime: 'sdk',
  });
  const appServer = buildSdkRuntimeModelCacheKey({
    id: 'discovered_codex',
    command: '/bin/codex',
    sdkBackend: 'codex',
    codexRuntime: 'app-server',
  });
  assert.notEqual(sdk, appServer);
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

test('normalizeStoredAgentModelSelection rewrites Cursor query effort but not extra params', () => {
  const presets: AgentModelPreset[] = [{
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    thinkingLevels: ['low', 'medium', 'high'],
    defaultThinkingLevel: 'medium',
  }];
  assert.equal(normalizeStoredAgentModelSelection('gpt-5.5?effort=low', presets), 'gpt-5.5/low');
  assert.equal(normalizeStoredAgentModelSelection('gpt-5.5/high', presets), 'gpt-5.5/high');
  assert.equal(
    normalizeStoredAgentModelSelection('gpt-5.5?effort=low&mode=fast', presets),
    undefined,
  );
});

test('normalizeStoredAgentModelSelection keeps bare CodeBuddy ids unsuffixed', () => {
  const presets: AgentModelPreset[] = [{
    id: 'glm-5.1',
    name: 'GLM 5.1',
    thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
    defaultThinkingLevel: 'medium',
    encodeDefaultThinking: false,
  }];
  assert.equal(normalizeStoredAgentModelSelection('glm-5.1', presets), 'glm-5.1');
  assert.equal(normalizeStoredAgentModelSelection('glm-5.1/high', presets), 'glm-5.1/high');
});

test('legacy plain model selections keep their model and gain its default reasoning effort', () => {
  const presets: AgentModelPreset[] = [{
    id: 'grok-4.5',
    name: 'Grok 4.5',
    thinkingLevels: ['high', 'medium', 'low'],
    defaultThinkingLevel: 'high',
  }, {
    id: 'grok-4.6',
    name: 'Grok 4.6',
    thinkingLevels: ['xhigh', 'high', 'medium', 'low'],
    defaultThinkingLevel: 'high',
  }];

  assert.equal(modelPresetsContainId(presets, 'grok-4.5'), true);
  assert.equal(normalizeStoredAgentModelSelection('grok-4.5', presets), 'grok-4.5/high');
  assert.equal(normalizeStoredAgentModelSelection('grok-4.5/medium', presets), 'grok-4.5/medium');
  assert.equal(
    shouldAdoptSdkCurrentModel('grok-4.6/high', 'grok-4.5', presets),
    false,
  );
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

test('SDK runtime model cache evicts expired catalogs', async () => {
  let now = 1_000;
  const cache = createSdkRuntimeModelCache({ ttlMs: 100, now: () => now });

  await cache.refresh('opencode:/opt/bin/opencode', async () => ({
    currentModelId: 'openai/gpt-5.1',
    models: [{ id: 'openai/gpt-5.1', name: 'GPT-5.1' }],
  }));
  assert.equal(cache.size(), 1);

  now = 1_101;
  assert.equal(cache.read('opencode:/opt/bin/opencode'), null);
  assert.equal(cache.size(), 0);
});

test('SDK runtime model cache stays bounded under agent configuration churn', async () => {
  const cache = createSdkRuntimeModelCache({ maxEntries: 4 });

  for (let index = 0; index < 20; index += 1) {
    await cache.refresh(`agent:${index}`, async () => ({
      currentModelId: `model-${index}`,
      models: [{ id: `model-${index}`, name: `Model ${index}` }],
    }));
  }

  assert.equal(cache.size(), 4);
  assert.equal(cache.read('agent:0'), null);
  assert.equal(cache.read('agent:19')?.currentModelId, 'model-19');
});
