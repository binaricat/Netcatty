"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const net = require("node:net");
const { once } = require("node:events");
const { sshForwardFixture } = require("./fixtures/sshForwardFixture.cjs");
const { openHostByteStream } = require("./hostByteStreamTransport.cjs");
const { PluginByteStreamBroker } = require("./byteStreamBroker.cjs");
const { listPortForwards } = require("../bridges/portForwardingBridge.cjs");

async function fixture(t, options) {
  const sockets = new Set();
  const echo = net.createServer((socket) => { sockets.add(socket); socket.on("error", () => {}); socket.pipe(socket); });
  echo.listen(0, "127.0.0.1"); await once(echo, "listening");
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => echo.close(resolve)); });
  const ssh = await sshForwardFixture(t, { destinationPort: echo.address().port, ...options });
  const endpoint = `tcp://127.0.0.1:${echo.address().port}`;
  let revoke;
  const broker = new PluginByteStreamBroker({ permissionEngine: {
    authorize: async () => { throw new Error("Direct network access was not granted"); },
    onDidRevoke(callback) { revoke = callback; return { dispose() {} }; },
  } });
  t.after(() => broker.shutdown());
  const controller = new AbortController();
  const context = { pluginId: "fixture", runtimeId: "runtime", sourceOwner: "owner", sourceId: "source", signal: controller.signal, assertActive: async () => {} };
  const open = (signal) => openHostByteStream({ sender: ssh.sender, connectionOptions: ssh.options, endpoint, signal, assertActive: context.assertActive });
  return { ssh, broker, context, controller, endpoint, open, revoke: (permission) => revoke({ pluginId: "fixture", permission }) };
}

test("host-reviewed stream uses real SSH forwarding, transfers bytes and opens no shell or listener", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const handle = await f.broker.connect(f.endpoint, f.context, { open: f.open });
  const bytes = Buffer.from("synthetic database bytes");
  await f.broker.write(handle.handleId, bytes, f.context);
  assert.deepEqual(Buffer.from(await f.broker.read(handle.handleId, f.context)), bytes);
  assert.equal(f.ssh.sessions, 0);
  assert.equal(f.ssh.forwarded.length, 1);
  const tunnels = await listPortForwards({ sender: f.ssh.sender });
  assert.ok(JSON.stringify(tunnels).includes("plugin-stream-"));
  f.broker.close(handle.handleId, f.context);
  assert.equal(f.broker.connections.size, 0);
});

test("direct loopback stays blocked, a revoked host stream closes immediately", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.broker.connect(f.endpoint, f.context), /not granted/);
  const handle = await f.broker.connect(f.endpoint, f.context, { open: f.open });
  const read = f.broker.read(handle.handleId, f.context);
  f.revoke("network.hostStream");
  await assert.rejects(read);
  assert.equal(f.broker.connections.size, 0);
});

test("cancelling SSH authentication releases the pending transport", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { stallAuth: true });
  const pending = f.broker.connect(f.endpoint, f.context, { open: f.open });
  void pending.catch(() => {});
  while (!f.ssh.peers.size) await new Promise((resolve) => setTimeout(resolve, 10));
  f.controller.abort();
  await assert.rejects(pending);
  assert.equal(f.broker.connections.size, 0);
});

test("a refused destination cannot leave a stream or SSH transport usable", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { rejectForward: true });
  await assert.rejects(f.broker.connect(f.endpoint, f.context, { open: f.open }));
  assert.equal(f.broker.connections.size, 0);
  assert.equal(f.ssh.sessions, 0);
});
