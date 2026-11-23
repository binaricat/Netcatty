"use strict";

// --- merged from sftpBridge.fallback.test.cjs ---
{
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const bridge = require("./sftpBridge.cjs");

for (const loggerThrows of [false, true]) {
  test(`Auto fallback reports the channel failure; loggerThrows=${loggerThrows}`, async () => {
    const failure = Object.assign(new Error("subsystem request rejected"), { code: "CHANNEL_OPEN_FAILURE" });
    const reports = [];
    const conn = {
      sftp(callback) { callback(failure); },
      exec(command, callback) {
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        stream.close = () => {};
        callback(null, stream);
        queueMicrotask(() => {
          if (!command.includes("command -v scp")) {
            stream.emit("data", Buffer.from("RAW:/home/test\n"));
          }
          stream.emit("close", 0);
        });
      },
    };
    bridge.init({
      electronModule: { webContents: { fromId: () => null } },
      sessions: new Map([["fallback-session", { conn }]]),
      sftpClients: new Map(),
      reportSuppressedError(...args) {
        reports.push(args);
        if (loggerThrows) throw new Error("logger unavailable");
      },
    });
    const opened = await bridge.openSftpForSession(null, { sessionId: "fallback-session" });
    try {
      assert.equal(opened.fileProtocol, "scp");
      assert.equal(reports.length, 1);
      assert.equal(reports[0][0], "sftpBridge.openSftpForSession");
      assert.equal(reports[0][1], failure);
      assert.match(reports[0][2], /fallback-session.*SCP mode \(auto\)/);
    } finally {
      await bridge.closeSftp(null, { sftpId: opened.sftpId });
    }
  });
}
}

// --- merged from sftpBridge.sessionActivity.test.cjs ---
{
const assert = require("node:assert/strict");
const test = require("node:test");
const sftpBridge = require("./sftpBridge.cjs");

test("renderer SFTP operations keep their source terminal session active", async () => {
  const handlers = new Map();
  const activity = [];
  const requests = [];
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
  const terminalWorkerManager = {
    async request(channel, payload) {
      requests.push({ channel, payload });
      if (channel === "netcatty:sftp:openForSession") {
        return { sftpId: "sftp-1", sourceSessionId: "terminal-2" };
      }
      if (channel === "netcatty:sftp:list") return [];
      if (channel === "netcatty:sftp:close") return { ok: true };
      throw new Error(`Unexpected channel: ${channel}`);
    },
  };
  sftpBridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: {},
    reportOpenedSessionActivity: (event) => activity.push(event),
  });
  sftpBridge.registerHandlers(ipcMain, { terminalWorkerManager });
  const event = { sender: { id: 7 } };

  await handlers.get("netcatty:sftp:openForSession")(event, { sessionId: "terminal-1" });
  await handlers.get("netcatty:sftp:list")(event, { sftpId: "sftp-1", path: "/tmp" });
  await handlers.get("netcatty:sftp:close")(event, { sftpId: "sftp-1" });

  assert.deepEqual(requests.map((entry) => entry.channel), [
    "netcatty:sftp:openForSession",
    "netcatty:sftp:list",
    "netcatty:sftp:close",
  ]);
  assert.deepEqual(activity, [
    { sessionId: "terminal-1", phase: "begin" },
    { sessionId: "terminal-2", phase: "touch" },
    { sessionId: "terminal-1", phase: "end" },
    { sessionId: "terminal-2", phase: "begin" },
    { sessionId: "terminal-2", phase: "end" },
    { sessionId: "terminal-2", phase: "begin" },
    { sessionId: "terminal-2", phase: "end" },
  ]);
});
}

