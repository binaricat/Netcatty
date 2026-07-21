const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

const { releaseConnectionRef } = require("./sshConnectionPool.cjs");

// Load sshBridge with a mocked ssh2 module so we can observe whether a *new*
// SSH client is constructed (a fresh connection) versus an existing connection
// being reused for a new shell channel (issue #1204).
function loadBridgeWithMockedSsh2(t) {
  const bridgePath = require.resolve("./sshBridge.cjs");
  const authHelperPath = require.resolve("./sshAuthHelper.cjs");
  const originalLoad = Module._load;
  let clientConstructCount = 0;

  class MockSSHClient extends EventEmitter {
    connect() {
      clientConstructCount += 1;
      // We never want the reuse test to reach a real connect; if it does the
      // test asserts on clientConstructCount and fails clearly.
      setImmediate(() => this.emit("error", new Error("unexpected fresh connect")));
    }
    end() {}
    destroy() {}
    exec() {}
    shell() {}
  }

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

  return { bridge, getClientConstructCount: () => clientConstructCount };
}

function makeSender() {
  return {
    id: 1,
    isDestroyed: () => false,
    sent: [],
    send(channel, payload) { this.sent.push({ channel, payload }); },
  };
}

function getConnectionReuseFallbackEvents(sender) {
  return sender.sent.filter((m) => m.channel === "netcatty:connection-reuse:fallback");
}

// A fake ssh2 shell channel.
function makeStream() {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.closed = false;
  stream.write = () => true;
  stream.signal = () => {};
  stream.close = () => { stream.closed = true; stream.emit("close"); };
  return stream;
}

// A fake authenticated ssh2 connection that hands out shell channels.
function makeReusableConn() {
  const conn = new EventEmitter();
  conn._sock = { destroyed: false };
  conn._remoteVer = "OpenSSH_9.0";
  conn.ended = 0;
  conn.openedShells = [];
  conn.openedShellOptions = [];
  conn.end = () => { conn.ended += 1; };
  conn.destroy = () => {};
  conn.shell = (_opts, shellOpts, cb) => {
    const stream = makeStream();
    conn.openedShells.push(stream);
    conn.openedShellOptions.push(shellOpts);
    // ssh2 invokes the callback asynchronously.
    setImmediate(() => cb(null, stream));
  };
  return conn;
}

function makePidTrackingReusableConn({ delayFirstNewPid = false } = {}) {
  const conn = makeReusableConn();
  conn.shellPidSnapshots = [];
  conn.sourceShellVisible = true;
  let delayed = false;
  conn.exec = (_command, callback) => {
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.close = () => {};
    let visibleShellCount = conn.openedShells.length;
    if (delayFirstNewPid && conn.openedShells.length > 0 && !delayed) {
      delayed = true;
      visibleShellCount -= 1;
    }
    const snapshot = [
      ...(conn.sourceShellVisible ? ["111"] : []),
      ...Array.from(
        { length: visibleShellCount },
        (_value, index) => String((index + 2) * 111),
      ),
    ];
    const pids = `${snapshot.join("\n")}\n__NETCATTY_SHELL_SCAN_COMPLETE__\n`;
    conn.shellPidSnapshots.push(snapshot);
    setImmediate(() => {
      stream.emit("data", Buffer.from(pids));
      stream.emit("close", 0);
    });
    callback(null, stream);
  };
  return conn;
}

function makeUnavailableDiscoveryConn() {
  const conn = makeReusableConn();
  conn.discoveryExecCalls = 0;
  conn.exec = (_command, callback) => {
    conn.discoveryExecCalls += 1;
    callback(new Error("exec channels disabled"));
  };
  return conn;
}

function makeFailedDiscoveryCommandConn() {
  const conn = makeReusableConn();
  conn.discoveryExecCalls = 0;
  conn.exec = (_command, callback) => {
    conn.discoveryExecCalls += 1;
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.close = () => {};
    setImmediate(() => {
      stream.emit("data", Buffer.from("111\n"));
      stream.emit("close", 127);
    });
    callback(null, stream);
  };
  return conn;
}

