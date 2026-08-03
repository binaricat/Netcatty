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

test("terminal user paste auto-uploads a clipboard image in remote sessions", async () => {
  const writes: Array<{ data: string }> = [];
  const readTextCalls: string[] = [];
  const image = {
    path: "/tmp/netcatty/shot.png",
    name: "shot.png",
    mediaType: "image/png",
    size: 12,
  };

  await handleTerminalClipboardPaste({
    bridge: {
      readClipboardFiles: async () => [],
    },
    autoUploadClipboardImage: true,
    clipboardImageBridge: {
      readClipboardImage: async () => image,
      openSftpForSession: async () => "sftp-1",
      startStreamTransfer: async (options) => ({ transferId: options.transferId }),
      closeSftp: async () => {},
      deleteTempFile: async () => ({ success: true }),
    },
    getRemoteCwd: async () => "/home/alice",
    isLocalConnection: false,
    readClipboardText: async () => {
      readTextCalls.push("read");
      return "hello";
    },
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: (_sessionId, data) => writes.push({ data }),
    },
    term: {
      paste: () => assert.fail("image upload should insert the remote path, not paste text"),
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(writes, [{ data: "/home/alice/.netcatty-paste-images/shot.png" }]);
  assert.deepEqual(readTextCalls, []);
});

test("terminal user paste falls back to text when the clipboard holds no image", async () => {
  const pasted: string[] = [];
  let sftpOpened = false;

  await handleTerminalClipboardPaste({
    bridge: {
      readClipboardFiles: async () => [],
    },
    autoUploadClipboardImage: true,
    clipboardImageBridge: {
      readClipboardImage: async () => null,
      openSftpForSession: async () => {
        sftpOpened = true;
        return "sftp-1";
      },
      startStreamTransfer: async (options) => ({ transferId: options.transferId }),
    },
    getRemoteCwd: async () => "/home/alice",
    isLocalConnection: false,
    readClipboardText: async () => "hello",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: () => assert.fail("no image should fall back to text paste"),
    },
    term: {
      paste: (text) => pasted.push(text),
      scrollToBottom: () => {},
    },
  });

  assert.equal(sftpOpened, false);
  assert.deepEqual(pasted, ["hello"]);
});

test("terminal user paste reports failed uploads instead of pasting text", async () => {
  const results: unknown[] = [];
  const readTextCalls: string[] = [];
  const image = {
    path: "/tmp/netcatty/shot.png",
    name: "shot.png",
    mediaType: "image/png",
    size: 12,
  };

  await handleTerminalClipboardPaste({
    bridge: {
      readClipboardFiles: async () => [],
    },
    autoUploadClipboardImage: true,
    clipboardImageBridge: {
      readClipboardImage: async () => image,
      openSftpForSession: async () => "sftp-1",
      startStreamTransfer: async (options) => ({ transferId: options.transferId, error: "disk full" }),
    },
    getRemoteCwd: async () => "/home/alice",
    isLocalConnection: false,
    onClipboardImageUploadResult: (result) => results.push(result),
    readClipboardText: async () => {
      readTextCalls.push("read");
      return "hello";
    },
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: () => assert.fail("failed upload should not paste anything"),
    },
    term: {
      paste: () => assert.fail("failed upload should not paste text"),
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(results, [{ ok: false, reason: "upload-failed" }]);
  assert.deepEqual(readTextCalls, []);
});

test("terminal user paste reports thrown upload failures instead of pasting text", async () => {
  const results: unknown[] = [];
  const readTextCalls: string[] = [];
  const image = {
    path: "/tmp/netcatty/shot.png",
    name: "shot.png",
    mediaType: "image/png",
    size: 12,
  };

  await handleTerminalClipboardPaste({
    bridge: {
      readClipboardFiles: async () => [],
    },
    autoUploadClipboardImage: true,
    clipboardImageBridge: {
      readClipboardImage: async () => image,
      openSftpForSession: async () => {
        throw new Error("SFTP unavailable");
      },
      startStreamTransfer: async (options) => ({ transferId: options.transferId }),
    },
    getRemoteCwd: async () => "/home/alice",
    isLocalConnection: false,
    onClipboardImageUploadResult: (result) => results.push(result),
    readClipboardText: async () => {
      readTextCalls.push("read");
      return "hello";
    },
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: () => assert.fail("thrown upload failure must not paste anything"),
    },
    term: {
      paste: () => assert.fail("thrown upload failure must not paste text"),
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(results, [{ ok: false, reason: "upload-failed" }]);
  assert.deepEqual(readTextCalls, []);
});

test("terminal user paste keeps local file path paste even with auto-upload enabled", async () => {
  const writes: Array<{ data: string }> = [];

  await handleTerminalClipboardPaste({
    bridge: {
      readClipboardFiles: async () => [
        { path: "/Users/alice/shot.png", name: "shot.png", isDirectory: false },
      ],
    },
    autoUploadClipboardImage: true,
    isLocalConnection: true,
    readClipboardText: async () => assert.fail("local file paste should not fall through to text"),
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: (_sessionId, data) => writes.push({ data }),
    },
    term: {
      paste: () => assert.fail("local file paste should write paths directly"),
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(writes, [{ data: "/Users/alice/shot.png" }]);
});
