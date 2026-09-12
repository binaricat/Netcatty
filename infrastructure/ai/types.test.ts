import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLAUDE_MODEL_PRESETS,
  CODEBUDDY_MODEL_PRESETS,
  CODEX_GPT_5_6_MIN_CLI_VERSION,
  CODEX_MODEL_PRESETS,
  CURSOR_MODEL_PRESETS,
  GROK_MODEL_PRESETS,
  extractCliSemver,
  filterAgentModelPresetsForCliVersion,
  getAgentModelPresets,
  resolveAgentCliVersion,
  resolveAgentModelSelection,
  resolveDiscoveredAgentCliVersion,
} from './types';

test('Claude presets advertise effort levels separately from the model id', () => {
  for (const preset of CLAUDE_MODEL_PRESETS) {
    assert.deepEqual(preset.thinkingLevels, ['low', 'medium', 'high', 'max']);
    assert.ok(preset.defaultThinkingLevel);
  }
  assert.equal(resolveAgentModelSelection(CLAUDE_MODEL_PRESETS[0]!), 'default/medium');
});

test('getAgentModelPresets returns CodeBuddy fallback models for command paths', () => {
  assert.deepEqual(
    getAgentModelPresets('/opt/homebrew/bin/codebuddy'),
    CODEBUDDY_MODEL_PRESETS,
  );
  assert.ok(CODEBUDDY_MODEL_PRESETS.some((model) => model.id === 'deepseek-v4-pro'));
});

test('getAgentModelPresets returns Cursor presets for cursor-agent paths and sdkBackend', () => {
  assert.deepEqual(getAgentModelPresets('/Users/me/.local/bin/cursor-agent', 'cursor'), CURSOR_MODEL_PRESETS);
  assert.deepEqual(getAgentModelPresets('/usr/bin/cursor-agent'), CURSOR_MODEL_PRESETS);
  // Bare `agent` is no longer treated as Cursor without an explicit sdkBackend.
  assert.deepEqual(getAgentModelPresets('/Users/me/.local/bin/agent'), []);
  assert.equal(getAgentModelPresets('/Users/me/.local/bin/agent', 'cursor')[0]?.id, 'auto');
  assert.deepEqual(
    getAgentModelPresets(undefined, 'cursor').find((model) => model.id === 'gpt-5.5')?.thinkingLevels,
    ['low', 'medium', 'high'],
  );
  assert.deepEqual(
    getAgentModelPresets(undefined, 'codebuddy')[0]?.thinkingLevels,
    ['low', 'medium', 'high', 'xhigh'],
  );
});

test('getAgentModelPresets keeps Codex presets separate from CodeBuddy presets', () => {
  assert.deepEqual(getAgentModelPresets('codex'), CODEX_MODEL_PRESETS);
  assert.notDeepEqual(CODEBUDDY_MODEL_PRESETS, CODEX_MODEL_PRESETS);
});

test('getAgentModelPresets returns curated Grok fallback when runtime catalog is empty', () => {
  assert.ok(GROK_MODEL_PRESETS.length > 0);
  assert.deepEqual(getAgentModelPresets(undefined, 'grok'), GROK_MODEL_PRESETS);
  assert.deepEqual(getAgentModelPresets('/usr/local/bin/grok'), GROK_MODEL_PRESETS);
  assert.deepEqual(getAgentModelPresets('C:\\\\Tools\\\\grok.exe', 'grok'), GROK_MODEL_PRESETS);
  assert.equal(getAgentModelPresets(undefined, 'grok')[0]?.id, 'grok-4.5');
  assert.deepEqual(getAgentModelPresets(undefined, 'grok')[0]?.thinkingLevels, [
    'high',
    'medium',
    'low',
  ]);
  assert.equal(getAgentModelPresets(undefined, 'grok')[0]?.defaultThinkingLevel, 'high');
  assert.deepEqual(getAgentModelPresets(undefined, 'grok')[1], {
    id: 'grok-4.6',
    name: 'Grok 4.6',
    thinkingLevels: ['xhigh', 'high', 'medium', 'low'],
    defaultThinkingLevel: 'high',
  });
  // Empty/failed runtime catalog path: shared resolver still yields a non-empty list.
  const runtimeCatalog: Array<{ id: string; name: string }> = [];
  const resolved = runtimeCatalog.length > 0
    ? runtimeCatalog
    : getAgentModelPresets('grok', 'grok');
  assert.ok(resolved.length > 0);
  assert.deepEqual(resolved, GROK_MODEL_PRESETS);
});

