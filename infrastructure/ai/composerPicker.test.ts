import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProviderConfig } from './types';
import {
  buildProviderSeedModels,
  filterComposerModels,
  mergeComposerModels,
  normalizeCattyReasoningLevel,
  parseComposerModelPrefs,
  resolveComposerEnterModelId,
  resolveModelSelectionWithThinking,
  resolvePinnedAndRecentModels,
  resolveThinkingSelection,
  toggleComposerPinnedPref,
  upsertComposerPrefFront,
} from './composerPicker';

test('normalizeCattyReasoningLevel falls back to off', () => {
  assert.equal(normalizeCattyReasoningLevel('high'), 'high');
  assert.equal(normalizeCattyReasoningLevel('nope'), 'off');
  assert.equal(normalizeCattyReasoningLevel(undefined), 'off');
});

test('resolveComposerEnterModelId prefers exact id, then the visible custom row', () => {
  const models = [
    { id: 'gpt-5.5', name: 'GPT-5.5' },
    { id: 'gpt-5', name: 'GPT-5' },
    { id: 'llama3', name: 'Llama 3' },
  ];
  const grouped = {
    pinned: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
    recent: [],
    rest: [{ id: 'gpt-5', name: 'GPT-5' }, { id: 'llama3', name: 'Llama 3' }],
  };
  assert.equal(
    resolveComposerEnterModelId({
      query: 'gpt-5',
      models,
      grouped,
      filtered: models,
      showCustom: false,
    }),
    'gpt-5',
  );
  assert.equal(
    resolveComposerEnterModelId({
      query: 'gpt-5',
      models: models.filter((model) => model.id !== 'gpt-5'),
      grouped,
      filtered: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
      showCustom: true,
    }),
    'gpt-5',
  );
  assert.equal(
    resolveComposerEnterModelId({
      query: 'gpt',
      models,
      grouped,
      filtered: [{ id: 'gpt-5.5', name: 'GPT-5.5' }, { id: 'gpt-5', name: 'GPT-5' }],
      showCustom: false,
    }),
    'gpt-5.5',
  );
});

