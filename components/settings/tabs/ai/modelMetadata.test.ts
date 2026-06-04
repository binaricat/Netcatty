import test from "node:test";
import assert from "node:assert/strict";

import {
  mergeModelContextWindow,
  parseFetchedModels,
} from "./modelMetadata.ts";

test("parseFetchedModels reads common context window fields from model list responses", () => {
  assert.deepEqual(
    parseFetchedModels({
      data: [
        { id: "openrouter/model", name: "OpenRouter Model", context_length: 131072 },
        { id: "vercel/model", context_window: 262144 },
        { id: "custom/model", contextWindow: 65536 },
      ],
    }),
    [
      { id: "openrouter/model", name: "OpenRouter Model", contextWindow: 131072 },
      { id: "vercel/model", contextWindow: 262144 },
      { id: "custom/model", contextWindow: 65536 },
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
