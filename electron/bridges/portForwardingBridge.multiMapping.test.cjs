"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Duplex } = require("node:stream");
const net = require("node:net");
const Module = require("node:module");
const { resetSshTransportRegistryForTests } = require("./sshConnectionPool.cjs");

function createSender(onSend = () => {}) {
  return {
    id: 1,
    isDestroyed: () => false,
    send: onSend,
  };
}

function loadBridgeWithMocks(t) {
  const originalLoad = Module._load;

  class MockSshClient extends EventEmitter {
    constructor() {
      super();
      this.socketTimeouts = [];
      this._sock = { setTimeout: (value) => this.socketTimeouts.push(value) };
    }

    connect() {
      setImmediate(() => {
        this.emit("connect");
        this.emit("ready");
      });
    }

    forwardOut(_srcIP, _srcPort, _dstHost, _dstPort, callback) {
      callback(null, new Duplex({
        read() {},
        write(_chunk, _encoding, done) { done(); },
      }));
    }

    end() {
      // Real ssh2 emits close asynchronously; keep the mock faithful so
      // bind-error cleanup cannot race ahead of the error propagation.
      setImmediate(() => this.emit("close"));
    }
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "ssh2") {
      return { Client: MockSshClient, utils: { parseKey: () => null } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const bridgePath = require.resolve("./portForwardingBridge.cjs");
  delete require.cache[bridgePath];
  const bridge = require("./portForwardingBridge.cjs");

  t.after(() => {
    Module._load = originalLoad;
    delete require.cache[bridgePath];
  });

  return bridge;
}

const basePayload = {
  type: "local",
  bindAddress: "127.0.0.1",
  remoteHost: "127.0.0.1",
  remotePort: 3306,
  hostname: "db.internal",
  hostId: "db-host",
  port: 22,
  username: "dbuser",
  password: "target-password",
  authMethod: "password",
  verifyHostKeys: false,
  useSshAgent: false,
};

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  server.close();
  await new Promise((resolve) => server.once("close", resolve));
  return port;
}

function occupyPort(port) {
  const blocker = net.createServer();
  return new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(port, "127.0.0.1", () => resolve(blocker));
  });
}

test("one multi-mapping rule starts one tunnel per mapping sharing the rule id", async (t) => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const bridge = loadBridgeWithMocks(t);
  const event = { sender: createSender() };
  const portA = await reservePort();
  const portB = await reservePort();

  try {
    const result = await bridge.startPortForward(event, {
      ...basePayload,
      tunnelId: "pf-multi-1",
      ruleId: "rule-multi",
      localPort: portA,
      remotePort: 3306,
      mappings: [
        { localPort: portA, remotePort: 3306 },
        { localPort: portB, remotePort: 3307 },
      ],
    });

    assert.equal(result.success, true);
    assert.equal(result.mappings.length, 2);
    assert.ok(result.mappings.every((mapping) => mapping.success));

    const tunnels = await bridge.listPortForwards(event, {});
    assert.equal(tunnels.length, 2);
    assert.ok(tunnels.every((tunnel) => tunnel.ruleId === "rule-multi"));

    const snapshot = bridge.getPortForwardSnapshot();
    const mappingIds = snapshot.records
      .map((record) => record.mappingId)
      .sort((a, b) => a - b);
    assert.deepEqual(mappingIds, [portA, portB].sort((a, b) => a - b));
  } finally {
    await bridge.stopPortForwardByRuleId(event, { ruleId: "rule-multi" });
  }
  assert.equal((await bridge.listPortForwards(event, {})).length, 0);
});

test("an occupied port fails only its own mapping; the sibling keeps running", async (t) => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const bridge = loadBridgeWithMocks(t);
  const event = { sender: createSender() };
  const blockedPort = await reservePort();
  const freePort = await reservePort();
  const blocker = await occupyPort(blockedPort);

  try {
    const result = await bridge.startPortForward(event, {
      ...basePayload,
      tunnelId: "pf-multi-2",
      ruleId: "rule-partial",
      localPort: blockedPort,
      remotePort: 3306,
      mappings: [
        { localPort: blockedPort, remotePort: 3306 },
        { localPort: freePort, remotePort: 3307 },
      ],
    });

    assert.equal(result.success, false);
    const failed = result.mappings.find((mapping) => mapping.mappingId === blockedPort);
    const live = result.mappings.find((mapping) => mapping.mappingId === freePort);
    assert.equal(failed.success, false);
    assert.match(failed.error ?? "", /EADDRINUSE|already in use/i);
    assert.equal(live.success, true);

    const tunnels = await bridge.listPortForwards(event, {});
    assert.equal(tunnels.length, 1);
    assert.equal(tunnels[0].ruleId, "rule-partial");
  } finally {
    await bridge.stopPortForwardByRuleId(event, { ruleId: "rule-partial" });
    blocker.close();
  }
  assert.equal((await bridge.listPortForwards(event, {})).length, 0);
});

