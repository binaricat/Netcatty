"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

async function createPair() {
  const { createPluginStreamEndpoint } = await import("./runtime/pluginStreamEndpoint.mjs");
  let left;
  let right;
  const leftTransport = {
    post(message) { queueMicrotask(() => right.accept(message)); },
  };
  const rightTransport = {
    post(message) { queueMicrotask(() => left.accept(message)); },
  };
  left = createPluginStreamEndpoint(leftTransport);
  right = createPluginStreamEndpoint(rightTransport);
  return { left, right };
}

test("runtime byte streams transfer owned chunks and end normally", async () => {
  const { left, right } = await createPair();
  const readablePromise = right.acceptReadable("connection:output");
  const writable = await left.openWritable("connection:output", 1024);
  const readable = await readablePromise;

  await writable.write(Uint8Array.from([1, 2, 3]));
  assert.deepEqual([...await readable.read()], [1, 2, 3]);
  const ended = writable.end();
  assert.equal(await readable.read(), null);
  await ended;
});

test("runtime byte streams retain receive credit until the next read", async () => {
  const { left, right } = await createPair();
  const readablePromise = right.acceptReadable("import:records");
  const writable = await left.openWritable("import:records", 1024);
  const readable = await readablePromise;
  const first = new Uint8Array(1024);
  await writable.write(first);
  assert.equal((await readable.read()).byteLength, 1024);

  let secondSettled = false;
  const second = writable.write(Uint8Array.of(9)).then(() => { secondSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);
  assert.deepEqual([...await readable.read()], [9]);
  await second;
});

test("runtime byte stream cancellation rejects queued writes", async () => {
  const { left, right } = await createPair();
  const readablePromise = right.acceptReadable("connection:input");
  const writable = await left.openWritable("connection:input", 1024);
  const readable = await readablePromise;
  await writable.write(new Uint8Array(1024));
  const blocked = writable.write(Uint8Array.of(1));
  readable.cancel();
  await assert.rejects(blocked, /cancel/i);
});

test("runtime byte streams reject invalid identifiers and windows", async () => {
  const { left } = await createPair();
  await assert.rejects(left.openWritable("", 1024), /stream ID/i);
  await assert.rejects(left.openWritable("valid", 1), /window/i);
});

test("runtime byte stream end waits behind backpressure and preserves ordering", async () => {
  const { left, right } = await createPair();
  const readablePromise = right.acceptReadable("ordered-end");
  const writable = await left.openWritable("ordered-end", 1024);
  const readable = await readablePromise;
  await writable.write(new Uint8Array(1024));
  const blocked = writable.write(Uint8Array.of(7));
  const ending = writable.end();
  assert.equal((await readable.read()).byteLength, 1024);
  assert.deepEqual([...await readable.read()], [7]);
  await blocked;
  assert.equal(await readable.read(), null);
  await ending;
});

test("runtime byte streams reject concurrent reads and bound pending accept reservations", async () => {
  const { left, right } = await createPair();
  const readablePromise = right.acceptReadable("serial-read");
  await left.openWritable("serial-read", 1024);
  const readable = await readablePromise;
  const pendingRead = readable.read();
  await assert.rejects(readable.read(), /concurrent reads/i);
  readable.cancel();
  await assert.rejects(pendingRead, /cancel/i);

  const firstRead = left.acceptReadable("read-once");
  await assert.rejects(left.acceptReadable("read-once"), /cannot be accepted/i);
  left.rejectReadable("read-once");
  await assert.rejects(firstRead, /cancel/i);

  const { createPluginStreamEndpoint } = await import("./runtime/pluginStreamEndpoint.mjs");
  const endpoint = createPluginStreamEndpoint({ post() {} }, { maxStreams: 1 });
  const reserved = endpoint.acceptReadable("reserved");
  await assert.rejects(endpoint.acceptReadable("overflow"), /limit/i);
  endpoint.rejectReadable("reserved");
  await assert.rejects(reserved, /cancel/i);
});

test("host cancellation discards buffered bytes and settles retained credit before the next read", async (t) => {
  const { createPluginStreamEndpoint } = await import("./runtime/pluginStreamEndpoint.mjs");
  const { PluginStreamRouter } = require("./streamRouter.cjs");
  const toHost = [];
  const endpoint = createPluginStreamEndpoint({ post(message) { toHost.push(message); } });
  const host = new PluginStreamRouter({ send(message) { endpoint.accept(message); } });
  t.after(() => { endpoint.close(); host.close(); });
  const pending = endpoint.acceptReadable("host-cancel");
  const output = await host.openOutgoing("host-cancel", 1024);
  const readable = await pending;
  await output.write(Uint8Array.of(1));
  assert.deepEqual([...await readable.read()], [1]);
  await output.write(Uint8Array.of(2));
  output.cancel();
  const count = toHost.length;
  await assert.rejects(readable.read(), /cancel/u);
  await assert.rejects(readable.read(), /cancel/u);
  assert.equal(toHost.length, count, "reads after cancellation must not return credit");
  assert.equal(toHost.reduce((sum, message) => sum + message.frame.creditBytes, 0), 2);
  for (const message of toHost) await host.accept(message);
  assert.equal(host.outgoing.size, 0);
  const otherPending = endpoint.acceptReadable("unrelated");
  const other = await host.openOutgoing("unrelated", 1024);
  await otherPending;
  other.cancel();
});

test("runtime producer cancellation drains discarded credit and rejects buffered reads", async () => {
  const { left, right } = await createPair();
  const pending = right.acceptReadable("producer-cancel");
  const writable = await left.openWritable("producer-cancel", 1024);
  const readable = await pending;
  await writable.write(Uint8Array.of(1));
  assert.deepEqual([...await readable.read()], [1]);
  await writable.write(Uint8Array.of(2));
  writable.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(readable.read(), /cancel/u);
  left.close();
  right.close();
});

test("browser producer cancellation settles host receive credit without resuming writes", async (t) => {
  const { createPluginStreamEndpoint } = await import("./runtime/pluginStreamEndpoint.mjs");
  const { PluginStreamRouter } = require("./streamRouter.cjs");
  const toHost = [];
  let release;
  const endpoint = createPluginStreamEndpoint({ post(message) { toHost.push(message); } }, { maxStreams: 1 });
  const host = new PluginStreamRouter({
    send(message) { endpoint.accept(message); },
    onIncomingStream({ bind }) { bind({ onChunk(_chunk, callback) { release = callback; } }); return true; },
  });
  t.after(() => { endpoint.close(); host.close(); });
  const output = await endpoint.openWritable("browser-cancel", 1024);
  await host.accept(toHost.shift());
  await output.write(new Uint8Array(1024));
  await host.accept(toHost.shift());
  const queued = output.write(Uint8Array.of(1));
  output.cancel();
  await assert.rejects(queued, /cancel/u);
  await host.accept(toHost.shift());
  release();
  assert.equal(toHost.length, 0);
  assert.equal(host.incoming.size, 0);
  await endpoint.openWritable("after-cancel", 1024);
});
