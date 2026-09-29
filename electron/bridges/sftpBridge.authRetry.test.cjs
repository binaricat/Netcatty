// Created: 2026-07-17
// Purpose: Verify SFTP retries KI first after EDR removes keyboard-interactive.

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const {
  beginTransportDial,
  buildConnectionReuseEndpoint,
  failTransportDial,
  getTransportStats,
  resetSshTransportRegistryForTests,
} = require("./sshConnectionPool.cjs");
const { shouldRegisterFreshSftpTransport } = require("./sftpBridge/openConnection.cjs");

test("sudo SFTP connections are never parked in the shared transport registry", () => {
  assert.equal(shouldRegisterFreshSftpTransport({ sudo: true, reuseTransport: true }), false);
  assert.equal(shouldRegisterFreshSftpTransport({ sudo: false, reuseTransport: true }), true);
  assert.equal(shouldRegisterFreshSftpTransport({ sudo: false, reuseTransport: true, singleChannelSsh: true }), false);
});

/** Build a minimal renderer sender for SFTP progress and auth prompt IPC. */
function makeSender() {
  return {
    id: 1,
    isDestroyed: () => false,
    sent: [],
    send(channel, payload) {
      this.sent.push({ channel, payload });
    },
  };
}

/** Load the SFTP bridge with ssh2-sftp-client mocked for auth retry scenarios. */
function loadSftpBridgeWithAuthRetryMocks(t, options = {}) {
  const bridgePath = require.resolve("./sftpBridge.cjs");
  const authHelperPath = require.resolve("./sshAuthHelper.cjs");
  const originalLoad = Module._load;
  const realAuthHelper = require(authHelperPath);

  /** Mock SFTP client that simulates password rejection removing KI, then KI retry success. */
  class MockSftpClient extends EventEmitter {
    /** Create a mock ssh2-sftp-client instance with an embedded ssh2 client emitter. */
    constructor() {
      super();
      MockSftpClient.instances.push(this);
      this.sftp = null;
      this.client = new EventEmitter();
      this.client.setMaxListeners = () => {};
      this.client._sock = { setTimeout() {} };
      this.client.connect = (opts) => {
        this.client.connectOpts = opts;
        this.connect(opts);
      };
      this.client.sftp = (cb) => {
        if (options.sftpError) {
          setImmediate(() => cb(options.sftpError));
          return;
        }
        const channel = new EventEmitter();
        channel.readdir = () => {};
        channel.stat = () => {};
        channel.mkdir = () => {};
        channel.unlink = () => {};
        setImmediate(() => cb(null, channel));
      };
      this.client.end = () => {
        this.client.ended = true;
      };
      this.client.destroy = () => {
        this.client.destroyed = true;
      };
    }

    /** Drive the fake server-side auth flow for each connection attempt. */
    connect(opts) {
      const attemptIndex = MockSftpClient.instances.length;
      const offered = [];
      this.authMethodsOffered = offered;
      setImmediate(() => {
        this.client.emit("connect");
        this.client.emit("handshake");
        if (options.alwaysSucceed) {
          this.client.emit("ready");
          return;
        }
        const offerNext = (methodsLeft, partialSuccess) => {
          let nextMethod;
          opts.authHandler(methodsLeft, partialSuccess, (method) => {
            nextMethod = method;
            offered.push(method);
          });
          return nextMethod;
        };

        offerNext(null, null);
        const firstMethods = options.dynamicAuth
          ? ["publickey", "password", "keyboard-interactive"]
          : ["password", "keyboard-interactive"];
        const first = offerNext(firstMethods, false);
        if (attemptIndex === 1 && options.dynamicAuth) {
          assert.equal(first?.type, "publickey");
          const password = offerNext(["password", "keyboard-interactive"], false);
          assert.equal(password?.type, "password");
          offerNext(["publickey"], false);
          const err = new Error("All configured authentication methods failed");
          err.level = "client-authentication";
          this.client.emit("error", err);
          return;
        }
        if (attemptIndex === 1) {
          assert.equal(first, "password");
          offerNext(["publickey"], false);
          const err = new Error("All configured authentication methods failed");
          err.level = "client-authentication";
          this.client.emit("error", err);
          return;
        }

        if (options.dynamicAuth) {
          assert.equal(first?.type, "publickey");
          const keyboardInteractive = offerNext(["keyboard-interactive"], false);
          assert.equal(keyboardInteractive, "keyboard-interactive");
        } else {
          assert.equal(first, "keyboard-interactive");
        }
        this.client.emit("ready");
      });
    }

    /** Mark the high-level SFTP client as ended. */
    end() {
      this.ended = true;
    }
  }
  MockSftpClient.instances = [];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "ssh2-sftp-client") {
      return MockSftpClient;
    }
    if (request === "./sshAuthHelper.cjs") {
      return {
        ...realAuthHelper,
        findAllDefaultPrivateKeys: async () => {
          if (options.defaultKeysError) throw options.defaultKeysError;
          return options.defaultKeys || [];
        },
        getAvailableAgentSocket: async () => null,
        prepareSystemSshAgentForAuth: async () => null,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[bridgePath];
  const bridge = require("./sftpBridge.cjs");

  t.after(() => {
    delete require.cache[bridgePath];
    Module._load = originalLoad;
  });

  return { bridge, MockSftpClient };
}

test("simultaneous SFTP browser opens share one physical SSH dial", async (t) => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const { bridge, MockSftpClient } = loadSftpBridgeWithAuthRetryMocks(t, { alwaysSucceed: true });
  const sftpClients = new Map();
  bridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
  const options = {
    hostname: "192.168.9.138",
    hostId: "host-sftp-shared",
    port: 22,
    username: "root",
    authMethod: "password",
    password: "saved-login-password",
    useSshAgent: false,
    verifyHostKeys: false,
    fileProtocol: "sftp",
  };

  const [first, second] = await Promise.all([
    bridge.openSftp({ sender: makeSender() }, { ...options, sessionId: "sftp-shared-1" }),
    bridge.openSftp({ sender: makeSender() }, { ...options, sessionId: "sftp-shared-2" }),
  ]);

  assert.equal(first.sftpId, "sftp-shared-1");
  assert.equal(second.sftpId, "sftp-shared-2");
  assert.equal(MockSftpClient.instances.length, 1);
  assert.equal(sftpClients.size, 2);
});

