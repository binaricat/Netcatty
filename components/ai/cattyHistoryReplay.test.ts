import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessageAttachment, ToolCall, ToolResult } from "../../infrastructure/ai/types.ts";
import {
  buildHistoricalToolResultReplayText,
  buildHistoricalUserReplayContent,
} from "./cattyHistoryReplay.ts";

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
