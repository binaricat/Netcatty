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
