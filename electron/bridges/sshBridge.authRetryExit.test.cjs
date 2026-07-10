const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");

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

function makeReusableSourceSession(endpoint) {
  const conn = new EventEmitter();
  conn._sock = { destroyed: false };
  conn._remoteVer = "OpenSSH_test";
  conn.shell = () => { throw new Error("Not connected"); };
  conn.end = () => {};
  conn.destroy = () => {};
  const stream = createShellStream();
  return {
    conn,
    stream,
    chainConnections: [],
    connRef: { count: 1, conn, chainConnections: [] },
    webContentsId: 1,
    zmodemSentry: { cancel() {} },
    hostname: endpoint.hostname,
    username: endpoint.username,
    _reuseEndpoint: {
      hostname: endpoint.hostname,
      port: endpoint.port || 22,
      username: endpoint.username,
    },
  };
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
      const eventName = connectEvents[MockSSHClient.connectCount++] || "auth-error";
      setImmediate(() => {
        if (eventName === "auth-error") {
          const err = new Error("All configured authentication methods failed");
          err.level = "client-authentication";
          this.emit("error", err);
          return;
        }
        if (eventName === "socket-error") {
          const err = new Error("Connection reset by auth-bastion.example.com");
          err.level = "client-socket";
          this.emit("error", err);
          return;
        }
        if (eventName === "permission-denied-socket-error") {
          const err = new Error("Permission denied opening channel to auth-bastion.example.com");
          err.level = "client-socket";
          this.emit("error", err);
          return;
        }
        if (eventName === "too-many-auth") {
          const err = new Error("Too many authentication failures");
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

    forwardOut(_srcHost, _srcPort, _dstHost, _dstPort, cb) {
      setImmediate(() => cb(null, new EventEmitter()));
    }

    shell(_pty, shellOptions, cb) {
      this.shellOptions = shellOptions;
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
  MockSSHClient.connectCount = 0;

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

test("fresh SSH sessions preserve the server locale for the default UTF-8 charset", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["ready"],
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);

  const result = await ipcMain.handlers.get("netcatty:start")(
    { sender: makeSender() },
    {
      sessionId: "default-locale-session",
      hostname: "example.test",
      username: "alice",
      port: 22,
      charset: "UTF-8",
      env: { TERM: "xterm-256color" },
      knownHosts: [],
    },
  );

  assert.deepEqual(result, { sessionId: "default-locale-session" });
  assert.deepEqual(MockSSHClient.instances[0].shellOptions.env, {
    COLORTERM: "truecolor",
    TERM: "xterm-256color",
  });
});

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

test("stale error from failed first attempt does not mark successful retry session failed", async (t) => {
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
      sessionId: "stale-error-session",
      hostname: "example.test",
      username: "alice",
      port: 22,
      knownHosts: [],
    },
  );

  assert.equal(MockSSHClient.instances.length, 2);
  assert.equal(sessions.has("stale-error-session"), true);

  const err = new Error("late error from failed first attempt");
  err.level = "client-socket";
  MockSSHClient.instances[0].emit("error", err);
  await nextTick();

  assert.equal(sessions.get("stale-error-session")._transportError, undefined);
});

test("jump-host auth failure does not emit exit before encrypted-key retry success", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error", "ready", "ready"],
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
      sessionId: "jump-retry-session",
      hostname: "target.example",
      username: "alice",
      port: 22,
      knownHosts: [],
      jumpHosts: [{ hostname: "jump.example", username: "alice", port: 22 }],
    },
  );

  assert.deepEqual(result, { sessionId: "jump-retry-session" });
  assert.equal(MockSSHClient.connectCount, 3);
  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:exit"
      && message.payload.sessionId === "jump-retry-session"
    )),
    false,
  );
});

