import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTerminalExecuteResultForModel,
  readToolResultHandle,
  resetToolResultHandlesForTests,
} from "./toolResultHandles.ts";

test("buildTerminalExecuteResultForModel compresses large terminal output into a readable handle", () => {
  resetToolResultHandlesForTests();
  const stdout = Array.from({ length: 2_000 }, (_, index) => `stdout line ${index}`).join("\n");
  const stderr = "error: build failed\nstack trace line";

  const result = buildTerminalExecuteResultForModel({
    stdout,
    stderr,
    exitCode: 1,
  }, {
    chatSessionId: "chat-1",
    toolCallId: "call-1",
    sessionId: "session-1",
    command: "npm test",
  });

  assert.equal("type" in result ? result.type : undefined, "netcatty.terminal_execute_result");
  assert.ok("outputCompression" in result);
  assert.equal(result.command, "npm test");
  assert.equal(result.sessionId, "session-1");
  assert.equal(result.status, "failed");
  assert.match(result.outputCompression.handle, /^trh_call-1_/);
  assert.equal(result.outputCompression.readTool, "tool_result_read");
  assert.match(result.stdout.content, /stdout line 0/);
  assert.match(result.stdout.content, /lines omitted/);
  assert.match(result.stdout.content, /stdout line 1999/);
  assert.doesNotMatch(JSON.stringify(result), /stdout line 1000/);
  assert.match(result.errorSummary ?? "", /error: build failed/);
});

test("readToolResultHandle returns exact slices and concise notices for duplicate reads", () => {
  resetToolResultHandlesForTests();
  const stdout = `${"A".repeat(20_000)}TARGET${"B".repeat(5_000)}`;
  const compressed = buildTerminalExecuteResultForModel({
    stdout,
    stderr: "",
    exitCode: 0,
  }, {
    chatSessionId: "chat-1",
    toolCallId: "call-2",
    sessionId: "session-1",
    command: "generate-output",
  });

  assert.ok("outputCompression" in compressed);
  const firstRead = readToolResultHandle({
    handle: compressed.outputCompression.handle,
    chatSessionId: "chat-1",
    channel: "stdout",
    offset: 19_995,
    length: 16,
  });

  assert.equal(firstRead.type, "netcatty.tool_result_slice");
  assert.match(firstRead.content, /TARGET/);
  assert.equal(firstRead.offset, 19_995);
  assert.equal(firstRead.nextOffset, 20_011);

  const duplicateRead = readToolResultHandle({
    handle: compressed.outputCompression.handle,
    chatSessionId: "chat-1",
    channel: "stdout",
    offset: 19_995,
    length: 16,
  });

  assert.equal(duplicateRead.type, "netcatty.tool_result_repeat_notice");
  assert.match(duplicateRead.message, /already returned/);
  assert.ok(!("content" in duplicateRead));
});

test("readToolResultHandle rejects handles from another chat session", () => {
  resetToolResultHandlesForTests();
  const compressed = buildTerminalExecuteResultForModel({
    stdout: "X".repeat(20_000),
    stderr: "",
    exitCode: 0,
  }, {
    chatSessionId: "chat-1",
    toolCallId: "call-3",
    sessionId: "session-1",
    command: "print",
  });

  assert.ok("outputCompression" in compressed);
  const result = readToolResultHandle({
    handle: compressed.outputCompression.handle,
    chatSessionId: "chat-2",
  });

  assert.deepEqual(result, { error: "Tool result handle is not available in this chat session." });
});
