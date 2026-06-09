import test from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";

import {
  DEFAULT_MAX_REQUEST_PAYLOAD_BYTES,
  compressVerboseText,
  estimateUtf8Bytes,
  fitMessagesToRequestPayloadBudget,
  truncateTextWithHeadAndTail,
} from "./requestPayloadBudget.ts";

test("compressVerboseText collapses repeated blank lines and duplicate runs", () => {
  const input = "line1\n\n\n\n\nline2\nsame\nsame\nsame\nsame\nline3";
  const output = compressVerboseText(input);
  assert.match(output, /line1\n\n\nline2/);
  assert.ok(output.split("\nsame\n").length <= 3);
});

test("truncateTextWithHeadAndTail keeps both ends of long terminal output", () => {
  const value = `${"A".repeat(500)}${"B".repeat(20_000)}${"C".repeat(500)}`;
  const truncated = truncateTextWithHeadAndTail(value, 2_000);
  assert.ok(truncated.startsWith("AAA"));
  assert.ok(truncated.includes("[... output truncated for request size ...]"));
  assert.ok(truncated.endsWith("CCC"));
  assert.ok(truncated.length <= 2_000);
});

test("fitMessagesToRequestPayloadBudget truncates verbose tool results before dropping recent turns", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "run build" },
    {
      role: "assistant",
      content: [{
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "terminal_execute",
        input: { command: "npm run build" },
      }],
    },
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "terminal_execute",
        output: { type: "text", value: "X".repeat(200_000) },
      }],
    },
    { role: "user", content: "what failed?" },
  ];

  const result = fitMessagesToRequestPayloadBudget({
    messages,
    maxPayloadBytes: 20_000,
    reservedBytes: 2_000,
    maxToolResultChars: 4_000,
    protectRecentMessages: 4,
  });

  assert.equal(result.messages.length, 4);
  const toolMessage = result.messages[2];
  assert.equal(toolMessage.role, "tool");
  assert.ok(Array.isArray(toolMessage.content));
  const toolPart = toolMessage.content[0] as { output?: { value?: string } };
  assert.ok((toolPart.output?.value?.length ?? 0) < 5_000);
  assert.ok(result.estimatedBytes <= 20_000);
});

test("fitMessagesToRequestPayloadBudget drops older turns when truncation alone is insufficient", () => {
  const messages: ModelMessage[] = [];
  for (let turn = 0; turn < 12; turn += 1) {
    messages.push({ role: "user", content: `question ${turn}` });
    messages.push({ role: "assistant", content: `answer ${turn} ${"Z".repeat(20_000)}` });
  }
  messages.push({ role: "user", content: "latest question" });

  const result = fitMessagesToRequestPayloadBudget({
    messages,
    maxPayloadBytes: 8_000,
    reservedBytes: 500,
    protectRecentMessages: 4,
    maxMessageTextChars: 2_000,
  });

  assert.ok(result.messages.length < messages.length);
  assert.equal(result.messages.at(-1)?.role, "user");
  assert.match(String(result.messages.at(-1)?.content ?? ""), /latest question/);
  assert.ok(result.estimatedBytes <= 8_000);
});

test("estimateUtf8Bytes measures JSON payload size in UTF-8 bytes", () => {
  const bytes = estimateUtf8Bytes({ text: "caf\u00e9" });
  assert.ok(bytes > 8);
});