test("jump-host auth failure is attributed to the failing jump host", async (t) => {
  const { bridge } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error"],
    encryptedKeys: [],
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");

  await assert.rejects(
    start(
      { sender: makeSender() },
      {
        sessionId: "jump-auth-failed-session",
        hostname: "target.example",
        username: "target-user",
        port: 22,
        knownHosts: [],
        jumpHosts: [{
          hostname: "jump.example",
          username: "jump-user",
          port: 22,
          label: "Bastion",
        }],
      },
    ),
    (err) => {
      assert.equal(err.isJumpHostAuthError, true);
      assert.equal(err.jumpHostLabel, "Bastion");
      assert.match(err.message, /Jump host authentication failed for "Bastion"/);
      return true;
    },
  );
});

test("jump-host too-many-auth failures are attributed to the failing jump host", async (t) => {
  const { bridge } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["too-many-auth"],
    encryptedKeys: [],
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");

  await assert.rejects(
    start(
      { sender: makeSender() },
      {
        sessionId: "jump-too-many-auth-session",
        hostname: "target.example",
        username: "target-user",
        port: 22,
        knownHosts: [],
        jumpHosts: [{
          hostname: "jump.example",
          username: "jump-user",
          port: 22,
          label: "Bastion",
        }],
      },
    ),
    (err) => {
      assert.equal(err.isJumpHostAuthError, true);
      assert.equal(err.jumpHostLabel, "Bastion");
      assert.match(err.message, /Jump host authentication failed for "Bastion": Too many authentication failures/);
      return true;
    },
  );
});

test("jump-host auth attribution survives encrypted-key retry failure", async (t) => {
  const { bridge } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error", "auth-error"],
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

  await assert.rejects(
    start(
      { sender: makeSender() },
      {
        sessionId: "jump-auth-retry-failed-session",
        hostname: "target.example",
        username: "target-user",
        port: 22,
        knownHosts: [],
        jumpHosts: [{
          hostname: "jump.example",
          username: "jump-user",
          port: 22,
          label: "Bastion",
        }],
      },
    ),
    (err) => {
      assert.equal(err.isJumpHostAuthError, true);
      assert.equal(err.jumpHostLabel, "Bastion");
      assert.match(err.message, /Jump host authentication failed for "Bastion"/);
      return true;
    },
  );
});

test("jump-host socket errors with auth in hostname are not wrapped as auth failures", async (t) => {
  let passphraseRequests = 0;
  const { bridge } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["socket-error"],
    encryptedKeys: [
      {
        keyPath: "/Users/test/.ssh/id_ed25519",
        keyName: "id_ed25519",
        isEncrypted: true,
      },
    ],
    onPassphraseRequest: () => {
      passphraseRequests += 1;
    },
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender();

  await assert.rejects(
    start(
      { sender },
      {
        sessionId: "jump-socket-error-session",
        hostname: "target.example",
        username: "target-user",
        port: 22,
        knownHosts: [],
        jumpHosts: [{
          hostname: "auth-bastion.example.com",
          username: "jump-user",
          port: 22,
          label: "Auth Bastion",
        }],
      },
    ),
    (err) => {
      assert.equal(err.isAuthError, undefined);
      assert.equal(err.isJumpHostAuthError, undefined);
      assert.equal(err.level, "client-socket");
      assert.equal(err.message, "Connection reset by auth-bastion.example.com");
      return true;
    },
  );
  assert.equal(passphraseRequests, 0);
  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:exit"
      && message.payload.sessionId === "jump-socket-error-session"
      && message.payload.error === "Connection reset by auth-bastion.example.com"
    )),
    true,
  );
});