test("sequential SFTP opens without a terminal authenticate only once", async (t) => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const { bridge, MockSftpClient } = loadSftpBridgeWithAuthRetryMocks(t, { alwaysSucceed: true });
  const sftpClients = new Map();
  bridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
  const options = {
    hostname: "no-terminal.example",
    hostId: "host-no-terminal",
    port: 22,
    username: "root",
    authMethod: "password",
    password: "saved-login-password",
    useSshAgent: false,
    verifyHostKeys: false,
    fileProtocol: "sftp",
  };

  const first = await bridge.openSftp(
    { sender: makeSender() },
    { ...options, sessionId: "sftp-no-terminal-1" },
  );
  await bridge.closeSftp(null, { sftpId: first.sftpId });
  assert.equal(sftpClients.size, 0);
  assert.equal(getTransportStats().idle, 1);

  const second = await bridge.openSftp(
    { sender: makeSender() },
    { ...options, sessionId: "sftp-no-terminal-2" },
  );
  assert.equal(second.sftpId, "sftp-no-terminal-2");
  assert.equal(MockSftpClient.instances.length, 1, "the second open must not repeat SSH authentication");
  assert.equal(sftpClients.size, 1);
});

test("explicitly dedicated SFTP opens stay outside shared dial coordination", async (t) => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const { bridge, MockSftpClient } = loadSftpBridgeWithAuthRetryMocks(t, { alwaysSucceed: true });
  const sftpClients = new Map();
  bridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
  const options = {
    hostname: "192.168.9.138",
    hostId: "host-sftp-dedicated",
    port: 22,
    username: "root",
    authMethod: "password",
    password: "saved-login-password",
    useSshAgent: false,
    verifyHostKeys: false,
    fileProtocol: "sftp",
    reuseTransport: false,
  };

  await Promise.all([
    bridge.openSftp({ sender: makeSender() }, { ...options, sessionId: "sftp-dedicated-1" }),
    bridge.openSftp({ sender: makeSender() }, { ...options, sessionId: "sftp-dedicated-2" }),
  ]);

  assert.equal(MockSftpClient.instances.length, 2);
  assert.deepEqual(getTransportStats(), {
    transports: 0,
    pendingDials: 0,
    live: 0,
    idle: 0,
    leases: 0,
    defaultIdleTtlMs: 0,
  });

  await bridge.openSftp(
    { sender: makeSender() },
    { ...options, reuseTransport: true, sessionId: "sftp-shareable-after-dedicated" },
  );
  assert.equal(
    MockSftpClient.instances.length,
    3,
    "a later shareable open must dial instead of borrowing a dedicated connection",
  );
});

