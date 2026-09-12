import test from 'node:test';
import assert from 'node:assert/strict';
import type { SharedV4ProviderOptions } from '@ai-sdk/provider';

import {
  applyResponsesApiStatelessStoreOption,
  buildCattyReasoningProviderOptions,
  cattyReasoningLevelsForSelection,
  estimateReasoningOutputReserve,
  openaiModelLikelySupportsReasoning,
  openaiModelSupportsNoneReasoning,
  resolveEffectiveCattyReasoningEffort,
  resolveVisibleCattyThinkingLevel,
} from './cattyReasoning';

test('resolveEffectiveCattyReasoningEffort prefers the composer chip over the provider default', () => {
  assert.equal(resolveEffectiveCattyReasoningEffort('low', 'high'), 'low');
  assert.equal(resolveEffectiveCattyReasoningEffort('off', 'high'), 'off');
});

test('resolveEffectiveCattyReasoningEffort falls back to the provider default', () => {
  assert.equal(resolveEffectiveCattyReasoningEffort(undefined, 'high'), 'high');
  assert.equal(resolveEffectiveCattyReasoningEffort(null, ' high '), 'high');
  assert.equal(resolveEffectiveCattyReasoningEffort('', 'HIGH'), 'high');
});

test('resolveEffectiveCattyReasoningEffort drops blank or default provider values', () => {
  assert.equal(resolveEffectiveCattyReasoningEffort(undefined, undefined), undefined);
  assert.equal(resolveEffectiveCattyReasoningEffort(undefined, ''), undefined);
  assert.equal(resolveEffectiveCattyReasoningEffort(undefined, 'default'), undefined);
  assert.equal(resolveEffectiveCattyReasoningEffort(undefined, '  '), undefined);
});

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
    buildCattyReasoningProviderOptions({ providerId: 'custom' as const, style: 'openai' }, 'low'),
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

test('applyResponsesApiStatelessStoreOption sets store:false for OpenAI Responses providers', () => {
  const responsesProvider = { providerId: 'openai' as const, openaiApi: 'responses' as const };
  assert.deepEqual(
    applyResponsesApiStatelessStoreOption(responsesProvider, { openai: { reasoningEffort: 'high' } }),
    { openai: { reasoningEffort: 'high', store: false, include: ['reasoning.encrypted_content'] } },
  );
  // Even with no reasoning options, Responses turns stay stateless
  // and request replayable (encrypted) reasoning.
  assert.deepEqual(
    applyResponsesApiStatelessStoreOption(responsesProvider, undefined),
    { openai: { store: false, include: ['reasoning.encrypted_content'] } },
  );
});

test('applyResponsesApiStatelessStoreOption is a no-op for Chat Completions and other styles', () => {
  assert.deepEqual(
    applyResponsesApiStatelessStoreOption({ providerId: 'openai' as const }, { openai: { reasoningEffort: 'high' } }),
    { openai: { reasoningEffort: 'high' } },
  );
  const chatProvider = { providerId: 'openai' as const, openaiApi: 'chat' as const };
  assert.deepEqual(
    applyResponsesApiStatelessStoreOption(chatProvider, { openai: { reasoningEffort: 'low' } }),
    { openai: { reasoningEffort: 'low' } },
  );
  const anthropicProvider = { providerId: 'openai' as const, openaiApi: 'responses' as const, style: 'anthropic' as const };
  assert.deepEqual(
    applyResponsesApiStatelessStoreOption(anthropicProvider, { anthropic: { thinking: { type: 'adaptive' } } }),
    { anthropic: { thinking: { type: 'adaptive' } } },
  );
  assert.equal(applyResponsesApiStatelessStoreOption(undefined, undefined), undefined);
});

test('applyResponsesApiStatelessStoreOption always requests encrypted reasoning on stateless Responses turns', () => {
  const responsesProvider = { providerId: 'custom' as const, openaiApi: 'responses' as const };
  // Every stateless Responses turn gets the include, covering known reasoner
  // IDs (`deepseek-r1`, `gpt-oss-120b`, `grok-4`, `o3`, `gpt-5.1`) as before,
  // always-thinking relay models whose IDs match no classifier (e.g.
  // DeepSeek's default `deepseek-v4-flash`), and plain chat models — for the
  // latter the include is a no-op (no reasoning items to encrypt).
  assert.deepEqual(
    applyResponsesApiStatelessStoreOption(responsesProvider, undefined),
    { openai: { store: false, include: ['reasoning.encrypted_content'] } },
    'deepseek-v4-flash',
  );
});

test('explicit provider effort exposes controls for a custom OpenAI model', () => {
  const provider = { providerId: 'custom' as const, style: 'openai' as const, advancedParams: { reasoningEffort: 'low' } };
  assert.deepEqual(cattyReasoningLevelsForSelection(provider, 'relay-model'), ['low', 'medium', 'high']);
  assert.deepEqual(cattyReasoningLevelsForSelection({ ...provider, advancedParams: {} }, 'relay-model'), []);
});

test('custom model requests send explicit effort for Chat and Responses and omit it by default', async () => {
  const { createOpenAI } = await import('@ai-sdk/openai');
  for (const api of ['chat', 'responses'] as const) {
    for (const [chip, fallback, expected] of [
      [undefined, 'high', 'high'],
      ['low', 'high', 'low'],
      ['', 'high', 'high'],
      [undefined, undefined, undefined],
      [undefined, 'default', undefined],
    ] as const) {
      let body: Record<string, unknown> | undefined;
      const openai = createOpenAI({ apiKey: 'test', fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        throw new Error('captured request');
      } });
      const provider = { providerId: 'custom' as const, style: 'openai' as const, openaiApi: api, advancedParams: { reasoningEffort: fallback } };
      const options = buildCattyReasoningProviderOptions(provider, resolveEffectiveCattyReasoningEffort(chip, fallback), 'relay-model');
      await assert.rejects(async () => await openai[api]('relay-model').doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        providerOptions: options as SharedV4ProviderOptions,
        temperature: 0.4,
        topP: 0.8,
      }), /captured request/);
      assert.ok(body);
      if (api === 'chat') {
        assert.equal(body.temperature, 0.4);
        assert.equal(body.top_p, 0.8);
      }
      assert.equal(api === 'chat' ? body.reasoning_effort : (body.reasoning as { effort?: string } | undefined)?.effort, expected);
      if (!expected) assert.equal(body.reasoning, undefined);
    }
  }
});


test('provider defaults do not enable reasoning on known unsupported OpenAI models', () => {
  for (const openaiApi of ['chat', 'responses'] as const) {
    const provider = { providerId: 'custom' as const, style: 'openai' as const, openaiApi, advancedParams: { reasoningEffort: 'high' } };
    for (const model of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4-turbo', 'gpt-3.5-turbo', 'openai/gpt-4o', 'gpt-5-chat-latest']) {
      assert.equal(buildCattyReasoningProviderOptions(provider, 'high', model), undefined, model);
      assert.deepEqual(cattyReasoningLevelsForSelection(provider, model), [], model);
    }
  }
});
