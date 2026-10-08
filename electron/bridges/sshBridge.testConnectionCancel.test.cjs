"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const originalHome = process.env.HOME;
const originalTmpdir = process.env.TMPDIR;
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-test-cancel-"));
process.env.HOME = isolatedHome;
process.env.TMPDIR = isolatedHome;
const bridge = require("./sshBridge.cjs");

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});

function registerBridge() {
  const handlers = new Map();
  const sessions = new Map();
  bridge.init({ sessions, electronModule: {} });
  bridge.registerHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    on() {},
  });
  return { handlers, sessions };
}

test("registered test-cancel IPC returns a result for an unknown connection", async () => {
  const { handlers } = registerBridge();
  const result = await handlers.get("netcatty:test-connection:cancel")(null, "missing-test");
  assert.deepEqual(result, { success: false, error: "Test connection not found" });
});

test("registered test-cancel IPC closes a live pending transport and settles its probe", { timeout: 10000 }, async (t) => {
  const { handlers, sessions } = registerBridge();
  const sockets = new Set();
  let acceptSocket;
  let closeSocket;
  const accepted = new Promise((resolve) => { acceptSocket = resolve; });
  const closed = new Promise((resolve) => { closeSocket = resolve; });
  // Accept TCP but withhold the SSH banner so authentication stays pending.
  // Both the SSH client and IPC registration are production implementations.
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => { sockets.delete(socket); closeSocket(); });
    socket.resume();
    acceptSocket();
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const sent = [];
  const event = { sender: { id: 2984, isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) } };
  const sessionId = "cancel-live-probe";
  const probe = handlers.get("netcatty:test-connection")(event, {
    sessionId, hostname: "127.0.0.1", port: server.address().port,
    username: "fixture", password: "fixture-password", authMethod: "password",
    useSshAgent: false, verifyHostKeys: false,
    sshTcpConnectTimeoutMs: 60000, sshAuthReadyTimeoutMs: 60000,
  });
  // Observe rejection immediately so a fast cancellation cannot be unhandled.
  const rejected = assert.rejects(probe, /Connection lost before handshake|closed unexpectedly/);
  await accepted;

  assert.deepEqual(await handlers.get("netcatty:test-connection:cancel")(event, sessionId), { success: true });
  await Promise.all([rejected, closed]);
  assert.equal(sessions.size, 0, "a headless probe never opens a terminal session");
  assert.ok(sent.some(({ channel, payload }) => channel === "netcatty:test:result" && payload.sessionId === sessionId && payload.ok === false));
});
