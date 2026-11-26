const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

function makeRawPublicKey(keyType, body = "trusted jump host key") {
  const type = Buffer.from(keyType);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(type.length, 0);
  return Buffer.concat([length, type, Buffer.from(body)]);
}

function loadBridgeWithMockedSsh2(t) {
  const bridgePath = require.resolve("./sshBridge.cjs");
  const authHelperPath = require.resolve("./sshAuthHelper.cjs");
  const originalLoad = Module._load;

  class MockSSHClient extends EventEmitter {
    constructor() {
      super();
      MockSSHClient.instances.push(this);
      this.ended = false;
      this.connectOpts = null;
      this.hostVerifierCalls = 0;
    }

    connect(opts) {
      this.connectOpts = opts;
      if (MockSSHClient.connectionErrorsByHost.has(opts.host)) {
        setImmediate(() => this.emit("error", MockSSHClient.connectionErrorsByHost.get(opts.host)));
        return;
      }
      if (MockSSHClient.timeoutHosts.has(opts.host)) {
        setImmediate(() => this.emit("timeout"));
        return;
      }
      const rawKey = MockSSHClient.hostKeysByHost.get(opts.host) || MockSSHClient.defaultHostKey;
      setImmediate(() => {
        const accept = () => {
          this.emit("connect");
          if (MockSSHClient.closeBeforeReadyHosts.has(opts.host)) {
            this.emit("close");
            return;
          }
          this.emit("handshake");
          this.emit("ready");
        };
        if (typeof opts.hostVerifier !== "function") {
          accept();
          return;
        }
        this.hostVerifierCalls += 1;
        opts.hostVerifier(rawKey, (accepted) => {
          if (accepted) {
            accept();
            return;
          }
          const err = new Error(`Host key rejected for ${opts.host || "tunneled host"}`);
          err.level = "client-socket";
          this.emit("error", err);
        });
      });
    }

    forwardOut(_srcIP, _srcPort, _dstHost, _dstPort, cb) {
      if (MockSSHClient.stalledForwardTargets.has(_dstHost)) {
        return;
      }
      const stream = new EventEmitter();
      stream.destroy = () => {};
      setImmediate(() => cb(null, stream));
    }

    end() {
      this.ended = true;
    }

    destroy() {
      this.ended = true;
    }
  }
  MockSSHClient.instances = [];
  MockSSHClient.hostKeysByHost = new Map();
  MockSSHClient.timeoutHosts = new Set();
  MockSSHClient.stalledForwardTargets = new Set();
  MockSSHClient.connectionErrorsByHost = new Map();
  MockSSHClient.closeBeforeReadyHosts = new Set();
  MockSSHClient.defaultHostKey = makeRawPublicKey("ssh-ed25519", "default untrusted key");

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "ssh2") {
      return {
        Client: MockSSHClient,
        utils: { parseKey: () => new Error("no key") },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[bridgePath];
  delete require.cache[authHelperPath];
  const bridge = require("./sshBridge.cjs");

  t.after(() => {
    delete require.cache[bridgePath];
    delete require.cache[authHelperPath];
    Module._load = originalLoad;
  });

  return { bridge, MockSSHClient };
}

function makeSender({ rejectHostKeyPrompts = false } = {}) {
  return {
    id: 1,
    isDestroyed: () => false,
    sent: [],
    send(channel, payload) {
      this.sent.push({ channel, payload });
      if (rejectHostKeyPrompts && channel === "netcatty:host-key:verify") {
        const { handleResponse } = require("./hostKeyVerifier.cjs");
        queueMicrotask(() => {
          handleResponse({ sender: { id: this.id } }, {
            requestId: payload.requestId,
            accept: false,
          });
        });
      }
    },
  };
}

test("jump-host chain connections verify hop host keys against known hosts", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithMockedSsh2(t);
  const sender = makeSender();
  const rawKey = makeRawPublicKey("ssh-ed25519");
  MockSSHClient.hostKeysByHost.set("bastion.example.com", rawKey);
  const fingerprint = crypto.createHash("sha256")
    .update(rawKey)
    .digest("base64")
    .replace(/=+$/g, "");

  await bridge.connectThroughChain(
    { sender },
    {
      knownHosts: [{
        id: "kh-jump",
        hostname: "bastion.example.com",
        port: 22,
        keyType: "ssh-ed25519",
        publicKey: `ssh-ed25519 ${rawKey.toString("base64")}`,
        fingerprint,
        discoveredAt: 1,
      }],
      _defaultKeys: [],
    },
    [{
      hostname: "bastion.example.com",
      port: 22,
      username: "alice",
      password: "secret",
      requiresMfa: true,
      label: "Bastion",
      sshTcpConnectTimeoutMs: 45_000,
      sshAuthReadyTimeoutMs: 300_000,
    }],
    "target.example.com",
    22,
    "session-1",
  );

  const progress = sender.sent.filter((message) => message.channel === "netcatty:chain:progress");
  assert.ok(progress.length > 0);
  for (const { payload } of progress) {
    assert.equal(payload.label, "Bastion");
    assert.equal(payload.hostname, "bastion.example.com");
    assert.equal(payload.port, 22);
    assert.equal(payload.hop, 1);
    assert.equal(payload.total, 2);
  }

  assert.equal(MockSSHClient.instances.length, 1);
  const connectOpts = MockSSHClient.instances[0].connectOpts;
  assert.equal(connectOpts.timeout, 45_000);
  assert.equal(connectOpts.readyTimeout, 0);
  assert.equal(typeof connectOpts.hostVerifier, "function");
  assert.equal(MockSSHClient.instances[0].hostVerifierCalls, 1);
  const offered = [];
  connectOpts.authHandler(null, null, (method) => offered.push(method));
  connectOpts.authHandler(
    ["password", "keyboard-interactive"],
    false,
    (method) => offered.push(method && typeof method === "object" ? method.type : method),
  );
  assert.deepEqual(offered, ["none", "keyboard-interactive"]);
  assert.ok(sender.sent.some((message) => (
    message.channel === "netcatty:chain:progress"
    && message.payload.sessionId === "session-1"
    && message.payload.status === "tcp-connected"
  )));
  assert.deepEqual(
    sender.sent.filter((message) => message.channel === "netcatty:host-key:verify"),
    [],
  );
});

