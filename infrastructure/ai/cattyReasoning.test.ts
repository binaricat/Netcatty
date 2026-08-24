import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCattyReasoningProviderOptions,
  cattyReasoningLevelsForSelection,
  estimateReasoningOutputReserve,
  openaiModelLikelySupportsReasoning,
  openaiModelSupportsNoneReasoning,
  resolveVisibleCattyThinkingLevel,
} from './cattyReasoning';

test('buildCattyReasoningProviderOptions is omitted when effort is off', () => {
  assert.equal(
    buildCattyReasoningProviderOptions({ providerId: 'openai' }, 'off'),
    undefined,
  );
  assert.equal(
    buildCattyReasoningProviderOptions({ providerId: 'openai' }, undefined),
    undefined,
  );
});

test('buildCattyReasoningProviderOptions maps OpenAI-compatible effort', () => {
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'deepseek' }, 'high'),
    { openai: { reasoningEffort: 'high' } },
  );
});

test('buildCattyReasoningProviderOptions omits reasoningEffort for non-reasoning OpenAI models', () => {
  assert.equal(
    buildCattyReasoningProviderOptions({ providerId: 'openai' }, 'high', 'gpt-4o'),
    undefined,
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'openai' }, 'high', 'gpt-5.5'),
    { openai: { reasoningEffort: 'high' } },
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'openai' }, 'off', 'o3-mini'),
    { openai: { reasoningEffort: 'low' } },
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'openai' }, 'off', 'gpt-5'),
    { openai: { reasoningEffort: 'minimal' } },
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'openai' }, 'off', 'gpt-5.5'),
    { openai: { reasoningEffort: 'none' } },
  );
  assert.equal(
    buildCattyReasoningProviderOptions({ providerId: 'openai' }, undefined, 'gpt-5.5'),
    undefined,
  );
  assert.equal(openaiModelSupportsNoneReasoning('o4-mini'), false);
  assert.equal(openaiModelSupportsNoneReasoning('gpt-5.1-codex'), true);
  assert.equal(openaiModelSupportsNoneReasoning('gpt-5.1-chat-latest'), false);
});

