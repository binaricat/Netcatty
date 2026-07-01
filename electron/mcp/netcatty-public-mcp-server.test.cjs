const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  createUnavailableError,
  createRpcTimeoutError,
  resolvePublicRpcTimeoutMs,
  readDiscovery,
  connectPublicBridge,
  createPublicBridgeClientManager,
  mapToolResult,
  PUBLIC_TOOL_DEFINITIONS,
} = require("./netcatty-public-mcp-server.cjs");

function createFakeNetModule(onRequest) {
  const writes = [];
  let socket = null;

  return {
    writes,
    createConnection(_options, onConnect) {
      socket = new EventEmitter();
      socket.destroyed = false;
      socket.writable = true;
      socket.setEncoding = () => {};
      socket.end = () => {
        socket.writable = false;
        socket.destroyed = true;
        socket.emit("close");
      };
      socket.write = (line) => {
        writes.push(line);
        const message = JSON.parse(line);
        onRequest?.(message, (payload) => {
          socket.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...payload })}\n`);
        });
      };
      setImmediate(onConnect);
      return socket;
    },
  };
}

test("readDiscovery returns parsed payload and missing/invalid discovery become unavailable errors", () => {
  const missingFs = {
    readFileSync() {
      const error = new Error("ENOENT");
      error.code = "ENOENT";
      throw error;
    },
  };
  const invalidFs = {
    readFileSync() {
      return "{";
    },
  };
  const validFs = {
    readFileSync() {
      return JSON.stringify({
        version: 1,
        host: "127.0.0.1",
        port: 47123,
        token: "tok",
        pid: 123,
      });
    },
  };

  assert.throws(
    () => readDiscovery({ discoveryPath: "/tmp/discovery.json", fsModule: missingFs }),
    (error) => error.code === "PUBLIC_MCP_UNAVAILABLE" && /not running|disabled/i.test(error.message),
  );

  assert.throws(
    () => readDiscovery({ discoveryPath: "/tmp/discovery.json", fsModule: invalidFs }),
    (error) => error.code === "PUBLIC_MCP_UNAVAILABLE" && /invalid/i.test(error.message),
  );

  assert.deepEqual(
    readDiscovery({ discoveryPath: "/tmp/discovery.json", fsModule: validFs }),
    {
      version: 1,
      host: "127.0.0.1",
      port: 47123,
      token: "tok",
      pid: 123,
    },
  );
});

test("mapToolResult converts success and error payloads into MCP tool responses", () => {
  assert.deepEqual(
    mapToolResult({ ok: true, hosts: [{ sessionId: "ssh-1" }] }),
    {
      content: [{ type: "text", text: JSON.stringify({ ok: true, hosts: [{ sessionId: "ssh-1" }] }, null, 2) }],
    },
  );

  assert.deepEqual(
    mapToolResult({ ok: false, error: "Session not found" }),
    {
      isError: true,
      content: [{ type: "text", text: "Error: Session not found" }],
    },
  );
});

test("public tool definitions map to expected RPC methods and params", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(PUBLIC_TOOL_DEFINITIONS).map(([name, value]) => [name, value.rpcMethod])),
    {
      get_environment: "public/getEnvironment",
      terminal_execute: "public/terminalExecute",
      terminal_start: "public/terminalStart",
      terminal_poll: "public/terminalPoll",
      terminal_stop: "public/terminalStop",
      sftp_list: "public/sftp/list",
      sftp_read_file: "public/sftp/readFile",
      sftp_write_file: "public/sftp/writeFile",
      sftp_stat: "public/sftp/stat",
      sftp_home: "public/sftp/home",
      sftp_mkdir: "public/sftp/mkdir",
      sftp_delete: "public/sftp/delete",
      sftp_rename: "public/sftp/rename",
      sftp_chmod: "public/sftp/chmod",
      asset_list: "public/asset/list",
      asset_get: "public/asset/get",
      asset_add: "public/asset/add",
      asset_edit: "public/asset/edit",
      asset_remove: "public/asset/remove",
      asset_open: "public/asset/open",
      asset_connect: "public/asset/connect",
      asset_disconnect: "public/asset/disconnect",
      asset_reconnect: "public/asset/reconnect",
    },
  );

  assert.deepEqual(
    PUBLIC_TOOL_DEFINITIONS.terminal_poll.buildParams({ jobId: "job-1", offset: 9 }),
    { jobId: "job-1", offset: 9 },
  );
  assert.deepEqual(
    PUBLIC_TOOL_DEFINITIONS.sftp_write_file.buildParams({
      sessionId: "ssh-1",
      path: "/tmp/a",
      content: "hello",
      encoding: "utf8",
    }),
    { sessionId: "ssh-1", path: "/tmp/a", content: "hello", encoding: "utf8" },
  );
  assert.deepEqual(
    PUBLIC_TOOL_DEFINITIONS.sftp_rename.buildParams({
      sessionId: "ssh-1",
      oldPath: "/tmp/a",
      newPath: "/tmp/b",
      encoding: "utf8",
    }),
    { sessionId: "ssh-1", oldPath: "/tmp/a", newPath: "/tmp/b", encoding: "utf8" },
  );
  assert.deepEqual(
    PUBLIC_TOOL_DEFINITIONS.asset_edit.buildParams({
      hostId: "host-1",
      patch: "{\"label\":\"prod\"}",
    }),
    { hostId: "host-1", patch: "{\"label\":\"prod\"}" },
  );
  assert.deepEqual(
    PUBLIC_TOOL_DEFINITIONS.asset_reconnect.buildParams({
      sessionId: "session-1",
      hostId: "host-1",
    }),
    { sessionId: "session-1", hostId: "host-1" },
  );
});

test("public RPC timeout uses bridge command timeout for long-running methods", () => {
  assert.equal(resolvePublicRpcTimeoutMs("public/getEnvironment", 120000), 30000);
  assert.equal(resolvePublicRpcTimeoutMs("public/terminalPoll", 120000), 30000);
  assert.equal(resolvePublicRpcTimeoutMs("public/terminalExecute", 120000), 235000);
  assert.equal(resolvePublicRpcTimeoutMs("public/sftp/writeFile", 120000), 235000);
  assert.equal(resolvePublicRpcTimeoutMs("public/sftp/readFile", null), 65000);
  assert.equal(resolvePublicRpcTimeoutMs("public/sftp/readFile", 1000), 30000);
});

test("public RPC timeout includes approval window for confirm-mode writes", () => {
  assert.equal(resolvePublicRpcTimeoutMs("public/terminalExecute", 120000, "confirm", 110000), 235000);
  assert.equal(resolvePublicRpcTimeoutMs("public/sftp/writeFile", 120000, "confirm", 110000), 235000);
  assert.equal(resolvePublicRpcTimeoutMs("public/sftp/readFile", 120000, "confirm", 110000), 125000);
  assert.equal(resolvePublicRpcTimeoutMs("public/terminalExecute", 120000, "autonomous", 110000), 235000);
});

test("public RPC timeout reserves approval window for writes even when cached mode is stale", () => {
  assert.equal(resolvePublicRpcTimeoutMs("public/terminalExecute", 120000, "autonomous", 110000), 235000);
  assert.equal(resolvePublicRpcTimeoutMs("public/sftp/writeFile", 120000, null, 110000), 235000);
  assert.equal(resolvePublicRpcTimeoutMs("public/sftp/readFile", 120000, null, 110000), 125000);
});

test("public RPC timeout error says client timeout does not cancel bridge operation", () => {
  const error = createRpcTimeoutError("public/sftp/writeFile", 125000);

  assert.equal(error.code, "PUBLIC_MCP_RPC_TIMEOUT");
  assert.match(error.message, /after 125000ms/);
  assert.match(error.message, /does not cancel in-flight operations/i);
  assert.match(error.message, /may still complete/i);
});

test("connectPublicBridge derives long RPC timeout from bridge status commandTimeoutMs", async () => {
  const scheduledTimeouts = [];
  const clearedTimeouts = [];
  const fakeNet = createFakeNetModule((message, respond) => {
    if (message.method === "auth/verify") {
      respond({ result: { ok: true } });
      return;
    }
    if (message.method === "public/getStatus") {
      respond({ result: { ok: true, commandTimeoutMs: 120000, permissionMode: "confirm", approvalTimeoutMs: 110000 } });
    }
  });

  const client = await connectPublicBridge(
    { host: "127.0.0.1", port: 41021, token: "token" },
    {
      netModule: fakeNet,
      setTimeout(callback, delay) {
        const timeout = { callback, delay };
        scheduledTimeouts.push(timeout);
        return timeout;
      },
      clearTimeout(timeout) {
        clearedTimeouts.push(timeout);
      },
    },
  );

  assert.deepEqual(
    JSON.parse(fakeNet.writes[0]),
    { jsonrpc: "2.0", id: 1, method: "auth/verify", params: { token: "token" } },
  );
  assert.deepEqual(
    JSON.parse(fakeNet.writes[1]),
    { jsonrpc: "2.0", id: 2, method: "public/getStatus", params: {} },
  );
  assert.deepEqual(scheduledTimeouts.map((timeout) => timeout.delay), [30000, 30000]);
  assert.deepEqual(clearedTimeouts, scheduledTimeouts);

  const pendingCall = client.call("public/terminalExecute", {
    sessionId: "ssh-1",
    command: "sleep 35",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(scheduledTimeouts.at(-1).delay, 235000);
  scheduledTimeouts.at(-1).callback();

  await assert.rejects(
    pendingCall,
    (error) => error.code === "PUBLIC_MCP_RPC_TIMEOUT" &&
      /after 235000ms/.test(error.message) &&
      /may still complete/i.test(error.message),
  );

  client.close();
});

test("client manager connects, authenticates, and reconnects after stale discovery/auth changes", async () => {
  const discoveryQueue = [
    { host: "127.0.0.1", port: 41001, token: "old-token" },
    { host: "127.0.0.1", port: 41002, token: "new-token" },
  ];
  const connectionAttempts = [];
  const clients = [];

  function makeClient(label, behavior) {
    let closed = false;
    return {
      label,
      get closed() {
        return closed;
      },
      async call(method, params) {
        return await behavior(method, params);
      },
      close() {
        closed = true;
      },
    };
  }

  const manager = createPublicBridgeClientManager({
    readDiscovery() {
      return discoveryQueue[0];
    },
    async connectPublicBridge(discovery) {
      connectionAttempts.push({ ...discovery });
      if (discovery.port === 41001) {
        const client = makeClient("stale", async (method) => {
          if (method === "auth/verify") {
            return { ok: false, error: "stale token" };
          }
          throw new Error("should not call methods on stale client");
        });
        clients.push(client);
        return client;
      }

      const client = makeClient("fresh", async (method, params) => {
        if (method === "auth/verify") return { ok: true };
        return { ok: true, method, params };
      });
      clients.push(client);
      return client;
    },
    shouldRetryConnection(error) {
      return /stale|auth|closed|refused/i.test(error.message);
    },
    onRetry() {
      discoveryQueue.shift();
    },
  });

  const result = await manager.call("public/getEnvironment", {});

  assert.deepEqual(result, { ok: true, method: "public/getEnvironment", params: {} });
  assert.deepEqual(connectionAttempts, [
    { host: "127.0.0.1", port: 41001, token: "old-token" },
    { host: "127.0.0.1", port: 41002, token: "new-token" },
  ]);
  assert.equal(clients[0].closed, true);
  assert.equal(clients[1].closed, false);
});

test("client manager reconnects on closed connection and returns unavailable after retry failure", async () => {
  const discoveryQueue = [
    { host: "127.0.0.1", port: 41011, token: "token-a" },
    { host: "127.0.0.1", port: 41012, token: "token-b" },
  ];
  const manager = createPublicBridgeClientManager({
    readDiscovery() {
      return discoveryQueue[0];
    },
    async connectPublicBridge(discovery) {
      if (discovery.port === 41011) {
        return {
          async call(method) {
            if (method === "auth/verify") return { ok: true };
            throw new Error("Connection closed");
          },
          close() {},
        };
      }
      throw createUnavailableError("Netcatty is not running or Public MCP is disabled.");
    },
    shouldRetryConnection(error) {
      return /closed|refused|stale|auth/i.test(error.message);
    },
    onRetry() {
      discoveryQueue.shift();
    },
  });

  await assert.rejects(
    manager.call("public/getStatus", {}),
    (error) => error.code === "PUBLIC_MCP_UNAVAILABLE" && /disabled|not running/i.test(error.message),
  );
});

test("client manager preserves non-retry timeout errors after reconnect attempt", async () => {
  const discoveryQueue = [
    { host: "127.0.0.1", port: 41031, token: "token-a" },
    { host: "127.0.0.1", port: 41032, token: "token-b" },
  ];
  const clients = [];
  const manager = createPublicBridgeClientManager({
    readDiscovery() {
      return discoveryQueue[0];
    },
    async connectPublicBridge(discovery) {
      const client = {
        async call(method) {
          if (method === "auth/verify") return { ok: true };
          if (discovery.port === 41031) throw new Error("Connection closed");
          throw createRpcTimeoutError(method, 125000);
        },
        close() {},
      };
      clients.push(client);
      return client;
    },
    shouldRetryConnection(error) {
      return /closed|refused|stale|auth/i.test(error.message);
    },
    onRetry() {
      discoveryQueue.shift();
    },
  });

  await assert.rejects(
    manager.call("public/sftp/writeFile", {}),
    (error) => error.code === "PUBLIC_MCP_RPC_TIMEOUT" && /may still complete/i.test(error.message),
  );
  assert.equal(clients.length, 2);
});
