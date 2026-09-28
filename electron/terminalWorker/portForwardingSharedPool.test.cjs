const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const Module = require("node:module");
const test = require("node:test");

let physicalDialCount = 0;

class MockSshClient extends EventEmitter {
  constructor() {
    super();
    this._sock = { destroyed: false, writable: true, setTimeout() {} };
  }

  connect() {
    physicalDialCount += 1;
    setImmediate(() => {
      this.emit("connect");
      this.emit("ready");
    });
  }

  forwardIn(_bindAddress, _bindPort, callback) {
    this.forwardInCalls = (this.forwardInCalls || 0) + 1;
    setImmediate(() => callback(null));
  }

  end() {
    if (this._sock.destroyed) return;
    this._sock.destroyed = true;
    this._sock.writable = false;
    setImmediate(() => this.emit("close"));
  }
}

const originalLoad = Module._load;
Module._load = function mockSsh2(request, parent, isMain) {
  if (request === "ssh2") return { Client: MockSshClient };
  return originalLoad.call(this, request, parent, isMain);
};
const { createTerminalWorkerRuntime } = require("./runtime.cjs");
const { registerPortForwardingWorkerBridge } = require("./process.cjs");
// Load the production worker bridge while ssh2 is replaced by the deterministic
// transport used by this integration test. The registration helper then uses
// this exact shared module instance.
require("../bridges/portForwardingBridge.cjs");
const {
  LEASE_KINDS,
  borrowTransport,
  createTransport,
  findTransportByEndpoint,
  resetSshTransportRegistryForTests,
  returnTransport,
} = require("../bridges/sshConnectionPool.cjs");
Module._load = originalLoad;

const endpoint = {
  hostId: "worker-host",
  hostname: "worker-host.test",
  port: 22,
  username: "alice",
  jumpHosts: [],
  proxy: null,
  authType: "password",
  keyId: "",
  certificate: "",
  requiresMfa: false,
  verifyHostKeys: true,
  knownHosts: [{
    id: "kh-worker-host",
    hostname: "worker-host.test",
    port: 22,
    keyType: "ssh-ed25519",
    fingerprint: "SHA256:worker-host",
    publicKey: "ssh-ed25519 WORKER_HOST_PUBLIC_KEY",
  }],
  useSshAgent: false,
  agentForwarding: false,
  password: "worker-password",
};

function createParentPort() {
  const listeners = new Map();
  const waiters = new Map();
  return {
    messages: [],
    on(channel, listener) {
      listeners.set(channel, listener);
    },
    postMessage(message) {
      this.messages.push(message);
      if (message.kind === "response") {
        const waiter = waiters.get(message.requestId);
        if (waiter) {
          waiters.delete(message.requestId);
          message.error ? waiter.reject(new Error(message.error)) : waiter.resolve(message.result);
        }
      }
    },
    request(channel, payload, webContentsId = 7) {
      const requestId = `${channel}:${Math.random()}`;
      const promise = new Promise((resolve, reject) => waiters.set(requestId, { resolve, reject }));
      listeners.get("message")?.({ kind: "request", requestId, channel, payload, webContentsId });
      return promise;
    },
  };
}

function createHarness() {
  const parentPort = createParentPort();
  const siblingHolders = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      registerPortForwardingWorkerBridge(ipcMain);
      for (const [channel, kind] of [
        ["netcatty:test:terminal-open", LEASE_KINDS.shell],
        ["netcatty:test:sftp-open", LEASE_KINDS.sftp],
      ]) {
        ipcMain.handle(channel, async (_event, payload) => {
          let transport = findTransportByEndpoint(endpoint, { kind: "channel" });
          if (!transport) {
            physicalDialCount += 1;
            transport = createTransport({ conn: new MockSshClient(), chainConnections: [], endpoint });
          }
          const holder = { id: payload.id };
          borrowTransport(transport, {
            kind,
            holder,
            leaseId: `${kind}:${payload.id}`,
          });
          siblingHolders.push(holder);
          return { id: payload.id };
        });
      }
    },
  });
  runtime.start();
  return { parentPort, siblingHolders };
}

