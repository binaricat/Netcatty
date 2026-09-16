"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createStartSessionApi, sendConnectionTestResult, cancelTestConnection } = require("./startSession.cjs");

const MUTED_CONSOLE = {
  log() {},
  error() {},
  warn() {},
  info() {},
};

function createHarness({ onConnect, chainDial } = {}) {
  const sent = [];
  const calls = {
    connectOptions: null,
    ends: 0,
    destroys: 0,
    defaultKeyScans: 0,
  };
  const sender = {
    send: (channel, payload) => {
      sent.push({ channel, payload });
    },
    isDestroyed: () => false,
  };

  class MockSSHClient extends EventEmitter {
    connect(options) {
      calls.connectOptions = options;
      if (onConnect) onConnect(this);
    }

    end() {
      calls.ends += 1;
    }

    destroy() {
      calls.destroys += 1;
    }
  }

  const sessions = new Map();
  const ctx = {
    randomUUID: () => "session-test",
    SSHClient: MockSSHClient,
    createSshDiagnosticLogger: () => () => {},
    buildConnectionReuseEndpoint: () => "endpoint",
    resolveConnectionKeepalivePolicy: () => ({ keepaliveIntervalMs: 0, keepaliveCountMax: 0 }),
    buildAlgorithms: () => undefined,
    attachSshDebugLogger: () => {},
    logSshAlgorithms: () => {},
    hostKeyVerifier: { createHostVerifier: () => (_rawKey, callback) => callback(true) },
    findAllDefaultPrivateKeys: async () => {
      calls.defaultKeyScans += 1;
      return [];
    },
    isPasswordProvided: () => true,
    hasUserConfiguredKey: () => false,
    getCachedAuthMethod: () => null,
    setCachedAuthMethod: () => {},
    clearCachedAuthMethod: () => {},
    createAuthPhase: () => ({}),
    markAuthPhasePartialSuccess: () => {},
    shouldSkipKiPasswordAutoFill: () => false,
    createKeyboardInteractiveHandler: () => () => {},
    createOrderedStringAuthHandler: () => () => {},
    getAvailableAgentSocket: async () => null,
    getAvailableForwardingAgentSocket: async () => null,
    prepareSystemSshAgentForAuth: async () => null,
    loadFirstIdentityFileForAuth: async () => null,
    preparePrivateKeyForAuth: async () => null,
    connectThroughChain: chainDial ?? (async () => {
      throw new Error("unexpected chain connect");
    }),
    createProxySocket: async () => {
      throw new Error("unexpected proxy connect");
    },
    enableSshNoDelay: () => {},
    enableTcpNoDelay: () => {},
    quoteShellArg: (value) => value,
    console: MUTED_CONSOLE,
    sessions,
    safeSend: () => {},
    electronModule: { webContents: { fromId: () => null } },
    sessionLogStreamManager: { stopStream: () => {} },
    closeTerminalOutputSession: () => {},
    sessionEncodings: new Map(),
    sessionDecoders: new Map(),
  };

  const api = createStartSessionApi(ctx);
  return { api, sent, calls, sender };
}

function baseOptions() {
  return {
    sessionId: "session-test",
    hostname: "example.test",
    port: 22,
    username: "alice",
    authMethod: "password",
    password: "secret",
    testMode: true,
    reuseTransport: false,
  };
}

test("sendConnectionTestResult emits a one-shot success payload", () => {
  const sent = [];
  const sender = {
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };

  sendConnectionTestResult(sender, "session-1", true);

  assert.deepEqual(sent, [
    { channel: "netcatty:test:result", payload: { sessionId: "session-1", ok: true } },
  ]);
});

test("sendConnectionTestResult ignores destroyed senders", () => {
  const sent = [];
  const sender = {
    isDestroyed: () => true,
    send: () => sent.push("should-not-fire"),
  };

  sendConnectionTestResult(sender, "session-1", false, "boom");

  assert.deepEqual(sent, []);
});

test("test mode resolves success on authentication without opening a shell", async () => {
  const { api, sent, calls, sender } = createHarness({
    onConnect: (conn) => {
      queueMicrotask(() => conn.emit("ready"));
    },
  });

  const result = await api.startSSHSession({ sender }, baseOptions());

  assert.equal(result.sessionId, "session-test");
  assert.equal(result.testResult, "connected");

  const resultEvent = sent.find((entry) => entry.channel === "netcatty:test:result");
  assert.ok(resultEvent, "netcatty:test:result should be emitted");
  assert.deepEqual(resultEvent.payload, { sessionId: "session-test", ok: true });
  assert.equal(calls.ends, 1, "connection should be torn down after success");
});

