const test = require("node:test");
const assert = require("node:assert/strict");
const {
  beginTransportDial,
  failTransportDial,
  waitForTransportDial,
} = require("../sshConnectionPool.cjs");
const { releaseUnsharedFreshDial } = require("./openConnection.cjs");

const endpoint = {
  hostname: "single-channel-bastion.example",
  port: 8022,
  username: "root",
  hostId: "unshared-dial-test",
};

test("an unshared single-channel dial lets the next upload dial instead of waiting", async () => {
  const leader = beginTransportDial(endpoint, { kind: "channel" });
  assert.equal(leader.role, "leader");
  const joiner = beginTransportDial(endpoint, { kind: "channel" });
  assert.equal(joiner.role, "join");

  assert.equal(releaseUnsharedFreshDial(leader, false, failTransportDial), true);
  await assert.rejects(
    () => waitForTransportDial(joiner),
    (error) => error?.code === "ERR_SFTP_SINGLE_CHANNEL_BASTION",
  );

  const next = beginTransportDial(endpoint, { kind: "channel" });
  assert.equal(next.role, "leader");
  failTransportDial(next, new Error("test cleanup"));
});

test("a registered transport is left for normal reuse", () => {
  const leader = beginTransportDial({
    ...endpoint,
    hostId: "registered-dial-test",
  }, { kind: "channel" });
  assert.equal(releaseUnsharedFreshDial(leader, true, failTransportDial), false);
  assert.equal(leader._record.settled, false);
  failTransportDial(leader, new Error("test cleanup"));
});
