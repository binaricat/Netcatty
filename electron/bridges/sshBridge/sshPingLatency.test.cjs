const test = require("node:test");
const assert = require("node:assert/strict");

const { createSshPingLatencyProbe } = require("./sshPingLatency.cjs");

// Minimal ssh2-client stand-in: a FIFO global-request callback queue plus a
// _protocol.ping() that answers after `delayMs`, like the real REQUEST_SUCCESS
// handler shifting the next queued callback.
function createFakeSshClient({ delayMs = 5, hadErr = false, failPing = false } = {}) {
  const callbacks = [];
  const proto = {
    ping() {
      if (failPing) throw new Error("send failed");
      setTimeout(() => {
        const next = callbacks.shift();
        if (next) next(hadErr);
      }, delayMs);
    },
  };
  return { _protocol: proto, _callbacks: callbacks };
}

function createProbe(overrides = {}) {
  const timers = [];
  return {
    timers,
    measure: createSshPingLatencyProbe({
      now: () => fakeNow,
      setTimeoutFn: (fn, ms) => {
        const timer = { fn, ms, fired: false };
        timers.push(timer);
        return timer;
      },
      clearTimeoutFn: (timer) => {
        if (timer) timer.fired = true;
      },
      ...overrides,
    }),
  };
}

let fakeNow = 0;

test("measures round-trip time between ping and reply", async () => {
  const { measure } = createProbe();
  const conn = createFakeSshClient({ delayMs: 25 });
  fakeNow = 1000;

  const pending = measure(conn);
  fakeNow = 1042;
  const latency = await pending;

  assert.equal(latency, 42);
});

test("resolves null for connections that cannot carry a transport ping", async () => {
  const { measure } = createProbe();
  assert.equal(await measure(null), null);
  assert.equal(await measure({}), null);
  assert.equal(await measure({ _protocol: { ping() {} }, _callbacks: "nope" }), null);
  // ET exec-fallback conns expose only exec()
  assert.equal(await measure({ exec() {} }), null);
});

test("treats REQUEST_FAILURE (`true`) as a completed ping", async () => {
  // OpenSSH answers the unsupported keepalive@openssh.com global request with
  // SSH_MSG_REQUEST_FAILURE, which ssh2 reports as boolean `true`.
  const { measure } = createProbe();
  const conn = createFakeSshClient({ delayMs: 25, hadErr: true });
  fakeNow = 1000;

  const pending = measure(conn);
  fakeNow = 1042;
  assert.equal(await pending, 42);
  assert.equal(conn._callbacks.length, 0);
});

test("resolves null when the reply reports an error", async () => {
  const { measure } = createProbe();
  const conn = createFakeSshClient({ hadErr: new Error("connection closed") });
  assert.equal(await measure(conn), null);
});

test("disconnect flush does not splice the queue being iterated", async () => {
  // Like ssh2's close handler, flush the queue by index so that splicing the
  // currently executing entry would shift later callbacks into already-visited
  // slots and make ssh2 skip them (e.g. a pending forwardIn reply).
  const { measure } = createProbe();
  const conn = createFakeSshClient({ delayMs: 10_000 });
  let laterCalled = false;
  const later = () => { laterCalled = true; };
  conn._callbacks.push(later);

  const pending = measure(conn);
  assert.equal(conn._callbacks.length, 2);

  const flushed = conn._callbacks;
  for (let i = 0; i < flushed.length; ++i) flushed[i](new Error("No response from server"));

  assert.equal(await pending, null);
  // The queue must be untouched during the flush so the later callback is
  // still visited and receives the disconnect error.
  assert.equal(flushed.length, 2);
  assert.ok(laterCalled, "later callback received the disconnect error");
});

test("resolves null when ping() throws", async () => {
  const { measure } = createProbe();
  const conn = createFakeSshClient({ failPing: true });
  assert.equal(await measure(conn), null);
});

test("times out but keeps its tombstone callback in the FIFO queue", async () => {
  const { measure, timers } = createProbe();
  const conn = createFakeSshClient({ delayMs: 10_000 });
  fakeNow = 0;

  const pending = measure(conn, 500);
  assert.equal(conn._callbacks.length, 1);

  const timeoutEntry = timers[0];
  fakeNow = 500;
  timeoutEntry.fn();
  assert.equal(await pending, null);
  assert.equal(timeoutEntry.fired, true);

  // The slot is preserved so a late reply still consumes it and cannot be
  // misattributed to a subsequent queued callback.
  assert.equal(conn._callbacks.length, 1);
  assert.equal(conn._callbacks[0].name, "onReply");
});

test("a late reply after a real timeout consumes its tombstone slot without resolving twice", async () => {
  const measure = createSshPingLatencyProbe({ defaultTimeoutMs: 50 });
  const conn = createFakeSshClient({ delayMs: 500 });
  fakeNow = 0;

  const latency = await measure(conn);
  assert.equal(latency, null);
  assert.equal(conn._callbacks.length, 1);

  // The delayed fake reply fires into the preserved tombstone slot (the fake
  // shifts it, like the real REQUEST_SUCCESS/REQUEST_FAILURE handlers); the
  // settled promise must stay null (no unhandled rejection / double resolve).
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(conn._callbacks.length, 0);
});
