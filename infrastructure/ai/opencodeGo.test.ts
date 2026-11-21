import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPENCODE_GO_DEFAULT_MODEL,
  OPENCODE_GO_PROVIDER_ID,
  isOpencodeGoProvider,
  shouldAutoActivateOpencodeGo,
  withOpencodeGoAutoConfiguredModel,
} from './opencodeGo';
import { PROVIDER_PRESETS } from './types';

test('OpenCode Go ships as a first-class provider preset', () => {
  const preset = PROVIDER_PRESETS[OPENCODE_GO_PROVIDER_ID];
  assert.ok(preset, 'opencode-go preset must exist');
  assert.equal(preset.name, 'OpenCode Go');
  assert.equal(preset.defaultBaseURL, 'https://opencode.ai/inference/go/openai/v1');
  assert.equal(preset.modelsEndpoint, '/models');
  assert.equal(preset.fixedProtocol, true, 'protocol and request format are fixed by the service');
  assert.equal(preset.modelProtocols?.['qwen3.8-max'], 'messages');
  assert.equal(preset.modelProtocols?.['grok-4.7'], 'responses');
  assert.equal(preset.modelProtocols?.['gemini-4-argon'], 'google');
  assert.equal(preset.protocolBaseURLs?.messages, 'https://opencode.ai/inference/go/anthropic/v1');
  assert.equal(preset.protocolBaseURLs?.google, 'https://opencode.ai/inference/go/google/v1beta');
  assert.ok(
    preset.defaultModels?.includes(OPENCODE_GO_DEFAULT_MODEL),
    'the auto-selected model must be offered before discovery runs',
  );
});

test('isOpencodeGoProvider only matches the OpenCode Go preset', () => {
  assert.equal(isOpencodeGoProvider({ providerId: 'opencode-go' }), true);
  assert.equal(isOpencodeGoProvider({ providerId: 'openrouter' }), false);
  assert.equal(isOpencodeGoProvider(null), false);
  assert.equal(isOpencodeGoProvider(undefined), false);
});

test('saving a key without a model picks the OpenCode Go default', () => {
  assert.deepEqual(
    withOpencodeGoAutoConfiguredModel(
      { providerId: 'opencode-go', defaultModel: undefined },
      { apiKey: 'encrypted-key' },
    ),
    { apiKey: 'encrypted-key', defaultModel: OPENCODE_GO_DEFAULT_MODEL },
  );
});

test('auto-config never overrides an existing or explicitly cleared model', () => {
  assert.deepEqual(
    withOpencodeGoAutoConfiguredModel(
      { providerId: 'opencode-go', defaultModel: 'kimi-k3' },
      { apiKey: 'encrypted-key' },
    ),
    { apiKey: 'encrypted-key' },
  );
  assert.deepEqual(
    withOpencodeGoAutoConfiguredModel(
      { providerId: 'opencode-go', defaultModel: undefined },
      { apiKey: 'encrypted-key', defaultModel: 'glm-5.3' },
    ),
    { apiKey: 'encrypted-key', defaultModel: 'glm-5.3' },
  );
  assert.deepEqual(
    withOpencodeGoAutoConfiguredModel(
      { providerId: 'opencode-go', defaultModel: undefined },
      { defaultModel: '' },
    ),
    { defaultModel: '' },
    'without a key there is nothing to configure',
  );
});

test('auto-config leaves other providers untouched', () => {
  assert.deepEqual(
    withOpencodeGoAutoConfiguredModel(
      { providerId: 'openrouter', defaultModel: undefined },
      { apiKey: 'encrypted-key' },
    ),
    { apiKey: 'encrypted-key' },
  );
});

test('auto-activation only kicks in for an inactive OpenCode Go with no active sibling', () => {
  const provider = { providerId: 'opencode-go' as const, enabled: false };
  assert.equal(shouldAutoActivateOpencodeGo(provider, false, true), true);
  assert.equal(shouldAutoActivateOpencodeGo(provider, true, true), false);
  assert.equal(shouldAutoActivateOpencodeGo(provider, false, false), false);
  assert.equal(
    shouldAutoActivateOpencodeGo({ providerId: 'opencode-go', enabled: true }, false, true),
    false,
  );
  assert.equal(
    shouldAutoActivateOpencodeGo({ providerId: 'openrouter', enabled: false }, false, true),
    false,
  );
});
