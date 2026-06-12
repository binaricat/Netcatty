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
      const rawKey = MockSSHClient.hostKeysByHost.get(opts.host) || MockSSHClient.defaultHostKey;
      setImmediate(() => {
        const accept = () => {
          this.emit("connect");
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
          handleResponse(null, {
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
      label: "Bastion",
    }],
    "target.example.com",
    22,
    "session-1",
  );

  assert.equal(MockSSHClient.instances.length, 1);
  const connectOpts = MockSSHClient.instances[0].connectOpts;
  assert.equal(typeof connectOpts.hostVerifier, "function");
  assert.equal(MockSSHClient.instances[0].hostVerifierCalls, 1);
  assert.deepEqual(
    sender.sent.filter((message) => message.channel === "netcatty:host-key:verify"),
    [],
  );
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