test('CODEX_MODEL_PRESETS lists GPT-5.6 Sol/Terra/Luna with official reasoning levels', () => {
  const byId = Object.fromEntries(CODEX_MODEL_PRESETS.map((model) => [model.id, model]));
  assert.deepEqual(
    CODEX_MODEL_PRESETS.map((model) => model.id),
    [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.2',
    ],
  );
  assert.equal(byId['gpt-5.6-sol']?.description, 'Latest');
  assert.equal(byId['gpt-5.6-sol']?.defaultThinkingLevel, 'low');
  assert.equal(byId['gpt-5.6-terra']?.defaultThinkingLevel, 'medium');
  assert.equal(byId['gpt-5.6-luna']?.defaultThinkingLevel, 'medium');
  assert.deepEqual(byId['gpt-5.6-sol']?.thinkingLevels, [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
  ]);
  assert.deepEqual(byId['gpt-5.6-terra']?.thinkingLevels, [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
  ]);
  // Luna omits ultra per openai/codex models-manager catalog (+ lobehub).
  assert.deepEqual(byId['gpt-5.6-luna']?.thinkingLevels, [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  assert.deepEqual(byId['gpt-5.5']?.thinkingLevels, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(byId['gpt-5.4']?.thinkingLevels, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(byId['gpt-5.4-mini']?.thinkingLevels, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(byId['gpt-5.2']?.thinkingLevels, ['low', 'medium', 'high', 'xhigh']);
});

test('resolveAgentModelSelection uses catalog default effort, not last array entry', () => {
  assert.equal(resolveAgentModelSelection(CODEX_MODEL_PRESETS[0]!), 'gpt-5.6-sol/low');
  assert.equal(
    resolveAgentModelSelection(CODEX_MODEL_PRESETS.find((m) => m.id === 'gpt-5.6-terra')!),
    'gpt-5.6-terra/medium',
  );
  assert.equal(
    resolveAgentModelSelection({
      id: 'custom',
      name: 'Custom',
      thinkingLevels: ['low', 'high'],
    }),
    'custom/low',
  );
  assert.equal(
    resolveAgentModelSelection({ id: 'plain', name: 'Plain' }),
    'plain',
  );
  assert.equal(
    resolveAgentModelSelection({
      id: 'glm-5.1',
      name: 'GLM 5.1',
      thinkingLevels: ['low', 'medium', 'high'],
      defaultThinkingLevel: 'medium',
      encodeDefaultThinking: false,
    }),
    'glm-5.1',
  );
});

test('filterAgentModelPresetsForCliVersion gates GPT-5.6 on CLI < 0.144.0', () => {
  assert.equal(extractCliSemver('codex-cli 0.136.0'), '0.136.0');
  assert.equal(CODEX_GPT_5_6_MIN_CLI_VERSION, '0.144.0');

  const oldCli = filterAgentModelPresetsForCliVersion(CODEX_MODEL_PRESETS, '0.136.0');
  assert.deepEqual(
    oldCli.map((model) => model.id),
    ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2'],
  );
  assert.equal(resolveAgentModelSelection(oldCli[0]!), 'gpt-5.5/medium');

  const newCli = filterAgentModelPresetsForCliVersion(CODEX_MODEL_PRESETS, 'codex-cli 0.144.1');
  assert.equal(newCli[0]?.id, 'gpt-5.6-sol');

  // Unknown version: hide version-gated models so pre-discovery cannot
  // auto-default old installs onto Sol. Ungated presets keep the picker usable.
  assert.deepEqual(
    filterAgentModelPresetsForCliVersion(CODEX_MODEL_PRESETS, undefined).map((m) => m.id),
    ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2'],
  );
});

test('resolveDiscoveredAgentCliVersion matches command path or sdk backend', () => {
  assert.equal(
    resolveDiscoveredAgentCliVersion(
      { command: '/usr/local/bin/codex', sdkBackend: 'codex' },
      [{ command: 'codex', path: '/usr/local/bin/codex', binPath: '/usr/local/bin/codex', sdkBackend: 'codex', version: '0.144.1' }],
    ),
    '0.144.1',
  );
  // Manual path must not inherit PATH discovery version for a different binary.
  assert.equal(
    resolveDiscoveredAgentCliVersion(
      { command: '/opt/old/codex', sdkBackend: 'codex' },
      [{ command: 'codex', path: '/usr/local/bin/codex', binPath: '/usr/local/bin/codex', sdkBackend: 'codex', version: '0.144.1' }],
    ),
    undefined,
  );
  assert.equal(
    resolveDiscoveredAgentCliVersion(
      { command: 'codex', sdkBackend: 'codex' },
      [{ command: 'claude', path: '/bin/claude', binPath: '/bin/claude', sdkBackend: 'claude', version: '1.0.0' }],
    ),
    undefined,
  );
  assert.equal(
    resolveDiscoveredAgentCliVersion(
      { command: 'codex', sdkBackend: 'codex' },
      [{ command: 'codex', path: '/usr/local/bin/codex', binPath: '/usr/local/bin/codex', sdkBackend: 'codex', version: '0.144.1' }],
    ),
    '0.144.1',
  );
});

test('resolveAgentCliVersion prefers stored cliVersion over discovery', () => {
  assert.equal(
    resolveAgentCliVersion(
      { command: '/opt/custom/codex', sdkBackend: 'codex', cliVersion: 'codex-cli 0.144.3' },
      [{ command: 'codex', path: '/usr/local/bin/codex', binPath: '/usr/local/bin/codex', sdkBackend: 'codex', version: '0.136.0' }],
    ),
    'codex-cli 0.144.3',
  );
  // Custom path with stored probe unlocks GPT-5.6 even when not on PATH.
  const gated = filterAgentModelPresetsForCliVersion(
    CODEX_MODEL_PRESETS,
    resolveAgentCliVersion(
      { command: '/opt/custom/codex', sdkBackend: 'codex', cliVersion: '0.144.0' },
      [],
    ),
  );
  assert.equal(gated[0]?.id, 'gpt-5.6-sol');
});

test('getAgentModelPresets resolves Windows command paths with backslashes', () => {
  assert.deepEqual(
    getAgentModelPresets('C\\Users\\foo\\AppData\\Roaming\\npm\\codex.cmd'),
    CODEX_MODEL_PRESETS,
  );
  assert.deepEqual(
    getAgentModelPresets('C\\Program Files\\nodejs\\claude.exe'),
    CLAUDE_MODEL_PRESETS,
  );
});
