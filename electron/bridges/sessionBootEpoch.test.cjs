const test = require("node:test");
const assert = require("node:assert/strict");

const {
  claimSessionSlot,
  sessionMatchesBootEpoch,
} = require("./sessionBootEpoch.cjs");

test("claimSessionSlot rejects a superseded lower boot epoch", () => {
  const sessions = new Map();
  const newer = { bootEpoch: 3 };
  sessions.set("s1", newer);
  const stale = {};
  const result = claimSessionSlot(sessions, "s1", stale, 1);
  assert.equal(result.ok, false);
  assert.equal(sessions.get("s1"), newer);
  assert.equal(stale.bootEpoch, undefined);
});

test("pending boot abort cancels older generations but not newer ones", () => {
  const {
    abortPendingBoot,
    clearPendingBootAbort,
    forgetBootEpoch,
    hasNewerBootEpoch,
    registerPendingBootAbort,
    hasPendingBootAfter,
  } = require("./sessionBootEpoch.cjs");
  const older = registerPendingBootAbort("s-pending", 2);
  const newer = registerPendingBootAbort("s-pending", 4);
  assert.equal(older.signal.aborted, true);
  assert.equal(newer.signal.aborted, false);
  assert.equal(abortPendingBoot("s-pending", 3), false);
  assert.equal(hasPendingBootAfter("s-pending", 3), true);
  assert.equal(hasNewerBootEpoch("s-pending", 3), true);
  assert.equal(newer.signal.aborted, false);
  assert.equal(abortPendingBoot("s-pending", 4), true);
  assert.equal(hasPendingBootAfter("s-pending", 3), false);
  assert.equal(hasNewerBootEpoch("s-pending", 3), true);
  assert.equal(newer.signal.aborted, true);
  clearPendingBootAbort("s-pending", newer);
  forgetBootEpoch("s-pending", 4);
  assert.equal(hasNewerBootEpoch("s-pending", 3), false);
});

test("claimSessionSlot replaces an older boot epoch and marks it superseded", () => {
  const sessions = new Map();
  const older = {
    bootEpoch: 1,
    proc: { killed: false, kill() { this.killed = true; } },
    externalAuthArtifacts: ["/tmp/et-auth-artifact"],
    externalAuthArtifactsCleaned: false,
    logStreamToken: Symbol("displaced-log"),
  };
  const removed = [];
  const stoppedLogs = [];
  const fs = require("node:fs");
  const originalRmSync = fs.rmSync;
  fs.rmSync = (target) => { removed.push(target); };
  const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");
  const originalStopStream = sessionLogStreamManager.stopStream;
  sessionLogStreamManager.stopStream = (id, token) => {
    stoppedLogs.push({ id, token });
  };
  try {
    sessions.set("s1", older);
    const newer = {};
    const result = claimSessionSlot(sessions, "s1", newer, 4);
    assert.equal(result.ok, true);
    assert.equal(sessions.get("s1"), newer);
    assert.equal(newer.bootEpoch, 4);
    assert.equal(older.closed, true);
    assert.equal(older.supersededByBootEpoch, 4);
    assert.equal(older.proc.killed, true);
    assert.equal(older._displacedDisposed, true);
    assert.equal(older.externalAuthArtifactsCleaned, true);
    assert.deepEqual(removed, ["/tmp/et-auth-artifact"]);
    assert.equal(result.displaced, older);
    assert.equal(stoppedLogs.length, 1);
    assert.equal(stoppedLogs[0].id, "s1");
    assert.equal(stoppedLogs[0].token, older.logStreamToken);
  } finally {
    fs.rmSync = originalRmSync;
    sessionLogStreamManager.stopStream = originalStopStream;
  }
});

test("claimSessionSlot cancels the displaced session's auto-login detector", () => {
  const sessions = new Map();
  let cancelCalls = 0;
  const older = {
    bootEpoch: 1,
    autoLogin: { cancel() { cancelCalls += 1; } },
  };
  sessions.set("s1", older);
  const newer = {};
  const result = claimSessionSlot(sessions, "s1", newer, 4);
  assert.equal(result.ok, true);
  assert.equal(sessions.get("s1"), newer);
  assert.equal(cancelCalls, 1);
});

test("sessionMatchesBootEpoch ignores closes for a different generation", () => {
  assert.equal(sessionMatchesBootEpoch({ bootEpoch: 3 }, 1), false);
  assert.equal(sessionMatchesBootEpoch({ bootEpoch: 3 }, 3), true);
  assert.equal(sessionMatchesBootEpoch({ bootEpoch: 3 }, undefined), true);
});
