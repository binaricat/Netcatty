const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  DEFAULT_REUSED_SHELL_LIVENESS_MS,
  remoteAllowsIdleParkedShellReuse,
  remoteNeedsReusedShellLivenessCheck,
  shouldConfirmReusedShellLiveness,
  resolveReusedShellLivenessMs,
  waitForReusedShellLiveness,
} = require("./sshIdleParkPolicy.cjs");

test("TERM-SSHD cannot host a later shell on a parked transport", () => {
  assert.equal(remoteAllowsIdleParkedShellReuse("TERM-SSHD"), false);
  assert.equal(remoteAllowsIdleParkedShellReuse("SSH-2.0-TERM-SSHD"), false);
  assert.equal(remoteAllowsIdleParkedShellReuse("term-sshd"), false);
});

test("OpenSSH and Dropbear still allow idle-park shell reuse", () => {
  assert.equal(remoteAllowsIdleParkedShellReuse("OpenSSH_9.6"), true);
  assert.equal(remoteAllowsIdleParkedShellReuse("SSH-2.0-OpenSSH_9.6"), true);
  assert.equal(remoteAllowsIdleParkedShellReuse("dropbear_2024.85"), true);
  assert.equal(remoteAllowsIdleParkedShellReuse(""), true);
});

test("shouldConfirmReusedShellLiveness covers idle park and SFTP-held last-shell close", () => {
  assert.equal(shouldConfirmReusedShellLiveness({
    state: "idle",
    remoteSshVersion: "CustomBastion_1.0",
  }), true);
  assert.equal(shouldConfirmReusedShellLiveness({
    state: "live",
    pendingShellReconnectRisk: { oldShellPids: [], hasUnknownOldShell: true },
    remoteSshVersion: "TERM-SSHD",
  }), true);
  assert.equal(shouldConfirmReusedShellLiveness({
    state: "live",
    remoteSshVersion: "CustomBastion_1.0",
  }), false);
  assert.equal(shouldConfirmReusedShellLiveness({
    state: "idle",
    remoteSshVersion: "OpenSSH_9.0",
  }), false);
});

test("unknown banners get a reused-shell liveness check; OpenSSH does not", () => {
  assert.equal(remoteNeedsReusedShellLivenessCheck("TERM-SSHD"), true);
  assert.equal(remoteNeedsReusedShellLivenessCheck("CustomBastion_1.0"), true);
  assert.equal(remoteNeedsReusedShellLivenessCheck(""), true);
  assert.equal(remoteNeedsReusedShellLivenessCheck("OpenSSH_9.0"), false);
  assert.equal(remoteNeedsReusedShellLivenessCheck("SSH-2.0-OpenSSH_9.0"), false);
  assert.equal(remoteNeedsReusedShellLivenessCheck("dropbear_2022.83"), false);
});

test("resolveReusedShellLivenessMs clamps invalid values to the default", () => {
  assert.equal(resolveReusedShellLivenessMs(undefined), DEFAULT_REUSED_SHELL_LIVENESS_MS);
  assert.equal(resolveReusedShellLivenessMs(-1), DEFAULT_REUSED_SHELL_LIVENESS_MS);
  assert.equal(resolveReusedShellLivenessMs("nope"), DEFAULT_REUSED_SHELL_LIVENESS_MS);
  assert.equal(resolveReusedShellLivenessMs(40), 40);
  assert.equal(resolveReusedShellLivenessMs(0), 0);
});

test("waitForReusedShellLiveness fails when the channel exits before settle", async () => {
  const stream = new EventEmitter();
  const pending = waitForReusedShellLiveness(stream, { settleMs: 50 });
  stream.emit("exit", 0);
  stream.emit("close");
  const result = await pending;
  assert.equal(result.alive, false);
  assert.equal(result.reason, "exit");
  assert.equal(result.code, 0);
});

test("waitForReusedShellLiveness keeps buffered output when the shell stays up", async () => {
  const stream = new EventEmitter();
  const pending = waitForReusedShellLiveness(stream, { settleMs: 15 });
  stream.emit("data", Buffer.from("banner\n"));
  const result = await pending;
  assert.equal(result.alive, true);
  assert.equal(result.reason, "settle");
  assert.equal(Buffer.concat(result.buffered).toString(), "banner\n");
});

test("waitForReusedShellLiveness treats an already-closed stream as dead", async () => {
  const stream = new EventEmitter();
  stream.closed = true;
  const result = await waitForReusedShellLiveness(stream, { settleMs: 50 });
  assert.equal(result.alive, false);
  assert.equal(result.reason, "already-closed");
});
