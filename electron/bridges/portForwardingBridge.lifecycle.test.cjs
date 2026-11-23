"use strict";

// --- merged from portForwardingBridge.endpoint.test.cjs ---
{
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildPortForwardEndpoint,
  buildPortForwardEndpointFromStartPayload,
} = require("./portForwardingBridge.cjs");
const {
  buildConnectionReuseEndpoint,
  buildEndpointKey,
  normalizeEndpoint,
} = require("./sshConnectionPool.cjs");

const baseOptions = {
  hostId: "pf-profile",
  hostname: "pf-endpoint.test",
  port: 22,
  username: "alice",
  authMethod: "key",
  keyId: "pf-key",
  privateKey: "PF_PRIVATE_SECRET",
  publicKey: "ssh-ed25519 PF_PUBLIC_KEY",
  passphrase: "PF_PASSPHRASE_SECRET",
  identityFilePaths: ["/keys/pf"],
  useSshAgent: true,
  identityAgent: "/run/user/1000/pf-agent-a.sock",
  identitiesOnly: true,
  agentPublicKeys: ["ssh-ed25519 PF_AGENT_KEY_A"],
  addKeysToAgent: "confirm",
  useKeychain: true,
  legacyAlgorithms: false,
  skipEcdsaHostKey: false,
  algorithmOverrides: { kex: ["curve25519-sha256"] },
  verifyHostKeys: true,
  knownHosts: [{
    id: "kh-pf-endpoint",
    hostname: "pf-endpoint.test",
    port: 22,
    keyType: "ssh-ed25519",
    fingerprint: "SHA256:pf-endpoint-a",
    publicKey: "ssh-ed25519 PF_KNOWN_HOST_KEY_A",
  }],
};

function endpointKey(options = baseOptions) {
  return buildEndpointKey(buildPortForwardEndpoint(options));
}

test("port-forward endpoint identity changes for every effective agent selection setting", () => {
  const baseKey = endpointKey();
  const variants = [
    { identityAgent: "/run/user/1000/pf-agent-b.sock" },
    { identitiesOnly: false },
    { agentPublicKeys: ["ssh-ed25519 PF_AGENT_KEY_B"] },
    { addKeysToAgent: "yes" },
    { useKeychain: false },
  ];

  for (const variant of variants) {
    assert.notEqual(endpointKey({ ...baseOptions, ...variant }), baseKey);
  }
});

test("port-forward endpoint identity changes for every effective algorithm setting", () => {
  const baseKey = endpointKey();
  const variants = [
    { legacyAlgorithms: true },
    { skipEcdsaHostKey: true },
    { algorithmOverrides: { kex: ["diffie-hellman-group14-sha256"] } },
  ];

  for (const variant of variants) {
    assert.notEqual(endpointKey({ ...baseOptions, ...variant }), baseKey);
  }
});

test("port-forward endpoint identity includes the effective known-host trust set", () => {
  const baseKey = endpointKey();
  const rotatedKnownHosts = [{
    ...baseOptions.knownHosts[0],
    fingerprint: "SHA256:pf-endpoint-b",
    publicKey: "ssh-ed25519 PF_KNOWN_HOST_KEY_B",
  }];

  assert.notEqual(endpointKey({ ...baseOptions, knownHosts: rotatedKnownHosts }), baseKey);
  assert.equal(
    endpointKey(),
    buildEndpointKey(buildConnectionReuseEndpoint(baseOptions, { sftpSudo: false })),
  );
});

