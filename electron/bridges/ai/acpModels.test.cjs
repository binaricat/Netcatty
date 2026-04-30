const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeAcpSessionModels } = require("./acpModels.cjs");

test("normalizeAcpSessionModels uses ACP config options for model and reasoning selectors", () => {
  const result = normalizeAcpSessionModels({
    models: {
      currentModelId: "gpt-5.5/xhigh",
      availableModels: [
        { modelId: "gpt-5.5/low", name: "GPT 5.5 Low" },
        { modelId: "gpt-5.5/medium", name: "GPT 5.5 Medium" },
        { modelId: "gpt-5.5/high", name: "GPT 5.5 High" },
        { modelId: "gpt-5.5/xhigh", name: "GPT 5.5 Extra High" },
        { modelId: "gpt-5.1-codex-mini/medium", name: "Codex Mini Medium" },
        { modelId: "gpt-5.1-codex-mini/high", name: "Codex Mini High" },
      ],
    },
    configOptions: [
      {
        id: "model",
        category: "model",
        currentValue: "gpt-5.5",
        options: [
          { value: "gpt-5.5", name: "GPT 5.5" },
          { value: "gpt-5.1-codex-mini", name: "Codex Mini", description: "Fast" },
        ],
      },
      {
        id: "reasoning_effort",
        category: "thought_level",
        currentValue: "xhigh",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
          { value: "xhigh", name: "Extra High" },
        ],
      },
    ],
  });

  assert.equal(result.currentModelId, "gpt-5.5/xhigh");
  assert.deepEqual(result.models, [
    {
      id: "gpt-5.5",
      name: "GPT 5.5",
      description: undefined,
      thinkingLevels: ["low", "medium", "high", "xhigh"],
    },
    {
      id: "gpt-5.1-codex-mini",
      name: "Codex Mini",
      description: "Fast",
      thinkingLevels: ["medium", "high"],
    },
  ]);
});

test("normalizeAcpSessionModels flattens grouped ACP config option values", () => {
  const result = normalizeAcpSessionModels({
    models: {
      currentModelId: "gpt-5.4/high",
      availableModels: [
        { modelId: "gpt-5.4/high", name: "GPT 5.4 High" },
      ],
    },
    configOptions: [
      {
        id: "model",
        category: "model",
        currentValue: "gpt-5.4",
        options: [
          {
            name: "Frontier",
            options: [
              { value: "gpt-5.4", name: "GPT 5.4" },
            ],
          },
        ],
      },
      {
        id: "reasoning_effort",
        category: "thought_level",
        currentValue: "high",
        options: [
          {
            name: "Reasoning",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
        ],
      },
    ],
  });

  assert.equal(result.currentModelId, "gpt-5.4/high");
  assert.deepEqual(result.models, [
    {
      id: "gpt-5.4",
      name: "GPT 5.4",
      description: undefined,
      thinkingLevels: ["high"],
    },
  ]);
});

test("normalizeAcpSessionModels infers thinking levels from available model ids", () => {
  const result = normalizeAcpSessionModels({
    models: {
      currentModelId: "gpt-5.4/high",
      availableModels: [
        { modelId: "gpt-5.4/low", name: "GPT 5.4 Low" },
        { modelId: "gpt-5.4/high", name: "GPT 5.4 High" },
      ],
    },
    configOptions: [
      {
        id: "model",
        category: "model",
        currentValue: "gpt-5.4",
        options: [
          { value: "gpt-5.4", name: "GPT 5.4" },
        ],
      },
    ],
  });

  assert.equal(result.currentModelId, "gpt-5.4/high");
  assert.deepEqual(result.models, [
    {
      id: "gpt-5.4",
      name: "GPT 5.4",
      description: undefined,
      thinkingLevels: ["low", "high"],
    },
  ]);
});

test("normalizeAcpSessionModels falls back to legacy ACP models when config options are absent", () => {
  const result = normalizeAcpSessionModels({
    models: {
      currentModelId: "claude-opus-4-5",
      availableModels: [
        { modelId: "claude-opus-4-5", displayName: "Opus 4.5" },
        { modelId: "claude-sonnet-4-5", name: "Sonnet 4.5" },
      ],
    },
  });

  assert.equal(result.currentModelId, "claude-opus-4-5");
  assert.deepEqual(result.models, [
    { id: "claude-opus-4-5", name: "Opus 4.5", description: undefined },
    { id: "claude-sonnet-4-5", name: "Sonnet 4.5", description: undefined },
  ]);
});