test("test mode does not emit a terminal exit on success", async () => {
  const { api, sent, sender } = createHarness({
    onConnect: (conn) => {
      queueMicrotask(() => conn.emit("ready"));
    },
  });

  await api.startSSHSession({ sender }, baseOptions());

  assert.equal(
    sent.some((entry) => entry.channel === "netcatty:exit"),
    false,
    "test success must not emit a terminal session exit",
  );
});

test("test mode reports failure through netcatty:test:result", async () => {
  const { api, sent, sender } = createHarness({
    onConnect: (conn) => {
      queueMicrotask(() => conn.emit("error", new Error("boom")));
    },
  });

  await assert.rejects(
    () => api.startSSHSession({ sender }, baseOptions()),
    /boom/,
  );

  const resultEvent = sent.find((entry) => entry.channel === "netcatty:test:result");
  assert.ok(resultEvent, "netcatty:test:result should be emitted on failure");
  assert.equal(resultEvent.payload.sessionId, "session-test");
  assert.equal(resultEvent.payload.ok, false);
  assert.equal(typeof resultEvent.payload.error, "string");
  assert.ok(resultEvent.payload.error.length > 0);
});

test("test mode reports an unexpected close as failure", async () => {
  const { api, sent, sender } = createHarness({
    onConnect: (conn) => {
      queueMicrotask(() => conn.emit("close"));
    },
  });

  await assert.rejects(
    () => api.startSSHSession({ sender }, baseOptions()),
    /closed unexpectedly/,
  );

  const resultEvent = sent.find((entry) => entry.channel === "netcatty:test:result");
  assert.ok(resultEvent);
  assert.equal(resultEvent.payload.ok, false);
});

test("cancelTestConnection ends an in-flight test transport", async () => {
  const { api, calls, sender } = createHarness({
    onConnect: () => {
      // Leave the dial pending (no ready/error/close).
    },
  });

  void api.startSSHSession({ sender }, baseOptions());
  // Let the async body reach conn.connect() + transport registration.
  await new Promise((resolve) => setTimeout(resolve, 0));

  const result = cancelTestConnection("session-test");

  assert.equal(result.success, true);
  assert.ok(calls.ends >= 1, "cancelTestConnection should end the SSH client");
});

test("cancelTestConnection reports unknown session ids", () => {
  assert.deepEqual(cancelTestConnection("nope"), {
    success: false,
    error: "Test connection not found",
  });
});

test("cancelTestConnection ends an in-flight chain hop registered before the dial", async () => {
  const hopConns = [];
  const { api, sender } = createHarness({
    chainDial: (_event, options) => {
      const conn = new EventEmitter();
      conn.ended = false;
      conn.destroyed = false;
      conn.end = () => { conn.ended = true; };
      conn.destroy = () => { conn.destroyed = true; };
      hopConns.push(conn);
      if (options._tunnelRef) {
        options._tunnelRef.pendingConn = conn;
        options._tunnelRef.chainConnections = options._connectionsRef || [];
        (options._connectionsRef || []).push(conn);
      }
      // Never resolves — simulates a slow/unreachable bastion.
      return new Promise(() => {});
    },
  });

  void api.startSSHSession({ sender }, {
    ...baseOptions(),
    jumpHosts: [
      { hostname: "jump.example.test", port: 22, username: "root", password: "jump-pass", authMethod: "password" },
    ],
  });

  // Let the async body reach connectThroughChain and register the hop.
  await new Promise((resolve) => setTimeout(resolve, 0));

  const result = cancelTestConnection("session-test");

  assert.equal(result.success, true);
  assert.ok(hopConns.length >= 1, "chain dial should have registered a hop conn");
  assert.ok(hopConns[0].ended || hopConns[0].destroyed, "cancel should end the in-flight hop conn");
});

test("test mode pins authHandler to a minimal method list", async () => {
  const { api, calls, sender } = createHarness({
    onConnect: (conn) => {
      queueMicrotask(() => conn.emit("ready"));
    },
  });

  await api.startSSHSession({ sender }, baseOptions());

  assert.deepEqual(calls.connectOptions.authHandler, ["password", "keyboard-interactive"]);
});
