"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { PluginStreamRouter } = require("./streamRouter.cjs");

test("outgoing close hook observes idle peer cancellation exactly once", async () => {
  const closed = [];
  const router = new PluginStreamRouter({ send() {} });
  const stream = await router.openOutgoing("idle-close-hook", 1024, { onClose: (reason) => closed.push(reason) });
  await router.accept({ frame: { streamId: "idle-close-hook", sequence: 1, kind: "cancel" } });
  stream.cancel();
  router.close();
  assert.deepEqual(closed, ["cancel"]);
  assert.equal(router.outgoing.size, 0);
});

test("incoming stream credit is returned only after the consumer releases a chunk", async () => {
  const sent = [];
  const received = [];
  const router = new PluginStreamRouter({
    send(message) { sent.push(message); },
    onIncomingStream({ bind }) {
      bind({
        async onChunk(chunk, release) {
          received.push(chunk.value);
          assert.equal(sent.length, 0);
          release();
        },
      });
      return true;
    },
  });
  await router.accept({ frame: { streamId: "input", sequence: 0, kind: "open", windowBytes: 1024 } });
  const contract = await import("@netcatty/plugin-contract");
  await router.accept({
    frame: {
      streamId: "input",
      sequence: 1,
      kind: "chunk",
      data: contract.createJsonStreamChunk({ value: 1 }),
    },
  });
  assert.deepEqual(received, [{ value: 1 }]);
  assert.deepEqual(sent[0].frame, {
    streamId: "input",
    sequence: 0,
    kind: "windowUpdate",
    creditBytes: contract.createJsonStreamChunk({ value: 1 }).byteLength,
  });
});

test("incoming binary streams return their declared byte credit after release", async () => {
  const sent = [];
  const received = [];
  const router = new PluginStreamRouter({
    send(message) { sent.push(message); },
    onIncomingStream({ bind }) {
      bind({
        onChunk(chunk, release) {
          received.push([...chunk.bytes]);
          release();
        },
      });
      return true;
    },
  });
  const contract = await import("@netcatty/plugin-contract");
  const bytes = new Uint8Array([1, 2, 3, 4]);

  await router.accept({ frame: { streamId: "binary", sequence: 0, kind: "open", windowBytes: 1024 } });
  await router.accept({
    frame: {
      streamId: "binary",
      sequence: 1,
      kind: "chunk",
      data: contract.createBase64StreamChunk(bytes),
    },
  });

  assert.deepEqual(received, [[1, 2, 3, 4]]);
  assert.deepEqual(sent[0].frame, {
    streamId: "binary",
    sequence: 0,
    kind: "windowUpdate",
    creditBytes: 4,
  });
  assert.equal(Number.isSafeInteger(sent[0].frame.creditBytes), true);
});