test("port-forward endpoint normalizes to the common digest-only connection identity", () => {
  const normalized = normalizeEndpoint(buildPortForwardEndpoint(baseOptions));
  const serialized = JSON.stringify(normalized);

  assert.ok(normalized?.authFingerprint);
  for (const secret of [
    baseOptions.privateKey,
    baseOptions.passphrase,
    baseOptions.agentPublicKeys[0],
    baseOptions.knownHosts[0].publicKey,
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("port-forward start identity uses the resolved keepalive policy", () => {
  const payload = {
    ...baseOptions,
    resolvedKeepaliveInterval: 30,
    resolvedKeepaliveCountMax: 10,
  };
  assert.equal(
    buildEndpointKey(buildPortForwardEndpointFromStartPayload(payload)),
    buildEndpointKey(buildConnectionReuseEndpoint({
      ...baseOptions,
      keepaliveInterval: 30,
      keepaliveCountMax: 10,
    })),
  );
});
}

// --- merged from portForwardingBridge.snapshot.test.cjs ---
{
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
}

// --- merged from portForwardingBridge.pipeLifecycle.test.cjs ---
{
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const net = require("node:net");
const test = require("node:test");

const {
  _bindPortForwardChannelsForTests: bindPortForwardChannels,
  _attachTunnelPipeStreamForTests: attachTunnelPipeStream,
  _clearPortForwardTunnelsForTests: clearPortForwardTunnels,
  _destroyTunnelPipesForTests: destroyTunnelPipes,
  _trackTunnelPipeForTests: trackTunnelPipe,
  cancelTunnel,
} = require("./portForwardingBridge.cjs");

function fakeEndpoint() {
  const endpoint = new EventEmitter();
  endpoint.destroyedByTest = false;
  endpoint.destroyCalls = 0;
  endpoint.destroy = () => {
    endpoint.destroyCalls += 1;
    endpoint.destroyedByTest = true;
  };
  endpoint.end = () => { endpoint.destroyedByTest = true; };
  endpoint.close = () => { endpoint.destroyedByTest = true; };
  return endpoint;
}

test("accepted sockets are tracked before forwardOut finishes and stop destroys them", () => {
  const tunnel = { cancelled: false, activePipes: new Set() };
  const socket = fakeEndpoint();
  const entry = trackTunnelPipe(tunnel, socket);
  assert.equal(tunnel.activePipes.size, 1);

  destroyTunnelPipes(tunnel);
  assert.equal(socket.destroyedByTest, true);
  assert.equal(entry.openAbortController, null);
  assert.equal(tunnel.activePipes.size, 0);
});

test("client disconnect drops only its pending channel open", () => {
  const tunnel = { cancelled: false, activePipes: new Set() };
  const socket = fakeEndpoint();
  const entry = trackTunnelPipe(tunnel, socket);
  entry.openStarted = true;
  let aborts = 0;
  entry.openAbortController.signal.addEventListener("abort", () => { aborts += 1; });

  socket.emit("close");

  assert.equal(aborts, 0);
  assert.equal(entry.closed, true);
  assert.equal(entry.openAbortController.signal.aborted, false);
  assert.equal(tunnel.activePipes.size, 1);
  const destroyCalls = socket.destroyCalls;

  socket.emit("error", new Error("client closed"));
  assert.equal(socket.destroyCalls, destroyCalls);

  destroyTunnelPipes(tunnel);

  assert.equal(aborts, 1);
  assert.equal(tunnel.activePipes.size, 0);
});

test("a client disconnect does not close the local forwarding listener", async () => {
  let finishForwardOut;
  let transportEnds = 0;
  let transportDestroys = 0;
  const conn = new EventEmitter();
  conn.forwardOut = (_sourceAddress, _sourcePort, _targetAddress, _targetPort, callback) => {
    finishForwardOut = callback;
  };
  conn.end = () => { transportEnds += 1; };
  conn.destroy = () => { transportDestroys += 1; };
  const tunnel = {
    tunnelId: "pf-client-disconnect",
    cancelled: false,
    activePipes: new Set(),
    chainConnections: [],
    sshTransportManaged: false,
  };
  const sender = { id: 1, isDestroyed: () => false };

  const started = await bindPortForwardChannels({
    type: "local",
    conn,
    tunnelId: tunnel.tunnelId,
    tunnelState: tunnel,
    sender,
    bindAddress: "127.0.0.1",
    localPort: 0,
    remoteHost: "127.0.0.1",
    remotePort: 22,
    chainConnections: [],
    sendStatus() {},
  });
  assert.equal(started.success, true);

  const client = net.connect(tunnel.server.address().port, "127.0.0.1");
  await once(client, "connect");
  client.destroy();
  await once(client, "close");
  assert.equal(tunnel.server.listening, true);

  finishForwardOut(new Error("client closed"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transportEnds, 0);
  assert.equal(transportDestroys, 0);

  await new Promise((resolve, reject) => tunnel.server.close((error) => error ? reject(error) : resolve()));
});

test("a disconnected SOCKS client remains cancellable until its channel open settles", async () => {
  let finishForwardOut;
  let forwardOutStarted;
  const conn = new EventEmitter();
  conn.forwardOut = (_sourceAddress, _sourcePort, _targetAddress, _targetPort, callback) => {
    finishForwardOut = callback;
    forwardOutStarted?.();
  };
  conn.end = () => {};
  conn.destroy = () => {};
  const tunnel = {
    tunnelId: "pf-socks-client-disconnect",
    cancelled: false,
    activePipes: new Set(),
    chainConnections: [],
    sshTransportManaged: false,
  };
  const sender = { id: 2, isDestroyed: () => false };

  try {
    const started = await bindPortForwardChannels({
      type: "dynamic",
      conn,
      tunnelId: tunnel.tunnelId,
      tunnelState: tunnel,
      sender,
      bindAddress: "127.0.0.1",
      localPort: 0,
      remoteHost: "127.0.0.1",
      remotePort: 22,
      chainConnections: [],
      sendStatus() {},
    });
    assert.equal(started.success, true);

    const client = net.connect(tunnel.server.address().port, "127.0.0.1");
    await once(client, "connect");
    client.write(Buffer.from([0x05, 0x01, 0x00]));
    await once(client, "data");
    const channelStarted = new Promise((resolve) => { forwardOutStarted = resolve; });
    client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0, 22]));
    await channelStarted;
    client.destroy();
    await once(client, "close");
    assert.equal(tunnel.server.listening, true);
    assert.equal(tunnel.activePipes.size, 1);

    await cancelTunnel(tunnel.tunnelId, tunnel, () => {});
    assert.equal(tunnel.activePipes.size, 0);
  } finally {
    clearPortForwardTunnels();
  }
});

test("an invalid SOCKS client is removed before opening an SSH channel", async () => {
  const conn = new EventEmitter();
  conn.end = () => {};
  conn.destroy = () => {};
  const tunnel = {
    tunnelId: "pf-socks-invalid-client",
    cancelled: false,
    activePipes: new Set(),
    chainConnections: [],
    sshTransportManaged: false,
  };
  const sender = { id: 3, isDestroyed: () => false };

  try {
    const started = await bindPortForwardChannels({
      type: "dynamic",
      conn,
      tunnelId: tunnel.tunnelId,
      tunnelState: tunnel,
      sender,
      bindAddress: "127.0.0.1",
      localPort: 0,
      remoteHost: "127.0.0.1",
      remotePort: 22,
      chainConnections: [],
      sendStatus() {},
    });
    assert.equal(started.success, true);

    const client = net.connect(tunnel.server.address().port, "127.0.0.1");
    await once(client, "connect");
    client.write(Buffer.from([0x04, 0x01, 0x00]));
    await once(client, "close");
    assert.equal(tunnel.activePipes.size, 0);
    assert.equal(tunnel.server.listening, true);
  } finally {
    await new Promise((resolve, reject) => tunnel.server.close((error) => error ? reject(error) : resolve()));
    clearPortForwardTunnels();
  }
});

test("a late forwardOut stream after stop is rejected and destroyed", () => {
  const tunnel = { cancelled: false, activePipes: new Set() };
  const socket = fakeEndpoint();
  const entry = trackTunnelPipe(tunnel, socket);
  tunnel.cancelled = true;
  const stream = fakeEndpoint();

  assert.equal(attachTunnelPipeStream(tunnel, entry, stream), false);
  assert.equal(socket.destroyedByTest, true);
  assert.equal(stream.destroyedByTest, true);
  assert.equal(tunnel.activePipes.size, 0);
});

test("closing either side tears down the paired endpoint and releases tracking", () => {
  const tunnel = { cancelled: false, activePipes: new Set() };
  const socket = fakeEndpoint();
  const stream = fakeEndpoint();
  const entry = trackTunnelPipe(tunnel, socket);
  assert.equal(attachTunnelPipeStream(tunnel, entry, stream), true);

  socket.emit("close");
  assert.equal(stream.destroyedByTest, true);
  assert.equal(tunnel.activePipes.size, 0);
});
}
