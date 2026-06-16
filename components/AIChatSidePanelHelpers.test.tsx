import test from 'node:test';
import assert from 'node:assert/strict';

import {
  modelPresetsContainId,
  shouldLoadSdkRuntimeModels,
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
  assert.equal(shouldLoadSdkRuntimeModels(agent('codex')), false);
  assert.equal(shouldLoadSdkRuntimeModels(undefined), false);
});
