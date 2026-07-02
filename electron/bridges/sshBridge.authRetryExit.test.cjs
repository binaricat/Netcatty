const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

function makeSender(events = null) {
  return {
    id: 1,
    isDestroyed: () => false,
    sent: [],
    send(channel, payload) {
      events?.push(`send:${channel}`);
      this.sent.push({ channel, payload });
    },
  };
}

function makeIpcMain() {
  return {
    handlers: new Map(),
    handle(channel, handler) {
      this.handlers.set(channel, handler);
    },
    on() {},
  };
}

function createShellStream() {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.write = () => true;
  stream.end = () => {};
  stream.destroy = () => {};
  stream.setWindow = () => {};
  return stream;
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadBridgeWithAuthRetryMocks(t, options = {}) {
  const bridgePath = require.resolve("./sshBridge.cjs");
  const startSessionPath = require.resolve("./sshBridge/startSession.cjs");
  const authHelperPath = require.resolve("./sshAuthHelper.cjs");
  const originalLoad = Module._load;
  const originalAuthHelper = require(authHelperPath);
  const connectEvents = options.connectEvents || ["auth-error", "ready"];

  class MockSSHClient extends EventEmitter {
    constructor() {
      super();
      MockSSHClient.instances.push(this);
      this._remoteVer = "OpenSSH_test";
      this._sock = {
        setTimeout() {},
        setNoDelay() {},
      };
    }

    connect(opts) {
      this.connectOpts = opts;
      const eventName = connectEvents[MockSSHClient.instances.length - 1] || "auth-error";
      setImmediate(() => {
        if (eventName === "auth-error") {
          const err = new Error("All configured authentication methods failed");
          err.level = "client-authentication";
          this.emit("error", err);
          return;
        }
        if (eventName === "ready") {
          this.emit("connect");
          this.emit("handshake");
          this.emit("ready");
        }
      });
    }

    shell(_pty, _opts, cb) {
      setImmediate(() => cb(null, createShellStream()));
    }

    end() {
      this.ended = true;
    }

    destroy() {
      this.destroyed = true;
    }
  }
  MockSSHClient.instances = [];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "ssh2") {
      return {
        Client: MockSSHClient,
        utils: { parseKey: () => new Error("no key parse needed") },
      };
    }
    if (request === "./sshAuthHelper.cjs" || request.endsWith("/sshAuthHelper.cjs")) {
      return {
        ...originalAuthHelper,
        findAllDefaultPrivateKeys: async (args = {}) => {
          if (args.includeEncrypted) {
            return options.encryptedKeys || [];
          }
          return [];
        },
        requestPassphrasesForEncryptedKeys: async () => (
          options.onPassphraseRequest?.(),
          options.passphraseResult || { cancelled: false, keys: [] }
        ),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[bridgePath];
  delete require.cache[startSessionPath];
  const bridge = require("./sshBridge.cjs");

  t.after(() => {
    delete require.cache[bridgePath];
    delete require.cache[startSessionPath];
    Module._load = originalLoad;
  });

  return { bridge, MockSSHClient };
}

test("retryable encrypted-key auth failure does not emit exit before retry success", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error", "ready"],
    encryptedKeys: [
      {
        keyPath: "/Users/test/.ssh/id_ed25519",
        keyName: "id_ed25519",
        isEncrypted: true,
      },
    ],
    passphraseResult: {
      cancelled: false,
      keys: [
        {
          keyPath: "/Users/test/.ssh/id_ed25519",
          keyName: "id_ed25519",
          privateKey: "UNLOCKED_PRIVATE_KEY",
          passphrase: "secret",
        },
      ],
    },
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender();

  const result = await start(
    { sender },
    {
      sessionId: "retry-session",
      hostname: "example.test",
      username: "alice",
      port: 22,
      knownHosts: [],
    },
  );

  assert.deepEqual(result, { sessionId: "retry-session" });
  assert.equal(MockSSHClient.instances.length, 2);
  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:exit"
      && message.payload.sessionId === "retry-session"
    )),
    false,
  );
  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:auth:failed"
      && message.payload.sessionId === "retry-session"
    )),
    true,
  );
});

test("stale close from failed first attempt does not close successful retry session", async (t) => {
  const sessions = new Map();
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error", "ready"],
    encryptedKeys: [
      {
        keyPath: "/Users/test/.ssh/id_ed25519",
        keyName: "id_ed25519",
        isEncrypted: true,
      },
    ],
    passphraseResult: {
      cancelled: false,
      keys: [
        {
          keyPath: "/Users/test/.ssh/id_ed25519",
          keyName: "id_ed25519",
          privateKey: "UNLOCKED_PRIVATE_KEY",
          passphrase: "secret",
        },
      ],
    },
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions, electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender();

  await start(
    { sender },
    {
      sessionId: "stale-close-session",
      hostname: "example.test",
      username: "alice",
      port: 22,
      knownHosts: [],
    },
  );

  assert.equal(MockSSHClient.instances.length, 2);
  assert.equal(sessions.has("stale-close-session"), true);

  MockSSHClient.instances[0].emit("close");
  await nextTick();

  assert.equal(sessions.has("stale-close-session"), true);
  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:exit"
      && message.payload.sessionId === "stale-close-session"
    )),
    false,
  );
});

test("non-retryable auth failure still emits one exit", async (t) => {
  const { bridge } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error"],
    encryptedKeys: [],
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender();

  await assert.rejects(
    () => start(
      { sender },
      {
        sessionId: "failed-session",
        hostname: "example.test",
        username: "alice",
        port: 22,
        knownHosts: [],
      },
    ),
    /All configured authentication methods failed/,
  );

  const exits = sender.sent.filter((message) => (
    message.channel === "netcatty:exit"
    && message.payload.sessionId === "failed-session"
  ));
  assert.equal(exits.length, 1);
  assert.equal(exits[0].payload.reason, "error");
});

test("cancelled encrypted-key retry emits one final exit", async (t) => {
  const events = [];
  const { bridge } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error"],
    encryptedKeys: [
      {
        keyPath: "/Users/test/.ssh/id_ed25519",
        keyName: "id_ed25519",
        isEncrypted: true,
      },
    ],
    passphraseResult: {
      cancelled: true,
      keys: [],
    },
    onPassphraseRequest: () => events.push("passphrase-request"),
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender(events);

  await assert.rejects(
    () => start(
      { sender },
      {
        sessionId: "cancelled-session",
        hostname: "example.test",
        username: "alice",
        port: 22,
        knownHosts: [],
      },
    ),
    /All configured authentication methods failed/,
  );

  const exits = sender.sent.filter((message) => (
    message.channel === "netcatty:exit"
    && message.payload.sessionId === "cancelled-session"
  ));
  assert.equal(exits.length, 1);
  assert.equal(exits[0].payload.reason, "error");
  assert.equal(events.includes("passphrase-request"), true);
  assert.equal(
    events.indexOf("send:netcatty:exit") > events.indexOf("passphrase-request"),
    true,
  );
});
