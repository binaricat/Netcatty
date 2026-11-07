"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSessionRecoveryService } = require("./sessionRecoveryService.cjs");

function fixture(overrides = {}) {
  let time = 0;
  let calls = 0;
  let state = { ok: true, status: "disconnected", reconnectAllowed: true };
  const service = createSessionRecoveryService({
    now: () => time,
    sleep: async (ms) => { time += ms; },
    validate: () => ({ ok: true }),
    inspect: async () => state,
    reconnect: async () => { calls++; state = { ok: true, status: "connected", shellReady: true }; return { ok: true, started: true }; },
    ...overrides,
  });
  return { service, calls: () => calls, setState: value => { state = value; }, now: () => time };
}

test("recovers the original session, reports observed prompt readiness and sends no command", async () => {
  const f = fixture();
  const result = await f.service.recover({ sessionId: "s" });
  assert.equal(result.sessionId, "s");
  assert.equal(result.status, "ready");
  assert.equal(result.shellReady, true);
  assert.equal(f.calls(), 1);
});

test("continuations preserve the overall deadline and never restart a connecting terminal", async () => {
  const f = fixture();
  f.setState({ ok: true, status: "connecting" });
  for (let i = 0; i < 6; i++) {
    const result = await f.service.recover({ sessionId: "s", chatSessionId: String(i) });
    // Still-connecting budget exhaustion must preserve nonconnected truth
    // as pending — never a false ready.
    assert.equal(result.status, "pending");
    assert.equal(result.shellReady, false);
    assert.equal(result.nextAction, "session_recover");
    assert.ok(f.now() <= (i + 1) * 20000);
  }
  assert.equal((await f.service.recover({ sessionId: "s" })).code, "RECOVERY_LIMIT");
  assert.equal(f.calls(), 0);
});

test("offline call-budget exhaustion returns pending, not ready", async () => {
  const f = fixture({
    reconnect: async () => ({ ok: true, started: true }),
  });
  f.setState({ ok: true, status: "disconnected", reconnectAllowed: true, reconnecting: true });
  const result = await f.service.recover({ sessionId: "s" });
  assert.equal(result.status, "pending");
  assert.equal(result.shellReady, false);
  assert.equal(result.nextAction, "session_recover");
  assert.notEqual(result.status, "ready");
  assert.equal(f.calls(), 0);
});

test("auth, busy jobs and unavailable handlers stop without reconnecting", async () => {
  for (const state of [
    { ok: true, status: "disconnected", waitingForInput: true },
    { ok: true, status: "connected", busy: true, shellReady: false },
    { ok: true, status: "disconnected", reconnectAllowed: false },
  ]) {
    const f = fixture(); f.setState(state);
    const result = await f.service.recover({ sessionId: "s" });
    assert.equal(result.status, state.waitingForInput ? "needs_input" : state.busy ? "busy" : "unavailable");
    assert.equal(f.calls(), 0);
  }
});

test("a user-disconnected terminal cannot be revived by automatic recovery", async () => {
  const f = fixture();
  f.setState({ ok: true, status: "disconnected", stopped: true, reconnectAllowed: true });
  assert.equal((await f.service.recover({ sessionId: "s" })).code, "RECOVERY_CANCELLED");
  assert.equal(f.calls(), 0);
});

test("cancellation during backoff stops before another inspection or reconnect", async () => {
  let time = 0;
  let calls = 0;
  const f = fixture({ now: () => time, sleep: async ms => { time += ms; },
    validate: () => time === 0 ? { ok: true } : { ok: false, error: "cancelled" },
    reconnect: async () => { calls++; return { ok: false, code: "RECONNECT_BACKOFF", retryAfterMs: 5000 }; } });
  assert.equal((await f.service.recover({ sessionId: "s" })).error, "cancelled");
  assert.equal(time, 1000);
  assert.equal(calls, 1);
});

test("checks scope again after inspecting and before another recovery action", async () => {
  let allowed = true;
  const f = fixture({ validate: () => allowed ? { ok: true } : { ok: false, error: "scope revoked" },
    inspect: async () => { allowed = false; return { ok: true, status: "disconnected", reconnectAllowed: true }; } });
  assert.equal((await f.service.recover({ sessionId: "s" })).error, "scope revoked");
  assert.equal(f.calls(), 0);
});

test("waits for backoff and respects the shared reconnect attempt limit", async () => {
  let calls = 0;
  const f = fixture({ reconnect: async () => {
    calls++;
    return calls === 1 ? { ok: false, code: "RECONNECT_BACKOFF", retryAfterMs: 2000 }
      : { ok: false, code: "RECONNECT_LIMIT", error: "three attempts exhausted" };
  } });
  const result = await f.service.recover({ sessionId: "s" });
  assert.equal(result.code, "RECONNECT_LIMIT");
  assert.equal(f.now(), 2000);
  assert.equal(calls, 2);
});

test("concurrent callers inspect their scope but do not start duplicate recovery loops", async () => {
  let resolve;
  let valid = true;
  const f = fixture({ validate: () => valid ? { ok: true } : { ok: false, error: "cancelled" },
    inspect: () => new Promise(r => { resolve = r; }) });
  const running = f.service.recover({ sessionId: "s" });
  assert.equal((await f.service.recover({ sessionId: "s" })).status, "pending");
  valid = false;
  assert.equal((await f.service.recover({ sessionId: "s" })).error, "cancelled");
  resolve({ ok: true, status: "connected", shellReady: true });
  assert.equal((await running).error, "cancelled");
});

test("unknown readiness is an advisory hint, not a gate, and failures do not loop", async () => {
  const f = fixture();
  f.setState({ ok: true, status: "connected", shellReady: null });
  const result = await f.service.recover({ sessionId: "s" });
  assert.equal(result.status, "ready");
  assert.equal(result.shellReady, null);
  assert.equal(result.nextAction, "inspect_shell");
  const failed = fixture({ inspect: async () => ({ ok: false, error: "renderer timeout" }) });
  assert.equal((await failed.service.recover({ sessionId: "s" })).error, "renderer timeout");
  assert.equal(failed.calls(), 0);
});

test("a false-ready prompt no longer gates a connected transport", async () => {
  const f = fixture();
  f.setState({ ok: true, status: "connected", shellReady: false });
  const result = await f.service.recover({ sessionId: "s" });
  assert.equal(result.status, "ready");
  assert.equal(result.shellReady, false);
  assert.equal(result.nextAction, "inspect_shell");
  assert.equal(f.calls(), 0);
});

test("flapping connection success cannot reset the overall three-attempt recovery limit", async () => {
  let calls = 0;
  const attemptsAt = [];
  const f = fixture({ reconnect: async () => { calls++; attemptsAt.push(f.now()); return { ok: true, started: true }; } });
  const result = await f.service.recover({ sessionId: 'flapping' });
  assert.equal(result.code, 'RECONNECT_LIMIT');
  assert.equal(calls, 3);
  assert.deepEqual(attemptsAt, [0, 2000, 7000]);
});