test("early SFTP preparation failure releases the coordinated dial", async (t) => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const { bridge } = loadSftpBridgeWithAuthRetryMocks(t, {
    alwaysSucceed: true,
    defaultKeysError: new Error("identity discovery failed"),
  });
  bridge.init({ sftpClients: new Map(), sessions: new Map(), electronModule: {} });
  const options = {
    hostname: "early-failure.example",
    hostId: "host-early-failure",
    username: "root",
    authMethod: "password",
    password: "secret",
    useSshAgent: false,
  };

  await assert.rejects(
    bridge.openSftp({ sender: makeSender() }, options),
    /identity discovery failed/,
  );
  assert.equal(getTransportStats().pendingDials, 0);

  const retry = beginTransportDial(options, { kind: "channel" });
  assert.equal(retry.role, "leader", "the failed opener must not leave a permanent join slot");
  failTransportDial(retry, new Error("test cleanup"));
});

test("forced SFTP subsystem rejection closes the authenticated client without retaining pool state", async (t) => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const { bridge, MockSftpClient } = loadSftpBridgeWithAuthRetryMocks(t, {
    alwaysSucceed: true,
    sftpError: new Error("SFTP subsystem rejected"),
  });
  const sftpClients = new Map();
  bridge.init({ sftpClients, sessions: new Map(), electronModule: {} });

  await assert.rejects(
    bridge.openSftp(
      { sender: makeSender() },
      {
        sessionId: "sftp-subsystem-rejected",
        hostname: "no-sftp.example",
        hostId: "host-no-sftp",
        username: "root",
        authMethod: "password",
        password: "secret",
        useSshAgent: false,
        verifyHostKeys: false,
        fileProtocol: "sftp",
      },
    ),
    /SFTP subsystem rejected/,
  );

  assert.equal(MockSftpClient.instances.length, 1);
  assert.equal(MockSftpClient.instances[0].client.ended, true);
  assert.equal(MockSftpClient.instances[0].client.destroyed, true);
  assert.equal(sftpClients.size, 0);
  assert.deepEqual(getTransportStats(), {
    transports: 0,
    pendingDials: 0,
    live: 0,
    idle: 0,
    leases: 0,
    defaultIdleTtlMs: 0,
  });
});

test("concurrent SFTP waiter survives the leader's recoverable auth retry", async (t) => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const { bridge, MockSftpClient } = loadSftpBridgeWithAuthRetryMocks(t);
  const sftpClients = new Map();
  bridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
  const options = {
    hostname: "retry-shared.example",
    hostId: "host-retry-shared",
    port: 22,
    username: "root",
    authMethod: "password",
    password: "saved-login-password",
    useSshAgent: false,
    verifyHostKeys: false,
    fileProtocol: "sftp",
  };

  const [leader, waiter] = await Promise.all([
    bridge.openSftp({ sender: makeSender() }, { ...options, sessionId: "sftp-retry-leader" }),
    bridge.openSftp({ sender: makeSender() }, { ...options, sessionId: "sftp-retry-waiter" }),
  ]);

  assert.equal(leader.sftpId, "sftp-retry-leader");
  assert.equal(waiter.sftpId, "sftp-retry-waiter");
  assert.equal(MockSftpClient.instances.length, 2, "only the leader's initial and retry dials are physical");
  assert.equal(sftpClients.size, 2);
  assert.equal(getTransportStats().pendingDials, 0);
});

