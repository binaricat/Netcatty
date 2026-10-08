import assert from "node:assert/strict";
import test from "node:test";

import type { AISession, ChatMessage } from "../../infrastructure/ai/types.ts";
import {
  collectSessionSearchFields,
  filterSessionHistory,
} from "./sessionHistorySearch.ts";

function createSession(
  id: string,
  title: string,
  messages: Partial<ChatMessage>[],
): AISession {
  return {
    id,
    title,
    agentId: "catty",
    scope: { type: "terminal", targetId: "terminal-1" },
    messages: messages.map((message, index) => ({
      id: `${id}-m${index}`,
      role: "user",
      content: "",
      timestamp: index,
      ...message,
    })) as ChatMessage[],
    createdAt: 0,
    updatedAt: 0,
  };
}

test("filterSessionHistory matches titles and keeps order when query is blank", () => {
  const sessions = [
    createSession("a", "nginx restart", []),
    createSession("b", "disk cleanup", []),
  ];

  assert.deepEqual(filterSessionHistory(sessions, "  "), sessions);
});

test("filterSessionHistory matches message content of user and assistant turns", () => {
  const sessions = [
    createSession("a", "Debugging", [
      { role: "user", content: "why is sshd down on prod-3?" },
      { role: "assistant", content: "let me check the journal" },
    ]),
    createSession("b", "Deploy notes", [
      { role: "user", content: "ship release 1.2" },
    ]),
  ];

  assert.deepEqual(filterSessionHistory(sessions, "sshd down"), [sessions[0]]);
  assert.deepEqual(filterSessionHistory(sessions, "1.2"), [sessions[1]]);
  assert.deepEqual(filterSessionHistory(sessions, "nothing here"), []);
});

test("filterSessionHistory searches thinking and tool call/result content", () => {
  const sessions = [
    createSession("a", "Untitled", [
      { role: "assistant", thinking: "the certificate expired" },
    ]),
    createSession("b", "Ops", [
      {
        role: "assistant",
        toolCalls: [{ name: "systemctl", id: "t1", arguments: {} }],
        toolResults: [{ toolCallId: "t1", content: "nginx failed to bind port" }],
      },
    ]),
  ];

  assert.deepEqual(filterSessionHistory(sessions, "certificate"), [sessions[0]]);
  assert.deepEqual(filterSessionHistory(sessions, "systemctl"), [sessions[1]]);
  assert.deepEqual(filterSessionHistory(sessions, "bind port"), [sessions[1]]);
});

test("collectSessionSearchFields skips empty content and caps very long fields", () => {
  const session = createSession("a", "  ", [
    { role: "user", content: "   " },
    { role: "assistant", content: "x".repeat(25_000) },
  ]);

  const fields = collectSessionSearchFields(session);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].length, 20_000);
});

test("filterSessionHistory matches CJK titles via the shared pinyin matcher", () => {
  const sessions = [
    createSession("a", "重启生产服务器", []),
    createSession("b", "backup", []),
  ];

  assert.deepEqual(filterSessionHistory(sessions, "chongqi"), [sessions[0]]);
  assert.deepEqual(filterSessionHistory(sessions, "重启"), [sessions[0]]);
});
