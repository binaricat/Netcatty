import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readDiscoveredModelVisionSupport } from './discoveredModelMetadata';
import {
  inferModelVisionSupport,
  isVisionUnsupportedProviderError,
  resolveModelVisionSupport,
} from './visionCapability';

describe('discoveredModelMetadata vision support parsing', () => {
  it('parses OpenRouter architecture input_modalities and modality strings', () => {
    assert.equal(
      readDiscoveredModelVisionSupport({
        id: 'anthropic/claude-sonnet-4',
        architecture: { input_modalities: ['text', 'image'] },
      }),
      true,
    );
    assert.equal(
      readDiscoveredModelVisionSupport({
        id: 'deepseek/deepseek-r1',
        architecture: { input_modalities: ['text'] },
      }),
      false,
    );
    assert.equal(
      readDiscoveredModelVisionSupport({
        id: 'openai/gpt-4o',
        architecture: { modality: 'text+image->text' },
      }),
      true,
    );
    assert.equal(
      readDiscoveredModelVisionSupport({
        id: 'deepseek/deepseek-chat',
        architecture: { modality: 'text->text' },
      }),
      false,
    );
  });

  it('parses Ollama and OpenAI-compatible capabilities metadata', () => {
    assert.equal(
      readDiscoveredModelVisionSupport({ id: 'llava:13b', capabilities: ['completion', 'vision'] }),
      true,
    );
    assert.equal(
      readDiscoveredModelVisionSupport({ id: 'custom-v', capabilities: { vision: true } }),
      true,
    );
    assert.equal(
      readDiscoveredModelVisionSupport({ id: 'custom-text', capabilities: { vision: false } }),
      false,
    );
    assert.equal(
      readDiscoveredModelVisionSupport({ id: 'custom-relay-model' }),
      undefined,
    );
  });
});

describe('visionCapability resolver', () => {
  it('classifies well-known multimodal model families as yes', () => {
    const visionModels = [
      ['openai', 'gpt-4o'],
      ['openai', 'gpt-4.1-mini'],
      ['openai', 'gpt-5.4/high'],
      ['openai', 'o3'],
      ['openai', 'o4-mini'],
      ['anthropic', 'claude-sonnet-4-20250514'],
      ['anthropic', 'claude-3-7-sonnet-latest'],
      ['google', 'gemini-2.5-pro'],
      ['qwen', 'qwen2.5-vl-72b-instruct'],
      ['openrouter', 'qwen/qwen3.6-plus:free'],
      ['zhipu', 'glm-4.6v'],
      ['kimi', 'kimi-k2.5'],
      ['doubao', 'doubao-seed-1-6'],
      ['ollama', 'llava:latest'],
      ['ollama', 'llama-3.2-11b-vision-instruct'],
      ['openrouter', 'mistralai/pixtral-large-2411'],
      ['custom', 'deepseek-vl2'],
    ] as const;

    for (const [providerId, modelId] of visionModels) {
      assert.equal(
        inferModelVisionSupport(providerId, modelId),
        'yes',
        `expected ${providerId}/${modelId} to be vision-capable`,
      );
    }
  });

  it('classifies well-known text-only model families as no', () => {
    const textOnlyModels = [
      ['deepseek', 'deepseek-chat'],
      ['deepseek', 'deepseek-reasoner'],
      ['openrouter', 'deepseek/deepseek-r1:free'],
      ['openai', 'o3-mini'],
      ['openai', 'o1-mini'],
      ['qwen', 'qwen3-coder-plus'],
      ['openrouter', 'mistralai/codestral-2501'],
      ['ollama', 'llama3.1:8b'],
      ['ollama', 'llama-3.3-70b-instruct'],
      ['openrouter', 'mistralai/mistral-large-2411'],
    ] as const;

    for (const [providerId, modelId] of textOnlyModels) {
      assert.equal(
        inferModelVisionSupport(providerId, modelId),
        'no',
        `expected ${providerId}/${modelId} to be text-only`,
      );
    }
  });

  it('returns unknown for custom/unrecognized relays so they are never hard-blocked', () => {
    assert.equal(inferModelVisionSupport('custom', 'my-internal-relay-v2'), 'unknown');
    assert.equal(inferModelVisionSupport('ollama', 'my-finetune:latest'), 'unknown');
    assert.equal(inferModelVisionSupport(undefined, ''), 'unknown');
  });

  it('prefers authoritative discovered metadata over heuristic guesses', () => {
    assert.equal(
      resolveModelVisionSupport({
        providerId: 'custom',
        modelId: 'my-internal-relay-v2',
        discoveredModel: { architecture: { input_modalities: ['text', 'image'] } },
      }),
      'yes',
    );
    assert.equal(
      resolveModelVisionSupport({
        providerId: 'openai',
        modelId: 'gpt-4o',
        supportsVision: false,
      }),
      'no',
    );
  });

  it('detects provider image-unsupported error messages', () => {
    assert.equal(isVisionUnsupportedProviderError(new Error('Model does not support image input')), true);
    assert.equal(isVisionUnsupportedProviderError('image_url is not supported by this model'), true);
    assert.equal(isVisionUnsupportedProviderError(new Error('Rate limit exceeded')), false);
  });
});
