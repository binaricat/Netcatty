import test from "node:test";
import assert from "node:assert/strict";

import {
  mergeModelContextWindow,
  parseFetchedModels,
} from "./modelMetadata.ts";
import { buildModelSuggestions } from "./ModelSelector.tsx";

test("parseFetchedModels reads common context window fields from model list responses", () => {
  assert.deepEqual(
    parseFetchedModels({
      data: [
        { id: "openrouter/model", name: "OpenRouter Model", context_length: 131072 },
        { id: "vercel/model", context_window: 262144 },
        { id: "custom/model", contextWindow: 65536 },
        { id: "opencode-go/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", limit: { context: 1000000, output: 384000 } },
      ],
    }),
    [
      { id: "openrouter/model", name: "OpenRouter Model", contextWindow: 131072 },
      { id: "vercel/model", contextWindow: 262144 },
      { id: "custom/model", contextWindow: 65536 },
      { id: "opencode-go/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextWindow: 1000000 },
    ],
  );
});

test("mergeModelContextWindow stores valid discovered model windows only", () => {
  assert.deepEqual(
    mergeModelContextWindow(undefined, "qwen", 262144),
    { qwen: 262144 },
  );
  assert.deepEqual(
    mergeModelContextWindow({ old: 8192 }, "qwen", undefined),
    { old: 8192 },
  );
});

test("buildModelSuggestions uses provider presets before fetched model discovery", () => {
  assert.deepEqual(
    buildModelSuggestions({
      presetModels: ["qwen3.6-plus", "qwen3.6-flash"],
      fetchedModels: [],
      hasFetched: false,
      value: "plus",
    }),
    [{ id: "qwen3.6-plus" }],
  );
});

test("buildModelSuggestions merges fetched and preset models without duplicates", () => {
  assert.deepEqual(
    buildModelSuggestions({
      presetModels: ["kimi-k2.6", "moonshot-v1-128k"],
      fetchedModels: [
        { id: "kimi-k2.6", name: "Kimi K2.6" },
        { id: "moonshot-v1-8k", name: "Moonshot 8K" },
      ],
      hasFetched: true,
      value: "",
    }).map((model) => model.id),
    ["kimi-k2.6", "moonshot-v1-128k", "moonshot-v1-8k"],
  );
});
