import assert from "node:assert/strict";
import test from "node:test";

import { createModelFromConfig, resolveProviderEndpoint } from "./sdk/providers";
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

test("resolveProviderEndpoint applies the openrouter URL fallback for every style override", () => {
  // Regression for codex feedback on #1105: gating the fallback on
  // style === 'openai' silently misrouted traffic away from openrouter.ai
  // when users overrode the wire format.
  for (const style of ["openai", "anthropic", "google"] as const) {
    const result = resolveProviderEndpoint(
      { id: "p", providerId: "openrouter", name: "OR", enabled: true },
      style,
      "sk-test",
    );
    assert.equal(result.baseURL, "https://openrouter.ai/api/v1", `style=${style} should still hit openrouter.ai`);
  }
});

test("resolveProviderEndpoint keeps an explicit openrouter baseURL untouched", () => {
  const result = resolveProviderEndpoint(
    { id: "p", providerId: "openrouter", name: "OR", enabled: true, baseURL: "https://proxy.example/v1" },
    "anthropic",
    "sk-test",
  );
  assert.equal(result.baseURL, "https://proxy.example/v1");
});

test("resolveProviderEndpoint applies the ollama URL fallback for every style override", () => {
  for (const style of ["openai", "anthropic", "google"] as const) {
    const result = resolveProviderEndpoint(
      { id: "p", providerId: "ollama", name: "Ollama", enabled: true },
      style,
      undefined,
    );
    assert.equal(result.baseURL, "http://localhost:11434/v1", `style=${style} should still hit localhost ollama`);
  }
});

test("resolveProviderEndpoint only swaps in the literal 'ollama' apiKey on the OpenAI-compat client", () => {
  const openai = resolveProviderEndpoint(
    { id: "p", providerId: "ollama", name: "Ollama", enabled: true },
    "openai",
    "PLACEHOLDER",
  );
  assert.equal(openai.apiKey, "ollama");

  // For Anthropic/Google styles the user supplied a real key; preserve it
  // verbatim so the SDK forwards the right header instead of "ollama".
  const anthropic = resolveProviderEndpoint(
    { id: "p", providerId: "ollama", name: "Ollama", enabled: true },
    "anthropic",
    "PLACEHOLDER",
  );
  assert.equal(anthropic.apiKey, "PLACEHOLDER");
});
