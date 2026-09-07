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

test("resolves null when the reply reports an error", async () => {
  const { measure } = createProbe();
  const conn = createFakeSshClient({ hadErr: true });
  assert.equal(await measure(conn), null);
});

test("resolves null when ping() throws", async () => {
  const { measure } = createProbe();
  const conn = createFakeSshClient({ failPing: true });
  assert.equal(await measure(conn), null);
});

test("times out and removes its callback from the queue", async () => {
  const { measure, timers } = createProbe();
  const conn = createFakeSshClient({ delayMs: 10_000 });
  fakeNow = 0;

  const pending = measure(conn, 500);
  assert.equal(conn._callbacks.length, 1);

  const timeoutEntry = timers[0];
  fakeNow = 500;
  timeoutEntry.fn();
  assert.equal(await pending, null);
  assert.equal(conn._callbacks.length, 0);
  assert.equal(timeoutEntry.fired, true);

  // The stale reply never fires (timer was "cleared" and entry removed).
});

test("a late reply after a real timeout does not resolve twice or leak the callback", async () => {
  const measure = createSshPingLatencyProbe({ defaultTimeoutMs: 50 });
  const conn = createFakeSshClient({ delayMs: 500 });
  fakeNow = 0;

  const latency = await measure(conn);
  assert.equal(latency, null);
  assert.equal(conn._callbacks.length, 0);

  // The delayed fake reply eventually fires into an empty queue; the settled
  // promise must stay null (no unhandled rejection / double resolve).
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(conn._callbacks.length, 0);
});