test("outgoing stream applies byte backpressure and ordered credit updates", async () => {
  const sent = [];
  const router = new PluginStreamRouter({ send(message) { sent.push(message); } });
  const stream = await router.openOutgoing("output", 1024);
  const source = new Uint8Array(1024);
  source[0] = 7;
  await stream.write(source);
  source[0] = 99;
  assert.equal(new Uint8Array(sent[1].transfer)[0], 7);
  let secondResolved = false;
  const second = stream.write(new Uint8Array(1)).then(() => { secondResolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondResolved, false);
  await router.accept({
    frame: { streamId: "output", sequence: 0, kind: "windowUpdate", creditBytes: 1 },
  });
  await second;
  assert.equal(sent.filter((message) => message.frame.kind === "chunk").length, 2);
  await assert.rejects(
    router.accept({ frame: { streamId: "output", sequence: 0, kind: "windowUpdate", creditBytes: 1 } }),
    /Out-of-order/,
  );
  await assert.rejects(
    router.accept({ frame: { streamId: "output", sequence: 2, kind: "windowUpdate", creditBytes: 1 } }),
    /Out-of-order/,
  );
});

test("outgoing JSON stream chunks preserve the exact contract shape", async () => {
  const sent = [];
  const router = new PluginStreamRouter({ send(message) { sent.push(message); } });
  const stream = await router.openOutgoing("json-output", 1024);
  const value = { nested: ["value", 1] };
  const contract = await import("@netcatty/plugin-contract");

  await stream.write(value);

  assert.deepEqual(sent[1].frame.data, contract.createJsonStreamChunk(value));
  assert.equal(Object.hasOwn(sent[1].frame.data, "transfer"), false);
  assert.equal(Object.hasOwn(sent[1], "transfer"), false);
});

test("ended outgoing streams accept final receive credit before retiring", async () => {
  const sent = [];
  const router = new PluginStreamRouter({ send(message) { sent.push(message); } });
  const stream = await router.openOutgoing("ended-output", 1024);
  const contract = await import("@netcatty/plugin-contract");
  const chunk = contract.createJsonStreamChunk({ final: true });
  await stream.write({ final: true });

  stream.end();
  assert.equal(sent.at(-1).frame.kind, "end");
  assert.equal(router.outgoing.has("ended-output"), true);
  await assert.rejects(stream.write({ late: true }), /closed/);

  await router.accept({
    frame: {
      streamId: "ended-output",
      sequence: 0,
      kind: "windowUpdate",
      creditBytes: chunk.byteLength,
    },
  });
  assert.equal(router.outgoing.has("ended-output"), false);
});

test("cancelled outgoing streams accept only ordered outstanding credit and release their slot", async () => {
  const router = new PluginStreamRouter({ send() {}, maxStreams: 1 });
  const stream = await router.openOutgoing("cancel-in-flight", 1024);
  await stream.write(new Uint8Array(1024));
  const queued = stream.write(Uint8Array.of(1));
  stream.cancel();
  await assert.rejects(queued, /cancel/u);
  await assert.rejects(stream.write(Uint8Array.of(1)), /closed/u);
  const credit = (streamId, sequence, creditBytes) => ({ frame: { streamId, sequence, kind: "windowUpdate", creditBytes } });
  await assert.rejects(router.accept(credit("unknown", 0, 1)), /Unknown outgoing/u);
  await assert.rejects(router.accept(credit("cancel-in-flight", 1, 1)), /Out-of-order/u);
  await assert.rejects(router.accept(credit("cancel-in-flight", 0, 0)), /contract|creditBytes/u);
  await router.accept(credit("cancel-in-flight", 0, 512));
  await assert.rejects(router.accept(credit("cancel-in-flight", 0, 1)), /Out-of-order/u);
  await router.accept(credit("cancel-in-flight", 1, 512));
  assert.equal(router.outgoing.size, 0);
  await assert.rejects(router.accept(credit("cancel-in-flight", 2, 1)), /Unknown outgoing/u);
  const other = await router.openOutgoing("next", 1024);
  other.cancel();
  assert.equal(router.outgoing.size, 0);
});

test("cancelled outgoing streams reject excess credit and clear retained state at runtime close", async () => {
  const router = new PluginStreamRouter({ send() {} });
  const stream = await router.openOutgoing("cancel-excess", 1024);
  await stream.write(Uint8Array.of(1));
  stream.cancel();
  await assert.rejects(router.accept({ frame: {
    streamId: "cancel-excess", sequence: 0, kind: "windowUpdate", creditBytes: 2,
  } }), /exceeds/u);
  router.close();
  assert.equal(router.outgoing.size, 0);
});

test("failed cancellation credit refund still aborts and cleans up its incoming owner", async () => {
  let ownerSignal;
  let closeReason;
  const router = new PluginStreamRouter({
    send() { throw new Error("refund transport failed"); },
    onIncomingStream({ signal, bind }) {
      ownerSignal = signal;
      bind({ onChunk() {}, onClose(reason) { closeReason = reason; } });
      return true;
    },
  });
  await router.accept({ frame: { streamId: "cancel-refund", sequence: 0, kind: "open", windowBytes: 1024 } });
  await router.accept({ frame: {
    streamId: "cancel-refund", sequence: 1, kind: "chunk",
    data: { encoding: "base64", value: "AQ==", byteLength: 1 },
  } });
  await assert.rejects(router.accept({ frame: {
    streamId: "cancel-refund", sequence: 2, kind: "cancel",
  } }), /refund transport failed/u);
  assert.equal(ownerSignal.aborted, true);
  assert.equal(closeReason, "cancel");
  assert.equal(router.incoming.size, 0);
});

test("unhandled incoming streams are cancelled immediately", async () => {
  const sent = [];
  const router = new PluginStreamRouter({ send(message) { sent.push(message); } });
  await router.accept({ frame: { streamId: "unhandled", sequence: 0, kind: "open", windowBytes: 1024 } });
  assert.equal(sent[0].frame.kind, "cancel");
});

test("a stalled incoming owner is aborted and cannot block later streams", async () => {
  const sent = [];
  const signals = [];
  const closed = [];
  let calls = 0;
  const router = new PluginStreamRouter({
    openTimeoutMs: 10,
    send(message) { sent.push(message); },
    onIncomingStream({ bind, signal }) {
      calls += 1;
      signals.push(signal);
      if (calls === 1) {
        bind({ onChunk() {}, onClose(reason) { closed.push(reason); } });
        return new Promise(() => {});
      }
      bind({ onChunk() {} });
      return true;
    },
  });

  await router.accept({
    frame: { streamId: "stalled", sequence: 0, kind: "open", windowBytes: 1024 },
  });
  assert.equal(signals[0].aborted, true);
  assert.equal(closed[0], signals[0].reason);
  assert.equal(sent[0].frame.kind, "cancel");
  assert.equal(router.incoming.has("stalled"), false);

  await router.accept({
    frame: { streamId: "next", sequence: 0, kind: "open", windowBytes: 1024 },
  });
  assert.equal(router.incoming.has("next"), true);
});

test("incoming streams require an explicit accept and a chunk handler", async () => {
  const sent = [];
  const router = new PluginStreamRouter({
    send(message) { sent.push(message); },
    onIncomingStream() {},
  });
  await router.accept({ frame: { streamId: "implicit", sequence: 0, kind: "open", windowBytes: 1024 } });
  assert.equal(sent[0].frame.kind, "cancel");

  const invalid = new PluginStreamRouter({
    send() {},
    onIncomingStream({ bind }) {
      bind({});
      return true;
    },
  });
  await assert.rejects(
    invalid.accept({ frame: { streamId: "invalid", sequence: 0, kind: "open", windowBytes: 1024 } }),
    /onChunk handler is required/,
  );
  assert.equal(invalid.incoming.size, 0);
});

test("owner-selection failures close an already-bound incoming stream", async () => {
  const sent = [];
  const closed = [];
  const router = new PluginStreamRouter({
    send(message) { sent.push(message); },
    onIncomingStream({ bind }) {
      bind({ onChunk() {}, onClose(reason) { closed.push(reason); } });
      throw new Error("owner setup failed");
    },
  });

  await assert.rejects(
    router.accept({ frame: { streamId: "failed-owner", sequence: 0, kind: "open", windowBytes: 1024 } }),
    /owner setup failed/,
  );
  assert.equal(sent[0].frame.kind, "cancel");
  assert.match(closed[0].message, /owner setup failed/);
  assert.equal(router.incoming.size, 0);
});

test("stream envelopes reject extra fields and accessors before state changes", async () => {
  const router = new PluginStreamRouter({ send() {} });
  await assert.rejects(router.accept({
    frame: { streamId: "extra", sequence: 0, kind: "open", windowBytes: 1024 },
    unexpected: true,
  }), /unknown properties/);
  const accessor = {};
  Object.defineProperty(accessor, "frame", {
    enumerable: true,
    get() { throw new Error("accessor invoked"); },
  });
  await assert.rejects(router.accept(accessor), /data properties/);
});

test("peer cancellation closes only the matching outgoing stream", async () => {
  const sent = [];
  const router = new PluginStreamRouter({ send(message) { sent.push(message); } });
  const stream = await router.openOutgoing("cancelled", 1024);
  await router.accept({
    frame: { streamId: "cancelled", sequence: 1, kind: "cancel" },
  });
  await assert.rejects(stream.write(new Uint8Array([1])), /closed/);
  const other = await router.openOutgoing("other", 1024);
  await other.write(new Uint8Array([2]));
  assert.equal(sent.at(-1).frame.streamId, "other");
});

test("transport failure while opening a stream releases its identity", async () => {
  const router = new PluginStreamRouter({
    send() { throw new Error("transport closed"); },
  });
  await assert.rejects(router.openOutgoing("failed-open", 1024), /transport closed/);
  assert.equal(router.outgoing.size, 0);
});

test("transport failure while returning credit closes the incoming stream", async () => {
  const closed = [];
  let releaseChunk;
  const router = new PluginStreamRouter({
    send() { throw new Error("transport closed"); },
    onIncomingStream({ bind }) {
      bind({
        onChunk(_chunk, release) { releaseChunk = release; },
        onClose(reason) { closed.push(reason); },
      });
      return true;
    },
  });
  const contract = await import("@netcatty/plugin-contract");
  await router.accept({ frame: { streamId: "failed-credit", sequence: 0, kind: "open", windowBytes: 1024 } });
  await router.accept({
    frame: {
      streamId: "failed-credit",
      sequence: 1,
      kind: "chunk",
      data: contract.createJsonStreamChunk({ value: 1 }),
    },
  });
  assert.throws(() => releaseChunk(), /transport closed/);
  assert.equal(router.incoming.size, 0);
  assert.equal(closed.length, 1);
  assert.match(closed[0].message, /transport closed/);
});

test("incoming stream completion waits for asynchronous owner cleanup", async () => {
  const sent = [];
  let ownerSignal;
  let releaseCleanup;
  const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
  let cleanupFinished = false;
  const router = new PluginStreamRouter({
    send(message) { sent.push(message); },
    onIncomingStream(stream) {
      ownerSignal = stream.signal;
      stream.bind({
        onChunk() {},
        async onClose() {
          await cleanup;
          cleanupFinished = true;
        },
      });
      return true;
    },
  });
  await router.accept({ frame: { streamId: "cleanup", sequence: 0, kind: "open", windowBytes: 1_024 } });
  let settled = false;
  const ending = router.accept({ frame: { streamId: "cleanup", sequence: 1, kind: "end" } })
    .then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(ownerSignal.aborted, true);
  assert.match(ownerSignal.reason.message, /stream end/);
  releaseCleanup();
  await ending;
  assert.equal(cleanupFinished, true);
  assert.deepEqual(sent, []);
});

test("router shutdown contains rejected asynchronous owner cleanup", async () => {
  const router = new PluginStreamRouter({
    send() {},
    onIncomingStream(stream) {
      stream.bind({
        onChunk() {},
        async onClose() { throw new Error("cleanup failed"); },
      });
      return true;
    },
  });
  await router.accept({ frame: { streamId: "shutdown-cleanup", sequence: 0, kind: "open", windowBytes: 1_024 } });
  router.close();
  await new Promise((resolve) => setImmediate(resolve));
});

test("transport failure rejects a write and closes its outgoing stream", async () => {
  let sends = 0;
  const router = new PluginStreamRouter({
    send() {
      sends += 1;
      if (sends > 1) throw new Error("transport closed");
    },
  });
  const stream = await router.openOutgoing("failed-write", 1024);
  await assert.rejects(stream.write(new Uint8Array([1])), /transport closed/);
  assert.equal(router.outgoing.size, 0);
  await assert.rejects(stream.write(new Uint8Array([2])), /closed/);
});

test("transport failure while cancelling rejects every backpressured write", async () => {
  let failSends = false;
  const router = new PluginStreamRouter({
    send() {
      if (failSends) throw new Error("transport closed");
    },
  });
  const stream = await router.openOutgoing("failed-cancel", 1024);
  await stream.write(new Uint8Array(1024));
  const queued = stream.write(new Uint8Array([1]));
  failSends = true;
  assert.throws(() => stream.cancel(), /transport closed/);
  await assert.rejects(queued, /cancel/);
  assert.equal(router.outgoing.size, 0);
});

test("closing a router invalidates retained incoming release callbacks", async () => {
  const sent = [];
  let releaseChunk;
  let finishChunk;
  const chunkBlocked = new Promise((resolve) => { finishChunk = resolve; });
  const closed = [];
  let ownerSignal;
  const router = new PluginStreamRouter({
    send(message) { sent.push(message); },
    onIncomingStream({ bind, signal }) {
      ownerSignal = signal;
      bind({
        onChunk(_chunk, release) {
          releaseChunk = release;
          return chunkBlocked;
        },
        onClose(reason) { closed.push(reason); },
      });
      return true;
    },
  });
  const contract = await import("@netcatty/plugin-contract");
  await router.accept({ frame: { streamId: "closing", sequence: 0, kind: "open", windowBytes: 1024 } });
  const accepting = router.accept({
    frame: {
      streamId: "closing",
      sequence: 1,
      kind: "chunk",
      data: contract.createJsonStreamChunk({ value: 1 }),
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const closeError = new Error("runtime closed");
  router.close(closeError);
  assert.equal(ownerSignal.aborted, true);
  assert.equal(ownerSignal.reason, closeError);
  releaseChunk();
  finishChunk();
  await accepting;
  assert.deepEqual(sent, []);
  assert.deepEqual(closed, [closeError]);
});

test("oversized binary writes fail before consuming stream credit", async () => {
  const sent = [];
  const router = new PluginStreamRouter({ send(message) { sent.push(message); } });
  const contract = await import("@netcatty/plugin-contract");
  const stream = await router.openOutgoing("oversized", contract.PLUGIN_STREAM_MAX_WINDOW_BYTES);
  await assert.rejects(
    stream.write(new Uint8Array(contract.PLUGIN_STREAM_MAX_CHUNK_BYTES + 1)),
    /chunk exceeds/,
  );
  assert.equal(sent.length, 1);
  assert.equal(router.outgoing.get("oversized").availableBytes, contract.PLUGIN_STREAM_MAX_WINDOW_BYTES);
});
