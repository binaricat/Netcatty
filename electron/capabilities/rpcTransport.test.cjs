"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  createNdjsonRpcClient,
  createTaggedError,
} = require("./rpcTransport.cjs");
const { CAPABILITY_SURFACES } = require("./constants.cjs");

function createFakeSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.writable = true;
  socket.setEncoding = () => {};
  socket.end = () => {
    socket.writable = false;
    socket.destroyed = true;
    socket.emit("close");
  };
  socket.write = (line, callback) => {
    const request = JSON.parse(line);
    socket.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n`);
    callback?.(null);
    return true;
  };
  return socket;
}

test("createNdjsonRpcClient resolves rpc responses", async () => {
  const socket = createFakeSocket();
  const client = createNdjsonRpcClient({ socket, surface: CAPABILITY_SURFACES.BUILTIN });

  const result = await client.call("netcatty/getStatus", {});
  assert.deepEqual(result, { ok: true });
});

test("createNdjsonRpcClient surfaces RPC_ERROR with code for bridge failures", async () => {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.writable = true;
  socket.setEncoding = () => {};
  socket.write = (line, callback) => {
    const request = JSON.parse(line);
    socket.emit("data", `${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { message: "Operation denied by user." },
    })}\n`);
    callback?.(null);
    return true;
  };

  const client = createNdjsonRpcClient({
    socket,
    surface: CAPABILITY_SURFACES.BUILTIN,
    createError: createTaggedError,
  });

  await assert.rejects(
    () => client.call("netcatty/exec", { sessionId: "sess-1", command: "pwd" }),
    (error) => error.code === "RPC_ERROR" && error.message === "Operation denied by user.",
  );
});

test("createNdjsonRpcClient uses injectable cli-compatible timeout messages", async () => {
  const socket = createFakeSocket();
  const client = createNdjsonRpcClient({
    socket,
    surface: CAPABILITY_SURFACES.BUILTIN,
    createError: createTaggedError,
    setTimeoutImpl: (callback) => {
      callback();
      return 1;
    },
    messages: {
      rpcTimeout: (method, timeoutMs) => (
        `Timed out waiting for Netcatty RPC response to "${method}" after ${timeoutMs}ms.`
      ),
    },
  });

  await assert.rejects(
    () => client.call("netcatty/exec", { sessionId: "sess-1", command: "pwd", chatSessionId: "chat-1" }),
    (error) => error.code === "RPC_TIMEOUT" && /Netcatty RPC response/.test(error.message),
  );
});

test("createNdjsonRpcClient ingests bridge status for timeout calculation", async () => {
  const socket = createFakeSocket();
  let captured = null;
  const client = createNdjsonRpcClient({
    socket,
    surface: CAPABILITY_SURFACES.BUILTIN,
    onBridgeStatus: (status) => {
      captured = status;
    },
  });

  client.ingestBridgeStatus({
    commandTimeoutMs: 45_000,
    permissionMode: "confirm",
    approvalTimeoutMs: 120_000,
  });

  assert.deepEqual(captured, {
    bridgeCommandTimeoutMs: 45_000,
    bridgePermissionMode: "confirm",
    bridgeApprovalTimeoutMs: 120_000,
  });
});
