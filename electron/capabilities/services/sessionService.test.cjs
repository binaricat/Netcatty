"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSessionService } = require("./sessionService.cjs");

test('automatic recovery shares the single-reconnect budget and stops after three failed connections', async () => {
  let time = 0;
  let attempts = 0;
  const service = createSessionService({ now: () => time, sleep: async ms => { time += ms; },
    validateReconnect: () => ({ ok: true }),
    inspectRecovery: async () => ({ ok: true, status: 'disconnected', reconnectAllowed: true }),
    invokeSessionAgent: async () => { attempts++; return { ok: true, started: true }; } });
  const result = await service.recover({ sessionId: 'failed' });
  assert.equal(result.code, 'RECONNECT_LIMIT');
  assert.equal(attempts, 3);
  assert.ok(time >= 7000 && time < 20000);
  assert.equal((await service.reconnect({ sessionId: 'failed', chatSessionId: 'another' })).code, 'RECONNECT_LIMIT');
});

test("reconnect fails closed without scoped authorization", async () => {
  let calls = 0;
  const service = createSessionService({ invokeSessionAgent: async () => { calls++; } });
  assert.equal((await service.reconnect({ sessionId: "s" })).ok, false);
  assert.equal(calls, 0);
});

test("reconnect bounds attempts across chats, uses backoff and resets only after observed connection", async () => {
  let now = 0;
  let calls = 0;
  let connected = false;
  const service = createSessionService({
    now: () => now,
    validateReconnect: () => ({ ok: true, connected }),
    invokeSessionAgent: async () => { calls++; return { ok: true, started: true, status: "reconnecting" }; },
  });
  const params = { sessionId: "s", chatSessionId: "first" };
  assert.equal((await service.reconnect(params)).started, true);
  assert.equal((await service.reconnect(params)).code, "RECONNECT_BACKOFF");
  now = 2000;
  assert.equal((await service.reconnect({ ...params, chatSessionId: "second" })).started, true);
  assert.equal((await service.reconnect(params)).retryAfterMs, 5000);
  now = 7000;
  assert.equal((await service.reconnect(params)).started, true);
  now = 200000;
  assert.equal((await service.reconnect(params)).code, "RECONNECT_LIMIT");
  connected = true;
  assert.equal((await service.reconnect(params)).status, "connected");
  assert.equal(calls, 3);
  connected = false;
  assert.equal((await service.reconnect(params)).started, true);
});

test("reconnect coalesces concurrent requests but revalidates every caller", async () => {
  let finish;
  let permitted = true;
  let calls = 0;
  const service = createSessionService({
    validateReconnect: () => permitted ? { ok: true } : { ok: false, error: "scope revoked" },
    invokeSessionAgent: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
  });
  const first = service.reconnect({ sessionId: "s" });
  assert.equal((await service.reconnect({ sessionId: "s" })).status, "reconnecting");
  permitted = false;
  assert.equal((await service.reconnect({ sessionId: "s" })).error, "scope revoked");
  finish({ ok: true, started: true });
  assert.equal((await first).error, "scope revoked");
  assert.equal(calls, 1);
});

test("unavailable renderer does not consume attempts and execution guard runs before dispatch", async () => {
  let calls = 0;
  const service = createSessionService({
    validateReconnect: () => ({ ok: true }),
    invokeSessionAgent: async () => { calls++; return { ok: false, started: false, code: "RECONNECT_UNAVAILABLE" }; },
  });
  await assert.rejects(service.reconnect({ sessionId: "s" }, { beforeExecute: () => { throw Error("cancelled"); } }), /cancelled/);
  for (let i = 0; i < 4; i++) assert.equal((await service.reconnect({ sessionId: "s" })).code, "RECONNECT_UNAVAILABLE");
  assert.equal(calls, 4);
});

test("elapsed recovery budget cannot be reset by waiting or changing chat", async () => {
  let now = 0;
  const service = createSessionService({ now: () => now, validateReconnect: () => ({ ok: true }),
    invokeSessionAgent: async () => ({ ok: true, started: true }) });
  await service.reconnect({ sessionId: "s" });
  now = 120000;
  assert.equal((await service.reconnect({ sessionId: "s", chatSessionId: "another" })).code, "RECONNECT_LIMIT");
});

test("unknown dispatch outcomes consume budget but observed success resets it", async () => {
  let now = 0;
  let fail = true;
  const service = createSessionService({ now: () => now, validateReconnect: () => ({ ok: true }),
    invokeSessionAgent: async () => { if (fail) throw Error('reply lost'); return { ok: true, started: true }; } });
  await assert.rejects(service.reconnect({ sessionId: 's' }), /reply lost/);
  assert.equal((await service.reconnect({ sessionId: 's' })).code, 'RECONNECT_BACKOFF');
  now = 120000;
  assert.equal((await service.reconnect({ sessionId: 's' })).code, 'RECONNECT_LIMIT');
  service.forgetReconnect('s');
  fail = false;
  assert.equal((await service.reconnect({ sessionId: 's' })).started, true);
});

test("closeTracked uses the same lifecycle while bypassing user-scope validation", async () => {
  const events = [];
  const service = createSessionService({
    validateClose: () => ({ ok: false, error: "scope was cleaned" }),
    beforeClose: async () => events.push("before"),
    invokeSessionAgent: async () => ({ ok: true, status: "closed" }),
    onClosed: async () => events.push("closed"),
    afterClose: async (_params, outcome) => events.push(outcome.closed ? "success" : "failed"),
  });

  const manualResult = await service.close({ sessionId: "session-1" });
  assert.equal(manualResult.ok, false);
  assert.deepEqual(events, []);

  const idleResult = await service.closeTracked({ sessionId: "session-1" });
  assert.equal(idleResult.ok, true);
  assert.deepEqual(events, ["before", "closed", "success"]);
});

test("failed closes report the outcome so idle tracking can resume", async () => {
  let outcome = null;
  const service = createSessionService({
    invokeSessionAgent: async () => ({ ok: false, error: "renderer unavailable" }),
    afterClose: async (_params, value) => {
      outcome = value;
    },
  });

  const result = await service.closeTracked({ sessionId: "session-1" });
  assert.equal(result.ok, false);
  assert.equal(outcome.closed, false);
  assert.equal(outcome.notFound, false);
  assert.deepEqual(outcome.result, result);
});

test("already-missing sessions are distinguished from retryable close failures", async () => {
  let outcome = null;
  const service = createSessionService({
    invokeSessionAgent: async () => ({ ok: false, error: 'Session "gone" was not found.' }),
    afterClose: async (_params, value) => {
      outcome = value;
    },
  });

  const result = await service.closeTracked({ sessionId: "gone" });
  assert.equal(result.ok, false);
  assert.equal(outcome.closed, false);
  assert.equal(outcome.notFound, true);
});

test("close rechecks its execution guard after cleanup and preserves failed-close lifecycle", async () => {
  const { createAiPrivacyService } = require("../../shared/aiPrivacyService.cjs");
  const privacy = createAiPrivacyService();
  privacy.checkSession("chat");
  let invokeCount = 0;
  let outcome;
  const service = createSessionService({
    beforeClose: async () => { privacy.configure({ enabled: true }); },
    invokeSessionAgent: async () => { invokeCount++; return { ok: true }; },
    afterClose: async (_params, value) => { outcome = value; },
  });
  await assert.rejects(service.close({ sessionId: "session-1" }, {
    beforeExecute: () => privacy.restore("chat", []),
  }), /start a new chat/);
  assert.equal(invokeCount, 0);
  assert.equal(outcome.closed, false);
  assert.equal(outcome.notFound, false);
});
