import test from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";

import {
  buildCompactedMessages,
  estimateModelMessagesTokens,
  estimateUnknownTokens,
  findSafeCompactionSplitIndex,
  formatMessagesForCompaction,
  prepareContextCompaction,
  resolveContextWindow,
  shouldCompactContext,
} from "./contextCompaction.ts";

test("shouldCompactContext waits until the prompt approaches the context window", () => {
  assert.equal(shouldCompactContext({ promptTokens: 70, contextWindow: 100 }), false);
  assert.equal(shouldCompactContext({ promptTokens: 85, contextWindow: 100 }), true);
});

test("findSafeCompactionSplitIndex keeps recent messages intact", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "old 1" },
    { role: "assistant", content: "old 2" },
    { role: "user", content: "recent 1" },
    { role: "assistant", content: "recent 2" },
  ];

  assert.equal(findSafeCompactionSplitIndex(messages, 2), 2);
});

test("findSafeCompactionSplitIndex avoids orphaning a tool result", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "old" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "run_command",
          input: { command: "pwd" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "run_command",
          output: { type: "text", value: "/tmp" },
        },
      ],
    },
    { role: "user", content: "recent" },
    { role: "assistant", content: "answer" },
  ];

  assert.equal(findSafeCompactionSplitIndex(messages, 3), 1);
});

test("buildCompactedMessages places the summary before recent messages", () => {
  const recentMessages: ModelMessage[] = [
    { role: "user", content: "what next?" },
  ];

  const compacted = buildCompactedMessages({
    summary: "Earlier work is summarized here.",
    recentMessages,
  });

  assert.deepEqual(compacted, [
    {
      role: "user",
      content: "[Previous conversation summary]\n\nEarlier work is summarized here.\n\n[Continue with the recent messages below.]",
    },
    {
      role: "assistant",
      content: "I understand the previous conversation summary and will continue from the recent messages.",
    },
    { role: "user", content: "what next?" },
  ]);
});

test("prepareContextCompaction summarizes old messages and returns compacted context", async () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "old ".repeat(40) },
    { role: "assistant", content: "older ".repeat(40) },
    { role: "user", content: "recent question" },
    { role: "assistant", content: "recent answer" },
  ];

  const result = await prepareContextCompaction({
    messages,
    contextWindow: 100,
    protectRecentMessages: 2,
    summarize: async (messagesToSummarize) => {
      assert.deepEqual(messagesToSummarize, messages.slice(0, 2));
      return "Summary of old messages.";
    },
  });

  assert.equal(result.didCompact, true);
  assert.equal(result.summary, "Summary of old messages.");
  assert.deepEqual(result.messages.slice(-2), messages.slice(-2));
});

test("prepareContextCompaction includes reserved request tokens in the compaction check", async () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "short prompt" },
    { role: "assistant", content: "short answer" },
    { role: "user", content: "recent question" },
  ];

  const result = await prepareContextCompaction({
    messages,
    contextWindow: 40,
    reservedTokens: estimateUnknownTokens("large system prompt ".repeat(20)),
    protectRecentMessages: 1,
    summarize: async (messagesToSummarize) => {
      assert.deepEqual(messagesToSummarize, messages.slice(0, 2));
      return "System prompt forced compaction.";
    },
  });

  assert.equal(result.didCompact, true);
  assert.equal(result.summary, "System prompt forced compaction.");
});

test("prepareContextCompaction summarizes older tool results instead of dropping them first", async () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "check disk usage" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "run_command",
          input: { command: "df -h" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "run_command",
          output: { type: "text", value: "/dev/disk1 81% full" },
        },
      ],
    },
    { role: "assistant", content: "Disk is 81% full." },
    { role: "user", content: "old follow-up ".repeat(80) },
    { role: "assistant", content: "old answer ".repeat(80) },
    { role: "user", content: "recent question" },
    { role: "assistant", content: "recent answer" },
  ];

  const result = await prepareContextCompaction({
    messages,
    contextWindow: 120,
    protectRecentMessages: 2,
    summarize: async (messagesToSummarize) => {
      assert.match(formatMessagesForCompaction(messagesToSummarize), /81% full/);
      return "Earlier disk check showed /dev/disk1 was 81% full.";
    },
  });

  assert.equal(result.didCompact, true);
  assert.match(result.messages[0]?.content as string, /81% full/);
});

test("formatMessagesForCompaction redacts image and file payloads", () => {
  const imagePayload = "iVBORw0KGgo".repeat(200);
  const filePayload = "JVBERi0xLjQK".repeat(200);
  const formatted = formatMessagesForCompaction([
    {
      role: "user",
      content: [
        { type: "text", text: "Please inspect these attachments." },
        {
          type: "image",
          image: imagePayload,
          mediaType: "image/png",
        },
        {
          type: "file",
          data: filePayload,
          filename: "report.pdf",
          mediaType: "application/pdf",
        },
      ],
    },
  ]);

  assert.match(formatted, /Please inspect these attachments/);
  assert.match(formatted, /redacted image payload/);
  assert.match(formatted, /mediaType=image\/png/);
  assert.match(formatted, /redacted file payload/);
  assert.match(formatted, /filename=report\.pdf/);
  assert.doesNotMatch(formatted, new RegExp(imagePayload.slice(0, 40)));
  assert.doesNotMatch(formatted, new RegExp(filePayload.slice(0, 40)));
});

test("formatMessagesForCompaction keeps non-attachment data fields", () => {
  const formatted = formatMessagesForCompaction([
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "read_json",
          output: {
            type: "json",
            value: {
              data: {
                host: "prod-1",
                status: "healthy",
              },
            },
          },
        },
      ],
    },
  ]);

  assert.match(formatted, /prod-1/);
  assert.match(formatted, /healthy/);
  assert.doesNotMatch(formatted, /redacted data payload/);
});

test("estimateModelMessagesTokens counts multimodal and tool content", () => {
  const tokens = estimateModelMessagesTokens([
    { role: "user", content: [{ type: "text", text: "hello world" }] },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "run_command",
          output: { type: "text", value: "result text" },
        },
      ],
    },
  ]);

  assert.ok(tokens >= 5);
});

test("resolveContextWindow prefers manual override, then fetched model metadata, then default", () => {
  assert.equal(
    resolveContextWindow({
      provider: {
        contextWindow: 262144,
        modelContextWindows: { "qwen/test": 131072 },
      },
      modelId: "qwen/test",
      defaultContextWindow: 128000,
    }),
    262144,
  );

  assert.equal(
    resolveContextWindow({
      provider: {
        modelContextWindows: { "qwen/test": 131072 },
      },
      modelId: "qwen/test",
      defaultContextWindow: 128000,
    }),
    131072,
  );

  assert.equal(
    resolveContextWindow({
      provider: {},
      modelId: "unknown",
      defaultContextWindow: 128000,
    }),
    128000,
  );
});
