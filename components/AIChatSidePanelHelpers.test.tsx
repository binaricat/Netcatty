import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  appendRetainedStoredModelPreset,
  retainStoredModelPresetForCatalog,
  buildCursorListModelsAgentEnv,
  buildSdkRuntimeModelCacheKey,
  canonicalizeEffortEncodedModelId,
  createSdkRuntimeModelCache,
  agentModelPresetsShallowEqual,
  mergeFallbackThinkingLevels,
  MODEL_CACHE_ENV_HINTS,
  modelPresetsContainId,
  normalizeStoredAgentModelSelection,
  normalizeSdkRuntimeModelPresets,
  resolveSdkRuntimeCatalogDefaultModelId,
  reconcileRuntimeModelWarning,
  toSdkRuntimeModelCatalog,
  shouldAdoptSdkCurrentModel,
  shouldLoadSdkRuntimeModels,
  shouldUseStoredAgentModel,
} from './AIChatSidePanelHelpers';
import { createRequire } from 'node:module';
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
  const unsupported = mergeFallbackThinkingLevels(
    [{ id: 'gpt-5.5', name: 'GPT-5.5', thinkingLevels: [] }],
    [{ id: 'gpt-5.5', name: 'GPT-5.5', thinkingLevels: ['low', 'high'] }],
  );
  assert.deepEqual(unsupported[0]?.thinkingLevels, []);
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
  assert.equal(shouldLoadSdkRuntimeModels(agent('codex')), true);
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
  assert.notEqual(
    buildSdkRuntimeModelCacheKey({ id: 'discovered_codex', sdkBackend: 'codex', command: '/bin/codex', env: { HOME: '/shared', CODEX_HOME: '/profiles/a' } }),
    buildSdkRuntimeModelCacheKey({ id: 'discovered_codex', sdkBackend: 'codex', command: '/bin/codex', env: { HOME: '/shared', CODEX_HOME: '/profiles/b' } }),
  );
});

test('Claude model cache keys isolate configuration directories under one home', () => {
  const agent = { id: 'discovered_claude', sdkBackend: 'claude', command: '/bin/claude' };
  assert.notEqual(
    buildSdkRuntimeModelCacheKey({ ...agent, env: { HOME: '/shared', CLAUDE_CONFIG_DIR: '/profiles/a' } }),
    buildSdkRuntimeModelCacheKey({ ...agent, env: { HOME: '/shared', CLAUDE_CONFIG_DIR: '/profiles/b' } }),
  );
});

test('MiMo model cache reloads after its config directory changes', async () => {
  const agent = { id: 'discovered_mimo', sdkBackend: 'mimo', command: '/bin/mimo' };
  const firstKey = buildSdkRuntimeModelCacheKey({ ...agent, env: { MIMOCODE_HOME: '/profiles/a' } });
  const secondKey = buildSdkRuntimeModelCacheKey({ ...agent, env: { MIMOCODE_HOME: '/profiles/b' } });
  const cache = createSdkRuntimeModelCache();
  let loads = 0;
  const load = async () => ({ currentModelId: String(++loads), models: [] });
  assert.deepEqual(await cache.refresh(firstKey, load), { currentModelId: '1', models: [] });
  assert.deepEqual(await cache.refresh(secondKey, load), { currentModelId: '2', models: [] });
  assert.equal(loads, 2);
  assert.notEqual(
    buildSdkRuntimeModelCacheKey({ ...agent, env: { MIMOCODE_CONFIG: '/profiles/a/mimocode.json' } }),
    buildSdkRuntimeModelCacheKey({ ...agent, env: { MIMOCODE_CONFIG: '/profiles/b/mimocode.json' } }),
  );
});

