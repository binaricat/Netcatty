const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

function makeRawPublicKey(keyType, body) {
  const type = Buffer.from(keyType);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(type.length, 0);
  return Buffer.concat([length, type, Buffer.from(body)]);
}

function makeKnownHost(id, hostname, rawKey) {
  return {
    id,
    hostname,
    port: 22,
    keyType: "ssh-ed25519",
    publicKey: `ssh-ed25519 ${rawKey.toString("base64")}`,
    fingerprint: crypto.createHash("sha256")
      .update(rawKey)
      .digest("base64")
      .replace(/=+$/g, ""),
    discoveredAt: 1,
  };
}

function loadSftpBridgeWithMockedClients(t) {
  const bridgePath = require.resolve("./sftpBridge.cjs");
  const originalLoad = Module._load;

  class MockJumpClient extends EventEmitter {
    constructor() {
      super();
      MockJumpClient.instances.push(this);
      this.connectOpts = null;
      this.ended = false;
    }

    connect(opts) {
      this.connectOpts = opts;
      setImmediate(() => {
        this.emit("handshake");
        this.emit("ready");
      });
    }

    forwardOut(_srcIP, _srcPort, _dstHost, _dstPort, cb) {
      const stream = new EventEmitter();
      stream.end = () => {};
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
  MockJumpClient.instances = [];

  class MockSftpClient extends EventEmitter {
    constructor() {
      super();
      MockSftpClient.instances.push(this);
      this.client = new EventEmitter();
      this.client.setMaxListeners = () => {};
      this.client.connectOpts = null;
      this.client.connect = (opts) => {
        this.client.connectOpts = opts;
        setImmediate(() => {
          this.client.emit("handshake");
          this.client.emit("ready");
        });
      };
      this.client.sftp = (cb) => {
        setImmediate(() => cb(null, new EventEmitter()));
      };
      this.client.end = () => {};
      this.client.destroy = () => {};
    }

    end() {}
  }
  MockSftpClient.instances = [];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "ssh2") {
      return {
        Client: MockJumpClient,
        utils: { parseKey: () => new Error("no key") },
      };
    }
    if (request === "ssh2-sftp-client") {
      return MockSftpClient;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[bridgePath];
  const bridge = require("./sftpBridge.cjs");

  t.after(() => {
    delete require.cache[bridgePath];
    Module._load = originalLoad;
  });

  return { bridge, MockJumpClient, MockSftpClient };
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

function verifyWith(verifier, rawKey) {
  return new Promise((resolve) => {
    verifier(rawKey, resolve);
  });
}

test("SFTP direct connections verify target host keys against known hosts", async (t) => {
  const { bridge, MockSftpClient } = loadSftpBridgeWithMockedClients(t);
  const sender = makeSender();
  const rawTargetKey = makeRawPublicKey("ssh-ed25519", "trusted sftp target key");

  bridge.init({ sftpClients: new Map(), sessions: new Map(), electronModule: {} });
  await bridge.openSftp(
    { sender },
    {
      sessionId: "sftp-direct-host-key",
      hostname: "target.example.com",
      port: 22,
      username: "alice",
      knownHosts: [makeKnownHost("kh-target", "target.example.com", rawTargetKey)],
    },
  );

  const connectOpts = MockSftpClient.instances[0].client.connectOpts;
  assert.equal(typeof connectOpts.hostVerifier, "function");
  assert.equal(await verifyWith(connectOpts.hostVerifier, rawTargetKey), true);
  assert.deepEqual(
    sender.sent.filter((message) => message.channel === "netcatty:host-key:verify"),
    [],
  );
});

test("SFTP jump-host chains verify hop and target host keys against known hosts", async (t) => {
  const { bridge, MockJumpClient, MockSftpClient } = loadSftpBridgeWithMockedClients(t);
  const sender = makeSender();
  const rawJumpKey = makeRawPublicKey("ssh-ed25519", "trusted sftp jump key");
  const rawTargetKey = makeRawPublicKey("ssh-ed25519", "trusted sftp target key");

  bridge.init({ sftpClients: new Map(), sessions: new Map(), electronModule: {} });
  await bridge.openSftp(
    { sender },
    {
      sessionId: "sftp-chain-host-key",
      hostname: "target.example.com",
      port: 22,
      username: "alice",
      knownHosts: [
        makeKnownHost("kh-jump", "bastion.example.com", rawJumpKey),
        makeKnownHost("kh-target", "target.example.com", rawTargetKey),
      ],
      jumpHosts: [{
        hostname: "bastion.example.com",
        port: 22,
        username: "jump",
        password: "secret",
        label: "Bastion",
      }],
    },
  );

  const jumpConnectOpts = MockJumpClient.instances[0].connectOpts;
  assert.equal(typeof jumpConnectOpts.hostVerifier, "function");
  assert.equal(await verifyWith(jumpConnectOpts.hostVerifier, rawJumpKey), true);

  const targetConnectOpts = MockSftpClient.instances[0].client.connectOpts;
  assert.equal(typeof targetConnectOpts.hostVerifier, "function");
  assert.equal(await verifyWith(targetConnectOpts.hostVerifier, rawTargetKey), true);
  assert.deepEqual(
    sender.sent.filter((message) => message.channel === "netcatty:host-key:verify"),
    [],
  );
});
