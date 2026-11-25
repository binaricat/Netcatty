"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const terminalBridge = require("./terminalBridge.cjs");
const sshBridge = require("./sshBridge.cjs");
const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");
const { createEtSessionApi } = require("./terminalBridge/etSession.cjs");

class FakePty {
  constructor(command, args, opts) {
    this.command = command;
    this.args = args;
    this.opts = opts;
    this.pid = FakePty.nextPid += 1;
    this.dataHandlers = [];
    this.exitHandlers = [];
    this.killed = false;
  }

  onData(handler) {
    this.dataHandlers.push(handler);
  }

  onExit(handler) {
    this.exitHandlers.push(handler);
  }

  write() {}
  resize() {}

  kill() {
    this.killed = true;
  }

  emitData(data) {
    for (const handler of this.dataHandlers) handler(data);
  }

  emitExit(evt) {
    for (const handler of this.exitHandlers) handler(evt);
  }
}
FakePty.nextPid = 5000;

class FakeSerialPort extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.closedCalled = false;
  }

  open(callback) {
    queueMicrotask(() => callback?.(null));
  }

  write() {
    return true;
  }

  close() {
    this.closedCalled = true;
  }
}

function makeSender(id = 42) {
  const sent = [];
  return {
    id,
    sent,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
}

function writeExecutable(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(filePath, 0o755);
}

function loadIsolatedTerminalBridge(mocks) {
  const bridgePath = require.resolve("./terminalBridge.cjs");
  const previousCached = require.cache[bridgePath];
  delete require.cache[bridgePath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("./terminalBridge.cjs");
  } finally {
    Module._load = originalLoad;
    if (previousCached) {
      require.cache[bridgePath] = previousCached;
    } else {
      delete require.cache[bridgePath];
    }
  }
}

test("Serial explicit closeSession stops auto-log stream synchronously and late close handler stops displaced stream", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-serial-close-log-"));
  t.after(async () => {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const createdPorts = [];
  const bridge = loadIsolatedTerminalBridge({
    serialport: {
      SerialPort: class extends FakeSerialPort {
        constructor(opts, cb) {
          super(opts, cb);
          createdPorts.push(this);
        }
      },
    },
  });

  const sender = makeSender(101);
  const sessions = new Map();
  bridge.init({
    sessions,
    electronModule: {
      webContents: { fromId: (id) => (id === sender.id ? sender : null) },
    },
  });
  t.after(() => bridge.cleanupAllSessions());

  // 1. Explicit closeSession stops the auto-log stream immediately before async serial close
  const sessionId = "serial-explicit-close";
  await bridge.startSerialSession({ sender }, {
    sessionId,
    path: "/dev/ttyS0",
    baudRate: 115200,
    sessionLog: { enabled: true, directory: tmpDir, format: "raw" },
  });
  const session = sessions.get(sessionId);
  assert.ok(session.logStreamToken, "Serial session should persist logStreamToken");
  assert.equal(sessionLogStreamManager.hasStream(sessionId), true);

  createdPorts[0].emit("data", Buffer.from("hello serial\r\n"));
  const result = bridge.closeSession({ sender }, { sessionId });
  assert.deepEqual(result, { closed: true });
  assert.equal(sessions.has(sessionId), false);
  assert.equal(sessionLogStreamManager.hasStream(sessionId), false, "closeSession must stop Serial log stream synchronously");

  // Late async serial close event must be a safe no-op
  createdPorts[0].emit("close");
  assert.equal(sessionLogStreamManager.hasStream(sessionId), false);

  // 2. Displaced serial session exit handler still stops its own log stream before early return
  const displacedId = "serial-displaced-exit";
  await bridge.startSerialSession({ sender }, {
    sessionId: displacedId,
    path: "/dev/ttyS1",
    baudRate: 115200,
    sessionLog: { enabled: true, directory: tmpDir, format: "raw" },
  });
  assert.equal(sessionLogStreamManager.hasStream(displacedId), true);
  // Simulate registry removal without calling closeSession
  sessions.delete(displacedId);
  createdPorts[1].emit("close");
  assert.equal(
    sessionLogStreamManager.hasStream(displacedId),
    false,
    "finalizeSerialExit must stop its own log stream before the sessions.get guard",
  );
});

test("closeSession and exit handlers do not stop manual or foreign log streams when session has no logStreamToken (#916)", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-manual-log-guard-"));
  t.after(async () => {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sender = makeSender(102);
  const sessions = new Map();
  terminalBridge.init({
    sessions,
    electronModule: {
      webContents: { fromId: (id) => (id === sender.id ? sender : null) },
    },
  });
  t.after(() => terminalBridge.cleanupAllSessions());

  // Manual log stream (stopRequiresToken: true)
  const manualSessionId = "manual-log-session";
  const manualFilePath = path.join(tmpDir, "manual.log");
  const manualStarted = sessionLogStreamManager.startStreamToFile(manualSessionId, {
    filePath: manualFilePath,
    format: "raw",
    stopRequiresToken: true,
  });
  assert.equal(manualStarted.ok, true);
  sessions.set(manualSessionId, {
    type: "serial",
    webContentsId: sender.id,
    serialPort: { close() {} },
    // Intentionally no logStreamToken (auto-logging disabled)
  });

  terminalBridge.closeSession({ sender }, { sessionId: manualSessionId });
  assert.equal(
    sessionLogStreamManager.hasStream(manualSessionId),
    true,
    "closeSession with undefined logStreamToken must never stop a manual log stream",
  );

  // Also verify an unlogged session cannot stop a foreign auto-log stream (stopRequiresToken: false)
  const foreignSessionId = "foreign-autolog-session";
  const foreignToken = sessionLogStreamManager.startStream(foreignSessionId, {
    hostLabel: "replacement",
    hostname: "replacement.local",
    directory: tmpDir,
    format: "raw",
  });
  assert.ok(foreignToken);
  sessions.set(foreignSessionId, {
    type: "mosh",
    webContentsId: sender.id,
    proc: { kill() {} },
    logStreamToken: null,
  });

  terminalBridge.closeSession({ sender }, { sessionId: foreignSessionId });
  assert.equal(
    sessionLogStreamManager.hasStream(foreignSessionId),
    true,
    "closeSession with null logStreamToken must never stop a stream without matching token",
  );
  await sessionLogStreamManager.stopStream(foreignSessionId, foreignToken);
  assert.equal(sessionLogStreamManager.hasStream(foreignSessionId), false);
});

test("Mosh explicit closeSession stops auto-log stream during handshake and after mosh-client swap", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mosh-close-log-"));
  const logDir = path.join(tmpDir, "logs");
  const binDir = path.join(tmpDir, "bin");
  const sshPath = path.join(binDir, "ssh");
  const moshClientPath = path.join(tmpDir, "resources", "mosh", "linux-x64", "mosh-client");
  writeExecutable(sshPath);
  writeExecutable(moshClientPath);

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;
  t.after(async () => {
    process.env.PATH = oldPath;
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const spawns = [];
  const bridge = loadIsolatedTerminalBridge({
    "node-pty": {
      spawn(command, args, opts) {
        const proc = new FakePty(command, args, opts);
        spawns.push(proc);
        return proc;
      },
    },
  });

  const sender = makeSender(103);
  const sessions = new Map();
  bridge.init({
    sessions,
    electronModule: {
      webContents: { fromId: (id) => (id === sender.id ? sender : null) },
    },
  });
  t.after(() => bridge.cleanupAllSessions());

  const lookup = { platform: "linux", arch: "x64", projectRoot: tmpDir };

  // Case A: explicit close during SSH handshake phase
  const handshakeId = "mosh-close-handshake";
  await bridge.startMoshSession({ sender }, {
    sessionId: handshakeId,
    hostname: "example.com",
    username: "alice",
    cols: 80,
    rows: 24,
    sessionLog: { enabled: true, directory: logDir, format: "raw" },
  }, { moshClientLookup: lookup });
  assert.equal(sessionLogStreamManager.hasStream(handshakeId), true);
  bridge.closeSession({ sender }, { sessionId: handshakeId });
  assert.equal(sessionLogStreamManager.hasStream(handshakeId), false, "closeSession must stop Mosh handshake log stream");
  spawns[0].emitExit({ exitCode: 0, signal: 0 });
  assert.equal(sessionLogStreamManager.hasStream(handshakeId), false);

  // Case B: explicit close after swapping to mosh-client
  const activeId = "mosh-close-active";
  await bridge.startMoshSession({ sender }, {
    sessionId: activeId,
    hostname: "example.com",
    username: "alice",
    cols: 80,
    rows: 24,
    sessionLog: { enabled: true, directory: logDir, format: "raw" },
  }, { moshClientLookup: lookup });
  assert.equal(sessionLogStreamManager.hasStream(activeId), true);
  const sshPty = spawns[1];
  sshPty.emitData(Buffer.from("MOSH CONNECT 60001 4NeCCgvZFe2RnPgrcU1PQw\r\n"));
  sshPty.emitExit({ exitCode: 0, signal: 0 });
  assert.equal(spawns.length, 3, "mosh-client should spawn after handshake");
  assert.equal(sessionLogStreamManager.hasStream(activeId), true, "successful handshake swap must keep log stream alive");

  bridge.closeSession({ sender }, { sessionId: activeId });
  assert.equal(sessionLogStreamManager.hasStream(activeId), false, "closeSession must stop active mosh-client log stream");
  spawns[2].emitExit({ exitCode: 0, signal: 0 });
  assert.equal(sessionLogStreamManager.hasStream(activeId), false);

  // Case C: displaced mosh-client exit handler still stops its own log stream before early return
  const displacedId = "mosh-displaced-exit";
  await bridge.startMoshSession({ sender }, {
    sessionId: displacedId,
    hostname: "example.com",
    username: "alice",
    cols: 80,
    rows: 24,
    sessionLog: { enabled: true, directory: logDir, format: "raw" },
  }, { moshClientLookup: lookup });
  spawns[3].emitData(Buffer.from("MOSH CONNECT 60002 4NeCCgvZFe2RnPgrcU1PQw\r\n"));
  spawns[3].emitExit({ exitCode: 0, signal: 0 });
  assert.equal(sessionLogStreamManager.hasStream(displacedId), true);
  sessions.delete(displacedId);
  spawns[4].emitExit({ exitCode: 0, signal: 0 });
  assert.equal(
    sessionLogStreamManager.hasStream(displacedId),
    false,
    "mcPty.onExit must stop its own log stream before early return on missing session",
  );
});

test("ET exit handler stops auto-log stream before early-return guard when session was closed or displaced", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-et-close-log-"));
  const logDir = path.join(tmpDir, "logs");
  t.after(async () => {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sessions = new Map();
  let exitHandler = null;
  const proc = {
    pid: 9999,
    onData() {},
    onExit(cb) { exitHandler = cb; },
    write() {},
    kill() {},
  };
  const sender = makeSender(104);
  const api = createEtSessionApi({
    fs,
    os,
    path,
    process,
    console,
    StringDecoder: require("node:string_decoder").StringDecoder,
    execFileSync: () => "",
    randomUUID: require("node:crypto").randomUUID,
    sessions,
    bundledEtClient: () => "/fake/et",
    findExecutable: () => null,
    pty: { spawn: () => proc },
    electronModule: { webContents: { fromId: () => sender } },
    openTerminalOutputSession: () => {},
    closeTerminalOutputSession: () => {},
    sessionLogStreamManager,
    tempDirBridge: { getTempFilePath: (name) => path.join(tmpDir, name) },
    createPtyOutputBuffer: () => ({
      bufferData() {},
      flush() {},
      flushPaced(cb) { cb(); },
      discard() {},
    }),
    createZmodemSentry: () => ({ consume() {}, cancel() {} }),
    trackSessionIdlePrompt: () => {},
    selectZmodemUploadFiles: null,
    selectZmodemDownloadDirectory: null,
    prepareSystemSshAgentForAuth: async () => null,
    getAvailableAgentSocket: async () => null,
    getAvailableForwardingAgentSocket: async () => null,
    buildTerminalProcessEnv: (env) => ({ ...env }),
    buildLocalSessionEnv: (env) => ({ ...env }),
  });

  const sessionId = "et-displaced-log";
  await api.startEtSession({ sender }, {
    sessionId,
    hostname: "et-host.example",
    username: "alice",
    sessionLog: { enabled: true, directory: logDir, format: "raw" },
  });
  const session = sessions.get(sessionId);
  assert.ok(session.logStreamToken, "ET session should persist logStreamToken");
  assert.equal(sessionLogStreamManager.hasStream(sessionId), true);

  // Simulate explicit close removing session before proc.onExit fires
  session.closed = true;
  sessions.delete(sessionId);
  exitHandler({ exitCode: 0 });
  assert.equal(
    sessionLogStreamManager.hasStream(sessionId),
    false,
    "ET onExit must stop its own log stream even after closeSession deleted sessions entry",
  );
});

test("SSH closeSession and cleanupAllSessions clear sessionEncodings and sessionDecoders synchronously while preserving newer reconnects", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-ssh-close-decoders-"));
  t.after(async () => {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sender = makeSender(105);
  const sessions = new Map();
  terminalBridge.init({
    sessions,
    electronModule: {
      webContents: { fromId: (id) => (id === sender.id ? sender : null) },
    },
  });
  t.after(() => {
    terminalBridge.cleanupAllSessions();
    sshBridge.clearSessionEncodingState("ssh-close-1");
    sshBridge.clearSessionEncodingState("ssh-epoch-guard");
    sshBridge.clearSessionEncodingState("ssh-missing-reconnect");
    sshBridge.clearSessionEncodingState("ssh-cleanup-a");
    sshBridge.clearSessionEncodingState("ssh-cleanup-b");
  });

  // 1. Explicit closeSession clears sessionEncodings & sessionDecoders synchronously
  const sshId = "ssh-close-1";
  sshBridge._sessionEncodings.set(sshId, "gb18030");
  sshBridge._getSessionDecoder(sshId, "stdout");
  assert.equal(sshBridge._sessionEncodings.has(sshId), true);
  assert.equal(sshBridge._sessionDecoders.has(sshId), true);

  const sshLogToken = sessionLogStreamManager.startStream(sshId, {
    hostLabel: "ssh-host",
    hostname: "ssh.example",
    directory: tmpDir,
    format: "raw",
  });
  sessions.set(sshId, {
    type: "ssh",
    webContentsId: sender.id,
    _logStreamToken: sshLogToken,
    // Async stream.close() that does NOT synchronously emit "close"
    stream: { close() {} },
    conn: { end() {} },
  });

  const closeResult = terminalBridge.closeSession({ sender }, { sessionId: sshId });
  assert.deepEqual(closeResult, { closed: true });
  assert.equal(sessions.has(sshId), false);
  assert.equal(sshBridge._sessionEncodings.has(sshId), false, "closeSession must clear sessionEncodings synchronously");
  assert.equal(sshBridge._sessionDecoders.has(sshId), false, "closeSession must clear sessionDecoders synchronously");
  assert.equal(sessionLogStreamManager.hasStream(sshId), false, "closeSession must stop SSH _logStreamToken synchronously");

  // 2. Stale bootEpoch closeSession MUST NOT wipe the live replacement session's encoding/decoders
  const epochId = "ssh-epoch-guard";
  sshBridge._sessionEncodings.set(epochId, "gb18030");
  sshBridge._getSessionDecoder(epochId, "stdout");
  sessions.set(epochId, {
    type: "ssh",
    bootEpoch: 2,
    webContentsId: sender.id,
    stream: { close() {} },
    conn: { end() {} },
  });
  const skipped = terminalBridge.closeSession({ sender }, { sessionId: epochId, bootEpoch: 1 });
  assert.deepEqual(skipped, { skipped: true, reason: "boot-epoch-mismatch" });
  assert.equal(sshBridge._sessionEncodings.get(epochId), "gb18030");
  assert.equal(sshBridge._sessionDecoders.has(epochId), true);

  // 3. Missing-session closeSession MUST NOT wipe encoding seeded by an in-flight reconnect
  const missingId = "ssh-missing-reconnect";
  sshBridge._sessionEncodings.set(missingId, "gb18030");
  sshBridge._getSessionDecoder(missingId, "stdout");
  const missingResult = terminalBridge.closeSession({ sender }, { sessionId: missingId });
  assert.deepEqual(missingResult, { closed: false, reason: "missing" });
  assert.equal(sshBridge._sessionEncodings.get(missingId), "gb18030");
  assert.equal(sshBridge._sessionDecoders.has(missingId), true);

  // 4. cleanupAllSessions clears encoding/decoders and owned log streams even if transport close throws
  const idA = "ssh-cleanup-a";
  const idB = "ssh-cleanup-b";
  sshBridge._sessionEncodings.set(idA, "gb18030");
  sshBridge._getSessionDecoder(idA, "stdout");
  sshBridge._sessionEncodings.set(idB, "utf-8");
  sshBridge._getSessionDecoder(idB, "stderr");
  const tokenA = sessionLogStreamManager.startStream(idA, {
    hostLabel: "a",
    hostname: "a.example",
    directory: tmpDir,
    format: "raw",
  });
  sessions.set(idA, {
    type: "ssh",
    webContentsId: sender.id,
    _logStreamToken: tokenA,
    stream: { close() { throw new Error("boom"); } },
    conn: { end() {} },
  });
  sessions.set(idB, {
    type: "ssh",
    webContentsId: sender.id,
    stream: { close() {} },
    conn: { end() {} },
  });

  terminalBridge.cleanupAllSessions();
  assert.equal(sessions.size, 0);
  assert.equal(sshBridge._sessionEncodings.has(idA), false);
  assert.equal(sshBridge._sessionDecoders.has(idA), false);
  assert.equal(sshBridge._sessionEncodings.has(idB), false);
  assert.equal(sshBridge._sessionDecoders.has(idB), false);
  assert.equal(sessionLogStreamManager.hasStream(idA), false);
});

test("startSession.cjs keeps strict liveSession === session guard (does not relax to !liveSession)", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "sshBridge", "startSession.cjs"),
    "utf8",
  );
  assert.match(source, /if\s*\(\s*liveSession\s*===\s*session\s*\)/);
  assert.doesNotMatch(source, /if\s*\(\s*!liveSession\s*\|\|\s*liveSession\s*===\s*session\s*\)/);
});
