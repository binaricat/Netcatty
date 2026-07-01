/**
 * Repro: multi-line compose bar input only sent the first line.
 *
 * Path: compose bar textarea -> executeSnippetCommand(text, false) ->
 * multi-line autoRun -> lineDelayMs=250 -> backend writeToSession sends the
 * first line immediately and queues the remaining lines in
 * session.pendingAutomatedWriteTimers.
 *
 * Root cause: terminal-originated automatic replies used the same netcatty:write
 * path without the automated flag. Treating those replies as user input cleared
 * queued lines, so only the first line was sent.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const terminalBridge = require("./terminalBridge.cjs");

function initBridge(sessions) {
  terminalBridge.init({
    sessions,
    electronModule: {
      webContents: { fromId: () => ({ send() {} }) },
    },
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Expected behavior: harmless terminal auto-replies must not cancel queued lines.
test("[REPRO] terminal auto-reply between automated lines must NOT cancel pending lines", async () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("ssh-1", {
    stream: { signal() {}, write(data) { calls.push(data); } },
  });
  initBridge(sessions);

  terminalBridge.writeToSession(
    { sender: {} },
    {
      sessionId: "ssh-1",
      data: "echo one\necho two\necho three\r",
      automated: true,
      lineDelayMs: 20,
    },
  );
  assert.deepEqual(calls, ["echo one\r"], "the first line is sent immediately");

  terminalBridge.writeToSession({ sender: {} }, { sessionId: "ssh-1", data: "\x1b[2;1R" });

  await delay(80);

  assert.deepEqual(
    calls,
    ["echo one\r", "\x1b[2;1R", "echo two\r", "echo three\r"],
    "terminal auto-replies should not clear queued line writes",
  );
});

test("[REPRO] Kitty keyboard query reply must NOT cancel pending lines", async () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("ssh-1", {
    stream: { signal() {}, write(data) { calls.push(data); } },
  });
  initBridge(sessions);

  terminalBridge.writeToSession(
    { sender: {} },
    {
      sessionId: "ssh-1",
      data: "echo one\necho two\necho three\r",
      automated: true,
      lineDelayMs: 20,
    },
  );
  assert.deepEqual(calls, ["echo one\r"], "the first line is sent immediately");

  terminalBridge.writeToSession({ sender: {} }, { sessionId: "ssh-1", data: "\x1b[?0u" });

  await delay(80);

  assert.deepEqual(
    calls,
    ["echo one\r", "\x1b[?0u", "echo two\r", "echo three\r"],
    "Kitty query replies should not clear queued line writes",
  );
});

// Guardrail: real user interruption must still cancel queued automated writes.
test("[GUARD] Ctrl+C between automated lines SHOULD cancel pending lines", async () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("ssh-1", {
    stream: { signal() {}, write(data) { calls.push(data); } },
  });
  initBridge(sessions);

  terminalBridge.writeToSession(
    { sender: {} },
    { sessionId: "ssh-1", data: "echo one\necho two\r", automated: true, lineDelayMs: 20 },
  );
  assert.deepEqual(calls, ["echo one\r"]);

  terminalBridge.writeToSession({ sender: {} }, { sessionId: "ssh-1", data: "\x03" }); // Ctrl+C
  await delay(60);

  assert.deepEqual(calls, ["echo one\r", "\x03"], "Ctrl+C should cancel queued line writes");
});
