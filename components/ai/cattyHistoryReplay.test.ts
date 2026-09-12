import assert from "node:assert/strict";
import test from "node:test";
import { buildExternalBridgeContextMessages } from "../../infrastructure/ai/harness/externalBridgeContext.ts";

import type { ChatMessageAttachment, ToolCall, ToolResult } from "../../infrastructure/ai/types.ts";
import {
  buildHistoricalToolReplayMaps,
  buildHistoricalToolResultReplayText,
  buildHistoricalUserReplayContent,
} from "./cattyHistoryReplay.ts";
import type { ChatMessage } from "../../infrastructure/ai/types.ts";

test("buildHistoricalUserReplayContent replaces historical image data with a placeholder", () => {
  const attachment: ChatMessageAttachment = {
    base64Data: "A".repeat(100_000),
    mediaType: "image/png",
    filename: "screenshot.png",
  };

  const result = buildHistoricalUserReplayContent("inspect this", [attachment]);

  assert.match(result, /inspect this/);
  assert.match(result, /Historical image attachment omitted from replay/);
  assert.match(result, /filename=screenshot\.png/);
  assert.doesNotMatch(result, /AAAAA/);
});

test("buildHistoricalUserReplayContent preserves historical file path metadata", () => {
  const content = buildHistoricalUserReplayContent("inspect this file", [{
    base64Data: "A".repeat(200),
    mediaType: "text/plain",
    filename: "deploy.log",
    filePath: "/tmp/netcatty/deploy.log",
  }]);

  assert.match(content, /Historical file attachment omitted from replay/);
  assert.match(content, /filename=deploy\.log/);
  assert.match(content, /path=\/tmp\/netcatty\/deploy\.log/);
  assert.doesNotMatch(content, /AAAAAAAA/);
});

test("buildHistoricalUserReplayContent replaces historical terminal selections with metadata only", () => {
  const attachment: ChatMessageAttachment = {
    base64Data: "VGhpcyBpcyBhIGxvbmcgdGVybWluYWwgc2VsZWN0aW9u",
    mediaType: "text/plain",
    filename: "terminal-selection.log",
    terminalSelection: true,
    previewText: "npm run build failed on vite",
    lineCount: 42,
  };

  const result = buildHistoricalUserReplayContent("", [attachment]);

  assert.match(result, /Historical terminal selection omitted from replay/);
  assert.match(result, /filename=terminal-selection\.log/);
  assert.match(result, /lines=42/);
  assert.match(result, /preview=npm run build failed on vite/);
  assert.doesNotMatch(result, /long terminal selection/);
});

test("buildHistoricalToolResultReplayText keeps bounded historical terminal evidence", () => {
  const toolCall: ToolCall = {
    id: "call-1",
    name: "terminal_execute",
    arguments: { command: "npm run build" },
  };
  const result: ToolResult = {
    toolCallId: "call-1",
    content: "BUILD ".repeat(20_000),
    isError: true,
  };

  const replay = buildHistoricalToolResultReplayText(result, toolCall);

  assert.match(replay, /Historical terminal output omitted from replay/);
  assert.match(replay, /command=npm run build/);
  assert.match(replay, /status=error/);
  assert.match(replay, /BUILD BUILD BUILD/);
  assert.match(replay, /shortened for replay/);
  assert.ok(replay.length < 4_600);
  assert.doesNotMatch(replay, /Re-run terminal_execute/);
  assert.match(replay, /do not execute the command again/i);
});

test("buildHistoricalToolResultReplayText bounds terminal poll output and keeps its job pointer", () => {
  const replay = buildHistoricalToolResultReplayText({
    toolCallId: "poll-1",
    content: "streamed output".repeat(5_000),
  }, {
    id: "poll-1",
    name: "terminal_poll",
    arguments: { jobId: "job-1", offset: 100 },
  });

  assert.match(replay, /Historical terminal output omitted from replay/);
  assert.match(replay, /streamed output/);
  assert.match(replay, /jobId=job-1/);
  assert.ok(replay.length < 4_600);
});

test("buildHistoricalToolResultReplayText preserves small output that has no saved handle", () => {
  const replay = buildHistoricalToolResultReplayText({
    toolCallId: "small-1",
    content: "exit 1: configuration file is missing",
    isError: true,
  }, {
    id: "small-1",
    name: "terminal_execute",
    arguments: { command: "deploy" },
  });

  assert.match(replay, /configuration file is missing/);
  assert.match(replay, /Only the bounded historical output below is available/);
  assert.doesNotMatch(replay, /saved output/i);
});

test("buildHistoricalToolResultReplayText preserves a large output handle from the tail", () => {
  const handleId = "tool-output-stable-handle-123";
  const replay = buildHistoricalToolResultReplayText({
    toolCallId: "large-1",
    content: `${"build line\n".repeat(2_000)}[output handle: stdout truncated for model context handleId=${handleId}]`,
  }, {
    id: "large-1",
    name: "terminal_execute",
    arguments: { command: "npm run build" },
  });

  assert.match(replay, new RegExp(`tool_output_read with handleId=${handleId}`));
  assert.match(replay, new RegExp(`handleId=${handleId}`));
});

test("buildHistoricalToolResultReplayText keeps non-terminal tool results intact", () => {
  const toolCall: ToolCall = {
    id: "call-1",
    name: "web_search",
    arguments: { query: "Vercel AI SDK" },
  };
  const result: ToolResult = {
    toolCallId: "call-1",
    content: "search result summary",
  };

  assert.equal(buildHistoricalToolResultReplayText(result, toolCall), "search result summary");
});