test("jump-host permission-denied socket errors are not wrapped as auth failures", async (t) => {
  let passphraseRequests = 0;
  const { bridge } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["permission-denied-socket-error"],
    encryptedKeys: [
      {
        keyPath: "/Users/test/.ssh/id_ed25519",
        keyName: "id_ed25519",
        isEncrypted: true,
      },
    ],
    onPassphraseRequest: () => {
      passphraseRequests += 1;
    },
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender();

  await assert.rejects(
    start(
      { sender },
      {
        sessionId: "jump-permission-denied-socket-error-session",
        hostname: "target.example",
        username: "target-user",
        port: 22,
        knownHosts: [],
        jumpHosts: [{
          hostname: "auth-bastion.example.com",
          username: "jump-user",
          port: 22,
          label: "Auth Bastion",
        }],
      },
    ),
    (err) => {
      assert.equal(err.isAuthError, undefined);
      assert.equal(err.isJumpHostAuthError, undefined);
      assert.equal(err.level, "client-socket");
      assert.equal(err.message, "Permission denied opening channel to auth-bastion.example.com");
      return true;
    },
  );
  assert.equal(passphraseRequests, 0);
  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:exit"
      && message.payload.sessionId === "jump-permission-denied-socket-error-session"
      && message.payload.error === "Permission denied opening channel to auth-bastion.example.com"
    )),
    true,
  );
});

test("fresh fallback after reuse failure still retries encrypted default key", async (t) => {
  const events = [];
  const sessions = new Map([
    [
      "source",
      makeReusableSourceSession({
        hostname: "example.test",
        username: "alice",
        port: 22,
      }),
    ],
  ]);
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
    onPassphraseRequest: () => events.push("passphrase-request"),
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions, electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender(events);

  const result = await start(
    { sender },
    {
      sessionId: "reuse-fallback-retry-session",
      sourceSessionId: "source",
      hostname: "example.test",
      username: "alice",
      port: 22,
      knownHosts: [],
    },
  );

  assert.deepEqual(result, { sessionId: "reuse-fallback-retry-session" });
  assert.equal(MockSSHClient.instances.length, 2);
  assert.equal(events.includes("passphrase-request"), true);
  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:connection-reuse:fallback"
      && message.payload.sessionId === "reuse-fallback-retry-session"
    )),
    true,
  );
  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:exit"
      && message.payload.sessionId === "reuse-fallback-retry-session"
    )),
    false,
  );
});

test("fresh fallback after reuse failure without encrypted keys emits one final exit", async (t) => {
  const sessions = new Map([
    [
      "source",
      makeReusableSourceSession({
        hostname: "example.test",
        username: "alice",
        port: 22,
      }),
    ],
  ]);
  const { bridge } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error"],
    encryptedKeys: [],
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions, electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender();

  await assert.rejects(
    () => start(
      { sender },
      {
        sessionId: "reuse-fallback-failed-session",
        sourceSessionId: "source",
        hostname: "example.test",
        username: "alice",
        port: 22,
        knownHosts: [],
      },
    ),
    /All configured authentication methods failed/,
  );

  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:connection-reuse:fallback"
      && message.payload.sessionId === "reuse-fallback-failed-session"
    )),
    true,
  );
  const exits = sender.sent.filter((message) => (
    message.channel === "netcatty:exit"
    && message.payload.sessionId === "reuse-fallback-failed-session"
  ));
  assert.equal(exits.length, 1);
  assert.equal(exits[0].payload.reason, "error");
});

test("stale close from failed encrypted-key retry does not stop successful retry log stream", async (t) => {
  const sessionId = "retry-session-log";
  const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-auth-retry-log-"));
  t.after(async () => {
    await sessionLogStreamManager.stopStream(sessionId);
    fs.rmSync(logDirectory, { recursive: true, force: true });
  });

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
      sessionId,
      hostname: "example.test",
      username: "alice",
      port: 22,
      knownHosts: [],
      sessionLog: {
        enabled: true,
        directory: logDirectory,
        format: "raw",
      },
    },
  );

  assert.equal(sessionLogStreamManager.hasStream(sessionId), true);

  MockSSHClient.instances[0].emit("close");
  await nextTick();

  assert.equal(sessionLogStreamManager.hasStream(sessionId), true);
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