test('Claude model cache keys isolate credentials without exposing them', () => {
  const agent = { id: 'discovered_claude', sdkBackend: 'claude', command: '/bin/claude' };
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    const first = buildSdkRuntimeModelCacheKey({ ...agent, env: { [name]: 'secret-one' } });
    const second = buildSdkRuntimeModelCacheKey({ ...agent, env: { [name]: 'secret-two' } });
    assert.notEqual(first, second, `${name} must separate cache entries`);
    assert.doesNotMatch(first, /secret-one/);
  }
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
    thinkingLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
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

test('stored claude alias selections keep resolving against a full-id catalog', () => {
  const claudeAgent: ExternalAgentConfig = {
    id: 'managed_claude',
    name: 'Claude Code',
    command: 'claude',
    enabled: true,
    sdkBackend: 'claude',
  };
  const fullIdPresets: AgentModelPreset[] = [
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', name: 'Haiku 5.5' },
  ];

  // Legacy persisted alias ids (pre-2026-10 preset refresh) still resolve for
  // the claude backend, with or without an effort suffix.
  assert.equal(shouldUseStoredAgentModel('sonnet', fullIdPresets, claudeAgent), true);
  assert.equal(shouldUseStoredAgentModel('sonnet/high', fullIdPresets, claudeAgent), true);
  // ...and are never silently replaced by the catalog's current model.
  assert.equal(shouldAdoptSdkCurrentModel('claude-sonnet-5-5', 'sonnet', fullIdPresets, claudeAgent), false);
  assert.equal(shouldAdoptSdkCurrentModel('claude-sonnet-5-5', 'sonnet/high', fullIdPresets, claudeAgent), false);

  // Without agent context the previous behavior is unchanged.
  assert.equal(shouldUseStoredAgentModel('sonnet', fullIdPresets), false);
  assert.equal(shouldAdoptSdkCurrentModel('claude-sonnet-5-5', 'sonnet', fullIdPresets), true);

  // Non-claude backends and non-alias stored ids are untouched.
  const opencodeAgent: ExternalAgentConfig = {
    id: 'managed_opencode',
    name: 'OpenCode',
    command: 'opencode',
    enabled: true,
    sdkBackend: 'opencode',
  };
  assert.equal(shouldUseStoredAgentModel('sonnet', fullIdPresets, opencodeAgent), false);
  assert.equal(shouldAdoptSdkCurrentModel('claude-sonnet-5-5', 'gpt-5.5', fullIdPresets, claudeAgent), true);
});

test('a saved Copilot model survives the auto-only degraded fallback', () => {
  const copilotAgent: ExternalAgentConfig = {
    id: 'managed_copilot',
    name: 'GitHub Copilot',
    command: 'copilot',
    enabled: true,
    sdkBackend: 'copilot',
  };
  const autoOnlyFallback: AgentModelPreset[] = [{ id: 'auto', name: 'Auto' }];

  // Live discovery failed (no last-known store yet): the saved explicit model
  // must keep resolving instead of silently switching to `auto`.
  assert.equal(shouldUseStoredAgentModel('claude-sonnet-4.5', autoOnlyFallback, copilotAgent, true), true);
  assert.equal(shouldUseStoredAgentModel('claude-sonnet-4.5/high', autoOnlyFallback, copilotAgent, true), true);
  // Other backends with the same shape are unaffected.
  const opencodeAgent: ExternalAgentConfig = {
    id: 'managed_opencode',
    name: 'OpenCode',
    command: 'opencode',
    enabled: true,
    sdkBackend: 'opencode',
  };
  assert.equal(shouldUseStoredAgentModel('claude-sonnet-4.5', autoOnlyFallback, opencodeAgent), false);
  // Composer custom ids are mixed into the same picker list; the degraded
  // fallback must still be detected with extra rows present.
  const mixedFallback: AgentModelPreset[] = [
    { id: 'auto', name: 'Auto', description: 'Automatic model selection' },
    { id: 'gpt-custom', name: 'gpt-custom' },
  ];
  assert.equal(shouldUseStoredAgentModel('claude-sonnet-4.5', mixedFallback, copilotAgent, true), true);
  assert.equal(modelPresetsContainId(
    appendRetainedStoredModelPreset(mixedFallback, 'claude-sonnet-4.5', copilotAgent, true),
    'claude-sonnet-4.5',
  ), true);
  // A real Copilot catalog (multiple entries with named rows) does not
  // trigger the fallback, mixed or not.
  assert.equal(
    shouldUseStoredAgentModel('claude-sonnet-4.5', [
      { id: 'auto', name: 'Auto' },
      { id: 'gpt-5', name: 'GPT-5' },
    ], copilotAgent),
    false,
  );
  assert.equal(
    shouldUseStoredAgentModel('claude-sonnet-4.5', [
      { id: 'auto', name: 'Auto' },
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'gpt-custom', name: 'gpt-custom' },
    ], copilotAgent),
    false,
  );
});