test("buildHistoricalToolResultReplayText can preserve terminal output for 413 retries", () => {
  const toolCall: ToolCall = {
    id: "call-1",
    name: "terminal_execute",
    arguments: { command: "npm test" },
  };
  const result: ToolResult = {
    toolCallId: "call-1",
    content: "real terminal output",
  };

  assert.equal(
    buildHistoricalToolResultReplayText(result, toolCall, { preserveTerminalOutput: true }),
    "real terminal output",
  );
});

test("buildHistoricalToolResultReplayText redacts credentials from omitted command details", () => {
  const replay = buildHistoricalToolResultReplayText(
    { toolCallId: "call-secret", content: "output" },
    { id: "call-secret", name: "terminal_execute", arguments: { command: "curl --password swordfish -H 'Authorization: Bearer secret_token_123456'" } },
  );
  assert.doesNotMatch(replay, /swordfish|secret_token/);
  assert.match(replay, /REDACTED/);
});

test("buildHistoricalToolReplayMaps pairs reused tool ids with the nearest preceding call", () => {
  const messages: ChatMessage[] = [
    {
      id: "assistant-1",
      role: "assistant",
      content: "",
      timestamp: 1,
      toolCalls: [{ id: "call1", name: "url_fetch", arguments: { url: "https://example.com" } }],
    },
    {
      id: "tool-1",
      role: "tool",
      content: "",
      timestamp: 2,
      toolResults: [{ toolCallId: "call1", content: "PAGE" }],
    },
    {
      id: "assistant-2",
      role: "assistant",
      content: "",
      timestamp: 3,
      toolCalls: [{ id: "call1", name: "terminal_execute", arguments: { command: "cat /tmp/log" } }],
    },
    {
      id: "tool-2",
      role: "tool",
      content: "",
      timestamp: 4,
      toolResults: [{ toolCallId: "call1", content: "TERMINAL BYTES" }],
    },
  ];

  const maps = buildHistoricalToolReplayMaps(messages);
  const secondResult = messages[3].toolResults?.[0];
  assert.ok(secondResult);
  const pairedCall = maps.toolCallByToolResult.get(secondResult);

  assert.equal(pairedCall?.name, "terminal_execute");
  assert.equal(maps.resolvedToolCallsByAssistant.get(messages[0])?.has(messages[0].toolCalls![0]), true);
  assert.equal(maps.resolvedToolCallsByAssistant.get(messages[1]), undefined);
  assert.equal(maps.resolvedToolCallsByAssistant.get(messages[2])?.has(messages[2].toolCalls![0]), true);
});

test("buildHistoricalUserReplayContent replaces historical vault note mentions with id metadata", () => {
  const attachment: ChatMessageAttachment = {
    base64Data: "A".repeat(5_000),
    mediaType: "text/markdown",
    filename: "runbook.md",
    vaultNoteId: "note-123",
    vaultNoteTitle: "Runbook",
    previewText: "restart nginx",
  };

  const result = buildHistoricalUserReplayContent("check this note", [attachment]);

  assert.match(result, /check this note/);
  assert.match(result, /Vault note reference/);
  assert.match(result, /"noteId":"note-123"/);
  assert.match(result, /"title":"Runbook"/);
  assert.doesNotMatch(result, /AAAAAA/);
});

test("external recovery retains note identity before truncating a long user request", () => {
  const history = buildExternalBridgeContextMessages([{
    id: "long-note-request", role: "user", timestamp: 1, content: "x".repeat(2500),
    attachments: [{mediaType: "text/markdown", base64Data: "", vaultNoteId: "note-123", vaultNoteTitle: "Runbook"}],
  }]);
  const replay = history.find((message) => message.role === "user")!;
  assert.match(replay.content, /"noteId":"note-123"/);
  assert.match(replay.content, /vault_notes_get/);
  assert.match(replay.content, /truncated/);
  assert.ok(replay.content.length <= 2000);
});

test("external recovery keeps multiple note IDs and a short user constraint", () => {
  const attachments = Array.from({length: 10}, (_, index) => ({
    mediaType: "text/markdown", base64Data: "", vaultNoteId: `note-${index}`, vaultNoteTitle: `Runbook ${index}`,
  }));
  const history = buildExternalBridgeContextMessages([{
    id: "many-notes", role: "user", timestamp: 1, content: "Only compare; do not edit.", attachments,
  }]);
  const replay = history.find((message) => message.role === "user")!;
  for (const attachment of attachments) assert.ok(replay.content.includes(JSON.stringify(attachment.vaultNoteId)));
  assert.match(replay.content, /Only compare; do not edit/);
  assert.equal(replay.content.match(/Use vault_notes_get/g)?.length, 1);
});

for (const terminalSelection of [false, true]) {
test(`compact external recovery retains the request and attachment (terminal=${terminalSelection}) alongside note references`, () => {
  const noteId = '550e8400-e29b-41d4-a716-446655440000';
  const request = "Only summarize yesterday's deployments; do not edit.";
  const messages: ChatMessage[] = [{
    id: 'old-note', role: 'user', timestamp: 1, content: request,
    attachments: [
      { mediaType: 'text/markdown', base64Data: '', vaultNoteId: noteId, vaultNoteTitle: 'Deployment Runbook' },
      { mediaType: 'text/plain', base64Data: 'YWJj', filename: 'other.txt', terminalSelection },
    ],
  }, ...Array.from({ length: 8 }, (_, i): ChatMessage => ({
    id: `later-${i}`, role: i % 2 ? 'assistant' : 'user', timestamp: i + 2, content: i % 2 ? 'Done.' : 'ok',
  }))];
  const compact = buildExternalBridgeContextMessages(messages)[0].content;
  assert.ok(compact.includes(noteId));
  assert.ok(compact.includes(request));
  assert.ok(compact.includes('other.txt'));
  assert.ok(compact.includes(terminalSelection ? 'terminal selection omitted' : 'attachment omitted'));
});
}
