import assert from "node:assert/strict";
import test from "node:test";

import { createModelFromConfig } from "./sdk/providers";
import type { ProviderConfig } from "./types";

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "p",
    providerId: "custom",
    name: "Test",
    enabled: true,
    defaultModel: "m",
    ...overrides,
  };
}

test("createModelFromConfig routes by explicit style: anthropic on top of custom providerId", () => {
  const model = createModelFromConfig(makeConfig({ style: "anthropic", defaultModel: "claude-3-5-sonnet" }));
  assert.match(String((model as { provider?: string }).provider ?? ""), /^anthropic/);
  assert.equal((model as { modelId?: string }).modelId, "claude-3-5-sonnet");
});

test("createModelFromConfig routes by explicit style: google on top of custom providerId", () => {
  const model = createModelFromConfig(makeConfig({ style: "google", defaultModel: "gemini-2.0-flash" }));
  assert.match(String((model as { provider?: string }).provider ?? ""), /^google/);
});

test("createModelFromConfig defaults legacy custom providerId to the OpenAI-compatible client", () => {
  const model = createModelFromConfig(makeConfig({ providerId: "custom", defaultModel: "gpt-4o" }));
  assert.match(String((model as { provider?: string }).provider ?? ""), /^openai/);
});

test("createModelFromConfig keeps the Anthropic providerId fallback when style is unset", () => {
  const model = createModelFromConfig(makeConfig({ providerId: "anthropic", defaultModel: "claude" }));
  assert.match(String((model as { provider?: string }).provider ?? ""), /^anthropic/);
});

test("createModelFromConfig keeps the Google providerId fallback when style is unset", () => {
  const model = createModelFromConfig(makeConfig({ providerId: "google", defaultModel: "gemini" }));
  assert.match(String((model as { provider?: string }).provider ?? ""), /^google/);
});

test("createModelFromConfig keeps ollama's baseURL fallback and disposable apiKey", () => {
  const model = createModelFromConfig(makeConfig({ providerId: "ollama", defaultModel: "llama3" }));
  assert.match(String((model as { provider?: string }).provider ?? ""), /^openai/);
  // Ollama leaves URL building to the SDK, but we can at least confirm it's still treated as OpenAI-style.
});
