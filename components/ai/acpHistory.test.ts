import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessage } from "../../infrastructure/ai/types.ts";
import {
  buildAcpHistoryMessages,
  buildAcpHistoryMessagesForBridge,
} from "./acpHistory.ts";

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: 1,
    ...extra,
  };
}

test("buildAcpHistoryMessages compacts older ACP context and keeps only recent raw turns", () => {
  const messages: ChatMessage[] = [
    message("u1", "user", "我希望最小改动，不要添加很多 test"),
    message("a1", "assistant", "已按最小改动处理"),
    message("u2", "user", "MCP 不允许使用，Windows 上不要假设 pwsh.exe"),
    message("a2", "assistant", "PR #738 已创建，commit 4181a2c"),
    message("u3", "user", "帮我上网查查优化方案，每轮都带历史太慢了"),
    message("a3", "assistant", "建议 ACP history compaction"),
    message("tool1", "tool", "", {
      toolResults: [
        {
          toolCallId: "search",
          content: `error: ${"large output ".repeat(500)}`,
          isError: true,
        },
      ],
    }),
    message("u4", "user", "好的"),
    message("a4", "assistant", "准备实现"),
    message("u5", "user", "继续"),
    message("a5", "assistant", "继续处理"),
    message("u6", "user", "现在提交"),
    message("a6", "assistant", "还没提交"),
  ];

  const result = buildAcpHistoryMessages(messages);

  assert.equal(result[0].role, "user");
  assert.match(result[0].content, /Compact prior Netcatty UI context/);
  assert.match(result[0].content, /最小改动/);
  assert.match(result[0].content, /pwsh\.exe/);
  assert.match(result[0].content, /PR #738/);
  assert.ok(result[0].content.length <= 3000);

  assert.ok(result.length <= 7);
  assert.deepEqual(
    result.slice(1).map((entry) => entry.content),
    ["好的", "准备实现", "继续", "继续处理", "现在提交", "还没提交"],
  );
  assert.ok(result.every((entry) => entry.content.length <= 3000));
});

test("buildAcpHistoryMessagesForBridge keeps fallback history available for stale ACP session recovery", () => {
  const messages = [message("u1", "user", "继续处理这个历史压缩问题")];

  assert.equal(buildAcpHistoryMessagesForBridge([], "acp-session-1"), undefined);
  assert.deepEqual(
    buildAcpHistoryMessagesForBridge(messages, "acp-session-1"),
    buildAcpHistoryMessages(messages),
  );
});

test("buildAcpHistoryMessages preserves older substantive user instructions outside the recent raw window", () => {
  const messages: ChatMessage[] = [
    message("u1", "user", "Keep this incremental and do not refactor unrelated files."),
    message("a1", "assistant", "Understood."),
  ];

  for (let index = 2; index <= 13; index += 1) {
    messages.push(
      message(`u${index}`, "user", `filler user message ${index}`),
      message(`a${index}`, "assistant", `filler assistant message ${index}`),
    );
  }

  const result = buildAcpHistoryMessages(messages);

  assert.equal(result[0].role, "user");
  assert.match(result[0].content, /Keep this incremental and do not refactor unrelated files\./);
  assert.deepEqual(
    result.slice(-6).map((entry) => entry.content),
    [
      "filler user message 11",
      "filler assistant message 11",
      "filler user message 12",
      "filler assistant message 12",
      "filler user message 13",
      "filler assistant message 13",
    ],
  );
});

test("buildAcpHistoryMessages preserves short important user constraints outside the recent raw window", () => {
  const messages: ChatMessage[] = [
    message("u1", "user", "不要提交"),
    message("a1", "assistant", "收到"),
  ];

  for (let index = 2; index <= 13; index += 1) {
    messages.push(
      message(`u${index}`, "user", `filler user message ${index}`),
      message(`a${index}`, "assistant", `filler assistant message ${index}`),
    );
  }

  const result = buildAcpHistoryMessages(messages);

  assert.equal(result[0].role, "user");
  assert.match(result[0].content, /不要提交/);
});

test("buildAcpHistoryMessages does not treat pr inside ordinary words as important", () => {
  const messages: ChatMessage[] = [
    message("u1", "user", "不要提交"),
    message("a1", "assistant", "收到"),
    message("u2", "user", "approach"),
    message("a2", "assistant", "ack"),
    message("u3", "user", "improve"),
    message("a3", "assistant", "ack"),
    message("u4", "user", "prepare"),
    message("a4", "assistant", "ack"),
  ];

  for (let index = 5; index <= 13; index += 1) {
    messages.push(
      message(`u${index}`, "user", `filler user message ${index}`),
      message(`a${index}`, "assistant", `filler assistant message ${index}`),
    );
  }

  const result = buildAcpHistoryMessages(messages);

  assert.equal(result[0].role, "user");
  assert.match(result[0].content, /不要提交/);
  assert.doesNotMatch(result[0].content, /approach|improve|prepare/);
});

test("buildAcpHistoryMessages prioritizes later durable instructions over older filler prompts", () => {
  const messages: ChatMessage[] = [];

  for (let index = 1; index <= 12; index += 1) {
    messages.push(
      message(
        `u${index}`,
        "user",
        `Please continue with implementation step ${index} and keep momentum by following the current plan carefully.`,
      ),
      message(`a${index}`, "assistant", `Ack ${index}`),
    );
  }

  messages.push(
    message("u13", "user", "Keep the existing layout and copy wording unchanged."),
    message("a13", "assistant", "Understood."),
  );

  for (let index = 14; index <= 18; index += 1) {
    messages.push(
      message(
        `u${index}`,
        "user",
        `Please continue with implementation step ${index} and keep momentum by following the current plan carefully.`,
      ),
      message(`a${index}`, "assistant", `Ack ${index}`),
    );
  }

  const result = buildAcpHistoryMessages(messages);

  assert.equal(result[0].role, "user");
  assert.match(result[0].content, /Keep the existing layout and copy wording unchanged\./);
});

test("buildAcpHistoryMessages preserves older substantive assistant context that later user prompts can reference", () => {
  const messages: ChatMessage[] = [
    message("u1", "user", "Please propose a migration plan for the sidebar state."),
    message(
      "a1",
      "assistant",
      "Plan: 1. Introduce a dedicated hook for the panel stack. 2. Move the derived view state into that hook. 3. Keep the existing UI copy and layout. 4. Add a regression test around back navigation.",
    ),
  ];

  for (let index = 2; index <= 13; index += 1) {
    messages.push(
      message(`u${index}`, "user", `filler user message ${index}`),
      message(`a${index}`, "assistant", `Ack ${index}`),
    );
  }

  messages.push(message("u14", "user", "Apply step 2 of your plan now."));

  const result = buildAcpHistoryMessages(messages);

  assert.equal(result[0].role, "user");
  assert.match(result[0].content, /Move the derived view state into that hook\./);
});

test("buildAcpHistoryMessages preserves assistant-only compact context", () => {
  const messages: ChatMessage[] = [
    message("u1", "user", "ok"),
    message(
      "a1",
      "assistant",
      "Plan: 1. Move parser setup into a dedicated hook. 2. Keep storage schema unchanged. 3. Add a regression test.",
    ),
  ];

  for (let index = 2; index <= 7; index += 1) {
    messages.push(
      message(`u${index}`, "user", index % 2 === 0 ? "ok" : "continue"),
      message(`a${index}`, "assistant", "ack"),
    );
  }

  const result = buildAcpHistoryMessages(messages);

  assert.equal(result[0].role, "user");
  assert.match(result[0].content, /Move parser setup into a dedicated hook\./);
});
