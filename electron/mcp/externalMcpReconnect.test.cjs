"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const EXTERNAL_SERVER = path.join(__dirname, "netcatty-external-mcp-server.cjs");
const MANAGED_SERVER = path.join(__dirname, "netcatty-mcp-server.cjs");

function errorText(result) {
  return (result?.content || []).map((part) => part?.text || "").join("\n");
}

function writeDiscovery(filePath, { port, token }) {
  fs.writeFileSync(filePath, `${JSON.stringify({
    version: 1,
    host: "127.0.0.1",
    port,
    token,
    permissionMode: "confirm",
    chatSessionId: "__external_mcp__",
    updatedAt: new Date().toISOString(),
  })}\n`);
}

function startBridge({ token, authDelayMs = 0, onGetContext = null }) {
  const calls = [];
  const sockets = new Set();
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    let authenticated = false;
    socket.setEncoding("utf8");
    const writeLine = (payload) => {
      if (socket.destroyed) return;
      socket.write(`${JSON.stringify(payload)}\n`);
    };
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        calls.push({
          id: msg.id,
          method: msg.method,
          token: msg.params?.token,
        });
        const respond = () => {
          if (socket.destroyed) return;
          if (msg.method === "auth/verify") {
            if (msg.params?.token !== token) {
              writeLine({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32001, message: "Authentication required. Send auth/verify with valid token first." },
              });
              socket.destroy();
              return;
            }
            authenticated = true;
            writeLine({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
            return;
          }
          // Match the app bridge: a call before auth/verify closes the socket.
          if (!authenticated) {
            writeLine({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32001, message: "Authentication required. Send auth/verify with valid token first." },
            });
            socket.destroy();
            return;
          }
          if (msg.method === "netcatty/getContext" && onGetContext) {
            const action = onGetContext(msg, socket);
            if (action === "hold-and-close") {
              socket.destroy();
              return;
            }
          }
          writeLine({
            jsonrpc: "2.0",
            id: msg.id,
            result: { ok: true, marker: token },
          });
        };
        if (msg.method === "auth/verify" && authDelayMs > 0) {
          setTimeout(respond, authDelayMs);
        } else {
          respond();
        }
      }
    });
  });

  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });

  return {
    calls,
    ready,
    get connections() {
      return connections;
    },
    destroySockets() {
      for (const socket of sockets) socket.destroy();
    },
    close() {
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return Promise.resolve();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function connectClient(entry, env) {
  const client = new Client({ name: "external-mcp-reconnect-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env,
    stderr: "pipe",
  });
  const stderr = [];
  transport.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  try {
    await client.connect(transport);
  } catch (error) {
    error.message = `${error.message}\nstderr:\n${stderr.join("")}`;
    throw error;
  }
  return {
    client,
    stderr,
    pid: transport.pid,
    async close() {
      await client.close();
    },
  };
}

function childEnv(overrides) {
  const env = { ...process.env };
  delete env.NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE;
  delete env.NETCATTY_MCP_PORT;
  delete env.NETCATTY_MCP_TOKEN;
  delete env.NETCATTY_MCP_PERMISSION_MODE;
  delete env.NETCATTY_MCP_CHAT_SESSION_ID;
  delete env.NETCATTY_MCP_SESSION_IDS;
  return { ...env, ...overrides };
}

async function callEnvironment(client) {
  return client.callTool({ name: "get_environment", arguments: {} });
}

async function waitForStoppedChild(pid) {
  const statusPath = `/proc/${pid}/status`;
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try {
      if (/^State:\s+T/m.test(fs.readFileSync(statusPath, "utf8"))) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`child ${pid} did not stop`);
}

test("external stdio bridge reconnects with refreshed discovery after the app endpoint changes", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mcp-reconnect-"));
  const discoveryPath = path.join(tmp, "discovery.json");
  const first = startBridge({ token: "token-first" });
  const firstPort = await first.ready;
  writeDiscovery(discoveryPath, { port: firstPort, token: "token-first" });
  const child = await connectClient(EXTERNAL_SERVER, childEnv({
    NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE: discoveryPath,
  }));
  t.after(async () => {
    await child.close().catch(() => {});
    await first.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const live = await callEnvironment(child.client);
  assert.equal(live.isError, undefined);
  assert.match(errorText(live), /token-first/);

  await first.close();
  const second = startBridge({ token: "token-restarted" });
  t.after(() => second.close().catch(() => {}));
  const secondPort = await second.ready;
  writeDiscovery(discoveryPath, { port: secondPort, token: "token-restarted" });

  const recovered = await callEnvironment(child.client);
  assert.notEqual(recovered.isError, true, errorText(recovered));
  assert.match(errorText(recovered), /token-restarted/);
  assert.deepEqual(
    second.calls.map((call) => call.method),
    ["auth/verify", "netcatty/getContext"],
  );
  assert.equal(second.calls[0].token, "token-restarted");
  assert.equal(second.connections, 1);
});

test("concurrent external calls share one reconnect and one re-auth", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mcp-reconnect-"));
  const discoveryPath = path.join(tmp, "discovery.json");
  const first = startBridge({ token: "token-first" });
  const firstPort = await first.ready;
  writeDiscovery(discoveryPath, { port: firstPort, token: "token-first" });
  const child = await connectClient(EXTERNAL_SERVER, childEnv({
    NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE: discoveryPath,
  }));
  let second = null;
  t.after(async () => {
    await child.close().catch(() => {});
    await first.close().catch(() => {});
    if (second) await second.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  assert.notEqual((await callEnvironment(child.client)).isError, true);
  await first.close();
  // Hold auth open so both tool calls enter recovery before the socket exists.
  second = startBridge({ token: "token-restarted", authDelayMs: 300 });
  const secondPort = await second.ready;
  writeDiscovery(discoveryPath, { port: secondPort, token: "token-restarted" });

  const [left, right] = await Promise.all([
    callEnvironment(child.client),
    callEnvironment(child.client),
  ]);
  assert.notEqual(left.isError, true, errorText(left));
  assert.notEqual(right.isError, true, errorText(right));
  assert.match(errorText(left), /token-restarted/);
  assert.match(errorText(right), /token-restarted/);
  assert.equal(second.connections, 1);
  assert.equal(second.calls.filter((call) => call.method === "auth/verify").length, 1);
  assert.equal(second.calls.filter((call) => call.method === "netcatty/getContext").length, 2);
  assert.equal(second.calls[0].token, "token-restarted");
});

test("in-flight external calls are rejected on disconnect and are not replayed", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mcp-reconnect-"));
  const discoveryPath = path.join(tmp, "discovery.json");
  let holdNext = false;
  const first = startBridge({
    token: "token-first",
    onGetContext: () => (holdNext ? "hold-and-close" : null),
  });
  const firstPort = await first.ready;
  writeDiscovery(discoveryPath, { port: firstPort, token: "token-first" });
  const child = await connectClient(EXTERNAL_SERVER, childEnv({
    NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE: discoveryPath,
  }));
  let second = null;
  t.after(async () => {
    await child.close().catch(() => {});
    await first.close().catch(() => {});
    if (second) await second.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  assert.notEqual((await callEnvironment(child.client)).isError, true);
  holdNext = true;
  const dropped = await callEnvironment(child.client);
  assert.equal(dropped.isError, true);
  assert.match(errorText(dropped), /TCP connection (closed|lost)/);
  const droppedCall = first.calls.filter((call) => call.method === "netcatty/getContext").at(-1);
  assert.ok(droppedCall);

  await first.close();
  second = startBridge({ token: "token-restarted" });
  const secondPort = await second.ready;
  writeDiscovery(discoveryPath, { port: secondPort, token: "token-restarted" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(second.connections, 0);

  const recovered = await callEnvironment(child.client);
  assert.notEqual(recovered.isError, true, errorText(recovered));
  assert.match(errorText(recovered), /token-restarted/);
  assert.deepEqual(
    second.calls.map((call) => call.method),
    ["auth/verify", "netcatty/getContext"],
  );
  assert.equal(second.calls.some((call) => call.id === droppedCall.id), false);
});

test("missing or rejected discovery stays recoverable without killing the external process", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mcp-reconnect-"));
  const discoveryPath = path.join(tmp, "discovery.json");
  const first = startBridge({ token: "token-first" });
  const firstPort = await first.ready;
  writeDiscovery(discoveryPath, { port: firstPort, token: "token-first" });
  const child = await connectClient(EXTERNAL_SERVER, childEnv({
    NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE: discoveryPath,
  }));
  let second = null;
  t.after(async () => {
    await child.close().catch(() => {});
    await first.close().catch(() => {});
    if (second) await second.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  assert.notEqual((await callEnvironment(child.client)).isError, true);
  await first.close();
  fs.rmSync(discoveryPath, { force: true });

  const missing = await callEnvironment(child.client);
  assert.equal(missing.isError, true);
  assert.match(errorText(missing), /temporarily unavailable|unavailable or invalid/i);

  second = startBridge({ token: "token-restarted" });
  const secondPort = await second.ready;
  writeDiscovery(discoveryPath, { port: secondPort, token: "wrong-token" });
  const rejected = await callEnvironment(child.client);
  assert.equal(rejected.isError, true);
  assert.match(errorText(rejected), /temporarily unavailable/i);

  writeDiscovery(discoveryPath, { port: secondPort, token: "token-restarted" });
  const recovered = await callEnvironment(child.client);
  assert.notEqual(recovered.isError, true, `${errorText(recovered)}\n${child.stderr.join("")}`);
  assert.match(errorText(recovered), /token-restarted/);
});

test("managed stdio children fail fast without rereading discovery", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mcp-reconnect-"));
  const discoveryPath = path.join(tmp, "discovery.json");
  const first = startBridge({ token: "managed-token" });
  const firstPort = await first.ready;
  const child = await connectClient(MANAGED_SERVER, childEnv({
    NETCATTY_MCP_PORT: String(firstPort),
    NETCATTY_MCP_TOKEN: "managed-token",
  }));
  let second = null;
  t.after(async () => {
    await child.close().catch(() => {});
    await first.close().catch(() => {});
    if (second) await second.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const live = await callEnvironment(child.client);
  assert.notEqual(live.isError, true, errorText(live));
  await first.close();

  second = startBridge({ token: "token-restarted" });
  const secondPort = await second.ready;
  writeDiscovery(discoveryPath, { port: secondPort, token: "token-restarted" });

  const started = Date.now();
  const failed = await callEnvironment(child.client);
  assert.ok(Date.now() - started < 1000, "managed disconnect must not wait on discovery refresh");
  assert.equal(failed.isError, true);
  assert.match(errorText(failed), /Not connected to Netcatty/);
  assert.equal(second.connections, 0);

  const stillAlive = await callEnvironment(child.client);
  assert.equal(stillAlive.isError, true);
  assert.match(errorText(stillAlive), /Not connected to Netcatty/);
  assert.equal(second.connections, 0);
});

test("managed stdio calls that race bridge shutdown stay not-connected", {
  skip: process.platform === "win32" ? "SIGSTOP is POSIX-only" : false,
  timeout: 10000,
}, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mcp-reconnect-"));
  const discoveryPath = path.join(tmp, "discovery.json");
  const first = startBridge({ token: "managed-token" });
  const firstPort = await first.ready;
  const child = await connectClient(MANAGED_SERVER, childEnv({
    NETCATTY_MCP_PORT: String(firstPort),
    NETCATTY_MCP_TOKEN: "managed-token",
  }));
  let second = null;
  const resumeChild = () => {
    if (!child.pid) return;
    try { process.kill(child.pid, "SIGCONT"); } catch { /* already gone */ }
  };
  t.after(async () => {
    resumeChild();
    await child.close().catch(() => {});
    await first.close().catch(() => {});
    if (second) await second.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const live = await callEnvironment(child.client);
  assert.notEqual(live.isError, true, errorText(live));
  assert.ok(child.pid);
  // Stop the child before the bridge socket is destroyed so the next tool
  // call is queued against a connection the process has not observed yet.
  // Loaded CI hit this ordering and reported "TCP connection lost".
  process.kill(child.pid, "SIGSTOP");
  await waitForStoppedChild(child.pid);
  await first.close();

  second = startBridge({ token: "token-restarted" });
  const secondPort = await second.ready;
  writeDiscovery(discoveryPath, { port: secondPort, token: "token-restarted" });

  const pending = callEnvironment(child.client);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const started = Date.now();
  resumeChild();
  const failed = await pending;
  assert.ok(Date.now() - started < 1000, "managed disconnect must not wait on discovery refresh");
  assert.equal(failed.isError, true);
  assert.match(errorText(failed), /Not connected to Netcatty/);
  assert.equal(second.connections, 0);

  const stillAlive = await callEnvironment(child.client);
  assert.equal(stillAlive.isError, true);
  assert.match(errorText(stillAlive), /Not connected to Netcatty/);
  assert.equal(second.connections, 0);
});