test("jump-host chain destroys timed-out hop connections", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithMockedSsh2(t);
  const sender = makeSender();
  MockSSHClient.timeoutHosts.add("slow-bastion.example.com");

  await assert.rejects(
    bridge.connectThroughChain(
      { sender },
      {
        knownHosts: [],
        _defaultKeys: [],
      },
      [{
        hostname: "slow-bastion.example.com",
        port: 22,
        username: "alice",
        password: "secret",
        label: "Slow Bastion",
      }],
      "target.example.com",
      22,
      "session-1",
    ),
    /Connection timeout to Slow Bastion/,
  );

  assert.equal(MockSSHClient.instances.length, 1);
  assert.equal(MockSSHClient.instances[0].connectOpts.timeout, 20_000);
  assert.equal(MockSSHClient.instances[0].ended, true);
});

test("jump-host chain rejects when a hop closes during authentication", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithMockedSsh2(t);
  const sender = makeSender();
  MockSSHClient.hostKeysByHost.set(
    "closing-bastion.example.com",
    makeRawPublicKey("ssh-ed25519", "closing bastion key"),
  );
  MockSSHClient.closeBeforeReadyHosts.add("closing-bastion.example.com");

  await assert.rejects(
    bridge.connectThroughChain(
      { sender },
      { knownHosts: [], verifyHostKeys: false, _defaultKeys: [] },
      [{
        hostname: "closing-bastion.example.com",
        port: 22,
        username: "alice",
        password: "secret",
        label: "Closing Bastion",
      }],
      "target.example.com",
      22,
      "session-close",
    ),
    /Connection to Closing Bastion closed before authentication completed/,
  );

  const errors = sender.sent.filter((message) => (
    message.channel === "netcatty:chain:progress"
    && message.payload.status === "error"
  ));
  assert.equal(errors.length, 1);
});

test("jump-host chain does not classify host-name auth substrings as auth failures", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithMockedSsh2(t);
  const sender = makeSender();
  const err = new Error("Connection reset by auth-bastion.example.com");
  err.level = "client-socket";
  MockSSHClient.connectionErrorsByHost.set("auth-bastion.example.com", err);

  await assert.rejects(
    bridge.connectThroughChain(
      { sender },
      { knownHosts: [], _defaultKeys: [] },
      [{
        hostname: "auth-bastion.example.com",
        port: 22,
        username: "alice",
        password: "secret",
        label: "Auth Bastion",
      }],
      "target.example.com",
      22,
      "session-1",
    ),
    (error) => {
      assert.equal(error.isJumpHostAuthError, undefined);
      assert.equal(error.message, "Connection reset by auth-bastion.example.com");
      return true;
    },
  );
});

test("jump-host chain times out stalled forwarding to the next target", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithMockedSsh2(t);
  const sender = makeSender();
  MockSSHClient.stalledForwardTargets.add("target.example.com");

  await assert.rejects(
    bridge.connectThroughChain(
      { sender },
      {
        knownHosts: [],
        _defaultKeys: [],
        _forwardTimeoutMs: 20,
        verifyHostKeys: false,
      },
      [{
        hostname: "bastion.example.com",
        port: 22,
        username: "alice",
        password: "secret",
        label: "Bastion",
      }],
      "target.example.com",
      22,
      "session-1",
    ),
    /Connection timeout from Bastion to target\.example\.com:22/,
  );

  assert.equal(MockSSHClient.instances.length, 1);
  assert.equal(MockSSHClient.instances[0].ended, true);
  assert.ok(sender.sent.some((message) => (
    message.channel === "netcatty:chain:progress"
    && message.payload.sessionId === "session-1"
    && message.payload.status === "forwarding"
  )));
});

test("jump-host chain connections stop when hop host keys are rejected", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithMockedSsh2(t);
  const sender = makeSender({ rejectHostKeyPrompts: true });
  MockSSHClient.hostKeysByHost.set(
    "bastion.example.com",
    makeRawPublicKey("ssh-ed25519", "unknown jump host key"),
  );

  await assert.rejects(
    bridge.connectThroughChain(
      { sender },
      {
        knownHosts: [],
        _defaultKeys: [],
      },
      [{
        hostname: "bastion.example.com",
        port: 22,
        username: "alice",
        password: "secret",
        label: "Bastion",
      }],
      "target.example.com",
      22,
      "session-1",
    ),
    /Host key rejected/,
  );

  assert.equal(MockSSHClient.instances.length, 1);
  assert.equal(MockSSHClient.instances[0].hostVerifierCalls, 1);
  assert.equal(
    sender.sent.filter((message) => message.channel === "netcatty:host-key:verify").length,
    1,
  );
});