test("estimateUtf8Bytes works in renderer-like environments without Buffer", () => {
  const originalBuffer = globalThis.Buffer;
  try {
    (globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer = undefined;
    assert.equal(estimateUtf8Bytes({ text: "caf\u00e9" }), new TextEncoder().encode(JSON.stringify({ text: "caf\u00e9" })).byteLength);
  } finally {
    (globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer = originalBuffer;
  }
});

test("default payload budget remains a general gateway guard", () => {
  assert.equal(DEFAULT_MAX_REQUEST_PAYLOAD_BYTES, 1_500_000);
});

test("fitMessagesToRequestPayloadBudget preserves current long text when the request is under budget", () => {
  const currentText = "CURRENT ".repeat(4_000);
  const result = fitMessagesToRequestPayloadBudget({
    messages: [{ role: "user", content: currentText }],
    maxPayloadBytes: 100_000,
  });

  assert.equal(result.didAdjust, false);
  assert.equal(result.messages[0].content, currentText);
});

test("fitMessagesToRequestPayloadBudget reports didAdjust when initial truncation succeeds", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "run build" },
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "terminal_execute",
        output: { type: "text", value: "X".repeat(200_000) },
      }],
    },
  ];

  const result = fitMessagesToRequestPayloadBudget({
    messages,
    maxPayloadBytes: 20_000,
    reservedBytes: 2_000,
  });

  assert.equal(result.didAdjust, true);
  assert.ok(result.estimatedBytes <= 20_000);
});

test("fitMessagesToRequestPayloadBudget keeps dropping messages after emergency caps when still over budget", () => {
  const messages: ModelMessage[] = [];
  for (let turn = 0; turn < 8; turn += 1) {
    messages.push({ role: "user", content: `question ${turn} ${"Q".repeat(5_000)}` });
    messages.push({ role: "assistant", content: `answer ${turn} ${"A".repeat(5_000)}` });
  }

  const result = fitMessagesToRequestPayloadBudget({
    messages,
    maxPayloadBytes: 5_000,
    protectRecentMessages: 8,
    maxMessageTextChars: 2_000,
  });

  assert.ok(result.messages.length < messages.length);
  assert.ok(result.estimatedBytes <= 5_000);
});

test("fitMessagesToRequestPayloadBudget shrinks a single oversized message for very small budgets", () => {
  const result = fitMessagesToRequestPayloadBudget({
    messages: [{ role: "assistant", content: "Z".repeat(1_000_000) }],
    maxPayloadBytes: 1_000,
    maxMessageTextChars: 500,
  });

  assert.equal(result.messages.length, 1);
  assert.ok(result.estimatedBytes <= 1_000);
});

test("fitMessagesToRequestPayloadBudget returns empty messages when budget is fully reserved", () => {
  const result = fitMessagesToRequestPayloadBudget({
    messages: [{ role: "user", content: "hello" }],
    maxPayloadBytes: 100,
    reservedBytes: 200,
  });

  assert.deepEqual(result.messages, []);
  assert.equal(result.didAdjust, true);
  assert.equal(result.estimatedBytes, 0);
});

test("fitMessagesToRequestPayloadBudget omits latest attachments only when they are still over budget at the last resort", () => {
  const result = fitMessagesToRequestPayloadBudget({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "please inspect this image" },
        { type: "image", image: "A".repeat(1_000_000), mediaType: "image/png" },
      ],
    }],
    maxPayloadBytes: 20_000,
  });

  assert.ok(result.estimatedBytes <= 20_000);
  assert.equal(result.messages.length, 1);
  const content = result.messages[0].content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(content[1], {
    type: "text",
    text: "[image attachment omitted to keep the AI request small: mediaType=image/png, 1000000 chars]",
  });
});

test("fitMessagesToRequestPayloadBudget omits older oversized attachment payloads as a last resort", () => {
  const result = fitMessagesToRequestPayloadBudget({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "older image" },
          { type: "image", image: "A".repeat(1_000_000), mediaType: "image/png" },
        ],
      },
      { role: "user", content: "current question" },
    ],
    maxPayloadBytes: 20_000,
    protectRecentMessages: 2,
  });

  assert.ok(result.estimatedBytes <= 20_000);
  assert.equal(result.messages.length, 2);
  const content = result.messages[0].content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(content[1], {
    type: "text",
    text: "[image attachment omitted to keep the AI request small: mediaType=image/png, 1000000 chars]",
  });
});
