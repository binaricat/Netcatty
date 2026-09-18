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
      hasClipboardImage: async () => assert.fail("local file paste must not probe clipboard images"),
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

test("local paste forwards Ctrl+V when clipboard holds only an image", async () => {
  const writes: Array<{ data: string; sensitive?: boolean }> = [];
  const scrolled: string[] = [];
  let focused = false;

  await handleTerminalClipboardPaste({
    bridge: {
      readClipboardFiles: async () => [],
      hasClipboardImage: async () => true,
    },
    isLocalConnection: true,
    isSensitiveInput: () => true,
    readClipboardText: async () => "",
    sessionId: "session-1",
    scrollToBottomAfterProgrammaticInput: (data) => scrolled.push(data),
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
      paste: () => assert.fail("image-only local paste must not use xterm paste"),
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(writes, [{ data: "\u0016", sensitive: true }]);
  assert.deepEqual(scrolled, ["\u0016"]);
  assert.equal(focused, true);
});

test("local paste prefers clipboard text over forwarding Ctrl+V for images", async () => {
  const pasted: string[] = [];
  let hasImageCalls = 0;

  await handleTerminalClipboardPaste({
    bridge: {
      readClipboardFiles: async () => [],
      hasClipboardImage: async () => {
        hasImageCalls += 1;
        return true;
      },
    },
    isLocalConnection: true,
    readClipboardText: async () => "hello",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: () => assert.fail("text paste should not write Ctrl+V"),
    },
    term: {
      paste: (text) => pasted.push(text),
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(pasted, ["hello"]);
  assert.equal(hasImageCalls, 0);
});

test("local paste forwards Ctrl+V when clipboard text read fails but an image is present", async () => {
  const writes: string[] = [];

  await handleTerminalClipboardPaste({
    bridge: {
      readClipboardFiles: async () => [],
      hasClipboardImage: async () => true,
    },
    isLocalConnection: true,
    readClipboardText: async () => {
      throw new Error("clipboard text unavailable");
    },
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: (_sessionId, data) => writes.push(data),
    },
    term: {
      paste: () => assert.fail("failed text read must not use xterm paste"),
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(writes, ["\u0016"]);
});

test("local paste treats whitespace-only clipboard text as empty for image forwarding", async () => {
  const writes: string[] = [];

  await handleTerminalClipboardPaste({
    bridge: {
      readClipboardFiles: async () => [],
      hasClipboardImage: async () => true,
    },
    isLocalConnection: true,
    readClipboardText: async () => " \n\t",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: (_sessionId, data) => writes.push(data),
    },
    term: {
      paste: () => assert.fail("whitespace-only text must not use xterm paste"),
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(writes, ["\u0016"]);
});

test("local paste keeps whitespace-only clipboard text when no image is present", async () => {
  const pasted: string[] = [];

  await handleTerminalClipboardPaste({
    bridge: {
      readClipboardFiles: async () => [],
      hasClipboardImage: async () => false,
    },
    isLocalConnection: true,
    readClipboardText: async () => " \n\t",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: () => assert.fail("whitespace paste should use xterm paste"),
    },
    term: {
      paste: (text) => pasted.push(text),
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(pasted, [" \n\t"]);
});

test("remote paste keeps whitespace-only clipboard text", async () => {
  const pasted: string[] = [];

  await handleTerminalClipboardPaste({
    bridge: {
      readClipboardFiles: async () => [],
      hasClipboardImage: async () => assert.fail("remote paste must not probe clipboard images"),
    },
    isLocalConnection: false,
    readClipboardText: async () => "\t",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: () => assert.fail("remote whitespace paste should use xterm paste"),
    },
    term: {
      paste: (text) => pasted.push(text),
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(pasted, ["\t"]);
});

test("local paste does not write when clipboard has neither text nor image", async () => {
  await handleTerminalClipboardPaste({
    bridge: {
      readClipboardFiles: async () => [],
      hasClipboardImage: async () => false,
    },
    isLocalConnection: true,
    readClipboardText: async () => "",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: () => assert.fail("empty local clipboard must not write"),
    },
    term: {
      paste: () => assert.fail("empty local clipboard must not use xterm paste"),
      scrollToBottom: () => {},
    },
  });
});

test("remote paste does not forward Ctrl+V for clipboard images", async () => {
  await handleTerminalClipboardPaste({
    bridge: {
      readClipboardFiles: async () => [],
      hasClipboardImage: async () => assert.fail("remote paste must not probe clipboard images"),
    },
    isLocalConnection: false,
    readClipboardText: async () => "",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: () => assert.fail("remote empty paste must not write Ctrl+V"),
    },
    term: {
      paste: () => assert.fail("empty remote paste must not call xterm paste"),
      scrollToBottom: () => {},
    },
  });
});

test("multi-line paste below the confirmation threshold pastes directly", async () => {
  const pasted: string[] = [];
  const confirmed: string[][] = [];

  await handleTerminalClipboardPaste({
    isLocalConnection: false,
    confirmMultilinePaste: {
      enabled: true,
      minLines: 2,
      requestConfirm: async (info) => {
        confirmed.push([String(info.lineCount), String(info.charCount)]);
        return { action: "send", text: "line1\nline2" };
      },
    },
    readClipboardText: async () => "single line",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: () => assert.fail("single-line paste must not use writeToSession"),
    },
    term: {
      paste: (text) => pasted.push(text),
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(confirmed, []);
  assert.deepEqual(pasted, ["single line"]);
});

test("multi-line paste confirmation sends the (possibly edited) preview text", async () => {
  const pasted: string[] = [];
  const requests: Array<{ lineCount: number; charCount: number; text: string }> = [];

  await handleTerminalClipboardPaste({
    isLocalConnection: false,
    confirmMultilinePaste: {
      enabled: true,
      minLines: 2,
      requestConfirm: async (info) => {
        requests.push({ ...info, text: info.text });
        return { action: "send", text: "line1\nedited" };
      },
    },
    readClipboardText: async () => "line1\r\nline2",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: () => assert.fail("send should use xterm paste handling"),
    },
    term: {
      paste: (text) => pasted.push(text),
      scrollToBottom: () => {},
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].lineCount, 2);
  assert.deepEqual(pasted, ["line1\nedited"]);
});

test("multi-line paste confirmation can send line by line with delay", async () => {
  const writes: Array<{ data: string; options?: { automated?: boolean; lineDelayMs?: number; sensitive?: boolean } }> = [];
  const scrolled: string[] = [];
  const pasted: string[] = [];
  const broadcast: Array<{ data: string; options?: { lineDelayMs?: number } }> = [];
  let focused = false;
  // Simulate the dialog staying open while remote output / a reconnect
  // clears the password prompt: the sensitive classification must be taken
  // before the dialog opens, not re-evaluated at send time.
  let passwordPromptActive = true;

  await handleTerminalClipboardPaste({
    isLocalConnection: false,
    isSensitiveInput: () => passwordPromptActive,
    confirmMultilinePaste: {
      enabled: true,
      minLines: 2,
      requestConfirm: async () => {
        passwordPromptActive = false;
        return { action: "line-by-line", text: "conf t\r\nint gi0/0" };
      },
    },
    readClipboardText: async () => "conf t\nint gi0/0",
    onPasteData: (data, options) => {
      broadcast.push({ data, options });
      return true;
    },
    scrollToBottomAfterProgrammaticInput: (data) => scrolled.push(data),
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: (_sessionId, data, options) => writes.push({ data, options }),
    },
    term: {
      focus: () => {
        focused = true;
      },
      paste: (text) => pasted.push(text),
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(writes, [{
    data: "conf t\nint gi0/0\r",
    options: { automated: true, lineDelayMs: 250, sensitive: true },
  }]);
  // A paste made at a sensitive prompt must not be fanned out to broadcast
  // peers, even though the dialog await cleared the live password-prompt ref.
  assert.deepEqual(broadcast, []);
  assert.deepEqual(scrolled, ["conf t\nint gi0/0\r"]);
  assert.deepEqual(pasted, []);
  assert.equal(focused, true);
});

test("line-by-line send converts a single trailing LF to CR so the last line is submitted", async () => {
  const writes: Array<{ data: string; options?: { lineDelayMs?: number } }> = [];

  await handleTerminalClipboardPaste({
    isLocalConnection: false,
    confirmMultilinePaste: {
      enabled: true,
      minLines: 2,
      requestConfirm: async () => ({ action: "line-by-line", text: "show run\n" }),
    },
    readClipboardText: async () => "show run\nconf t",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: (_sessionId, data, options) => writes.push({ data, options }),
    },
    term: {
      paste: () => {},
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(writes, [{
    data: "show run\r",
    options: { automated: true, lineDelayMs: 250, sensitive: false },
  }]);
});

test("line-by-line send revalidates the backend session after the dialog resolves", async () => {
  const writes: Array<{ sessionId: string; data: string }> = [];
  let liveSessionId: string | null = "session-1";

  await handleTerminalClipboardPaste({
    isLocalConnection: false,
    confirmMultilinePaste: {
      enabled: true,
      minLines: 2,
      requestConfirm: async () => {
        // Simulate a reconnect replacing the backend session while the
        // confirmation dialog is open.
        liveSessionId = "session-2";
        return { action: "line-by-line", text: "conf t\nint gi0/0" };
      },
    },
    readClipboardText: async () => "conf t\nint gi0/0",
    sessionId: "session-1",
    getCurrentSessionId: () => liveSessionId,
    terminalBackend: {
      writeToSession: (sessionId, data) => writes.push({ sessionId, data }),
    },
    term: {
      paste: () => {},
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(writes, [{ sessionId: "session-2", data: "conf t\nint gi0/0\r" }]);
});

test("line-by-line send drops the paste when the session is gone after the dialog", async () => {
  let liveSessionId: string | null = "session-1";

  await handleTerminalClipboardPaste({
    isLocalConnection: false,
    confirmMultilinePaste: {
      enabled: true,
      minLines: 2,
      requestConfirm: async () => {
        liveSessionId = null;
        return { action: "line-by-line", text: "conf t\nint gi0/0" };
      },
    },
    readClipboardText: async () => "conf t\nint gi0/0",
    sessionId: "session-1",
    getCurrentSessionId: () => liveSessionId,
    terminalBackend: {
      writeToSession: () => assert.fail("defunct session must not receive the paste"),
    },
    term: {
      paste: () => {},
      scrollToBottom: () => {},
    },
  });
});

test("line-by-line send terminates the final line when the text lacks a trailing newline", async () => {
  const writes: Array<{ data: string; options?: { lineDelayMs?: number } }> = [];

  await handleTerminalClipboardPaste({
    isLocalConnection: false,
    confirmMultilinePaste: {
      enabled: true,
      minLines: 2,
      requestConfirm: async () => ({ action: "line-by-line", text: "conf t\nint gi0/0" }),
    },
    readClipboardText: async () => "conf t\nint gi0/0",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: (_sessionId, data, options) => writes.push({ data, options }),
    },
    term: {
      paste: () => {},
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(writes, [{
    data: "conf t\nint gi0/0\r",
    options: { automated: true, lineDelayMs: 250, sensitive: false },
  }]);
});

test("an intentionally emptied preview sends nothing instead of the original text", async () => {
  const writes: string[] = [];
  const pasted: string[] = [];

  await handleTerminalClipboardPaste({
    isLocalConnection: false,
    confirmMultilinePaste: {
      enabled: true,
      minLines: 2,
      requestConfirm: async () => ({ action: "send", text: "" }),
    },
    readClipboardText: async () => "line1\nline2",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: (_sessionId, data) => writes.push(data),
    },
    term: {
      paste: (text) => pasted.push(text),
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(writes, []);
  assert.deepEqual(pasted, []);
});

test("cancelling the multi-line paste confirmation drops the paste", async () => {
  await handleTerminalClipboardPaste({
    isLocalConnection: false,
    confirmMultilinePaste: {
      enabled: true,
      minLines: 2,
      requestConfirm: async () => ({ action: "cancel", text: "line1\nline2" }),
    },
    readClipboardText: async () => "line1\nline2",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: () => assert.fail("cancelled paste must not write to the session"),
    },
    term: {
      paste: () => assert.fail("cancelled paste must not call xterm paste"),
      scrollToBottom: () => {},
    },
  });
});

test("multi-line paste confirmation skipped when the gate is disabled", async () => {
  const pasted: string[] = [];

  await handleTerminalClipboardPaste({
    isLocalConnection: false,
    confirmMultilinePaste: {
      enabled: false,
      minLines: 2,
      requestConfirm: async () => assert.fail("disabled gate must not open the dialog"),
    },
    readClipboardText: async () => "line1\nline2\nline3",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: () => assert.fail("disabled gate should use xterm paste"),
    },
    term: {
      paste: (text) => pasted.push(text),
      scrollToBottom: () => {},
    },
  });

  assert.deepEqual(pasted, ["line1\nline2\nline3"]);
});

for (const [preview, expected] of [
  ["\ufeffshow\u200b run\r\nshow version", "show run\nshow version\r"],
  ["echo 👩\u200d💻\u200c\n", "echo 👩\u200d💻\u200c\r"],
  ["\ufeff\u200b", ""],
]) {
  test(`line-by-line paste sanitizes preview ${JSON.stringify(preview)}`, async () => {
    const writes: string[] = [];
    const broadcasts: string[] = [];
    await handleTerminalClipboardPaste({
      isLocalConnection: false,
      confirmMultilinePaste: {
        enabled: true,
        minLines: 2,
        requestConfirm: async () => ({ action: "line-by-line", text: preview }),
      },
      readClipboardText: async () => "first\nsecond",
      sessionId: "session-1",
      terminalBackend: { writeToSession: (_id, data) => { writes.push(data); } },
      onPasteData: (data) => { broadcasts.push(data); },
      term: { paste: () => assert.fail("must use delayed writes"), scrollToBottom: () => {} },
    });
    assert.deepEqual(writes, expected ? [expected] : []);
    assert.deepEqual(broadcasts, expected ? [expected] : []);
  });
}
