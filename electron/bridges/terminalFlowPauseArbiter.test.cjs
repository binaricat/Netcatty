"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createTerminalFlowPauseArbiter } = require("./terminalFlowPauseArbiter.cjs");

const make = () => {
  let nextLease = 0;
  return createTerminalFlowPauseArbiter({
    createLeaseId: () => `lease-${++nextLease}`,
  });
};

test("leases from isolated renderers resume only after both release", () => {
  const arbiter = make();
  const home = arbiter.acquire("session-1", 10);
  const popup = arbiter.acquire("session-1", 20);

  assert.deepEqual(arbiter.release("session-1", 10, home.leaseId), {
    success: true,
    paused: true,
  });
  assert.deepEqual(arbiter.release("session-1", 20, popup.leaseId), {
    success: true,
    paused: false,
  });
});

test("one renderer cannot release another renderer's lease", () => {
  const arbiter = make();
  const home = arbiter.acquire("session-1", 10);

  assert.deepEqual(arbiter.release("session-1", 20, home.leaseId), {
    success: false,
    paused: true,
  });
  assert.equal(arbiter.owns("session-1", 10, home.leaseId), true);
});

test("direct flow resume cannot override a lease in another renderer", () => {
  const arbiter = make();
  const popup = arbiter.acquire("session-1", 20);

  assert.equal(arbiter.setDirectPaused("session-1", 10, true), true);
  assert.equal(arbiter.setDirectPaused("session-1", 10, false), true);
  assert.equal(arbiter.release("session-1", 20, popup.leaseId).paused, false);
});

test("attach recovery release cannot override a home renderer lease", () => {
  const arbiter = make();
  const home = arbiter.acquire("session-1", 10);

  assert.equal(arbiter.setDirectPaused("session-1", "main:attach-restore", true), true);
  assert.equal(arbiter.setDirectPaused("session-1", "main:attach-restore", false), true);
  assert.equal(arbiter.release("session-1", 10, home.leaseId).paused, false);
});

test("destroying one renderer preserves other renderers' pause owners", () => {
  const arbiter = make();
  arbiter.acquire("session-1", 10);
  const popup = arbiter.acquire("session-1", 20);

  assert.deepEqual(arbiter.clearSender(10), []);
  assert.equal(arbiter.release("session-1", 20, popup.leaseId).paused, false);
});