test('cattyReasoningLevelsForSelection hides the chip unless the model can take effort', () => {
  assert.equal(openaiModelLikelySupportsReasoning('gpt-4o'), false);
  assert.equal(openaiModelLikelySupportsReasoning('gpt-5-chat-latest'), false);
  assert.equal(openaiModelLikelySupportsReasoning('gpt-5.1-chat-latest'), false);
  assert.equal(
    buildCattyReasoningProviderOptions({ providerId: 'openai' }, 'high', 'gpt-5-chat-latest'),
    undefined,
  );
  assert.equal(
    buildCattyReasoningProviderOptions({ providerId: 'openai' }, 'off', 'gpt-5.1-chat-latest'),
    undefined,
  );
  assert.equal(openaiModelLikelySupportsReasoning('gpt-5.5'), true);
  assert.deepEqual(cattyReasoningLevelsForSelection({ providerId: 'openai' }, 'gpt-4o'), []);
  assert.ok(cattyReasoningLevelsForSelection({ providerId: 'openai' }, 'gpt-5.5').includes('high'));
  assert.ok(cattyReasoningLevelsForSelection({ providerId: 'openai' }, 'gpt-5.5').includes('off'));
  assert.equal(
    cattyReasoningLevelsForSelection({ providerId: 'openai' }, 'gpt-5.5'),
    cattyReasoningLevelsForSelection({ providerId: 'openai' }, 'gpt-5.6'),
  );
  assert.deepEqual(
    cattyReasoningLevelsForSelection({ providerId: 'openai' }, 'gpt-5'),
    ['minimal', 'low', 'medium', 'high'],
  );
  assert.deepEqual(
    cattyReasoningLevelsForSelection({ providerId: 'openai' }, 'o3-mini'),
    ['low', 'medium', 'high'],
  );
  assert.deepEqual(cattyReasoningLevelsForSelection({ providerId: 'google' }, 'gemini-1.5-flash'), []);
  assert.deepEqual(
    cattyReasoningLevelsForSelection({ providerId: 'google' }, 'gemini-3-flash'),
    ['minimal', 'low', 'medium', 'high'],
  );
  assert.ok(cattyReasoningLevelsForSelection({ providerId: 'google' }, 'gemini-3-flash').includes('minimal'));
  assert.ok(!cattyReasoningLevelsForSelection({ providerId: 'google' }, 'gemini-3-flash').includes('off'));
  assert.deepEqual(
    cattyReasoningLevelsForSelection({ providerId: 'google' }, 'gemini-3.7-flash'),
    ['low', 'medium', 'high'],
  );
  assert.deepEqual(
    cattyReasoningLevelsForSelection({ providerId: 'google' }, 'gemini-3.1-flash-lite-image'),
    ['minimal', 'high'],
  );
  assert.ok(cattyReasoningLevelsForSelection({ providerId: 'anthropic' }, 'claude-opus-4-6').includes('high'));
  assert.ok(cattyReasoningLevelsForSelection({ providerId: 'anthropic' }, 'claude-sonnet-5').includes('high'));
  assert.deepEqual(
    cattyReasoningLevelsForSelection({ providerId: 'anthropic' }, 'claude-fable-5'),
    ['low', 'medium', 'high'],
  );
  assert.deepEqual(
    cattyReasoningLevelsForSelection({ providerId: 'anthropic' }, 'claude-3-haiku-20240307'),
    [],
  );
  assert.equal(
    buildCattyReasoningProviderOptions({ providerId: 'anthropic' }, 'high', 'claude-3-haiku-20240307'),
    undefined,
  );
  assert.deepEqual(
    cattyReasoningLevelsForSelection({ providerId: 'google' }, 'gemini-3-pro'),
    ['low', 'high'],
  );
  assert.deepEqual(
    cattyReasoningLevelsForSelection({ providerId: 'google' }, 'gemini-3.1-pro-preview'),
    ['low', 'medium', 'high'],
  );
  assert.deepEqual(
    cattyReasoningLevelsForSelection({ providerId: 'google' }, 'gemini-2.5-pro'),
    ['low', 'medium', 'high'],
  );
});

test('resolveVisibleCattyThinkingLevel drops stale levels after a model switch', () => {
  assert.equal(
    resolveVisibleCattyThinkingLevel(['low', 'medium', 'high'], 'minimal'),
    'low',
  );
  assert.equal(
    resolveVisibleCattyThinkingLevel(['minimal', 'low', 'medium', 'high'], 'off'),
    'minimal',
  );
  assert.equal(
    resolveVisibleCattyThinkingLevel(['off', 'low', 'medium', 'high'], 'high'),
    'high',
  );
  assert.equal(
    resolveVisibleCattyThinkingLevel(['low', 'high'], 'medium'),
    'high',
  );
  assert.equal(
    resolveVisibleCattyThinkingLevel(['low', 'medium', 'high'], 'off'),
    'low',
  );
});

test('estimateReasoningOutputReserve folds thinking budgets into the output reserve', () => {
  assert.equal(estimateReasoningOutputReserve(undefined), 0);
  assert.equal(
    estimateReasoningOutputReserve(
      buildCattyReasoningProviderOptions({ providerId: 'anthropic' }, 'high', 'claude-sonnet-4-5'),
    ),
    20_000,
  );
  assert.equal(
    estimateReasoningOutputReserve(
      buildCattyReasoningProviderOptions({ providerId: 'anthropic' }, 'medium', 'claude-3-7-sonnet-20250219'),
    ),
    10_000,
  );
  assert.equal(
    estimateReasoningOutputReserve(
      buildCattyReasoningProviderOptions({ providerId: 'anthropic' }, 'high', 'claude-opus-4-6'),
    ),
    0,
  );
  assert.equal(
    estimateReasoningOutputReserve(
      buildCattyReasoningProviderOptions({ providerId: 'google' }, 'high', 'gemini-2.5-pro'),
    ),
    16_384,
  );
  assert.equal(
    estimateReasoningOutputReserve(
      buildCattyReasoningProviderOptions({ providerId: 'openai' }, 'high', 'gpt-5.5'),
    ),
    0,
  );
});

