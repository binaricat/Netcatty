import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ComposerModelPicker } from './ComposerModelPicker';

test('Catty picker keeps a single model list and hides other providers until the submenu opens', () => {
  const html = renderToStaticMarkup(
    <ComposerModelPicker
      providers={[
        {
          id: 'p1',
          providerId: 'deepseek',
          name: 'DeepSeek',
          defaultModel: 'deepseek-v4-pro',
          enabled: true,
        },
        {
          id: 'p2',
          providerId: 'openai',
          name: 'OpenAI',
          defaultModel: 'gpt-5.5',
          enabled: true,
        },
      ]}
      selectedProviderId="p1"
      selectedModelId="deepseek-v4-pro"
      prefs={{ recent: [], pinned: [] }}
      onSelectProviderModel={() => {}}
      onTogglePinned={() => {}}
    />,
  );

  assert.match(html, /DeepSeek/);
  assert.match(html, /placeholder="ai\.chat\.searchModels"/);
  assert.match(html, /deepseek-v4-pro/);
  assert.match(html, /aria-label="ai\.chat\.selectProvider"/);
  assert.doesNotMatch(html, /OpenAI/);
  assert.doesNotMatch(html, /w-\[128px\]/);
});

test('external agent picker lists presets without a provider column', () => {
  const html = renderToStaticMarkup(
    <ComposerModelPicker
      modelPresets={[
        { id: 'gpt-5.5', name: 'GPT-5.5' },
        { id: 'gpt-5.4', name: 'GPT-5.4' },
      ]}
      selectedModelId="gpt-5.5"
      prefs={{ recent: [{ modelId: 'gpt-5.5' }], pinned: [] }}
      onSelectModel={() => {}}
      onTogglePinned={() => {}}
    />,
  );

  assert.match(html, /GPT-5\.5/);
  assert.match(html, /GPT-5\.4/);
  assert.match(html, /ai\.chat\.recent/);
  assert.doesNotMatch(html, /ai\.chat\.providers/);
});

test('custom model action is only offered in Catty provider-switcher mode', () => {
  const source = readFileSync(new URL('./ComposerModelPicker.tsx', import.meta.url), 'utf8');
  assert.match(source, /const showCustom = Boolean\(\s*hasProviders/s);
  assert.match(source, /resolveComposerEnterModelId/);
});