test('appendRetainedStoredModelPreset makes preserved saved models visible', () => {
  const claudeAgent: ExternalAgentConfig = {
    id: 'managed_claude',
    name: 'Claude Code',
    command: 'claude',
    enabled: true,
    sdkBackend: 'claude',
  };
  const fullIdPresets: AgentModelPreset[] = [{ id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }];

  // A stored claude alias absent from a full-id catalog gains a preset row
  // (reusing the build-time preset so thinking levels come along).
  const withAlias = appendRetainedStoredModelPreset(fullIdPresets, 'sonnet/high', claudeAgent);
  assert.equal(withAlias.length, 2);
  assert.equal(withAlias[1].id, 'sonnet');
  assert.equal(modelPresetsContainId(withAlias, 'sonnet/high'), true);

  // The copilot auto-only degraded fallback keeps a saved explicit model
  // selectable as its own row.
  const copilotAgent: ExternalAgentConfig = {
    id: 'managed_copilot',
    name: 'GitHub Copilot',
    command: 'copilot',
    enabled: true,
    sdkBackend: 'copilot',
  };
  const withCopilot = appendRetainedStoredModelPreset(
    [{ id: 'auto', name: 'Auto' }],
    'claude-sonnet-4.5',
    copilotAgent,
    true,
  );
  assert.deepEqual(withCopilot[1], { id: 'claude-sonnet-4.5', name: 'claude-sonnet-4.5' });

  // An effort-suffixed saved id keeps its full spelling so the appended row
  // matches the selection the send preflight passes.
  const withCopilotSuffix = appendRetainedStoredModelPreset(
    [{ id: 'auto', name: 'Auto' }],
    'claude-sonnet-4.5/high',
    copilotAgent,
    true,
  );
  assert.deepEqual(withCopilotSuffix[1], { id: 'claude-sonnet-4.5/high', name: 'claude-sonnet-4.5/high' });
  assert.equal(modelPresetsContainId(withCopilotSuffix, 'claude-sonnet-4.5/high'), true);

  // A base-only custom row (no thinking levels) does not cover the stored
  // suffixed id, so the exact retained id is appended beside it.
  const baseOnly: AgentModelPreset[] = [
    { id: 'auto', name: 'Auto' },
    { id: 'claude-sonnet-4.5', name: 'claude-sonnet-4.5' },
  ];
  const besideBase = appendRetainedStoredModelPreset(baseOnly, 'claude-sonnet-4.5/high', copilotAgent, true);
  assert.equal(besideBase.length, 3);
  assert.equal(modelPresetsContainId(besideBase, 'claude-sonnet-4.5/high'), true);

  // Listed or non-retained selections are untouched.
  assert.equal(appendRetainedStoredModelPreset(fullIdPresets, 'claude-sonnet-5-5', claudeAgent), fullIdPresets);
  assert.equal(appendRetainedStoredModelPreset(fullIdPresets, 'gpt-5.5', claudeAgent), fullIdPresets);
  assert.equal(appendRetainedStoredModelPreset(fullIdPresets, undefined, claudeAgent), fullIdPresets);
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

test('SDK runtime model cache preserves degraded warnings until a successful retry', async () => {
  const cache = createSdkRuntimeModelCache();
  const degraded = {
    currentModelId: 'auto',
    models: [{ id: 'auto', name: 'Auto' }],
    warning: 'Live discovery failed; serving last-known-good models',
  };
  assert.equal((await cache.refresh('copilot', async () => degraded)).warning, degraded.warning);
  assert.equal(cache.read('copilot')?.warning, degraded.warning);
  assert.equal((await cache.refresh('copilot', async () => {
    assert.fail('A second panel should use the cached catalog within the TTL');
  })).warning, degraded.warning);

  await cache.refresh('copilot', async () => ({
    currentModelId: 'auto',
    models: [{ id: 'auto', name: 'Auto' }],
  }), { force: true });
  assert.equal(cache.read('copilot')?.warning, undefined);
});

// #3584 alignment: OpenCode must render build-time presets while its live
// catalog load is pending, exactly like every other backend. The old host
// code suppressed presets for opencode while `runtimeModelLoading` was set,
// leaving the picker empty until the pull resolved. Guard against it coming
// back: the preset fallback in the panel must not gate on opencode loading.
test('host preset fallback does not suppress presets for a loading opencode catalog', () => {
  const source = readFileSync(new URL('./AIChatSidePanel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /getExternalAgentSdkBackend\(currentAgentConfig\) === 'opencode'[\s\S]*?runtimeModelLoading/);
  // Build-time presets remain the fallback whenever no runtime catalog is
  // active for the agent (loading included).
  assert.match(source, /const presets = getAgentModelPresets\(/);
});

test('reconcileRuntimeModelWarning adds the banner for a warned catalog and keeps unrelated agents', () => {
  const current = { other: { cacheKey: 'k-other', message: 'x' } };
  const next = reconcileRuntimeModelWarning(current, 'copilot', 'k1', true, 'warn');
  assert.deepEqual(next, {
    other: { cacheKey: 'k-other', message: 'x' },
    copilot: { cacheKey: 'k1', message: 'warn' },
  });
});

test('reconcileRuntimeModelWarning returns the same object when nothing changes', () => {
  const current = { copilot: { cacheKey: 'k1', message: 'warn' } };
  assert.equal(reconcileRuntimeModelWarning(current, 'copilot', 'k1', true, 'warn'), current);
  assert.equal(reconcileRuntimeModelWarning({}, 'copilot', 'k1', false, 'warn').copilot, undefined);
});

test('reconcileRuntimeModelWarning clears only the banner that belongs to this cache key', () => {
  const current = { copilot: { cacheKey: 'k1', message: 'warn' } };
  assert.deepEqual(reconcileRuntimeModelWarning(current, 'copilot', 'k1', false, 'warn'), {});
  // A banner that belongs to another cache key (another profile) is not ours to clear.
  assert.equal(reconcileRuntimeModelWarning(current, 'copilot', 'k2', false, 'warn'), current);
});

test('renderer model cache env hints cover every key the main-process catalog cache fingerprints', () => {
  // Both caches must split on the same profile-affecting environment: a key that
  // only the main process knows lets the renderer serve one profile's catalog to another.
  const require = createRequire(import.meta.url);
  const { SDK_MODEL_CACHE_ENV_KEYS } = require('../electron/bridges/aiBridge/sdk/sdkStreamHandlers.cjs') as {
    SDK_MODEL_CACHE_ENV_KEYS: string[];
  };
  const hints = new Set<string>(MODEL_CACHE_ENV_HINTS);
  const missing = SDK_MODEL_CACHE_ENV_KEYS.filter((key) => !hints.has(key));
  assert.deepEqual(missing, []);
});

test('toSdkRuntimeModelCatalog keeps the provenance main reported for a last-known-good serve', () => {
  const catalog = toSdkRuntimeModelCatalog({
    ok: true,
    currentModelId: 'm-1',
    models: [{ id: 'm-1', name: 'M1' }],
    warning: 'live fetch failed',
    source: 'last-known-good',
    fetchedAt: '2026-10-10T08:00:00.000Z',
  });
  assert.deepEqual(catalog, {
    currentModelId: 'm-1',
    models: [{ id: 'm-1', name: 'M1' }],
    warning: 'live fetch failed',
    source: 'last-known-good',
    fetchedAt: '2026-10-10T08:00:00.000Z',
  });
});

test('toSdkRuntimeModelCatalog tolerates an older main without provenance or with unknown values', () => {
  assert.deepEqual(
    toSdkRuntimeModelCatalog({ ok: true, models: [{ id: 'a', name: 'A' }] }),
    { currentModelId: null, models: [{ id: 'a', name: 'A' }], warning: null },
  );
  const odd = toSdkRuntimeModelCatalog({
    ok: true,
    models: [],
    source: 'something-else' as never,
    fetchedAt: 42 as never,
  });
  assert.equal(odd.source, undefined);
  assert.equal(odd.fetchedAt, undefined);
});

test('retainStoredModelPresetForCatalog leaves the built-in fallback list alone when no catalog arrived', () => {
  const claudeAgent = { id: 'claude', command: 'claude', sdkBackend: 'claude' } as unknown as ExternalAgentConfig;
  // The first Claude catalog request failed: nothing to extend. Appending only
  // the saved alias would make a one-row list authoritative and hide the
  // built-in presets, so the empty list must stay empty.
  assert.deepEqual(retainStoredModelPresetForCatalog([], [], 'sonnet', claudeAgent), []);
});

test('retainStoredModelPresetForCatalog drops composer custom rows too when no catalog arrived', () => {
  const claudeAgent = { id: 'claude', command: 'claude', sdkBackend: 'claude' } as unknown as ExternalAgentConfig;
  // The callers wrap the empty catalog with the user's custom composer models, so
  // the list is non-empty even though no catalog arrived. Stored as the runtime
  // list it would still hide the built-in presets; the panel appends custom
  // models on top of the fallback list itself.
  const withCustom = [{ id: 'my-custom-model', name: 'my-custom-model' }];
  assert.deepEqual(retainStoredModelPresetForCatalog([], withCustom, 'sonnet', claudeAgent), []);
});

test('retainStoredModelPresetForCatalog still retains a saved selection on top of a real catalog', () => {
  const claudeAgent = { id: 'claude', command: 'claude', sdkBackend: 'claude' } as unknown as ExternalAgentConfig;
  const catalog = [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }];
  const retained = retainStoredModelPresetForCatalog(catalog, catalog, 'sonnet', claudeAgent);
  assert.deepEqual(retained, appendRetainedStoredModelPreset(catalog, 'sonnet', claudeAgent));
});

test('catalog source adaptation preserves explicit Copilot failure retention', () => {
  const agent = { id: 'copilot', command: 'copilot', sdkBackend: 'copilot' } as ExternalAgentConfig;
  const catalog = toSdkRuntimeModelCatalog({
    ok: true,
    models: [{ id: 'auto', name: 'Auto' }],
    warning: 'live discovery unavailable',
    source: 'last-known-good',
    fetchedAt: '2026-10-15T09:00:00.000Z',
  });
  const presets = retainStoredModelPresetForCatalog(
    catalog.models, catalog.models, 'saved-model', agent, Boolean(catalog.warning),
  );
  assert.deepEqual(presets.map(model => model.id), ['auto', 'saved-model']);
  assert.deepEqual(retainStoredModelPresetForCatalog(
    catalog.models, catalog.models, 'saved-model', agent, false,
  ).map(model => model.id), ['auto']);
});

test('SDK runtime model cache keeps the retry warning when a degraded refresh retains the cached catalog', async () => {
  let now = 1_000;
  const cache = createSdkRuntimeModelCache({ now: () => now });
  const key = 'copilot:/opt/bin/copilot';

  await cache.refresh(key, async () => ({
    currentModelId: 'gpt-5',
    models: [{ id: 'gpt-5', name: 'GPT-5' }],
    source: 'live',
    fetchedAt: '2026-10-15T09:00:00.000Z',
  }));

  now = 2_000;
  const retried = await cache.refresh(
    key,
    async () => ({ currentModelId: null, models: [], warning: 'catalog unavailable' }),
    { force: true },
  );

  assert.deepEqual(retried.models, [{ id: 'gpt-5', name: 'GPT-5' }]);
  assert.equal(retried.warning, 'catalog unavailable');
  assert.equal(retried.source, 'last-known-good');
  assert.equal(retried.fetchedAt, '2026-10-15T09:00:00.000Z');
  // Later reads retain the warning without extending the good catalog's age.
  assert.equal(cache.read(key)?.warning, 'catalog unavailable');
  assert.equal(cache.read(key)?.updatedAt, 1_000);
  const nextRead = await cache.refresh(key, async () => { throw new Error('fresh cache should be reused'); });
  assert.equal(nextRead.warning, 'catalog unavailable');
  assert.equal(nextRead.source, 'last-known-good');
});


test('degraded Copilot selection survives custom rows while live auto-only remains authoritative', () => {
  const agent: ExternalAgentConfig = { id: 'copilot', name: 'Copilot', command: 'copilot', enabled: true, sdkBackend: 'copilot' };
  const customRows = [{ id: 'manual-model', name: 'manual-model' }];
  const retained = appendRetainedStoredModelPreset(customRows, 'saved-model', agent, true);
  assert.equal(modelPresetsContainId(retained, 'saved-model'), true);
  assert.equal(shouldUseStoredAgentModel('saved-model', retained, agent, true), true);
  assert.equal(shouldAdoptSdkCurrentModel('auto', 'saved-model', retained, agent), false);
  const live = [{ id: 'auto', name: 'auto' }];
  assert.equal(appendRetainedStoredModelPreset(live, 'saved-model', agent, false), live);
  assert.equal(shouldUseStoredAgentModel('saved-model', live, agent, false), false);
  assert.equal(shouldAdoptSdkCurrentModel('auto', 'saved-model', live, agent), true);
});

test('renderer catalogs separate supported credential and profile overrides', () => {
  const agent = { id: 'agent', command: '/same/cli', sdkBackend: 'copilot' };
  for (const name of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_INTERNET_ENVIRONMENT', 'XAI_API_KEY', 'GROK_CONFIG_DIR']) {
    const key = buildSdkRuntimeModelCacheKey({ ...agent, env: { [name]: 'fixture-profile-a' } });
    assert.notEqual(key, buildSdkRuntimeModelCacheKey({ ...agent, env: { [name]: 'fixture-profile-b' } }), name);
    assert.doesNotMatch(key, /fixture-profile-a/);
  }
});


test('Copilot successful catalog without current id replaces an unlisted saved choice before failure', () => {
  const agent: ExternalAgentConfig = { id: 'copilot', name: 'Copilot', command: 'copilot', enabled: true, sdkBackend: 'copilot' };
  // Copilot returns an array, so IPC has no currentModelId even on success.
  const live = { models: [{ id: 'auto', name: 'auto' }], currentModelId: null };
  const next = resolveSdkRuntimeCatalogDefaultModelId(live, agent);
  assert.equal(next, 'auto');
  assert.equal(shouldAdoptSdkCurrentModel(next, 'saved-model', live.models, agent), true);
  const laterFailure = appendRetainedStoredModelPreset(live.models, next, agent, true);
  assert.deepEqual(laterFailure, live.models);
  assert.equal(resolveSdkRuntimeCatalogDefaultModelId({ ...live, warning: 'unavailable' }, agent), null);
});