test("openSftp retries keyboard-interactive first when password rejection removes KI", async (t) => {
  const { bridge, MockSftpClient } = loadSftpBridgeWithAuthRetryMocks(t);
  const sftpClients = new Map();
  bridge.init({ sftpClients, sessions: new Map(), electronModule: {} });

  const result = await bridge.openSftp(
    { sender: makeSender() },
    {
      sessionId: "sftp-edr-mfa",
      hostname: "192.168.9.138",
      port: 22,
      username: "root",
      authMethod: "password",
      password: "saved-login-password",
      sshTcpConnectTimeoutMs: 45_000,
      sshAuthReadyTimeoutMs: 300_000,
    },
  );

  assert.equal(result.sftpId, "sftp-edr-mfa");
  assert.equal(MockSftpClient.instances.length, 2);
  assert.deepEqual(MockSftpClient.instances[0].authMethodsOffered, [
    "none",
    "password",
    false,
  ]);
  assert.deepEqual(MockSftpClient.instances[1].authMethodsOffered, [
    "none",
    "keyboard-interactive",
  ]);
  assert.equal(sftpClients.has("sftp-edr-mfa"), true);
});

test("openSftp retries keyboard-interactive after dynamic auth password rejection removes KI", async (t) => {
  const { bridge, MockSftpClient } = loadSftpBridgeWithAuthRetryMocks(t, {
    dynamicAuth: true,
    defaultKeys: [{
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nmock-default-key\n-----END OPENSSH PRIVATE KEY-----",
      keyPath: "id_ed25519",
      keyName: "id_ed25519",
    }],
  });
  const sftpClients = new Map();
  bridge.init({ sftpClients, sessions: new Map(), electronModule: {} });

  const result = await bridge.openSftp(
    { sender: makeSender() },
    {
      sessionId: "sftp-edr-mfa-auto",
      hostname: "192.168.9.138",
      port: 22,
      username: "root",
      authMethod: "auto",
      password: "saved-login-password",
      sshTcpConnectTimeoutMs: 45_000,
      sshAuthReadyTimeoutMs: 300_000,
    },
  );

  assert.equal(result.sftpId, "sftp-edr-mfa-auto");
  assert.equal(MockSftpClient.instances.length, 2);
  assert.deepEqual(
    MockSftpClient.instances[0].authMethodsOffered.map((method) => (
      method?.type === "publickey" ? "publickey" : method?.type || method
    )),
    ["none", "publickey", "password", false],
  );
  assert.deepEqual(
    MockSftpClient.instances[1].authMethodsOffered.map((method) => (
      method?.type === "publickey" ? "publickey" : method?.type || method
    )),
    ["none", "publickey", "keyboard-interactive"],
  );
  assert.equal(sftpClients.has("sftp-edr-mfa-auto"), true);
});

test("single-channel SFTP does not join an in-flight terminal dial", async (t) => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const { bridge, MockSftpClient } = loadSftpBridgeWithAuthRetryMocks(t, { alwaysSucceed: true });
  const sftpClients = new Map();
  bridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
  const options = {
    hostname: "bastion.example",
    hostId: "host-bastion",
    port: 22,
    username: "root",
    authMethod: "password",
    password: "saved-login-password",
    useSshAgent: false,
    verifyHostKeys: false,
    fileProtocol: "sftp",
    singleChannelSsh: true,
  };
  const coordination = beginTransportDial(buildConnectionReuseEndpoint(options), { kind: "shell" });
  assert.equal(coordination.role, "leader");

  const opened = await bridge.openSftp(
    { sender: makeSender() },
    { ...options, sessionId: "sftp-during-terminal" },
  );

  assert.equal(opened.sftpId, "sftp-during-terminal");
  assert.equal(MockSftpClient.instances.length, 1);
  assert.equal(coordination._record.settled, false);
  assert.equal(failTransportDial(coordination, new Error("terminal cancelled")), true);
  assert.notEqual(MockSftpClient.instances[0].client.ended, true);
  assert.equal(sftpClients.has("sftp-during-terminal"), true);
});