test("restarting the same rule reuses live mapping tunnels per mapping", async (t) => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const bridge = loadBridgeWithMocks(t);
  const firstEvent = { sender: createSender() };
  const secondEvent = { sender: { ...createSender(), id: 2 } };
  const portA = await reservePort();
  const portB = await reservePort();

  try {
    const first = await bridge.startPortForward(firstEvent, {
      ...basePayload,
      tunnelId: "pf-multi-3",
      ruleId: "rule-reuse",
      localPort: portA,
      mappings: [
        { localPort: portA, remotePort: 3306 },
        { localPort: portB, remotePort: 3307 },
      ],
    });
    assert.equal(first.success, true);

    const second = await bridge.startPortForward(secondEvent, {
      ...basePayload,
      tunnelId: "pf-multi-3-other-window",
      ruleId: "rule-reuse",
      localPort: portA,
      mappings: [
        { localPort: portA, remotePort: 3306 },
        { localPort: portB, remotePort: 3307 },
      ],
    });
    assert.equal(second.success, true);
    assert.ok(second.mappings.every((mapping) => mapping.reused));
    assert.equal((await bridge.listPortForwards(secondEvent, {})).length, 2);
  } finally {
    await bridge.stopPortForwardByRuleId(firstEvent, { ruleId: "rule-reuse" });
  }
});

test("dynamic forwarding rejects mapping lists", async (t) => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const bridge = loadBridgeWithMocks(t);
  const event = { sender: createSender() };
  const portA = await reservePort();

  await assert.rejects(
    bridge.startPortForward(event, {
      ...basePayload,
      type: "dynamic",
      tunnelId: "pf-multi-4",
      ruleId: "rule-dynamic",
      localPort: portA,
      mappings: [{ localPort: portA, remotePort: 3306 }],
    }),
    /mappings are not supported for dynamic/,
  );
  assert.equal((await bridge.listPortForwards(event, {})).length, 0);
});

test("fresh multi-mapping successes report their active status with the result", async (t) => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const bridge = loadBridgeWithMocks(t);
  const event = { sender: createSender() };
  const portA = await reservePort();
  const portB = await reservePort();

  try {
    const result = await bridge.startPortForward(event, {
      ...basePayload,
      tunnelId: "pf-multi-5",
      ruleId: "rule-fresh-status",
      localPort: portA,
      mappings: [
        { localPort: portA, remotePort: 3306 },
        { localPort: portB, remotePort: 3307 },
      ],
    });

    assert.equal(result.success, true);
    // The "active" event fired before callers could subscribe per-mapping
    // listeners, so the status must travel with the result entries.
    assert.ok(result.mappings.every((mapping) => mapping.status === "active"));
  } finally {
    await bridge.stopPortForwardByRuleId(event, { ruleId: "rule-fresh-status" });
  }
  assert.equal((await bridge.listPortForwards(event, {})).length, 0);
});

function loadBridgeWithRemoteMocks(t, { unbindablePorts = new Set() } = {}) {
  const originalLoad = Module._load;

  class MockRemoteSshClient extends EventEmitter {
    constructor() {
      super();
      this.socketTimeouts = [];
      this._sock = { setTimeout: (value) => this.socketTimeouts.push(value) };
    }

    connect() {
      setImmediate(() => {
        this.emit("connect");
        this.emit("ready");
      });
    }

    forwardIn(bindAddress, port, callback) {
      setImmediate(() => {
        if (unbindablePorts.has(port)) {
          // What ssh2 reports when the server rejects tcpip-forward.
          callback(new Error(`Unable to bind to ${bindAddress}:${port}`));
          return;
        }
        callback(null);
      });
    }

    unforwardIn(_bindAddress, _port, callback) {
      if (callback) setImmediate(() => callback(null));
    }

    end() {
      setImmediate(() => this.emit("close"));
    }
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "ssh2") {
      return { Client: MockRemoteSshClient, utils: { parseKey: () => null } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const bridgePath = require.resolve("./portForwardingBridge.cjs");
  delete require.cache[bridgePath];
  const bridge = require("./portForwardingBridge.cjs");

  t.after(() => {
    Module._load = originalLoad;
    delete require.cache[bridgePath];
  });

  return bridge;
}

test("a remote bind failure fails only its own mapping; later mappings still start", async (t) => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const blockedPort = await reservePort();
  const freePort = await reservePort();
  const bridge = loadBridgeWithRemoteMocks(t, { unbindablePorts: new Set([blockedPort]) });
  const event = { sender: createSender() };

  try {
    const result = await bridge.startPortForward(event, {
      ...basePayload,
      type: "remote",
      tunnelId: "pf-multi-remote-1",
      ruleId: "rule-remote-partial",
      localPort: blockedPort,
      mappings: [
        { localPort: blockedPort, remotePort: 3306 },
        { localPort: freePort, remotePort: 3307 },
      ],
    });

    assert.equal(result.success, false);
    assert.equal(result.mappings.length, 2);
    const failed = result.mappings.find((mapping) => mapping.mappingId === blockedPort);
    const live = result.mappings.find((mapping) => mapping.mappingId === freePort);
    assert.equal(failed.success, false);
    assert.match(failed.error ?? "", /unable to bind/i);
    assert.equal(live.success, true);
    assert.equal(live.status, "active");

    const tunnels = await bridge.listPortForwards(event, {});
    assert.equal(tunnels.length, 1);
    assert.equal(tunnels[0].ruleId, "rule-remote-partial");
  } finally {
    await bridge.stopPortForwardByRuleId(event, { ruleId: "rule-remote-partial" });
  }
  assert.equal((await bridge.listPortForwards(event, {})).length, 0);
});
