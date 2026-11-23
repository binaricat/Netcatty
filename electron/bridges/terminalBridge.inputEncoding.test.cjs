"use strict";

// --- merged from terminalBridge.inputEncoding.test.cjs ---
{
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const iconv = require("iconv-lite");

const terminalBridge = require("./terminalBridge.cjs");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("Timed out waiting for telnet input bytes"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

// These tests drive the real terminalBridge.writeToSession path over a raw TCP
// "device" that never speaks the Telnet protocol (no IAC bytes), so the bytes
// captured server-side are exactly what the input path serialized — proving
// the keystroke encoding without IAC-escaping noise. They guard issue #1216:
// input must use the SAME charset the output decoder uses.

function initBridge(sessions) {
  terminalBridge.init({
    sessions,
    electronModule: {
      webContents: {
        fromId: () => ({ send() {} }),
      },
    },
  });
}

test("Telnet input is encoded with the session's GB18030 charset", async () => {
  const chunks = [];
  const sockets = new Set();
  let serverSocket = null;
  const server = net.createServer((socket) => {
    serverSocket = socket;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (buf) => chunks.push(buf));
  });

  const port = await listen(server);
  const sessions = new Map();
  initBridge(sessions);

  try {
    await terminalBridge.startTelnetSession(
      { sender: { id: 1 } },
      {
        sessionId: "telnet-gb18030-input",
        hostname: "127.0.0.1",
        port,
        // No saved credentials → auto-login stays idle and does not inject bytes.
        charset: "GB18030",
      },
    );
    await waitFor(() => serverSocket);

    terminalBridge.writeToSession(
      {},
      { sessionId: "telnet-gb18030-input", data: "你好\r" },
    );

    await waitFor(() => Buffer.concat(chunks).length >= 6);
    const received = Buffer.concat(chunks);
    assert.deepEqual([...received], [...iconv.encode("你好\r\n", "gb18030")]);
    // It must NOT be the UTF-8 serialization that the old code always sent.
    assert.notDeepEqual([...received], [...Buffer.from("你好\r", "utf8")]);
  } finally {
    terminalBridge.cleanupAllSessions();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Telnet input stays UTF-8 when no charset is configured", async () => {
  const chunks = [];
  const sockets = new Set();
  let serverSocket = null;
  const server = net.createServer((socket) => {
    serverSocket = socket;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (buf) => chunks.push(buf));
  });

  const port = await listen(server);
  const sessions = new Map();
  initBridge(sessions);

  try {
    await terminalBridge.startTelnetSession(
      { sender: { id: 1 } },
      {
        sessionId: "telnet-utf8-input",
        hostname: "127.0.0.1",
        port,
      },
    );
    await waitFor(() => serverSocket);

    terminalBridge.writeToSession(
      {},
      { sessionId: "telnet-utf8-input", data: "你好\r" },
    );

    await waitFor(() => Buffer.concat(chunks).length >= 8);
    const received = Buffer.concat(chunks);
    assert.deepEqual([...received], [...Buffer.from("你好\r\n", "utf8")]);
  } finally {
    terminalBridge.cleanupAllSessions();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Telnet Enter is sent as CRLF so RT-Thread shells submit the command", async () => {
  const chunks = [];
  const sockets = new Set();
  let serverSocket = null;
  const server = net.createServer((socket) => {
    serverSocket = socket;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (buf) => chunks.push(buf));
  });

  const port = await listen(server);
  const sessions = new Map();
  initBridge(sessions);

  try {
    await terminalBridge.startTelnetSession(
      { sender: { id: 1 } },
      {
        sessionId: "telnet-rtthread-enter",
        hostname: "127.0.0.1",
        port,
      },
    );
    await waitFor(() => serverSocket);

    terminalBridge.writeToSession(
      {},
      { sessionId: "telnet-rtthread-enter", data: "ps\r" },
    );

    await waitFor(() => Buffer.concat(chunks).length >= 3);
    const received = Buffer.concat(chunks);
    assert.deepEqual([...received], [...Buffer.from("ps\r\n", "utf8")]);
  } finally {
    terminalBridge.cleanupAllSessions();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Telnet input preserves existing CRLF and CR NUL while normalizing bare LF", async () => {
  const chunks = [];
  const sockets = new Set();
  let serverSocket = null;
  const server = net.createServer((socket) => {
    serverSocket = socket;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (buf) => chunks.push(buf));
  });

  const port = await listen(server);
  const sessions = new Map();
  initBridge(sessions);

  try {
    await terminalBridge.startTelnetSession(
      { sender: { id: 1 } },
      {
        sessionId: "telnet-rfc-newlines",
        hostname: "127.0.0.1",
        port,
      },
    );
    await waitFor(() => serverSocket);

    terminalBridge.writeToSession(
      {},
      { sessionId: "telnet-rfc-newlines", data: "one\r\ntwo\nthree\r\0" },
    );

    await waitFor(() => Buffer.concat(chunks).length >= 17);
    const received = Buffer.concat(chunks);
    assert.deepEqual([...received], [...Buffer.from("one\r\ntwo\r\nthree\r\0", "utf8")]);
  } finally {
    terminalBridge.cleanupAllSessions();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("setSessionEncoding switches the Telnet input charset at runtime", async () => {
  const chunks = [];
  const sockets = new Set();
  let serverSocket = null;
  const server = net.createServer((socket) => {
    serverSocket = socket;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (buf) => chunks.push(buf));
  });

  const port = await listen(server);
  const sessions = new Map();
  initBridge(sessions);

  try {
    await terminalBridge.startTelnetSession(
      { sender: { id: 1 } },
      {
        sessionId: "telnet-switch-input",
        hostname: "127.0.0.1",
        port,
      },
    );
    await waitFor(() => serverSocket);

    const switchResult = terminalBridge.setSessionEncoding(
      {},
      { sessionId: "telnet-switch-input", encoding: "gbk" },
    );
    // "gbk" normalizes onto the gb18030 superset and is mirrored to
    // session.encoding so the input path picks it up immediately.
    assert.deepEqual(switchResult, { ok: true, encoding: "gb18030" });
    assert.equal(sessions.get("telnet-switch-input").encoding, "gb18030");

    terminalBridge.writeToSession(
      {},
      { sessionId: "telnet-switch-input", data: "测试\r" },
    );

    await waitFor(() => Buffer.concat(chunks).length >= 6);
    const received = Buffer.concat(chunks);
    assert.deepEqual([...received], [...iconv.encode("测试\r\n", "gb18030")]);
  } finally {
    terminalBridge.cleanupAllSessions();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
}

// --- merged from terminalBridge.binaryInput.test.cjs ---
{
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPreloadApi } = require("../preload/api.cjs");
const terminalBridge = require("./terminalBridge.cjs");

function setup(session) {
  terminalBridge.init({ sessions: new Map([["session", session]]) });
  const sent = [];
  const api = createPreloadApi({
    ipcRenderer: {
      send(channel, payload) {
        sent.push({ channel, payload });
        // Model Electron structured-clone IPC, including the binary flag.
        terminalBridge.writeToSession({}, structuredClone(payload));
      },
    },
    webUtils: {},
  });
  return { api, sent };
}

for (const transport of ["stream", "proc", "socket", "serialPort"]) {
  for (const encoding of ["utf-8", "gb18030"]) {
    test(`binary input preserves all byte values through preload to ${transport} (${encoding})`, () => {
      const writes = [];
      const { api, sent } = setup({
        type: transport === "serialPort" ? "serial" : "ssh",
        encoding,
        [transport]: { write: (data) => writes.push(data) },
      });
      const bytes = Array.from({ length: 256 }, (_, i) => i);
      const data = String.fromCharCode(...bytes);
      api.writeToSession("session", data, { binary: true });

      assert.equal(sent[0].channel, "netcatty:write");
      assert.equal(sent[0].payload.binary, true);
      assert.equal(sent[0].payload.data, data);
      assert.equal(writes.length, 1);
      assert.ok(Buffer.isBuffer(writes[0]));
      assert.deepEqual([...writes[0]], bytes);
    });
  }
}

test("binary Telnet input preserves bytes and still doubles IAC", () => {
  const writes = [];
  const { api } = setup({
    type: "telnet-native",
    encoding: "gb18030",
    telnetProtocolActive: true,
    socket: { write: (data) => writes.push(data) },
  });
  const bytes = [0x1b, 0x5b, 0x4d, 0x20, 0xc0, 0xff, 0x0d, 0x21, 0x0a];
  api.writeToSession("session", String.fromCharCode(...bytes), { binary: true });
  assert.equal(writes.length, 1);
  assert.ok(Buffer.isBuffer(writes[0]));
  assert.deepEqual([...writes[0]], [0x1b, 0x5b, 0x4d, 0x20, 0xc0, 0xff, 0xff, 0x0d, 0x21, 0x0a]);
});

test("ordinary CJK text retains the default UTF-8 string path", () => {
  const writes = [];
  const { api, sent } = setup({
    type: "ssh",
    encoding: "utf-8",
    stream: { write: (data) => writes.push(data) },
  });
  const text = "\u4e2d\u6587";
  api.writeToSession("session", text);
  assert.equal(sent[0].payload.binary, false);
  assert.deepEqual(writes, [text]);
  assert.deepEqual([...Buffer.from(writes[0], "utf8")], [0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87]);
});
}

// --- merged from terminalBridge.composeMultiline.test.cjs ---
{
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
}
