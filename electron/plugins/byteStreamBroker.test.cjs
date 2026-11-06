"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const net = require("node:net");
const tls = require("node:tls");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { LIMITS, PluginByteStreamBroker, canonicalizeStreamEndpoint, isLocalControlAddress } = require("./byteStreamBroker.cjs");
const { RPC_ERRORS } = require("./rpcRouter.cjs");

function context(runtimeId = "runtime-a", controller = new AbortController()) {
  return { pluginId: "test.stream", runtimeId, signal: controller.signal,
    assertActive: async () => controller.signal.throwIfAborted() };
}

async function server(t, listener, options) {
  const sockets = new Set();
  const instance = options ? tls.createServer(options, listener) : net.createServer(listener);
  instance.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  instance.on("tlsClientError", () => {});
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => instance.close(resolve));
  });
  return instance;
}

function broker(t, endpoint, options = {}) {
  const audit = [];
  const requests = [];
  let revoke;
  const instance = new PluginByteStreamBroker({
    permissionEngine: {
      authorize: async (_ctx, request) => requests.push(request),
      onDidRevoke(listener) { revoke = listener; return { dispose() {} }; },
    },
    audit: (...args) => audit.push(args),
    testLocalEndpoints: endpoint ? [endpoint] : [],
    ...options,
  });
  t.after(() => instance.shutdown());
  return { instance, requests, audit, revoke: (event) => revoke(event) };
}

test("stream endpoint canonicalization requires one exact host, transport and port", () => {
  assert.equal(canonicalizeStreamEndpoint("tls://EXAMPLE.test:443").endpoint, "tls://example.test:443");
  assert.equal(canonicalizeStreamEndpoint("tcp://[0:0:0:0:0:0:0:1]:3306").endpoint, "tcp://[::1]:3306");
  for (const value of ["*", "tcp://*:3306", "tcp://x:0", "tcp://x:01", "tcp://x:65536", "udp://x:22",
    "tcp://x", "tcp://x:22/", "tcp://user@x:22", "tcp://127.1:22", "tcp://x:22?x", "tcp://x.:22",
    "tcp://[::1%25lo]:22", "tcp://x:22#x", "tcp://-x:22"]) {
    assert.throws(() => canonicalizeStreamEndpoint(value), TypeError, value);
  }
});