function portForwardPayload(tunnelId, overrides = {}) {
  return {
    tunnelId,
    ruleId: `rule-${tunnelId}`,
    type: "local",
    localPort: 0,
    bindAddress: "127.0.0.1",
    remoteHost: "127.0.0.1",
    remotePort: 3306,
    ...endpoint,
    authMethod: endpoint.authType,
    ...overrides,
  };
}

async function cleanupHarness(parentPort, siblingHolders, tunnelId) {
  if (tunnelId) {
    await parentPort.request("netcatty:portforward:stop", { tunnelId }).catch(() => {});
  }
  for (const holder of siblingHolders) returnTransport(holder);
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
}

for (const [label, channel] of [
  ["terminal", "netcatty:test:terminal-open"],
  ["SFTP", "netcatty:test:sftp-open"],
]) {
  test(`worker ${label} opened after port forwarding reuses one physical SSH dial`, async (t) => {
    physicalDialCount = 0;
    resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
    const { parentPort, siblingHolders } = createHarness();
    t.after(() => cleanupHarness(parentPort, siblingHolders, "pf-first"));

    assert.equal((await parentPort.request(
      "netcatty:portforward:start",
      portForwardPayload("pf-first"),
    )).success, true);
    await parentPort.request(channel, { id: `${label}-after` });

    assert.equal(physicalDialCount, 1);
  });

  test(`worker port forwarding opened after ${label} reuses one physical SSH dial`, async (t) => {
    physicalDialCount = 0;
    resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
    const { parentPort, siblingHolders } = createHarness();
    t.after(() => cleanupHarness(parentPort, siblingHolders, "pf-after"));

    await parentPort.request(channel, { id: `${label}-first` });
    assert.equal((await parentPort.request(
      "netcatty:portforward:start",
      portForwardPayload("pf-after"),
    )).success, true);

    assert.equal(physicalDialCount, 1);
  });
}

test("worker port forwarding with reuseTransport false stays physically independent", async (t) => {
  physicalDialCount = 0;
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  const { parentPort, siblingHolders } = createHarness();
  t.after(() => cleanupHarness(parentPort, siblingHolders, "pf-dedicated"));

  await parentPort.request("netcatty:test:sftp-open", { id: "sftp-first" });
  assert.equal((await parentPort.request(
    "netcatty:portforward:start",
    portForwardPayload("pf-dedicated", { reuseTransport: false }),
  )).success, true);

  assert.equal(physicalDialCount, 2);
});

test("single-channel local and remote forwards leave the terminal connection alone", async (t) => {
  physicalDialCount = 0;
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  const { parentPort, siblingHolders } = createHarness();
  const terminalConn = new MockSshClient();
  const terminalHolder = { id: "terminal-single" };
  const transport = createTransport({
    conn: terminalConn,
    endpoint: { ...endpoint, singleChannelSsh: true },
  });
  borrowTransport(transport, {
    kind: LEASE_KINDS.shell,
    holder: terminalHolder,
    leaseId: "shell:terminal-single",
  });
  siblingHolders.push(terminalHolder);
  t.after(async () => {
    await parentPort.request("netcatty:portforward:stop", { tunnelId: "pf-single-local" }).catch(() => {});
    await parentPort.request("netcatty:portforward:stop", { tunnelId: "pf-single-remote" }).catch(() => {});
    await cleanupHarness(parentPort, siblingHolders);
  });

  const local = await parentPort.request(
    "netcatty:portforward:start",
    portForwardPayload("pf-single-local", { type: "local", singleChannelSsh: true, localPort: 0 }),
  );
  assert.equal(local.success, true, local.error);
  const remote = await parentPort.request(
    "netcatty:portforward:start",
    portForwardPayload("pf-single-remote", {
      type: "remote",
      singleChannelSsh: true,
      localPort: 19022,
      bindAddress: "127.0.0.1",
    }),
  );
  assert.equal(remote.success, true, remote.error);
  assert.equal(physicalDialCount, 2);
  assert.equal(terminalConn.forwardInCalls || 0, 0);
  assert.equal(terminalConn.listenerCount("tcp connection"), 0);
});
