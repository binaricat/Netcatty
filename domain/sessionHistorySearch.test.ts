import assert from "node:assert/strict";
import test from "node:test";

import type { AISession, ChatMessage } from "../infrastructure/ai/types.ts";
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

test("filterSessionHistory matches text stored only in tool call arguments", () => {
  const sessions = [
    createSession("a", "Ops", [
      {
        role: "assistant",
        toolCalls: [{
          name: "shell",
          id: "t1",
          arguments: { command: "systemctl restart nginx" },
        }],
      },
    ]),
    createSession("b", "Deploy", [
      {
        role: "assistant",
        toolCalls: [{ name: "file", id: "t2", arguments: {} }],
      },
    ]),
  ];

  assert.deepEqual(filterSessionHistory(sessions, "nginx"), [sessions[0]]);
  assert.deepEqual(filterSessionHistory(sessions, "restart nginx"), [sessions[0]]);
  assert.deepEqual(filterSessionHistory(sessions, "nothing here"), []);

  const fields = collectSessionSearchFields(sessions[0]);
  assert.ok(fields.some((field) => field.includes("systemctl restart nginx")));
});

test("filterSessionHistory matches persisted agent activities", () => {
  const sessions = [
    createSession("a", "Research", [
      {
        role: "assistant",
        agentActivities: [
          { id: "1", type: "web_search", status: "completed", query: "rust async runtime benchmarks" },
        ],
      },
    ]),
    createSession("b", "Refactor", [
      {
        role: "assistant",
        agentActivities: [
          {
            id: "2",
            type: "file_change",
            status: "completed",
            changes: [
              { path: "src/sessionStore.ts", kind: "update" },
              { path: "src/sessionStore.test.ts", kind: "add" },
            ],
          },
        ],
      },
    ]),
    createSession("c", "Plan", [
      {
        role: "assistant",
        agentActivities: [
          {
            id: "3",
            type: "plan_update",
            status: "completed",
            items: [
              { text: "extract search collector", completed: true },
              { text: "wire into drawer", completed: false },
            ],
          },
          { id: "4", type: "warning", status: "completed", message: "rate limit hit" },
        ],
      },
    ]),
  ];

  assert.deepEqual(filterSessionHistory(sessions, "async runtime"), [sessions[0]]);
  assert.deepEqual(filterSessionHistory(sessions, "sessionStore.test"), [sessions[1]]);
  assert.deepEqual(filterSessionHistory(sessions, "extract search collector"), [sessions[2]]);
  assert.deepEqual(filterSessionHistory(sessions, "rate limit"), [sessions[2]]);
  assert.deepEqual(filterSessionHistory(sessions, "nothing here"), []);

  const fields = collectSessionSearchFields(sessions[2]);
  assert.ok(fields.some((field) => field.includes("extract search collector")));
  assert.ok(fields.some((field) => field.includes("rate limit hit")));
});