test("local/control address classification handles mapped IPv6 and alternate literals", () => {
  for (const address of ["127.0.0.1", "127.9.8.7", "0.0.0.0", "169.254.169.254", "224.0.0.1",
    "::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "fe80::1", "ff02::1", "2002:7f00:1::"]) {
    assert.equal(isLocalControlAddress(address), true, address);
  }
  for (const address of ["192.168.1.2", "10.0.0.8", "203.0.113.1", "2001:db8::1", "fd00::1"]) {
    assert.equal(isLocalControlAddress(address), false, address);
  }
});

test("real TCP transport exchanges binary bytes and records no payloads", async (t) => {
  const peer = await server(t, (socket) => socket.on("data", (bytes) => socket.write(bytes)));
  const endpoint = `tcp://127.0.0.1:${peer.address().port}`;
  const { instance, requests, audit } = broker(t, endpoint);
  const ctx = context();
  const handle = await instance.connect(endpoint, ctx);
  const bytes = Uint8Array.from([0, 255, 1, 254, 19]);
  await instance.write(handle.handleId, bytes, ctx);
  assert.deepEqual(await instance.read(handle.handleId, ctx), bytes);
  instance.close(handle.handleId, ctx);
  assert.equal(instance.connections.size, 0);
  assert.deepEqual(requests[0].resources, [endpoint]);
  assert.equal(requests[0].permission, "network.stream");
  assert.deepEqual(audit.map((entry) => entry[1]), ["network.stream.open", "network.stream.close"]);
  assert.equal(audit[1][2].bytesRead, bytes.byteLength);
  assert.equal(audit[1][2].bytesWritten, bytes.byteLength);
  assert.equal(JSON.stringify(audit).includes("data"), false);
});

test("remote EOF returns the final bytes and releases the connection", async (t) => {
  const peer = await server(t, (socket) => socket.end("synthetic final bytes"));
  const endpoint = `tcp://127.0.0.1:${peer.address().port}`;
  const { instance } = broker(t, endpoint);
  const ctx = context();
  const { handleId } = await instance.connect(endpoint, ctx);
  const chunks = [];
  while (true) {
    const chunk = await instance.read(handleId, ctx);
    if (chunk === null) break;
    chunks.push(Buffer.from(chunk));
  }
  assert.equal(Buffer.concat(chunks).toString(), "synthetic final bytes");
  assert.equal(instance.connections.size, 0);
});

test("a delayed consumer can observe EOF after the real socket has closed", async (t) => {
  const peer = await server(t, (socket) => socket.end("final"));
  const endpoint = `tcp://127.0.0.1:${peer.address().port}`;
  const { instance, revoke } = broker(t, endpoint);
  const ctx = context();
  const { handleId } = await instance.connect(endpoint, ctx);
  const socket = instance.connections.get(handleId).socket;
  const closed = once(socket, "close");
  assert.equal(Buffer.from(await instance.read(handleId, ctx)).toString(), "final");
  await closed;
  await assert.rejects(instance.read(handleId, context("other-runtime")), { code: RPC_ERRORS.permissionDenied });
  assert.equal(await instance.read(handleId, ctx), null);
  assert.equal(instance.connections.size, 0);
  const second = await instance.connect(endpoint, ctx);
  const secondClosed = once(instance.connections.get(second.handleId).socket, "close");
  await instance.read(second.handleId, ctx);
  await secondClosed;
  revoke({ pluginId: ctx.pluginId, permission: "network.stream", resource: endpoint });
  await assert.rejects(instance.read(second.handleId, ctx), { code: RPC_ERRORS.permissionDenied });
});

test("denial happens before DNS or a socket is created", async (t) => {
  let lookedUp = false;
  const { instance } = broker(t, null, {
    permissionEngine: { authorize: async () => { throw new Error("denied"); }, onDidRevoke: () => ({ dispose() {} }) },
    lookup: () => { lookedUp = true; },
  });
  await assert.rejects(instance.connect("tcp://example.test:22", context()), /denied/u);
  assert.equal(lookedUp, false);
  assert.equal(instance.connections.size, 0);
});

test("production rejects loopback, mixed DNS answers, and app control peers", async (t) => {
  const endpoint = "tcp://example.test:22";
  const { instance } = broker(t, null, {
    lookup: async () => [{ address: "203.0.113.1", family: 4 }, { address: "127.0.0.1", family: 4 }],
  });
  await assert.rejects(instance.connect(endpoint, context()), { code: RPC_ERRORS.permissionDenied });
  await assert.rejects(instance.connect("tcp://127.0.0.1:22", context()), { code: RPC_ERRORS.permissionDenied });
  const protectedBroker = broker(t, "tcp://127.0.0.1:22", { isControlEndpoint: () => true }).instance;
  await assert.rejects(protectedBroker.connect("tcp://127.0.0.1:22", context()), { code: RPC_ERRORS.permissionDenied });
});

test("runtime handles cannot cross runtime or plugin boundaries", async (t) => {
  const peer = await server(t, () => {});
  const endpoint = `tcp://127.0.0.1:${peer.address().port}`;
  const { instance } = broker(t, endpoint);
  const ctx = context();
  const { handleId } = await instance.connect(endpoint, ctx);
  for (const other of [context("runtime-b"), { ...ctx, pluginId: "test.other" }]) {
    await assert.rejects(instance.read(handleId, other), { code: RPC_ERRORS.permissionDenied });
    assert.throws(() => instance.close(handleId, other), { code: RPC_ERRORS.permissionDenied });
  }
  instance.close(handleId, ctx);
  await assert.rejects(instance.write(handleId, Uint8Array.of(1), ctx), { code: RPC_ERRORS.permissionDenied });
});

test("revocation and runtime release cancel pending real reads", async (t) => {
  const peer = await server(t, () => {});
  const endpoint = `tcp://127.0.0.1:${peer.address().port}`;
  const { instance, revoke } = broker(t, endpoint);
  const ctx = context();
  let handle = await instance.connect(endpoint, ctx);
  const reading = instance.read(handle.handleId, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  revoke({ pluginId: ctx.pluginId, permission: "network.stream", resource: endpoint });
  await assert.rejects(reading, { code: RPC_ERRORS.permissionDenied });
  assert.equal(instance.connections.size, 0);
  handle = await instance.connect(endpoint, ctx);
  const secondRead = instance.read(handle.handleId, ctx);
  instance.releaseRuntime(ctx.runtimeId);
  await assert.rejects(secondRead, { code: RPC_ERRORS.unavailable });
  assert.equal(instance.connections.size, 0);
});

test("cancellation during DNS rejects promptly and ignores late resolution", async (t) => {
  let resolveDns;
  let dialed = false;
  const { instance } = broker(t, null, {
    lookup: () => new Promise((resolve) => { resolveDns = resolve; }),
    connectSocket: () => { dialed = true; },
  });
  const controller = new AbortController();
  const pending = instance.connect("tcp://example.test:22", context("runtime-a", controller));
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: RPC_ERRORS.cancelled });
  resolveDns([{ address: "203.0.113.1", family: 4 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dialed, false);
  assert.equal(instance.connections.size, 0);
});

test("cancellation after the last async guard cannot create a late real socket", async (t) => {
  const peer = await server(t, () => {});
  const endpoint = `tcp://127.0.0.1:${peer.address().port}`;
  let dialed = false;
  const { instance } = broker(t, endpoint, { connectSocket(options) {
    dialed = true;
    const socket = net.createConnection(options);
    t.after(() => socket.destroy());
    return socket;
  } });
  const controller = new AbortController();
  let guards = 0;
  const ctx = context("runtime-a", controller);
  ctx.assertActive = async () => {
    controller.signal.throwIfAborted();
    if (++guards === 3) queueMicrotask(() => queueMicrotask(() => controller.abort()));
  };
  await assert.rejects(instance.connect(endpoint, ctx), { code: RPC_ERRORS.cancelled });
  assert.equal(dialed, false);
  assert.equal(instance.connections.size, 0);
});

test("connect and idle deadlines close resources and reject pending operations", async (t) => {
  const peer = await server(t, () => {});
  const endpoint = `tcp://127.0.0.1:${peer.address().port}`;
  const { instance } = broker(t, endpoint);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = context();
  const { handleId } = await instance.connect(endpoint, ctx);
  const reading = instance.read(handleId, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(LIMITS.idleMs);
  await assert.rejects(reading, { code: RPC_ERRORS.deadlineExceeded });
  assert.equal(instance.connections.size, 0);
  let resolveDns;
  let dialed = false;
  const slow = broker(t, null, {
    lookup: () => new Promise((resolve) => { resolveDns = resolve; }),
    connectSocket: () => { dialed = true; },
  }).instance;
  const pending = slow.connect("tcp://example.test:22", ctx);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(LIMITS.connectMs);
  await assert.rejects(pending, { code: RPC_ERRORS.deadlineExceeded });
  resolveDns([{ address: "203.0.113.1", family: 4 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dialed, false);
  assert.equal(slow.connections.size, 0);
});

test("concurrent operations and oversized writes cannot grow an unbounded queue", async (t) => {
  const peer = await server(t, () => {});
  const endpoint = `tcp://127.0.0.1:${peer.address().port}`;
  const { instance } = broker(t, endpoint);
  const ctx = context();
  const { handleId } = await instance.connect(endpoint, ctx);
  const pending = instance.read(handleId, ctx);
  await assert.rejects(instance.read(handleId, ctx), { code: RPC_ERRORS.failedPrecondition });
  await assert.rejects(instance.write(handleId, new Uint8Array(LIMITS.chunkBytes + 1), ctx), { code: RPC_ERRORS.invalidArgument });
  const writing = instance.write(handleId, Uint8Array.of(1), ctx);
  await assert.rejects(instance.write(handleId, Uint8Array.of(2), ctx), { code: RPC_ERRORS.resourceExhausted });
  await writing;
  instance.close(handleId, ctx);
  await assert.rejects(pending, { code: RPC_ERRORS.cancelled });
});

test("connection reservations bound concurrent DNS operations", async (t) => {
  const { instance } = broker(t, null, { lookup: () => new Promise(() => {}) });
  const ctx = context();
  const pending = Array.from({ length: LIMITS.connectionsPerRuntime }, () => instance.connect("tcp://example.test:22", ctx));
  const results = Promise.allSettled(pending);
  await assert.rejects(instance.connect("tcp://example.test:22", ctx), { code: RPC_ERRORS.resourceExhausted });
  instance.releaseRuntime(ctx.runtimeId);
  assert.ok((await results).every((result) => result.status === "rejected"));
  assert.equal(instance.connections.size, 0);
});

test("real unread TCP output stays bounded and byte quota closes the socket", async (t) => {
  const peer = await server(t, (socket) => {
    const flood = () => { while (!socket.destroyed && socket.write(Buffer.alloc(LIMITS.chunkBytes))) {} };
    socket.on("drain", flood);
    flood();
  });
  const endpoint = `tcp://127.0.0.1:${peer.address().port}`;
  const { instance } = broker(t, endpoint, { quotaManager: {
    chargeBytes() { throw new Error("quota reached"); },
  } });
  const ctx = context();
  const { handleId } = await instance.connect(endpoint, ctx);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const state = instance.connections.get(handleId);
  assert.ok(state.socket.readableLength <= LIMITS.bufferBytes + LIMITS.chunkBytes);
  await assert.rejects(instance.read(handleId, ctx), /quota reached/u);
  assert.equal(instance.connections.size, 0);
});

test("real TLS validates trust and the original hostname against a pinned IP", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-stream-tls-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keyPath = path.join(directory, "test.key");
  const certPath = path.join(directory, "test.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
    "-out", certPath, "-days", "1", "-subj", "/CN=stream-fixture.test", "-addext", "subjectAltName=DNS:stream-fixture.test"],
  { stdio: "ignore" });
  const cert = fs.readFileSync(certPath);
  const peer = await server(t, (socket) => socket.on("data", (data) => socket.write(data)), {
    key: fs.readFileSync(keyPath), cert,
  });
  const endpoint = `tls://stream-fixture.test:${peer.address().port}`;
  const lookup = async () => [{ address: "127.0.0.1", family: 4 }];
  const untrusted = broker(t, endpoint, { lookup }).instance;
  await assert.rejects(untrusted.connect(endpoint, context()), { code: RPC_ERRORS.unavailable });
  let dialOptions;
  const trusted = broker(t, endpoint, { lookup,
    connectTls: (options) => { dialOptions = options; return tls.connect({ ...options, ca: cert }); },
  }).instance;
  const ctx = context();
  const { handleId } = await trusted.connect(endpoint, ctx);
  assert.equal(dialOptions.host, "127.0.0.1");
  assert.equal(dialOptions.servername, "stream-fixture.test");
  assert.equal(dialOptions.rejectUnauthorized, true);
  await trusted.write(handleId, Uint8Array.of(42), ctx);
  assert.deepEqual(await trusted.read(handleId, ctx), Uint8Array.of(42));
  trusted.close(handleId, ctx);
  const wrongEndpoint = `tls://wrong-fixture.test:${peer.address().port}`;
  const wrong = broker(t, wrongEndpoint, { lookup, connectTls: (options) => tls.connect({ ...options, ca: cert }) }).instance;
  await assert.rejects(wrong.connect(wrongEndpoint, context()), { code: RPC_ERRORS.unavailable });
});