test('buildCattyReasoningProviderOptions maps Anthropic thinking budgets', () => {
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'anthropic' }, 'medium'),
    { anthropic: { thinking: { type: 'enabled', budgetTokens: 10_000 } } },
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'anthropic' }, 'medium', 'claude-sonnet-4-5'),
    { anthropic: { thinking: { type: 'enabled', budgetTokens: 10_000 } } },
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'anthropic' }, 'high', 'claude-opus-4-20250514'),
    { anthropic: { thinking: { type: 'enabled', budgetTokens: 20_000 } } },
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'anthropic' }, 'high', 'claude-opus-4-6'),
    { anthropic: { thinking: { type: 'adaptive' }, effort: 'high' } },
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'anthropic' }, 'low', 'claude-sonnet-5'),
    { anthropic: { thinking: { type: 'adaptive' }, effort: 'low' } },
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'anthropic' }, 'off', 'claude-sonnet-5'),
    { anthropic: { thinking: { type: 'disabled' } } },
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'anthropic' }, 'off', 'claude-fable-5'),
    { anthropic: { thinking: { type: 'adaptive' }, effort: 'low' } },
  );
  assert.equal(
    buildCattyReasoningProviderOptions({ providerId: 'anthropic' }, 'off', 'claude-sonnet-4-5'),
    undefined,
  );
});

test('buildCattyReasoningProviderOptions respects an explicit style override', () => {
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'custom', style: 'openai' }, 'low'),
    { openai: { reasoningEffort: 'low' } },
  );
});

test('buildCattyReasoningProviderOptions maps Gemini thinking levels', () => {
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'google' }, 'high', 'gemini-3-pro'),
    { google: { thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } } },
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'google' }, 'off', 'gemini-3-pro'),
    { google: { thinkingConfig: { thinkingLevel: 'low', includeThoughts: true } } },
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'google' }, 'medium', 'gemini-3-pro'),
    { google: { thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } } },
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'google' }, 'medium', 'gemini-3.1-pro-preview'),
    { google: { thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true } } },
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'google' }, 'off', 'gemini-3-flash'),
    { google: { thinkingConfig: { thinkingLevel: 'minimal', includeThoughts: false } } },
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'google' }, 'minimal', 'gemini-3.7-flash'),
    { google: { thinkingConfig: { thinkingLevel: 'low', includeThoughts: true } } },
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'google' }, 'off', 'gemini-3.7-flash'),
    { google: { thinkingConfig: { thinkingLevel: 'low', includeThoughts: true } } },
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'google' }, 'low', 'gemini-3.1-flash-lite-image'),
    { google: { thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } } },
  );
  assert.equal(
    buildCattyReasoningProviderOptions({ providerId: 'google' }, undefined, 'gemini-3-flash'),
    undefined,
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'google' }, 'high', 'gemini-2.5-pro'),
    { google: { thinkingConfig: { thinkingBudget: 16_384, includeThoughts: true } } },
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'google' }, 'off', 'gemini-2.5-pro'),
    { google: { thinkingConfig: { thinkingBudget: 1_024, includeThoughts: true } } },
  );
  assert.deepEqual(
    buildCattyReasoningProviderOptions({ providerId: 'google' }, 'off', 'gemini-2.5-flash'),
    { google: { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } } },
  );
  assert.equal(
    buildCattyReasoningProviderOptions({ providerId: 'google' }, undefined, 'gemini-2.5-flash'),
    undefined,
  );
  assert.equal(
    buildCattyReasoningProviderOptions({ providerId: 'google' }, 'high'),
    undefined,
  );
  assert.equal(
    buildCattyReasoningProviderOptions({ providerId: 'google' }, 'high', 'gemini-1.5-flash'),
    undefined,
  );
});
