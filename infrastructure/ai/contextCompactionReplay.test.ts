import test from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";

import {
  formatMessagesForCompaction,
  prepareContextCompaction,
} from "./contextCompaction.ts";

test("context compaction replay preserves goal, command, path, error, and unfinished work", async () => {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: "用户目标：让上下文压缩可解释、可测试、可回放；保持最小改动。",
    },
    {
      role: "assistant",
      content: "我会先补 trace，再补边界和回放测试。",
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-ctx-test",
          toolName: "terminal_execute",
          input: {
            command: "node --test --import tsx infrastructure/ai/contextCompaction.test.ts",
          },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-ctx-test",
          toolName: "terminal_execute",
          output: {
            type: "text",
            value: [
              "cwd=/workspace",
              "path=/workspace/infrastructure/ai/contextCompaction.ts",
              "error=AssertionError: orphaned tool result at split boundary",
              "exitCode=1",
            ].join("\n"),
          },
        },
      ],
    },
    {
      role: "assistant",
      content: "失败原因在 /workspace/infrastructure/ai/contextCompaction.ts 的 split 边界保护。",
    },
    {
      role: "user",
      content: "未完成事项：修复边界保护后继续补回放测试，并记录 413 retry 信息。",
    },
    {
      role: "user",
      content: "当前请求：继续实现 trace 并跑相关测试。",
    },
    {
      role: "assistant",
      content: "正在继续处理。",
    },
  ];

  const result = await prepareContextCompaction({
    messages,
    contextWindow: 120,
    protectRecentMessages: 2,
    trace: {
      triggerReason: "replay-quality-fixture",
      now: () => 789,
    },
    summarize: async (messagesToSummarize) => {
      const replayInput = formatMessagesForCompaction(messagesToSummarize);
      assert.match(replayInput, /用户目标：让上下文压缩可解释、可测试、可回放/);
      assert.match(replayInput, /node --test --import tsx infrastructure\/ai\/contextCompaction\.test\.ts/);
      assert.match(replayInput, /\/workspace\/infrastructure\/ai\/contextCompaction\.ts/);
      assert.match(replayInput, /AssertionError: orphaned tool result/);
      assert.match(replayInput, /未完成事项：修复边界保护后继续补回放测试/);

      return [
        "用户目标：让上下文压缩可解释、可测试、可回放；保持最小改动。",
        "已运行命令：node --test --import tsx infrastructure/ai/contextCompaction.test.ts。",
        "关键路径：/workspace/infrastructure/ai/contextCompaction.ts。",
        "关键错误：AssertionError: orphaned tool result at split boundary。",
        "未完成事项：修复边界保护后继续补回放测试，并记录 413 retry 信息。",
      ].join("\n");
    },
  });

  assert.equal(result.didCompact, true);
  assert.equal(result.trace.triggerReason, "replay-quality-fixture");
  assert.equal(result.trace.summary, result.summary);

  const replayText = result.messages.map((message) => {
    return typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content);
  }).join("\n");

  assert.match(replayText, /用户目标：让上下文压缩可解释、可测试、可回放/);
  assert.match(replayText, /node --test --import tsx infrastructure\/ai\/contextCompaction\.test\.ts/);
  assert.match(replayText, /\/workspace\/infrastructure\/ai\/contextCompaction\.ts/);
  assert.match(replayText, /AssertionError: orphaned tool result/);
  assert.match(replayText, /未完成事项：修复边界保护后继续补回放测试/);
  assert.match(replayText, /当前请求：继续实现 trace 并跑相关测试/);
});
