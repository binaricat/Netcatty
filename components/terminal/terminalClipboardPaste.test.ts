import test from "node:test";
import assert from "node:assert/strict";

import { handleTerminalClipboardPaste } from "./terminalClipboardPaste";

test("terminal user paste does not inspect or upload remote clipboard images", async () => {
  const pasted: string[] = [];
  const readTextCalls: string[] = [];
  const bridge = {
    readClipboardImage: async () => assert.fail("user paste must not read clipboard images"),
    readClipboardFiles: async () => [],
  };

  await handleTerminalClipboardPaste({
    bridge,
    isLocalConnection: false,
    readClipboardText: async () => {
      readTextCalls.push("read");
      return "hello";
    },
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: () => assert.fail("remote user paste should use xterm paste handling"),
    },
    term: {
      paste: (text) => pasted.push(text),
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(readTextCalls, ["read"]);
  assert.deepEqual(pasted, ["hello"]);
});

test("terminal user paste still inserts local clipboard file paths", async () => {
  const writes: Array<{ data: string; sensitive?: boolean }> = [];
  const scrolled: string[] = [];
  let focused = false;

  await handleTerminalClipboardPaste({
    bridge: {
      readClipboardFiles: async () => [
        { path: "/Users/alice/shot.png", name: "shot.png", isDirectory: false },
        { path: "/Users/alice/report.txt", name: "report.txt", isDirectory: false },
      ],
    },
    isLocalConnection: true,
    isSensitiveInput: () => true,
    readClipboardText: async () => assert.fail("local file paste should not fall through to text"),
    scrollToBottomAfterProgrammaticInput: (data) => scrolled.push(data),
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: (_sessionId, data, options) => writes.push({
        data,
        sensitive: options?.sensitive,
      }),
    },
    term: {
      focus: () => {
        focused = true;
      },
      paste: () => assert.fail("local file paste should write paths directly"),
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(writes, [{
    data: "/Users/alice/shot.png /Users/alice/report.txt",
    sensitive: true,
  }]);
  assert.deepEqual(scrolled, ["/Users/alice/shot.png /Users/alice/report.txt"]);
  assert.equal(focused, true);
});
