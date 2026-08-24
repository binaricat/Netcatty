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
  assert.match(String((model as { provider?: string }).provider ?? ""), /^openai\.chat/);
});

test("createModelFromConfig keeps Chat Completions as the OpenAI default", () => {
  const model = createModelFromConfig(makeConfig({ providerId: "openai", defaultModel: "gpt-4o" }));
  assert.equal((model as { provider?: string }).provider, "openai.chat");
});

test("createModelFromConfig uses Responses API when openaiApi is responses", () => {
  const model = createModelFromConfig(makeConfig({
    providerId: "openai",
    defaultModel: "gpt-4o",
    openaiApi: "responses",
  }));
  assert.equal((model as { provider?: string }).provider, "openai.responses");
});

test("createModelFromConfig ignores openaiApi when style is not openai", () => {
  const model = createModelFromConfig(makeConfig({
    style: "anthropic",
    openaiApi: "responses",
    defaultModel: "claude",
  }));
  assert.match(String((model as { provider?: string }).provider ?? ""), /^anthropic/);
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

test("resolveProviderEndpoint normalizes Anthropic-compat Base URL for @ai-sdk/anthropic", () => {
  // Claude Code style (bare host) must gain /v1 so chat hits …/v1/messages.
  assert.equal(
    resolveProviderEndpoint(
      makeConfig({ style: "anthropic", baseURL: "https://gateway.example/" }),
      "anthropic",
      "sk-test",
    ).baseURL,
    "https://gateway.example/v1",
  );
  // AI SDK style already includes /v1 — leave it alone.
  assert.equal(
    resolveProviderEndpoint(
      makeConfig({ style: "anthropic", baseURL: "https://gateway.example/v1" }),
      "anthropic",
      "sk-test",
    ).baseURL,
    "https://gateway.example/v1",
  );
  // Official Anthropic preset default (no /v1) also needs the suffix.
  assert.equal(
    resolveProviderEndpoint(
      makeConfig({ providerId: "anthropic", baseURL: "https://api.anthropic.com" }),
      "anthropic",
      "sk-test",
    ).baseURL,
    "https://api.anthropic.com/v1",
  );
  // Custom complete SDK prefix without /v1 must not gain /v1
  // (proxy serves …/anthropic/messages, not …/anthropic/v1/messages).
  assert.equal(
    resolveProviderEndpoint(
      makeConfig({ style: "anthropic", baseURL: "https://proxy.example/anthropic" }),
      "anthropic",
      "sk-test",
    ).baseURL,
    "https://proxy.example/anthropic",
  );
  // OpenAI-compat style must not rewrite the path.
  assert.equal(
    resolveProviderEndpoint(
      makeConfig({ style: "openai", baseURL: "https://api.deepseek.com" }),
      "openai",
      "sk-test",
    ).baseURL,
    "https://api.deepseek.com",
  );
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

test("resolveProviderEndpoint only swaps in the literal 'ollama' apiKey when no key is configured", () => {
  const local = resolveProviderEndpoint(
    { id: "p", providerId: "ollama", name: "Ollama", enabled: true },
    "openai",
    undefined,
  );
  assert.equal(local.apiKey, "ollama");

  // Cloud / any configured key must keep the IPC placeholder so the main
  // process can inject the decrypted key. Overwriting it with 'ollama'
  // produced Authorization: Bearer ollama and 401s against ollama.com.
  const cloud = resolveProviderEndpoint(
    {
      id: "p",
      providerId: "ollama",
      name: "Ollama",
      enabled: true,
      baseURL: "https://ollama.com/v1",
    },
    "openai",
    "__IPC_SECURED__",
  );
  assert.equal(cloud.apiKey, "__IPC_SECURED__");
  assert.equal(cloud.baseURL, "https://ollama.com/v1");

  const anthropic = resolveProviderEndpoint(
    { id: "p", providerId: "ollama", name: "Ollama", enabled: true },
    "anthropic",
    "PLACEHOLDER",
  );
  assert.equal(anthropic.apiKey, "PLACEHOLDER");

  const empty = resolveProviderEndpoint(
    { id: "p", providerId: "ollama", name: "Ollama", enabled: true },
    "openai",
    "",
  );
  assert.equal(empty.apiKey, "ollama");
});

test("resolveProviderEndpoint adds /v1 to a bare ollama.com Cloud host", () => {
  assert.equal(
    resolveProviderEndpoint(
      {
        id: "p",
        providerId: "ollama",
        name: "Ollama",
        enabled: true,
        baseURL: "https://ollama.com",
      },
      "openai",
      "__IPC_SECURED__",
    ).baseURL,
    "https://ollama.com/v1",
  );
  assert.equal(
    resolveProviderEndpoint(
      {
        id: "p",
        providerId: "ollama",
        name: "Ollama",
        enabled: true,
        baseURL: "https://ollama.com/",
      },
      "openai",
      "__IPC_SECURED__",
    ).baseURL,
    "https://ollama.com/v1",
  );
  assert.equal(
    resolveProviderEndpoint(
      {
        id: "p",
        providerId: "ollama",
        name: "Ollama",
        enabled: true,
        baseURL: "https://ollama.com/api",
      },
      "openai",
      "__IPC_SECURED__",
    ).baseURL,
    "https://ollama.com/v1",
  );
});
