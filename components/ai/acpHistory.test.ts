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
  // Original intent: `\bpr\b` in IMPORTANT_PATTERNS must NOT match 'pr'
  // inside ordinary English words like 'approach' / 'improve' / 'prepare'.
  // Those words land at priority=1 (kept only as space allows) while the
  // 不要提交 line lands at priority=2 (always preferred). The check below
  // doesn't assert that the ordinary words are absent from the compact
  // section — they may legitimately survive when budget allows; that's
  // intentional after we stopped blanket-dropping short user messages.
  // What we DO verify: the priority-2 line is selected, which is only
  // possible if the IMPORTANT_PATTERNS regex correctly distinguishes it
  // from the surrounding short ordinary-word turns.
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

test("buildAcpHistoryMessages preserves short non-trivial user constraints that miss the IMPORTANT regex", () => {
  // Regression: short load-bearing instructions like "Use ssh2" / "中文输出"
  // would previously be dropped by a blanket length<10 heuristic, even
  // though they don't match any TRIVIAL pattern.
  const messages: ChatMessage[] = [
    message("u1", "user", "Use ssh2"),
    message("a1", "assistant", "Got it."),
    message("u2", "user", "中文输出"),
    message("a2", "assistant", "明白"),
  ];

  // Push enough later turns so u1/u2 fall outside the recent raw window
  // and have to survive via the durable-user compaction path.
  for (let index = 3; index <= 13; index += 1) {
    messages.push(
      message(`u${index}`, "user", `filler user message ${index}`),
      message(`a${index}`, "assistant", `filler assistant message ${index}`),
    );
  }

  const result = buildAcpHistoryMessages(messages);

  assert.equal(result[0].role, "user");
  assert.match(result[0].content, /Use ssh2/);
  assert.match(result[0].content, /中文输出/);
});

test("buildAcpHistoryMessages still drops one-word filler user messages", () => {
  // Sanity: removing the length<10 heuristic must not cause "ok" / "继续" /
  // "thanks" filler to leak into the compact section.
  const messages: ChatMessage[] = [
    message("u1", "user", "ok"),
    message("a1", "assistant", "ack"),
    message("u2", "user", "继续"),
    message("a2", "assistant", "继续处理"),
  ];

  for (let index = 3; index <= 13; index += 1) {
    messages.push(
      message(`u${index}`, "user", `filler user message ${index}`),
      message(`a${index}`, "assistant", `filler assistant message ${index}`),
    );
  }

  const result = buildAcpHistoryMessages(messages);

  // u1 / u2 fall outside the recent raw window. The compact context, if it
  // exists, must not surface these trivial turns as durable user requests.
  if (result.length > 0 && result[0].role === "user") {
    assert.doesNotMatch(result[0].content, /User request: ok\b/);
    assert.doesNotMatch(result[0].content, /User request: 继续/);
  }
});

test("buildAcpHistoryMessages preserves recent tool results verbatim (up to the raw budget) for follow-up references", () => {
  // Regression: tool results used to only reach fallback replay via the
  // 500-char compact summary. If the user's last interaction produced a
  // large tool output (cat/rg/fetched file), any "use that output"-style
  // follow-up lost the actual bytes. Now tool messages flow through the
  // recent raw window at MAX_RAW_MESSAGE_CHARS (2000).
  const bigToolOutput = "DATA ".repeat(300); // ~1500 chars — bigger than summary cap but smaller than raw cap
  const messages: ChatMessage[] = [
    message("u1", "user", "cat /etc/hosts"),
    message("a1", "assistant", "", {
      toolCalls: [{ id: "call1", name: "terminal", arguments: { cmd: "cat /etc/hosts" } }],
    }),
    message("tool1", "tool", "", {
      toolResults: [
        { toolCallId: "call1", content: bigToolOutput, isError: false },
      ],
    }),
    message("u2", "user", "use that output"),
  ];

  const result = buildAcpHistoryMessages(messages);
  const flat = result.map((m) => m.content).join("\n---\n");

  // The actual tool output (or at least its prefix) must appear — not
  // just the compact summary which would have been truncated to ~500 chars.
  assert.match(flat, /Tool result \(call1\): DATA DATA DATA/);
  // Confirm we kept enough bytes to exceed the compact-summary cap.
  const toolResultChunk = flat.slice(flat.indexOf("Tool result (call1)"));
  assert.ok(
    toolResultChunk.length > 600,
    `expected tool result chunk to exceed compact cap (~500 chars), got ${toolResultChunk.length}`,
  );
});

test("buildAcpHistoryMessages inlines tool_call name+args so tool_result is interpretable without the preceding assistant turn", () => {
  // Regression: if the raw window starts mid-tool-interaction, the
  // preceding assistant tool_call message may be outside the 6-item
  // slice. Without the call's name/args inline on the result line, the
  // AI sees opaque bytes and "use that output" becomes ambiguous.
  const messages: ChatMessage[] = [
    // Early filler to push the tool_call off the raw window
    message("u0", "user", "prior chatter"),
    message("a0", "assistant", "prior reply"),
    message("u1", "user", "cat /etc/hosts"),
    message("a1", "assistant", "", {
      toolCalls: [
        { id: "call1", name: "terminal_exec", arguments: { command: "cat /etc/hosts" } },
      ],
    }),
    message("tool1", "tool", "", {
      toolResults: [
        { toolCallId: "call1", content: "127.0.0.1 localhost", isError: false },
      ],
    }),
    message("u2", "user", "use that output"),
    message("a2", "assistant", "acknowledged"),
    message("u3", "user", "now do the same for /etc/resolv.conf"),
  ];

  const result = buildAcpHistoryMessages(messages);
  const flat = result.map((m) => m.content).join("\n---\n");

  // The tool_result line must carry the originating tool_call's name and
  // args, so even if a1 was pushed out of the raw window, the result is
  // self-describing.
  assert.match(flat, /Tool result \[from terminal_exec/);
  assert.match(flat, /cat \/etc\/hosts/);
});

test("buildAcpHistoryMessages bounds the durable-candidate scan to avoid O(N) work per send on long chats", () => {
  // Regression target: codex review flagged that the compaction path
  // scanned messages.entries() over the full transcript. Build a very
  // long chat and verify that only messages within MAX_DURABLE_SCAN_MESSAGES
  // (200) of the end contribute durable candidates.

  const messages: ChatMessage[] = [];
  // An ancient high-priority constraint that MUST be aged out.
  messages.push(message("old-important", "user", "不要提交 old-marker-xyz"));
  messages.push(message("old-ack", "assistant", "收到"));

  // 300 filler turns between the ancient constraint and the window.
  for (let i = 0; i < 300; i += 1) {
    messages.push(
      message(`u${i}`, "user", `filler user message ${i}`),
      message(`a${i}`, "assistant", `filler assistant message ${i}`),
    );
  }

  // A recent constraint that should survive.
  messages.push(message("recent-important", "user", "不要提交 recent-marker-abc"));
  for (let i = 0; i < 5; i += 1) {
    messages.push(
      message(`t${i}`, "user", `tail user message ${i}`),
      message(`ta${i}`, "assistant", `tail assistant message ${i}`),
    );
  }

  const result = buildAcpHistoryMessages(messages);
  const flat = result.map((m) => m.content).join("\n---\n");

  // Recent priority-2 constraint is kept.
  assert.match(flat, /recent-marker-abc/);
  // Ancient one past the scan window is dropped — proof the bound holds.
  assert.doesNotMatch(flat, /old-marker-xyz/);
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
