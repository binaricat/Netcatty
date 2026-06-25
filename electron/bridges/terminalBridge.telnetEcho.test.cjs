const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { setTimeout: delay } = require("node:timers/promises");

const terminalBridge = require("./terminalBridge.cjs");
const { IAC, WILL, WONT, DO, OPT } = require("./telnetProtocol.cjs");

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
        reject(new Error("Timed out waiting for telnet echo event"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

let nextSessionId = 0;

async function runEchoNegotiationTest({ auth = {}, command }) {
  const sessionId = `telnet-echo-test-${nextSessionId++}`;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    setImmediate(() => {
      socket.write(Buffer.from([IAC, command, OPT.ECHO]));
    });
  });

  const port = await listen(server);
  const sessions = new Map();
  const sentEvents = [];
  terminalBridge.init({
    sessions,
    electronModule: {
      webContents: {
        fromId: () => ({
          send(channel, payload) {
            sentEvents.push({ channel, payload });
          },
        }),
      },
    },
  });

  try {
    await terminalBridge.startTelnetSession(
      { sender: { id: 1 } },
      {
        sessionId,
        hostname: "127.0.0.1",
        port,
        ...auth,
      },
    );
    await waitFor(() => sentEvents.some((evt) => evt.channel === "netcatty:telnet:echo-mode"));
    return {
      sessionId,
      payload: sentEvents.find((evt) => evt.channel === "netcatty:telnet:echo-mode").payload,
    };
  } finally {
    terminalBridge.cleanupAllSessions();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("Telnet WONT ECHO does not force local echo for no-auth sessions", async () => {
  const { sessionId, payload } = await runEchoNegotiationTest({ command: WONT });

  assert.deepEqual(payload, {
    sessionId,
    remoteEcho: false,
    localEcho: false,
  });
});

test("Telnet WILL ECHO disables local echo for no-auth sessions", async () => {
  const { sessionId, payload } = await runEchoNegotiationTest({ command: WILL });

  assert.deepEqual(payload, {
    sessionId,
    remoteEcho: true,
    localEcho: false,
  });
});

test("Telnet WONT ECHO does not force local echo for credential sessions", async () => {
  const { sessionId, payload } = await runEchoNegotiationTest({
    command: WONT,
    auth: { username: "admin", password: "secret" },
  });

  assert.deepEqual(payload, {
    sessionId,
    remoteEcho: false,
    localEcho: false,
  });
});

test("Telnet DO ECHO enables client local echo", async () => {
  const { sessionId, payload } = await runEchoNegotiationTest({ command: DO });

  assert.deepEqual(payload, {
    sessionId,
    remoteEcho: true,
    localEcho: true,
  });
});

test("replaced Telnet sockets close without affecting the replacement session", async () => {
  const sessionId = `telnet-echo-test-${nextSessionId++}`;
  const sockets = new Set();
  let oldSocket = null;
  let newSocket = null;
  let resolveOldClosed = () => {};
  const oldClosed = new Promise((resolve) => {
    resolveOldClosed = resolve;
  });
  const oldServer = net.createServer((socket) => {
    oldSocket = socket;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      resolveOldClosed();
    });
  });
  const newServer = net.createServer((socket) => {
    newSocket = socket;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });

  const oldPort = await listen(oldServer);
  const newPort = await listen(newServer);
  const sessions = new Map();
  const sentEvents = [];
  terminalBridge.init({
    sessions,
    electronModule: {
      webContents: {
        fromId: () => ({
          send(channel, payload) {
            sentEvents.push({ channel, payload });
          },
        }),
      },
    },
  });

  try {
    await terminalBridge.startTelnetSession(
      { sender: { id: 1 } },
      { sessionId, hostname: "127.0.0.1", port: oldPort },
    );
    await waitFor(() => oldSocket);
    await terminalBridge.startTelnetSession(
      { sender: { id: 1 } },
      { sessionId, hostname: "127.0.0.1", port: newPort },
    );
    await waitFor(() => newSocket);
    await oldClosed;

    assert.equal(sessions.has(sessionId), true);
    assert.equal(sentEvents.some((evt) => evt.channel === "netcatty:exit"), false);
    assert.equal(sentEvents.some((evt) => evt.channel === "netcatty:telnet:echo-mode"), false);

    newSocket.write(Buffer.from([IAC, WONT, OPT.ECHO]));
    await waitFor(() => sentEvents.some((evt) => evt.channel === "netcatty:telnet:echo-mode"));
    assert.deepEqual(sentEvents.find((evt) => evt.channel === "netcatty:telnet:echo-mode").payload, {
      sessionId,
      remoteEcho: false,
      localEcho: false,
    });
  } finally {
    terminalBridge.cleanupAllSessions();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => oldServer.close(resolve));
    await new Promise((resolve) => newServer.close(resolve));
  }
});

test("replacing a Telnet session cancels delayed automated writes from the old socket", async () => {
  const sessionId = `telnet-echo-test-${nextSessionId++}`;
  const sockets = new Set();
  const oldChunks = [];
  const newChunks = [];
  let oldSocket = null;
  let newSocket = null;
  const oldServer = net.createServer((socket) => {
    oldSocket = socket;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (buf) => oldChunks.push(buf));
  });
  const newServer = net.createServer((socket) => {
    newSocket = socket;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (buf) => newChunks.push(buf));
  });

  const oldPort = await listen(oldServer);
  const newPort = await listen(newServer);
  const sessions = new Map();
  terminalBridge.init({
    sessions,
    electronModule: {
      webContents: {
        fromId: () => ({ send() {} }),
      },
    },
  });

  try {
    await terminalBridge.startTelnetSession(
      { sender: { id: 1 } },
      { sessionId, hostname: "127.0.0.1", port: oldPort },
    );
    await waitFor(() => oldSocket);

    terminalBridge.writeToSession(
      {},
      {
        sessionId,
        data: "old-one\rold-two\r",
        automated: true,
        lineDelayMs: 80,
      },
    );
    await waitFor(() => Buffer.concat(oldChunks).includes(Buffer.from("old-one\r\n")));

    await terminalBridge.startTelnetSession(
      { sender: { id: 1 } },
      { sessionId, hostname: "127.0.0.1", port: newPort },
    );
    await waitFor(() => newSocket);
    await delay(140);

    assert.equal(Buffer.concat(newChunks).includes(Buffer.from("old-two")), false);
  } finally {
    terminalBridge.cleanupAllSessions();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => oldServer.close(resolve));
    await new Promise((resolve) => newServer.close(resolve));
  }
});
