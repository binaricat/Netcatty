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
    }

    connect(opts) {
      this.connectOpts = opts;
      setImmediate(() => {
        this.emit("connect");
        this.emit("handshake");
        this.emit("ready");
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

test("jump-host chain connections verify hop host keys against known hosts", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithMockedSsh2(t);
  const sender = makeSender();
  const rawKey = makeRawPublicKey("ssh-ed25519");
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

  const accepted = await new Promise((resolve) => {
    connectOpts.hostVerifier(rawKey, resolve);
  });

  assert.equal(accepted, true);
  assert.deepEqual(
    sender.sent.filter((message) => message.channel === "netcatty:host-key:verify"),
    [],
  );
});
