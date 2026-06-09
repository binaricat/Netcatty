import assert from "node:assert/strict";
import test from "node:test";

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

test("buildHistoricalToolResultReplayText replaces historical terminal output with a replay placeholder", () => {
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
  assert.doesNotMatch(replay, /BUILD BUILD BUILD/);
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
