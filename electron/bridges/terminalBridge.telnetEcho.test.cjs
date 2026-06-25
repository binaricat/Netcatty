const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");

const terminalBridge = require("./terminalBridge.cjs");
const { IAC, WILL, WONT, OPT } = require("./telnetProtocol.cjs");

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

test("Telnet WONT ECHO enables local echo for no-auth sessions", async () => {
  const { sessionId, payload } = await runEchoNegotiationTest({ command: WONT });

  assert.deepEqual(payload, {
    sessionId,
    remoteEcho: false,
    localEcho: true,
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

test("Telnet WONT ECHO does not local-echo credential sessions", async () => {
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