test('filterComposerModels matches id, name, and description', () => {
  const models = [
    { id: 'gpt-5.5', name: 'GPT-5.5', description: 'Balanced' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  ];
  assert.deepEqual(filterComposerModels(models, '5.5').map((m) => m.id), ['gpt-5.5']);
  assert.deepEqual(filterComposerModels(models, 'v4').map((m) => m.id), ['deepseek-v4-pro']);
  assert.deepEqual(filterComposerModels(models, 'balanced').map((m) => m.id), ['gpt-5.5']);
});

test('buildProviderSeedModels includes default plus preset ids', () => {
  const provider: ProviderConfig = {
    id: 'p1',
    providerId: 'deepseek',
    name: 'DeepSeek',
    defaultModel: 'deepseek-chat',
    enabled: true,
  };
  const ids = buildProviderSeedModels(provider).map((model) => model.id);
  assert.ok(ids.includes('deepseek-chat'));
  assert.ok(ids.includes('deepseek-v4-pro'));
});

test('mergeComposerModels prefers a human name over a raw id', () => {
  const merged = mergeComposerModels(
    [{ id: 'gpt-5.5', name: 'gpt-5.5' }],
    [{ id: 'gpt-5.5', name: 'GPT-5.5', description: 'Latest' }],
  );
  assert.deepEqual(merged, [{ id: 'gpt-5.5', name: 'GPT-5.5', description: 'Latest' }]);
});

test('resolveThinkingSelection keeps slashy model ids unless they match a declared effort', () => {
  const presets = [
    { id: 'qwen/qwen3.6-plus', name: 'Qwen 3.6' },
    { id: 'gpt-5.5', name: 'GPT-5.5', thinkingLevels: ['low', 'high'] },
  ];
  assert.deepEqual(resolveThinkingSelection('qwen/qwen3.6-plus', presets), {
    preset: presets[0],
  });
  assert.deepEqual(resolveThinkingSelection('gpt-5.5/high', presets), {
    preset: presets[1],
    thinking: 'high',
  });
  assert.deepEqual(resolveThinkingSelection('gpt-5.5?effort=high', presets), {
    preset: presets[1],
    thinking: 'high',
  });
});

test('resolveModelSelectionWithThinking keeps the current effort when still valid', () => {
  const preset = {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    thinkingLevels: ['low', 'medium', 'high'],
    defaultThinkingLevel: 'medium',
  };
  assert.equal(resolveModelSelectionWithThinking(preset, 'high'), 'gpt-5.5/high');
  assert.equal(resolveModelSelectionWithThinking(preset, 'ultra'), 'gpt-5.5/medium');
  assert.equal(resolveModelSelectionWithThinking({ id: 'haiku', name: 'Haiku' }, 'high'), 'haiku');
  assert.equal(
    resolveModelSelectionWithThinking({
      id: 'glm-5.1',
      name: 'GLM 5.1',
      thinkingLevels: ['low', 'medium', 'high'],
      defaultThinkingLevel: 'medium',
      encodeDefaultThinking: false,
    }),
    'glm-5.1',
  );
});

test('recent and pinned grouping keeps pinned first and drops duplicates from recent', () => {
  const models = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ];
  const grouped = resolvePinnedAndRecentModels({
    models,
    providerId: 'p1',
    prefs: {
      pinned: [{ providerId: 'p1', modelId: 'b' }],
      recent: [
        { providerId: 'p1', modelId: 'b' },
        { providerId: 'p1', modelId: 'a' },
      ],
    },
  });
  assert.deepEqual(grouped.pinned.map((m) => m.id), ['b']);
  assert.deepEqual(grouped.recent.map((m) => m.id), ['a']);
  assert.deepEqual(grouped.rest.map((m) => m.id), ['c']);
});

test('external agent prefs do not resurrect models missing from the catalog', () => {
  const grouped = resolvePinnedAndRecentModels({
    models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
    prefs: {
      pinned: [{ modelId: 'stale-model' }],
      recent: [{ modelId: 'gpt-5.5' }, { modelId: 'also-gone' }],
    },
  });
  assert.deepEqual(grouped.pinned.map((m) => m.id), []);
  assert.deepEqual(grouped.recent.map((m) => m.id), ['gpt-5.5']);
});

test('Catty may keep a custom model that is not in the live catalog', () => {
  const grouped = resolvePinnedAndRecentModels({
    models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    providerId: 'p1',
    allowMissing: true,
    prefs: {
      pinned: [{ providerId: 'p1', modelId: 'my-custom' }],
      recent: [],
    },
  });
  assert.deepEqual(grouped.pinned.map((m) => m.id), ['my-custom']);
});

test('pref helpers upsert and toggle without duplicating keys', () => {
  const recent = upsertComposerPrefFront(
    [{ modelId: 'a' }, { modelId: 'b' }],
    { modelId: 'b' },
    3,
  );
  assert.deepEqual(recent, [{ modelId: 'b' }, { modelId: 'a' }]);
  const pinned = toggleComposerPinnedPref([{ modelId: 'a' }], { modelId: 'a' });
  assert.deepEqual(pinned, []);
});

test('parseComposerModelPrefs drops empty and duplicate entries', () => {
  const parsed = parseComposerModelPrefs({
    recent: [
      { providerId: 'p1', modelId: 'a' },
      { providerId: 'p1', modelId: 'a' },
      { modelId: '  ' },
      { modelId: 'b' },
    ],
    pinned: [{ modelId: 'c' }],
  });
  assert.deepEqual(parsed.recent, [
    { providerId: 'p1', modelId: 'a' },
    { modelId: 'b' },
  ]);
  assert.deepEqual(parsed.pinned, [{ modelId: 'c' }]);
});
