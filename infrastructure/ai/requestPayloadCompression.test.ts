import test from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";

import {
  compressMessagesForRequestTooLargeRetry,
  compressVerboseText,
  truncateTextWithHeadAndTail,
} from "./requestPayloadCompression.ts";

test("compressVerboseText collapses repeated blank lines and duplicate runs", () => {
  const input = "line1\n\n\n\n\nline2\nsame\nsame\nsame\nsame\nline3";
  const output = compressVerboseText(input);
  assert.match(output, /line1\n\n\nline2/);
  assert.ok(output.split("\nsame\n").length <= 3);
});

test("compressVerboseText normalizes terminal control noise and huge payload lines", () => {
  const ansiProgress = "\u001b[31mstarting\u001b[0m\r10%\r20%\r100%\n";
  const longLine = "x".repeat(8_000);
  const base64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=".repeat(100);
  const output = compressVerboseText(`${ansiProgress}${longLine}\n${base64}`);

  assert.equal(output.includes("\u001b["), false);
  assert.doesNotMatch(output, /10%|20%/);
  assert.match(output, /100%/);
  assert.match(output, /long line shortened/);
  assert.match(output, /base64-like payload omitted/);
  assert.ok(output.length < 5_000);
});

test("compressVerboseText preserves CRLF-delimited lines", () => {
  assert.equal(compressVerboseText("alpha\r\nbeta\r\n"), "alpha\nbeta\n");
});

test("truncateTextWithHeadAndTail keeps both ends of long terminal output", () => {
  const value = `${"A".repeat(500)}${"B".repeat(20_000)}${"C".repeat(500)}`;
  const truncated = truncateTextWithHeadAndTail(value, 2_000);
  assert.ok(truncated.startsWith("AAA"));
  assert.ok(truncated.includes("[... output truncated for request size ...]"));
  assert.ok(truncated.endsWith("CCC"));
  assert.ok(truncated.length <= 2_000);
});

test("compressMessagesForRequestTooLargeRetry compresses messages without enforcing a byte budget", () => {
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
    {
      role: "user",
      content: [
        { type: "text", text: "please inspect this image" },
        { type: "image", image: "A".repeat(1_000_000), mediaType: "image/png" },
      ],
    },
  ];

  const result = compressMessagesForRequestTooLargeRetry(messages);

  assert.equal(result.didAdjust, true);
  assert.deepEqual(Object.keys(result).sort(), ["didAdjust", "messages"]);
  assert.equal(result.messages.length, messages.length);

  const toolContent = result.messages[1].content;
  assert.ok(Array.isArray(toolContent));
  const toolPart = toolContent[0] as { output?: { value?: string } };
  assert.ok((toolPart.output?.value?.length ?? 0) < 5_000);

  const userContent = result.messages[2].content;
  assert.ok(Array.isArray(userContent));
  assert.deepEqual(userContent[1], {
    type: "text",
    text: "[image attachment omitted to keep the AI request small: mediaType=image/png, 1000000 chars]",
  });
});

test("compressMessagesForRequestTooLargeRetry reports no adjustment for compact messages", () => {
  const messages: ModelMessage[] = [{ role: "user", content: "hello" }];

  const result = compressMessagesForRequestTooLargeRetry(messages);

  assert.equal(result.didAdjust, false);
  assert.deepEqual(result.messages, messages);
});

test("compressMessagesForRequestTooLargeRetry keeps attachments when preserveAttachments is set", () => {
  const imageData = "A".repeat(300_000);
  const fileData = Buffer.from("label,hostname\nprod,prod.example.com\n").toString("base64");
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "what does this screenshot say?" },
        { type: "file", data: imageData, mediaType: "image/png" },
      ],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "import these hosts" },
        { type: "file", data: fileData, mediaType: "text/csv", filename: "hosts.csv" },
      ],
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
  ];

  const result = compressMessagesForRequestTooLargeRetry(messages, { preserveAttachments: true });

  // Text and tool output are still reduced; only the multimodal parts survive.
  assert.equal(result.didAdjust, true);
  assert.doesNotMatch(JSON.stringify(result.messages), /attachment omitted to keep the AI request small/);

  const imageContent = result.messages[0].content;
  assert.ok(Array.isArray(imageContent));
  assert.deepEqual(imageContent[1], messages[0].content[1]);

  const fileContent = result.messages[1].content;
  assert.ok(Array.isArray(fileContent));
  assert.deepEqual(fileContent[1], messages[1].content[1]);

  const toolContent = result.messages[2].content;
  assert.ok(Array.isArray(toolContent));
  const toolPart = toolContent[0] as { output?: { value?: string } };
  assert.ok((toolPart.output?.value?.length ?? 0) < 5_000);
});
