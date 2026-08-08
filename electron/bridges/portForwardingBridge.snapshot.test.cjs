const test = require("node:test");
const assert = require("node:assert/strict");

const {
  publishTunnelStatus,
  getPortForwardSnapshot,
  subscribePortForwardRuntime,
  unsubscribePortForwardRuntime,
  cancelTunnel,
  _resetPortForwardRuntimeMetaForTests: resetRuntimeMeta,
  _seedPortForwardTunnelForTests: seedTunnel,
  _clearPortForwardTunnelsForTests: clearTunnels,
} = require("./portForwardingBridge.cjs");

function createCapturingSender(onSend = () => {}, id = 1) {
  return {
    id,
    isDestroyed: () => false,
    send: (channel, payload) => onSend(channel, payload),
    once() {},
    removeListener() {},
  };
}

test("snapshot exposes process epoch, revision, and rule-scoped records", () => {
  resetRuntimeMeta();
  clearTunnels();
  const tunnelId = "snap-tunnel-1";
  const tunnel = {
    ruleId: "rule-1",
    status: "active",
    subscribers: new Map(),
    cleanupFailed: false,
  };
  seedTunnel(tunnelId, tunnel);

  const before = getPortForwardSnapshot();
  assert.equal(typeof before.epoch, "string");
  assert.ok(before.epoch.length > 0);
  assert.equal(before.records.length, 1);
  assert.equal(before.records[0].ruleId, "rule-1");
  assert.equal(before.records[0].phase, "active");

  publishTunnelStatus(tunnelId, tunnel, "error", "listener failed");
  const after = getPortForwardSnapshot();
  assert.equal(after.epoch, before.epoch);
  assert.ok(after.revision > before.revision);
  assert.equal(after.records[0].phase, "error");
  assert.equal(after.records[0].error, "listener failed");
  assert.equal(after.records[0].cleanupRequired, false);

  clearTunnels();
});

test("subscribePortForwardRuntime returns snapshot and receives ordered events", () => {
  resetRuntimeMeta();
  clearTunnels();
  const events = [];
  const sender = createCapturingSender((channel, payload) => {
    if (channel === "netcatty:portforward:runtime") events.push(payload);
  }, 42);

  const snapshot = subscribePortForwardRuntime({ sender });
  assert.equal(typeof snapshot.epoch, "string");
  assert.equal(snapshot.revision, 0);
  assert.deepEqual(snapshot.records, []);

  const tunnelId = "runtime-tunnel";
  const tunnel = {
    ruleId: "rule-runtime",
    status: "connecting",
    subscribers: new Map([[sender.id, sender]]),
    cleanupFailed: false,
  };
  seedTunnel(tunnelId, tunnel);
  publishTunnelStatus(tunnelId, tunnel, "active");

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "upsert");
  assert.equal(events[0].record.phase, "active");
  assert.equal(events[0].record.ruleId, "rule-runtime");
  assert.equal(events[0].revision, 1);
  assert.equal(events[0].epoch, snapshot.epoch);

  unsubscribePortForwardRuntime({ sender });
  publishTunnelStatus(tunnelId, tunnel, "error", "boom");
  assert.equal(events.length, 1);
  clearTunnels();
});

test("successful cleanup publishes remove after inactive", async () => {
  resetRuntimeMeta();
  clearTunnels();
  const events = [];
  const sender = createCapturingSender((channel, payload) => {
    if (channel === "netcatty:portforward:runtime") events.push(payload);
  }, 7);
  subscribePortForwardRuntime({ sender });

  const tunnelId = "cleanup-tunnel";
  const tunnel = {
    ruleId: "rule-cleanup",
    status: "active",
    subscribers: new Map(),
    cleanupFailed: false,
    cleanupInProgress: false,
  };
  seedTunnel(tunnelId, tunnel);

  await cancelTunnel(
    tunnelId,
    tunnel,
    (status, error) => publishTunnelStatus(tunnelId, tunnel, status, error),
    { deleteEntry: true },
  );

  assert.ok(events.some((event) => event.kind === "upsert" && event.record?.phase === "inactive"));
  assert.ok(events.some((event) => event.kind === "remove" && event.tunnelId === tunnelId));
  assert.deepEqual(getPortForwardSnapshot().records, []);
  unsubscribePortForwardRuntime({ sender });
  clearTunnels();
});
