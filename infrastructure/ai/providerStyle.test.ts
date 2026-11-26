import assert from "node:assert/strict";
import test from "node:test";

import { PROVIDER_PRESETS, resolveOpenAIApi, resolveProviderDiscoveryStyle, resolveProviderStyle } from "./types";

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
  for (const providerId of ["openai", "ollama", "openrouter", "opencode-go", "qwen", "deepseek", "kimi", "zhipu", "doubao", "mimo", "martllm", "custom"] as const) {
    assert.equal(resolveProviderStyle({ providerId }), "openai", `expected openai for ${providerId}`);
  }
});

test("resolveOpenAIApi defaults missing and unknown values to Chat Completions", () => {
  assert.equal(resolveOpenAIApi({}), "chat");
  assert.equal(resolveOpenAIApi({ openaiApi: "chat" }), "chat");
  assert.equal(resolveOpenAIApi({ openaiApi: "responses" }), "responses");
  assert.equal(resolveOpenAIApi({ openaiApi: "weird" as "chat" }), "chat");
});

test("fixed-protocol providers ignore stale style and request-format overrides", () => {
  assert.equal(resolveProviderStyle({ providerId: "opencode-go", style: "anthropic" }), "openai");
  assert.equal(resolveProviderStyle({ providerId: "opencode-go", style: "google" }), "openai");
  assert.equal(resolveOpenAIApi({ providerId: "opencode-go", openaiApi: "responses" }), "chat");
  assert.equal(resolveOpenAIApi({ providerId: "opencode-go", openaiApi: "chat" }), "chat");
});

test("OpenCode Go routes each model to its native wire protocol", () => {
  assert.equal(resolveProviderStyle({ providerId: "opencode-go", defaultModel: "kimi-k3" }), "openai");
  assert.equal(resolveOpenAIApi({ providerId: "opencode-go", defaultModel: "kimi-k3" }), "chat");
  assert.equal(resolveProviderStyle({ providerId: "opencode-go", defaultModel: "grok-4.7" }), "openai");
  assert.equal(resolveOpenAIApi({ providerId: "opencode-go", defaultModel: "grok-4.7" }), "responses");
  assert.equal(resolveProviderStyle({ providerId: "opencode-go", defaultModel: "qwen3.8-max" }), "anthropic");
  assert.equal(resolveProviderStyle({ providerId: "opencode-go" }, "claude-haiku-5-5"), "anthropic");
  assert.equal(resolveProviderStyle({ providerId: "opencode-go", defaultModel: "gemini-4-argon" }), "google");
  assert.equal(resolveProviderStyle({ providerId: "opencode-go", defaultModel: "future-model" }), "openai");
});

test("model discovery for fixed-protocol providers stays on the OpenAI prefix", () => {
  assert.equal(
    resolveProviderDiscoveryStyle({ providerId: "opencode-go", defaultModel: "qwen3.8-max" }),
    "openai",
  );
  assert.equal(resolveProviderDiscoveryStyle({ providerId: "deepseek" }), "openai");
  assert.equal(resolveProviderDiscoveryStyle({ providerId: "anthropic" }), "anthropic");
});

test("domestic provider presets include editable OpenAI-compatible base URLs", () => {
  assert.equal(PROVIDER_PRESETS.qwen.defaultBaseURL, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(PROVIDER_PRESETS.deepseek.defaultBaseURL, "https://api.deepseek.com/v1");
  assert.equal(PROVIDER_PRESETS.kimi.defaultBaseURL, "https://api.moonshot.ai/v1");
  assert.equal(PROVIDER_PRESETS.zhipu.defaultBaseURL, "https://open.bigmodel.cn/api/paas/v4");
  assert.equal(PROVIDER_PRESETS.doubao.defaultBaseURL, "https://ark.cn-beijing.volces.com/api/v3");
  assert.equal(PROVIDER_PRESETS.mimo.defaultBaseURL, "https://api.xiaomimimo.com/v1");
});

test("openrouter keeps dynamic model discovery instead of a static preset list", () => {
  assert.equal(PROVIDER_PRESETS.openrouter.defaultBaseURL, "https://openrouter.ai/api/v1");
  assert.equal(PROVIDER_PRESETS.openrouter.modelsEndpoint, "/models");
  assert.equal(PROVIDER_PRESETS.openrouter.defaultModels, undefined);
});

test("martllm keeps dynamic model discovery on its OpenAI-compatible base URL", () => {
  assert.equal(PROVIDER_PRESETS.martllm.defaultBaseURL, "https://api.martllm.com/v1");
  assert.equal(PROVIDER_PRESETS.martllm.modelsEndpoint, "/models");
  assert.equal(PROVIDER_PRESETS.martllm.defaultModels, undefined);
  assert.equal(resolveProviderDiscoveryStyle({ providerId: "martllm" }), "openai");
});

test("domestic provider presets expose provider-specific model suggestions", () => {
  assert.equal(PROVIDER_PRESETS.qwen.defaultModels?.[0], "qwen3.7-plus");
  assert.ok(PROVIDER_PRESETS.qwen.defaultModels?.includes("qwen3.7-max"));
  assert.equal(PROVIDER_PRESETS.deepseek.defaultModels?.[0], "deepseek-v4-flash");
  assert.ok(PROVIDER_PRESETS.kimi.defaultModels?.includes("kimi-k2.6"));
  assert.ok(PROVIDER_PRESETS.zhipu.defaultModels?.includes("glm-5.1"));
  assert.ok(PROVIDER_PRESETS.doubao.defaultModels?.includes("doubao-seed-2-0-pro-260215"));
  assert.ok(!PROVIDER_PRESETS.doubao.defaultModels?.some((model) => model.startsWith("ep-")));
  assert.ok(PROVIDER_PRESETS.mimo.defaultModels?.includes("mimo-v2.5-pro"));
  assert.equal(PROVIDER_PRESETS.custom.defaultModels, undefined);
});