test("filterSessionHistory matches persisted error messages and attachment labels", () => {
  const sessions = [
    createSession("a", "Untitled", [
      {
        role: "assistant",
        content: "",
        errorInfo: { type: "provider", message: "upstream rate limit exceeded", retryable: true },
      },
    ]),
    createSession("b", "Deploy", [
      {
        role: "user",
        content: "please summarize",
        attachments: [
          { base64Data: "", mediaType: "text/plain", filename: "k8s-manifest.yaml" },
          { base64Data: "", mediaType: "text/markdown", vaultNoteTitle: "Postgres runbook" },
        ],
      },
    ]),
    createSession("c", "Legacy", [
      {
        role: "user",
        content: "see attached",
        images: [
          { base64Data: "", mediaType: "image/png", filename: "screenshot.png" },
        ],
      },
    ]),
    createSession("d", "Payloads", [
      {
        role: "user",
        content: "",
        attachments: [
          { base64Data: "AAAA", mediaType: "image/png", terminalSelection: true },
        ],
      },
    ]),
  ];

  assert.deepEqual(filterSessionHistory(sessions, "rate limit exceeded"), [sessions[0]]);
  assert.deepEqual(filterSessionHistory(sessions, "k8s-manifest"), [sessions[1]]);
  assert.deepEqual(filterSessionHistory(sessions, "postgres runbook"), [sessions[1]]);
  assert.deepEqual(filterSessionHistory(sessions, "screenshot.png"), [sessions[2]]);
  // Attachment base64 payloads and unlabeled attachments are not indexed.
  assert.deepEqual(filterSessionHistory(sessions, "AAAA"), []);
  assert.deepEqual(filterSessionHistory(sessions, "nothing here"), []);

  const fields = collectSessionSearchFields(sessions[1]);
  assert.ok(fields.some((field) => field.includes("k8s-manifest.yaml")));
  assert.ok(fields.some((field) => field.includes("Postgres runbook")));
  assert.ok(!fields.some((field) => field === "AAAA"));
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

test("filterSessionHistory keeps the pinyin fallback on titles only", () => {
  const sessions = [
    createSession("a", "Ops", [
      { role: "user", content: "重启生产服务器" },
    ]),
  ];

  // Pinyin transliteration of long message content is skipped; literal CJK
  // queries still match message text.
  assert.deepEqual(filterSessionHistory(sessions, "重启"), [sessions[0]]);
  assert.deepEqual(filterSessionHistory(sessions, "chongqi"), []);
});

test("collectSessionSearchFields bounds the total searchable text per session", () => {
  const session = createSession("a", "big session", Array.from({ length: 40 }, (_, i) => ({
    role: "user" as const,
    content: `chunk-${i}-${"y".repeat(19_000)}`,
  })));

  const fields = collectSessionSearchFields(session);
  const total = fields.reduce((sum, field) => sum + field.length, 0);
  assert.ok(total <= 64_000, `total ${total} exceeds session cap`);
  // Title is indexed first so it always lands in the bounded window.
  assert.equal(fields[0], "big session");
});

test("collectSessionSearchFields keeps recent messages searchable under the cap", () => {
  // Four 20,000-char messages exceed the 64 KB cap; the budget must be
  // allocated newest-first so the most recent message remains searchable.
  const session = createSession("a", "big session", [0, 1, 2, 3].map((i) => ({
    role: "user" as const,
    content: `${"x".repeat(19_900)} marker-${i}`,
  })));

  const fields = collectSessionSearchFields(session);
  assert.equal(fields[0], "big session");
  // Oldest messages are dropped, the newest is retained.
  assert.ok(!fields.some((field) => field.includes("marker-0")));
  assert.ok(fields.some((field) => field.includes("marker-3")));
  // Output order stays chronological (marker-1 before marker-2).
  const marker1 = fields.findIndex((field) => field.includes("marker-1"));
  const marker2 = fields.findIndex((field) => field.includes("marker-2"));
  assert.ok(marker1 !== -1 && marker2 !== -1 && marker1 < marker2);
});

test("collectSessionSearchFields truncates a field to the remaining session budget", () => {
  // Four 19,000-char messages plus the title overflow the 64 KB cap; the last
  // collected (oldest) message must be truncated to exactly the remaining
  // budget instead of being discarded wholesale.
  const session = createSession("a", "big session", [0, 1, 2, 3].map(() => ({
    role: "user" as const,
    content: "a".repeat(19_000),
  })));

  const fields = collectSessionSearchFields(session);
  const total = fields.reduce((sum, field) => sum + field.length, 0);
  assert.ok(total <= 64_000, `total ${total} exceeds session cap`);
  assert.equal(total, 64_000);
  // The oldest message fills the leftover budget with its freshest-available
  // head instead of being dropped entirely.
  assert.ok(fields.some((field) => field.length === 64_000 - (11 + 3 * 19_000)));
  assert.ok(fields.some((field) => field.startsWith("aaa")));
});

test("huge tool call arguments are serialized within the field cap without full materialization", () => {
  const blob = "x".repeat(5_000_000);
  const sessions = [
    createSession("a", "Ops", [
      {
        role: "assistant",
        toolCalls: [{
          // Retained calls can carry uncapped payloads (e.g. `sftp_write_file`
          // content); serialization must stop at the field cap instead of
          // stringifying the whole argument object on every keystroke.
          name: "sftp_write_file",
          id: "t1",
          arguments: { path: "/tmp/report.md", content: blob },
        }],
      },
    ]),
  ];

  const fields = collectSessionSearchFields(sessions[0]);
  const serialized = fields.find((field) => field.includes("/tmp/report.md"));
  assert.ok(serialized);
  // The serialized field (plus the tool name) must land under the total
  // per-session budget cap, i.e. no multi-megabyte field is ever emitted.
  assert.ok(serialized!.length <= 2_000);
  assert.ok(serialized!.includes("/tmp/report.md"));

  // Short payloads still serialize fully and stay searchable.
  const searchable = createSession("b", "Ops", [
    {
      role: "assistant",
      toolCalls: [{
        name: "shell",
        id: "t2",
        arguments: { command: "systemctl restart nginx" },
      }],
    },
  ]);
  assert.ok(
    collectSessionSearchFields(searchable).some((field) => field.includes('"command":"systemctl restart nginx"')),
  );
});

test("wide tool call argument objects and long property names stay within the cap", () => {
  // A wide object: thousands of own properties must be iterated lazily
  // instead of materializing the full entries array on every keystroke.
  const wide: Record<string, unknown> = {};
  for (let i = 0; i < 5_000; i++) wide[`key-${i}`] = `value-${i}`;
  // An unusually large property name must be capped before it is escaped.
  const longKey = "k".repeat(50_000);
  const sessions = [
    createSession("a", "Ops", [
      {
        role: "assistant",
        toolCalls: [{
          name: "shell",
          id: "t1",
          arguments: { command: "systemctl restart nginx", [longKey]: "ignored", ...wide },
        }],
      },
    ]),
  ];

  const fields = collectSessionSearchFields(sessions[0]);
  const serialized = fields.find((field) => field.includes("systemctl restart nginx"));
  assert.ok(serialized);
  assert.ok(serialized!.length <= 2_000);
  // The oversized key (and the wide object past the cap) never materialize:
  // the long key is truncated before escaping.
  assert.ok(!fields.some((field) => field.length > 2_000));
});

test("filterSessionHistory matches persisted status text", () => {
  const sessions = [
    createSession("a", "Untitled", [
      { role: "assistant", content: "", statusText: "generating diff for src/main.ts" },
    ]),
    createSession("b", "Deploy", [
      { role: "user", content: "ship it" },
    ]),
  ];

  assert.deepEqual(filterSessionHistory(sessions, "generating diff"), [sessions[0]]);
  assert.deepEqual(filterSessionHistory(sessions, "src/main.ts"), [sessions[0]]);
  assert.deepEqual(filterSessionHistory(sessions, "nothing here"), []);

  const fields = collectSessionSearchFields(sessions[0]);
  assert.ok(fields.some((field) => field.includes("generating diff for src/main.ts")));
});
