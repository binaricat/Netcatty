import assert from "node:assert/strict";
import test from "node:test";

import { resolveProviderStyle } from "./types";

test("resolveProviderStyle prefers an explicit style override", () => {
  assert.equal(resolveProviderStyle({ providerId: "custom", style: "anthropic" }), "anthropic");
  assert.equal(resolveProviderStyle({ providerId: "openai", style: "google" }), "google");
});

test("resolveProviderStyle falls back to providerId for anthropic", () => {
  assert.equal(resolveProviderStyle({ providerId: "anthropic" }), "anthropic");
});

test("resolveProviderStyle falls back to providerId for google", () => {
  assert.equal(resolveProviderStyle({ providerId: "google" }), "google");
});

test("resolveProviderStyle treats every other providerId as the OpenAI-compatible family", () => {
  for (const providerId of ["openai", "ollama", "openrouter", "custom"] as const) {
    assert.equal(resolveProviderStyle({ providerId }), "openai", `expected openai for ${providerId}`);
  }
});
