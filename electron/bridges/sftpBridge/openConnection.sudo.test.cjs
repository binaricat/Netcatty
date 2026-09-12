const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

function makeExecStream() {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.write = () => {};
  stream.close = () => {};
  stream.end = () => {};
  stream.destroy = () => {};
  return stream;
}

function loadSftpBridgeWithFailingFreshSudo(t) {
  const bridgePath = require.resolve("../sftpBridge.cjs");
  const openConnectionPath = require.resolve("./openConnection.cjs");
  const authHelperPath = require.resolve("../sshAuthHelper.cjs");
  const realAuthHelper = require(authHelperPath);
  const originalLoad = Module._load;

  class MockSftpClient extends EventEmitter {
    constructor() {
      super();
      MockSftpClient.instances.push(this);
      this.sftp = null;
      this.client = new EventEmitter();
      this.client._sock = { setTimeout() {} };
      this.client.setMaxListeners = () => {};
      this.client.connect = () => {
        setImmediate(() => {
          this.client.emit("connect");
          this.client.emit("handshake");
          this.client.emit("ready");
        });
      };
      this.client.exec = (command, execOptions, callback) => {
        const done = typeof execOptions === "function" ? execOptions : callback;
        this.execCommands.push(command);
        const stream = makeExecStream();
        done(null, stream);
        setImmediate(() => {
          if (command.startsWith("test -x ")) stream.emit("close", 1);
          else stream.emit("exit", 127);
        });
      };
      this.client.sftp = (callback) => {
        this.standardSftpCalls += 1;
        callback(null, new EventEmitter());
      };
      this.client.end = () => { this.sshEnded = true; };
      this.client.destroy = () => { this.sshDestroyed = true; };
      this.execCommands = [];
      this.standardSftpCalls = 0;
      this.sshEnded = false;
      this.sshDestroyed = false;
    }

    end() {
      this.highLevelEnded = true;
    }
  }
  MockSftpClient.instances = [];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "ssh2-sftp-client") return MockSftpClient;
    if (request === "./sshAuthHelper.cjs") {
      return {
        ...realAuthHelper,
        findAllDefaultPrivateKeys: async () => [],
        getAvailableAgentSocket: async () => null,
        prepareSystemSshAgentForAuth: async () => null,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[bridgePath];
  delete require.cache[openConnectionPath];
  const bridge = require("../sftpBridge.cjs");
  t.after(() => {
    delete require.cache[bridgePath];
    delete require.cache[openConnectionPath];
    Module._load = originalLoad;
  });
  return { bridge, MockSftpClient };
}

test("fresh sudo SFTP failure rejects without ordinary SFTP or SCP downgrade", async (t) => {
  const { bridge, MockSftpClient } = loadSftpBridgeWithFailingFreshSudo(t);
  const sftpClients = new Map();
  bridge.init({ sftpClients, sessions: new Map(), electronModule: {} });

  await assert.rejects(
    bridge.openSftp(
      { sender: { id: 1, isDestroyed: () => false, send: () => {} } },
      {
        sessionId: "fresh-sudo-failure",
        hostname: "target.example",
        port: 22,
        username: "alice",
        password: "secret",
        authMethod: "password",
        useSshAgent: false,
        verifyHostKeys: false,
        fileProtocol: "auto",
        sudo: true,
      },
    ),
    /SFTP sudo failed with exit code 127/,
  );

  const client = MockSftpClient.instances[0];
  assert.ok(client.execCommands.some((command) => command.startsWith("sudo -S")));
  assert.equal(client.standardSftpCalls, 0);
  assert.equal(sftpClients.size, 0);
  assert.equal(client.sshEnded, true);
  assert.equal(client.sshDestroyed, true);
});
