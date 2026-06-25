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
        reject(new Error("Timed out waiting for telnet auto-login"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("startTelnetSession answers login prompts with saved credentials", async () => {
  const received = [];
  const sockets = new Set();
  const serverErrors = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let promptedForUsername = false;
    socket.on("error", (err) => {
      if (err.code !== "ECONNRESET") serverErrors.push(err);
    });
    socket.on("close", () => {
      sockets.delete(socket);
    });
    socket.write("Device bannerPress RETURN to get started.");
    socket.on("data", (chunk) => {
      received.push(chunk);
      const joined = received.join("");
      if (!promptedForUsername && joined.includes("\r")) {
        promptedForUsername = true;
        socket.write("Username: ");
      }
      if (joined.includes("admin\r\n") && !joined.includes("secret\r\n")) {
        socket.write("\r\nPassword: ");
      }
      if (joined.includes("secret\r\n")) {
        socket.end("\r\nWelcome\r\nrouter# ");
      }
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
    const result = await terminalBridge.startTelnetSession(
      { sender: { id: 1 } },
      {
        sessionId: "telnet-auto-login-test",
        hostname: "127.0.0.1",
        port,
        username: "admin",
        password: "secret",
      },
    );

    assert.equal(result.sessionId, "telnet-auto-login-test");
    await waitFor(() => received.join("").includes("\r\nadmin\r\nsecret\r\n"));
    assert.equal(received.join(""), "\r\nadmin\r\nsecret\r\n");
    assert.ok(sentEvents.some((evt) =>
      evt.channel === "netcatty:telnet:auto-login-complete" &&
      evt.payload?.sessionId === "telnet-auto-login-test",
    ));
    assert.deepEqual(serverErrors, []);
  } finally {
    terminalBridge.cleanupAllSessions();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("startTelnetSession encodes saved Telnet credentials with the session charset", async () => {
  const chunks = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
    });
    socket.write("Username: ");
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).includes(iconv.encode("管理员\r\n", "gb18030"))) {
        socket.write("\r\nPassword: ");
      }
    });
  });

  const port = await listen(server);
  const sessions = new Map();
  terminalBridge.init({
    sessions,
    electronModule: {
      webContents: {
        fromId: () => ({
          send() {},
        }),
      },
    },
  });

  try {
    await terminalBridge.startTelnetSession(
      { sender: { id: 1 } },
      {
        sessionId: "telnet-auto-login-gb18030",
        hostname: "127.0.0.1",
        port,
        username: "管理员",
        password: "秘密",
        charset: "GB18030",
      },
    );

    await waitFor(() => Buffer.concat(chunks).length >= iconv.encode("管理员\r\n秘密\r\n", "gb18030").length);
    assert.deepEqual(
      [...Buffer.concat(chunks)],
      [...iconv.encode("管理员\r\n秘密\r\n", "gb18030")],
    );
  } finally {
    terminalBridge.cleanupAllSessions();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("automated Telnet writes do not cancel auto-login", async () => {
  const received = [];
  const sockets = new Set();
  let clientSocket = null;
  const server = net.createServer((socket) => {
    clientSocket = socket;
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
    });
    socket.on("data", (chunk) => {
      received.push(chunk);
      const joined = received.join("");
      if (joined.includes("admin\r\n") && !joined.includes("secret\r\n")) {
        socket.write("\r\nPassword: ");
      }
      if (joined.includes("secret\r\n")) {
        socket.end("\r\nWelcome\r\n");
      }
    });
  });

  const port = await listen(server);
  const sessions = new Map();
  terminalBridge.init({
    sessions,
    electronModule: {
      webContents: {
        fromId: () => ({
          send() {},
        }),
      },
    },
  });

  try {
    await terminalBridge.startTelnetSession(
      { sender: { id: 1 } },
      {
        sessionId: "telnet-automated-write-test",
        hostname: "127.0.0.1",
        port,
        username: "admin",
        password: "secret",
      },
    );
    await waitFor(() => clientSocket);

    terminalBridge.writeToSession(
      {},
      {
        sessionId: "telnet-automated-write-test",
        data: "show version\r",
        automated: true,
      },
    );

    clientSocket.write("Username: ");

    await waitFor(() => received.join("").includes("admin\r\nsecret\r\n"));
    assert.equal(received.join(""), "show version\r\nadmin\r\nsecret\r\n");
  } finally {
    terminalBridge.cleanupAllSessions();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("manual Telnet writes cancel auto-login", async () => {
  const sockets = new Set();
  let clientSocket = null;
  const server = net.createServer((socket) => {
    clientSocket = socket;
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
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
        sessionId: "telnet-manual-write-test",
        hostname: "127.0.0.1",
        port,
        username: "admin",
        password: "secret",
      },
    );
    await waitFor(() => clientSocket);

    terminalBridge.writeToSession(
      {},
      {
        sessionId: "telnet-manual-write-test",
        data: "a",
      },
    );

    await waitFor(() => sentEvents.some((evt) =>
      evt.channel === "netcatty:telnet:auto-login-cancelled" &&
      evt.payload?.sessionId === "telnet-manual-write-test",
    ));
  } finally {
    terminalBridge.cleanupAllSessions();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