// A reusable connection whose shell callback is held until released, so a test
// can simulate the source tab closing while conn.shell() is still pending.
function makeDeferredShellConn() {
  const conn = new EventEmitter();
  conn._sock = { destroyed: false };
  conn._remoteVer = "OpenSSH_9.0";
  conn.ended = 0;
  conn.openedShells = [];
  conn._pending = [];
  conn.end = () => { conn.ended += 1; };
  conn.destroy = () => {};
  conn.shell = (_opts, _shellOpts, cb) => {
    conn._pending.push(cb);
  };
  conn.flushShell = () => {
    const cbs = conn._pending.splice(0);
    for (const cb of cbs) {
      const stream = makeStream();
      conn.openedShells.push(stream);
      cb(null, stream);
    }
  };
  return conn;
}

// Build a live source session as if it had connected normally, including the
// reference-counted descriptor and the recorded endpoint used for reuse target
// matching.
function makeSourceSession(conn, endpoint) {
  return {
    conn,
    stream: makeStream(),
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

function registerStartHandler(bridge, sessions) {
  bridge.init({ sessions, electronModule: {} });
  const ipcMain = {
    handlers: new Map(),
    handle(channel, handler) { this.handlers.set(channel, handler); },
    on() {},
  };
  bridge.registerHandlers(ipcMain);
  return ipcMain.handlers.get("netcatty:start");
}

test("Copy Tab reuses the source connection instead of dialing fresh", async (t) => {
  const { bridge, getClientConstructCount } = loadBridgeWithMockedSsh2(t);
  const sessions = new Map();
  const sourceConn = makeReusableConn();

  // Seed a live source session as if it had connected normally.
  sessions.set("source", makeSourceSession(sourceConn, { hostname: "10.0.0.1", username: "alice" }));

  const start = registerStartHandler(bridge, sessions);
  const sender = makeSender();

  const result = await start(
    { sender },
    {
      sessionId: "copy",
      hostname: "10.0.0.1",
      username: "alice",
      port: 22,
      sourceSessionId: "source",
    },
  );

  assert.equal(result.sessionId, "copy");
  // No new SSH client was constructed/connected — the existing connection was reused.
  assert.equal(getClientConstructCount(), 0);
  // A new shell channel was opened on the source connection.
  assert.equal(sourceConn.openedShells.length, 1);
  // The new session is tracked and shares the source's connRef (count bumped).
  const copy = sessions.get("copy");
  assert.ok(copy, "copy session should be registered");
  assert.equal(copy.conn, sourceConn);
  assert.equal(copy.connRef.count, 2);

  // A 'connected' progress event was emitted for the renderer.
  const progress = sender.sent.filter((m) => m.channel === "netcatty:chain:progress");
  assert.ok(progress.some((m) => m.payload.status === "connected"));
  assert.equal(getConnectionReuseFallbackEvents(sender).length, 0, "successful reuse should not emit fallback");
});

test("Copy Tab records a distinct remote shell for each shared terminal", async (t) => {
  const { bridge } = loadBridgeWithMockedSsh2(t);
  const sessions = new Map();
  const sourceConn = makePidTrackingReusableConn();
  const source = makeSourceSession(sourceConn, { hostname: "10.0.0.1", username: "alice" });
  sessions.set("source", source);

  const start = registerStartHandler(bridge, sessions);
  await start(
    { sender: makeSender() },
    {
      sessionId: "copy",
      hostname: "10.0.0.1",
      username: "alice",
      sourceSessionId: "source",
    },
  );

  assert.deepEqual(sourceConn.shellPidSnapshots, [["111"], ["111", "222"]]);
  assert.equal(source.shellPid, "111");
  assert.equal(sessions.get("copy").shellPid, "222");
});

test("Copy Tab skips POSIX shell discovery for network devices", async (t) => {
  const { bridge } = loadBridgeWithMockedSsh2(t);
  const sessions = new Map();
  const sourceConn = makeReusableConn();
  let execCalls = 0;
  sourceConn.exec = () => { execCalls += 1; };
  sessions.set("source", makeSourceSession(sourceConn, { hostname: "10.0.0.1", username: "alice" }));

  const start = registerStartHandler(bridge, sessions);
  await start(
    { sender: makeSender() },
    {
      sessionId: "copy",
      hostname: "10.0.0.1",
      username: "alice",
      sourceSessionId: "source",
      skipShellPidDiscovery: true,
    },
  );

  assert.equal(execCalls, 0);
  assert.equal(sourceConn.openedShells.length, 1);
  assert.ok(sessions.get("copy"));
});

test("Copy Tab waits briefly when the new remote shell is not visible immediately", async (t) => {
  const { bridge } = loadBridgeWithMockedSsh2(t);
  const sessions = new Map();
  const sourceConn = makePidTrackingReusableConn({ delayFirstNewPid: true });
  sessions.set("source", makeSourceSession(sourceConn, { hostname: "10.0.0.1", username: "alice" }));

  const start = registerStartHandler(bridge, sessions);
  await start(
    { sender: makeSender() },
    {
      sessionId: "copy",
      hostname: "10.0.0.1",
      username: "alice",
      sourceSessionId: "source",
    },
  );

  assert.deepEqual(sourceConn.shellPidSnapshots, [["111"], ["111"], ["111", "222"]]);
  assert.equal(sessions.get("copy").shellPid, "222");
});

test("Copy Tab does not retry when remote shell discovery is unavailable", async (t) => {
  const { bridge } = loadBridgeWithMockedSsh2(t);
  const sessions = new Map();
  const sourceConn = makeUnavailableDiscoveryConn();
  sessions.set("source", makeSourceSession(sourceConn, { hostname: "10.0.0.1", username: "alice" }));

  const start = registerStartHandler(bridge, sessions);
  await start(
    { sender: makeSender() },
    {
      sessionId: "copy",
      hostname: "10.0.0.1",
      username: "alice",
      sourceSessionId: "source",
    },
  );

  assert.equal(sourceConn.discoveryExecCalls, 1);
  assert.equal(sessions.get("source").shellPid, undefined);
  assert.equal(sessions.get("copy").shellPid, undefined);
});

test("Copy Tab does not retry when the remote discovery command fails", async (t) => {
  const { bridge } = loadBridgeWithMockedSsh2(t);
  const sessions = new Map();
  const sourceConn = makeFailedDiscoveryCommandConn();
  sessions.set("source", makeSourceSession(sourceConn, { hostname: "10.0.0.1", username: "alice" }));

  const start = registerStartHandler(bridge, sessions);
  await start(
    { sender: makeSender() },
    {
      sessionId: "copy",
      hostname: "10.0.0.1",
      username: "alice",
      sourceSessionId: "source",
    },
  );

  assert.equal(sourceConn.discoveryExecCalls, 1);
  assert.equal(sessions.get("copy").shellPid, undefined);
});

test("concurrent Copy Tab requests serialize shell discovery per connection", async (t) => {
  const { bridge } = loadBridgeWithMockedSsh2(t);
  const sessions = new Map();
  const sourceConn = makePidTrackingReusableConn();
  sessions.set("source", makeSourceSession(sourceConn, { hostname: "10.0.0.1", username: "alice" }));

  const start = registerStartHandler(bridge, sessions);
  await Promise.all([
    start(
      { sender: makeSender() },
      { sessionId: "copy-1", hostname: "10.0.0.1", username: "alice", sourceSessionId: "source" },
    ),
    start(
      { sender: makeSender() },
      { sessionId: "copy-2", hostname: "10.0.0.1", username: "alice", sourceSessionId: "source" },
    ),
  ]);

  assert.equal(sessions.get("source").shellPid, "111");
  assert.equal(sessions.get("copy-1").shellPid, "222");
  assert.equal(sessions.get("copy-2").shellPid, "333");
});

test("concurrent copies keep distinct shell IDs when the source closes immediately", async (t) => {
  const { bridge } = loadBridgeWithMockedSsh2(t);
  const terminalBridge = require("./terminalBridge.cjs");
  const sessions = new Map();
  const sourceConn = makePidTrackingReusableConn({ delayFirstNewPid: true });
  const source = makeSourceSession(sourceConn, { hostname: "10.0.0.1", username: "alice" });
  source.shellPid = "111";
  const closeSourceStream = source.stream.close;
  source.stream.close = () => {
    sourceConn.sourceShellVisible = false;
    closeSourceStream();
  };
  sessions.set("source", source);

  terminalBridge.init({ sessions, electronModule: {} });
  const start = registerStartHandler(bridge, sessions);
  const copies = Promise.all([
    start(
      { sender: makeSender() },
      { sessionId: "copy-1", hostname: "10.0.0.1", username: "alice", sourceSessionId: "source" },
    ),
    start(
      { sender: makeSender() },
      { sessionId: "copy-2", hostname: "10.0.0.1", username: "alice", sourceSessionId: "source" },
    ),
  ]);

  terminalBridge.closeSession({ sender: {} }, { sessionId: "source" });
  await copies;

  assert.equal(sessions.get("copy-1").shellPid, "222");
  assert.equal(sessions.get("copy-2").shellPid, "333");
});

test("Copy Tab preserves the server locale unless the host explicitly overrides it", async (t) => {
  const { bridge } = loadBridgeWithMockedSsh2(t);
  const sessions = new Map();
  const sourceConn = makeReusableConn();
  sessions.set("source", makeSourceSession(sourceConn, { hostname: "10.0.0.1", username: "alice" }));

  const start = registerStartHandler(bridge, sessions);

  await start(
    { sender: makeSender() },
    {
      sessionId: "copy-default-locale",
      hostname: "10.0.0.1",
      username: "alice",
      sourceSessionId: "source",
      charset: "UTF-8",
      env: { TERM: "xterm-256color" },
    },
  );

  assert.deepEqual(sourceConn.openedShellOptions[0].env, {
    COLORTERM: "truecolor",
    TERM: "xterm-256color",
  });

  await start(
    { sender: makeSender() },
    {
      sessionId: "copy-explicit-locale",
      hostname: "10.0.0.1",
      username: "alice",
      sourceSessionId: "source",
      charset: "UTF-8",
      env: { LANG: "zh_CN.UTF-8" },
    },
  );

  assert.equal(sourceConn.openedShellOptions[1].env.LANG, "zh_CN.UTF-8");
});

test("closing the reused channel keeps the source connection alive", async (t) => {
  const { bridge } = loadBridgeWithMockedSsh2(t);
  const sessions = new Map();
  const sourceConn = makeReusableConn();
  const source = makeSourceSession(sourceConn, { hostname: "10.0.0.1", username: "alice" });
  const connRef = source.connRef;
  sessions.set("source", source);

  const start = registerStartHandler(bridge, sessions);
  await start(
    { sender: makeSender() },
    { sessionId: "copy", hostname: "10.0.0.1", username: "alice", sourceSessionId: "source" },
  );

  const copy = sessions.get("copy");
  assert.equal(connRef.count, 2);

  // Simulate the remote shell of the copy exiting: its channel closes.
  copy.stream.emit("close");

  // The shared connection must NOT be ended — the source is still using it.
  assert.equal(sourceConn.ended, 0);
  assert.equal(connRef.count, 1);
  assert.equal(sessions.has("copy"), false, "copy session cleaned up");
  assert.ok(sessions.has("source"), "source session still alive");

  // Now releasing the source (last holder) ends the connection.
  assert.equal(releaseConnectionRef(sessions.get("source")), true);
  assert.equal(sourceConn.ended, 1);
});

test("skips reuse for X11-forwarding hosts and connects fresh", async (t) => {
  const { bridge, getClientConstructCount } = loadBridgeWithMockedSsh2(t);
  const sessions = new Map();
  const sourceConn = makeReusableConn();
  sessions.set("source", makeSourceSession(sourceConn, { hostname: "10.0.0.1", username: "alice" }));

  const start = registerStartHandler(bridge, sessions);

  // X11 forwarding is per-channel, so a reused channel would lose it. The
  // bridge must skip reuse and dial a fresh connection instead.
  await assert.rejects(
    () => start(
      { sender: makeSender() },
      {
        sessionId: "copy",
        hostname: "10.0.0.1",
        username: "alice",
        sourceSessionId: "source",
        x11Forwarding: true,
      },
    ),
  );
  assert.equal(sourceConn.openedShells.length, 0, "must not reuse the source connection");
  assert.equal(getClientConstructCount(), 1, "should dial a fresh connection for X11");
});

test("source closed while reused shell is pending keeps the connection alive", async (t) => {
  const { bridge } = loadBridgeWithMockedSsh2(t);
  const terminalBridge = require("./terminalBridge.cjs");
  const sessions = new Map();
  const conn = makeDeferredShellConn();
  const source = makeSourceSession(conn, { hostname: "10.0.0.1", username: "alice" });
  const connRef = source.connRef;
  sessions.set("source", source);

  terminalBridge.init({ sessions, electronModule: {} });
  const start = registerStartHandler(bridge, sessions);

  // Begin the copy; conn.shell() is deferred, so the reuse path has acquired the
  // ref (count -> 2) but not yet attached the session.
  const startPromise = start(
    { sender: makeSender() },
    { sessionId: "copy", hostname: "10.0.0.1", username: "alice", sourceSessionId: "source" },
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(connRef.count, 2, "reuse pins the connection before opening the shell");

  // Close the source tab while the copy's shell is still opening.
  terminalBridge.closeSession({ sender: {} }, { sessionId: "source" });
  assert.equal(conn.ended, 0, "connection must survive for the pending copy");
  assert.equal(connRef.count, 1);

  // Now let the copy's shell open.
  conn.flushShell();
  const result = await startPromise;
  assert.equal(result.sessionId, "copy");
  assert.equal(conn.ended, 0, "connection still alive for the active copy");
  const copy = sessions.get("copy");
  assert.ok(copy);
  assert.equal(copy.connRef, connRef);
  assert.equal(connRef.count, 1, "count reflects exactly the one remaining channel");

  // Closing the copy (last holder) finally ends the connection.
  terminalBridge.closeSession({ sender: {} }, { sessionId: "copy" });
  assert.equal(conn.ended, 1);
});

test("does not reuse when the source endpoint differs from the requested target", async (t) => {
  const { bridge, getClientConstructCount } = loadBridgeWithMockedSsh2(t);
  const sessions = new Map();
  const sourceConn = makeReusableConn();
  // Source connected to the OLD host; the saved host was then edited.
  sessions.set("source", makeSourceSession(sourceConn, { hostname: "10.0.0.1", username: "alice" }));

  const start = registerStartHandler(bridge, sessions);

  // The duplicate now targets a DIFFERENT hostname. Reusing the old connection
  // would run commands on the wrong machine, so it must connect fresh instead.
  await assert.rejects(
    () => start(
      { sender: makeSender() },
      {
        sessionId: "copy",
        hostname: "10.0.0.2", // different host
        username: "alice",
        sourceSessionId: "source",
      },
    ),
  );
  assert.equal(sourceConn.openedShells.length, 0, "must not reuse a mismatched connection");
  assert.equal(getClientConstructCount(), 1, "should dial a fresh connection to the new host");
});

test("synchronous shell failure releases the ref and falls back to fresh", async (t) => {
  const { bridge, getClientConstructCount } = loadBridgeWithMockedSsh2(t);
  const sessions = new Map();
  const sourceConn = makeReusableConn();
  // Make conn.shell throw synchronously, as ssh2 does when the transport just
  // dropped (e.g. "Not connected").
  sourceConn.shell = () => { throw new Error("Not connected"); };
  const source = makeSourceSession(sourceConn, { hostname: "10.0.0.1", username: "alice" });
  const connRef = source.connRef;
  sessions.set("source", source);

  const start = registerStartHandler(bridge, sessions);
  const sender = makeSender();
  await assert.rejects(
    () => start(
      { sender },
      { sessionId: "copy", hostname: "10.0.0.1", username: "alice", sourceSessionId: "source" },
    ),
  );
  // The up-front ref hold must be released so the source's count isn't leaked.
  assert.equal(connRef.count, 1, "ref count restored after synchronous shell failure");
  assert.equal(getClientConstructCount(), 1, "should fall back to a fresh connection");
  assert.deepEqual(
    getConnectionReuseFallbackEvents(sender).map((m) => m.payload),
    [{ sessionId: "copy", sourceSessionId: "source" }],
  );
});

test("falls back to a fresh connection when the source is gone", async (t) => {
  const { bridge, getClientConstructCount } = loadBridgeWithMockedSsh2(t);
  const sessions = new Map();
  const start = registerStartHandler(bridge, sessions);

  // sourceSessionId points at a session that doesn't exist -> fresh connect.
  // The mocked client emits an error on connect, so the start call rejects;
  // the important assertion is that a fresh connection was attempted.
  const sender = makeSender();
  await assert.rejects(
    () => start(
      { sender },
      {
        sessionId: "copy",
        hostname: "10.0.0.1",
        username: "alice",
        sourceSessionId: "missing-source",
      },
    ),
  );
  assert.equal(getClientConstructCount(), 1, "should attempt one fresh connection");
  assert.deepEqual(
    getConnectionReuseFallbackEvents(sender).map((m) => m.payload),
    [{ sessionId: "copy", sourceSessionId: "missing-source" }],
  );
});