// --- merged from sftpBridge.relativePaths.test.cjs ---
{
const test = require("node:test");
const assert = require("node:assert/strict");

const sftpBridge = require("./sftpBridge.cjs");

function createSftpChannel(existingPaths = []) {
  const existing = new Set(existingPaths);
  const calls = {
    mkdir: [],
    realpath: [],
    rmdir: [],
    stat: [],
  };
  const channel = {
    readdir(_targetPath, callback) {
      callback(null, []);
    },
    stat(targetPath, callback) {
      calls.stat.push(targetPath);
      if (existing.has(targetPath)) {
        callback(null, { isDirectory: () => true });
        return;
      }
      const error = new Error(`No such file: ${targetPath}`);
      error.code = 2;
      callback(error);
    },
    mkdir(targetPath, callback) {
      calls.mkdir.push(targetPath);
      existing.add(targetPath);
      callback(null);
    },
    rmdir(targetPath, callback) {
      calls.rmdir.push(targetPath);
      existing.delete(targetPath);
      callback(null);
    },
    unlink(_targetPath, callback) {
      callback(null);
    },
    realpath(targetPath, callback) {
      calls.realpath.push(targetPath);
      callback(null, targetPath === ".." ? "/home" : "/home/alice");
    },
  };
  return { calls, channel };
}

test("mkdir preserves hidden relative names and resolves explicit dot segments", async () => {
  const { calls, channel } = createSftpChannel(["/home", "/home/alice"]);
  const client = {
    sftp: channel,
    realPath: (targetPath) => new Promise((resolve, reject) => {
      channel.realpath(targetPath, (error, resolvedPath) => (
        error ? reject(error) : resolve(resolvedPath)
      ));
    }),
  };
  sftpBridge.init({
    electronModule: {},
    sessions: new Map(),
    sftpClients: new Map([["mkdir-test", client]]),
  });

  await sftpBridge.mkdirSftp(null, {
    sftpId: "mkdir-test",
    path: ".config/app",
    encoding: "utf-8",
  });
  await sftpBridge.mkdirSftp(null, {
    sftpId: "mkdir-test",
    path: "..staging/cache",
    encoding: "utf-8",
  });
  await sftpBridge.mkdirSftp(null, {
    sftpId: "mkdir-test",
    path: "./logs",
    encoding: "utf-8",
  });
  await sftpBridge.mkdirSftp(null, {
    sftpId: "mkdir-test",
    path: "../shared",
    encoding: "utf-8",
  });
  await sftpBridge.mkdirSftp(null, {
    sftpId: "mkdir-test",
    path: ".\\windows-logs",
    encoding: "utf-8",
  });
  await sftpBridge.mkdirSftp(null, {
    sftpId: "mkdir-test",
    path: "..\\windows-shared",
    encoding: "utf-8",
  });

  assert.deepEqual(calls.realpath, [".", "..", ".", ".."]);
  assert.deepEqual(calls.mkdir, [
    ".config",
    ".config/app",
    "..staging",
    "..staging/cache",
    "/home/alice/logs",
    "/home/shared",
    "/home/alice/windows-logs",
    "/home/windows-shared",
  ]);
});

test("session-backed recursive delete preserves a hidden directory name", async () => {
  const { calls, channel } = createSftpChannel([".cache"]);
  const connection = {
    sftp(callback) {
      callback(null, channel);
    },
  };
  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: {},
    sessions: new Map([["session-1", { conn: connection }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, { sessionId: "session-1" });

  await sftpBridge.deleteSftp(null, {
    sftpId: opened.sftpId,
    path: ".cache",
    encoding: "utf-8",
  });

  assert.deepEqual(calls.realpath, []);
  assert.deepEqual(calls.rmdir, [".cache"]);
});
}

// --- merged from sftpBridge.readLimit.test.cjs ---
{
const assert = require("node:assert/strict");
const test = require("node:test");
const { Readable } = require("node:stream");
const { EventEmitter } = require("node:events");

const { createFileOpsApi } = require("./sftpBridge/fileOps.cjs");

const MAX_IN_MEMORY_READ_BYTES = 10 * 1024 * 1024;

function createApi(client, overrides = {}) {
  return createFileOpsApi({
    sftpClients: new Map([["sftp-1", client]]),
    resolveEncodingForRequest: () => "utf-8",
    encodePath: (value) => value,
    Buffer,
    ...overrides,
  });
}

test("SFTP text reads reject oversized files before opening the data stream", async () => {
  let streamOpened = false;
  const sftp = {
    createReadStream() {
      streamOpened = true;
      throw new Error("oversized file stream should not open");
    },
  };
  const api = createApi({}, {
    requireSftpChannel: async () => sftp,
    statAsync: async () => ({ size: MAX_IN_MEMORY_READ_BYTES + 1 }),
  });

  await assert.rejects(
    api.readSftp(null, { sftpId: "sftp-1", path: "/large.log" }),
    /10 MB.*download.*external app/i,
  );
  assert.equal(streamOpened, false);
});

test("SFTP text reads still stream ordinary files", async () => {
  const sftp = {
    createReadStream() {
      return Readable.from([Buffer.from("hel"), Buffer.from("lo")]);
    },
  };
  const api = createApi({}, {
    requireSftpChannel: async () => sftp,
    statAsync: async () => ({ size: 5 }),
  });

  assert.equal(
    await api.readSftp(null, { sftpId: "sftp-1", path: "/small.txt" }),
    "hello",
  );
});

test("SFTP binary reads reject oversized files before opening the data stream", async () => {
  let streamOpened = false;
  const sftp = {
    createReadStream() {
      streamOpened = true;
      throw new Error("oversized file stream should not open");
    },
  };
  const api = createApi({}, {
    requireSftpChannel: async () => sftp,
    statAsync: async () => ({ size: MAX_IN_MEMORY_READ_BYTES + 1 }),
  });

  await assert.rejects(
    api.readSftpBinary(null, { sftpId: "sftp-1", path: "/large.bin" }),
    /10 MB.*download.*external app/i,
  );
  assert.equal(streamOpened, false);
});

test("SFTP reads stop at the byte limit when the remote file grows after stat", async () => {
  let legacyGetCalled = false;
  const stream = Readable.from([
    Buffer.alloc(MAX_IN_MEMORY_READ_BYTES),
    Buffer.from("x"),
  ]);
  const sftp = {
    createReadStream() {
      return stream;
    },
  };
  const api = createApi({
    async get() {
      legacyGetCalled = true;
      return Buffer.alloc(MAX_IN_MEMORY_READ_BYTES + 1);
    },
  }, {
    requireSftpChannel: async () => sftp,
    statAsync: async () => ({ size: 1 }),
  });

  await assert.rejects(
    api.readSftp(null, { sftpId: "sftp-1", path: "/growing.log" }),
    /10 MB.*download.*external app/i,
  );
  assert.equal(legacyGetCalled, false);
  assert.equal(stream.destroyed, true);
  assert.equal(stream.listenerCount("data"), 0);
  assert.equal(stream.listenerCount("end"), 0);
  assert.equal(stream.listenerCount("error"), 0);
  assert.equal(stream.listenerCount("close"), 0);
});

test("SCP reads reject oversized files before starting the transfer", async () => {
  let readStarted = false;
  const backend = {
    async stat() {
      return { size: MAX_IN_MEMORY_READ_BYTES + 1 };
    },
    async readFile() {
      readStarted = true;
      throw new Error("oversized SCP transfer should not start");
    },
  };
  const api = createApi({
    __netcattyFileProtocol: "scp",
    __netcattyScpBackend: backend,
  });

  await assert.rejects(
    api.readSftp(null, { sftpId: "sftp-1", path: "/large.log" }),
    /10 MB.*download.*external app/i,
  );
  assert.equal(readStarted, false);
});

test("the total in-memory SFTP read deadline also bounds a stalled stat", async () => {
  const api = createApi({}, {
    requireSftpChannel: async () => ({}),
    statAsync: async () => new Promise(() => {}),
  });

  await assert.rejects(
    Promise.race([
      api.readSftp(null, { sftpId: "sftp-1", path: "/stalled.txt", timeoutMs: 5 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("test watchdog")), 100)),
    ]),
    /SFTP in-memory read timed out/i,
  );
});

test("a timed-out in-memory SFTP stream is destroyed and releases every listener", async () => {
  const stream = new EventEmitter();
  let destroyed = 0;
  stream.destroy = () => { destroyed += 1; };
  stream.close = () => { destroyed += 1; };
  const api = createApi({}, {
    requireSftpChannel: async () => ({ createReadStream: () => stream }),
    statAsync: async () => ({ size: 1 }),
  });

  await assert.rejects(
    Promise.race([
      api.readSftpBinary(null, { sftpId: "sftp-1", path: "/stalled.bin", timeoutMs: 5 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("test watchdog")), 100)),
    ]),
    /SFTP in-memory read timed out/i,
  );
  assert.ok(destroyed > 0);
  assert.equal(stream.listenerCount("data"), 0);
  assert.equal(stream.listenerCount("end"), 0);
  assert.equal(stream.listenerCount("error"), 0);
  assert.equal(stream.listenerCount("close"), 0);
});

test("in-memory SFTP stream error and premature close both release listeners", async () => {
  for (const terminalEvent of ["error", "close"]) {
    const stream = new EventEmitter();
    stream.destroy = () => {};
    stream.close = () => {};
    const api = createApi({}, {
      requireSftpChannel: async () => ({ createReadStream: () => stream }),
      statAsync: async () => ({ size: 1 }),
    });
    const reading = api.readSftp(null, { sftpId: "sftp-1", path: "/broken.txt", timeoutMs: 100 });
    process.nextTick(() => {
      if (terminalEvent === "error") stream.emit("error", new Error("read failed"));
      else stream.emit("close");
    });
    await assert.rejects(reading, /read failed|closed before/i);
    assert.equal(stream.listenerCount("data"), 0);
    assert.equal(stream.listenerCount("end"), 0);
    assert.equal(stream.listenerCount("error"), 0);
    assert.equal(stream.listenerCount("close"), 0);
  }
});
}
