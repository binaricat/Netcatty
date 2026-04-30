const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

class FakePty {
  constructor(command, args, opts) {
    this.command = command;
    this.args = args;
    this.opts = opts;
    this.pid = FakePty.nextPid += 1;
    this.dataHandlers = [];
    this.exitHandlers = [];
    this.writes = [];
    this.resizes = [];
    this.killed = false;
  }

  onData(handler) {
    this.dataHandlers.push(handler);
  }

  onExit(handler) {
    this.exitHandlers.push(handler);
  }

  write(data) {
    this.writes.push(data);
  }

  resize(cols, rows) {
    this.resizes.push({ cols, rows });
  }

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
FakePty.nextPid = 1000;

function writeExecutable(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(filePath, 0o755);
}

function loadBridgeWithFakePty(spawns) {
  const bridgePath = require.resolve("./terminalBridge.cjs");
  delete require.cache[bridgePath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "node-pty") {
      return {
        spawn(command, args, opts) {
          const pty = new FakePty(command, args, opts);
          spawns.push(pty);
          return pty;
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("./terminalBridge.cjs");
  } finally {
    Module._load = originalLoad;
  }
}

function makeHarness(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mosh-session-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const binDir = path.join(tmp, "bin");
  const sshPath = path.join(binDir, "ssh");
  const moshClientPath = path.join(binDir, "mosh-client");
  writeExecutable(sshPath);
  writeExecutable(moshClientPath);

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;
  t.after(() => { process.env.PATH = oldPath; });

  const spawns = [];
  const bridge = loadBridgeWithFakePty(spawns);
  const sessions = new Map();
  const sent = [];
  bridge.init({
    sessions,
    electronModule: {
      webContents: {
        fromId() {
          return { send: (channel, payload) => sent.push({ channel, payload }) };
        },
      },
    },
  });

  return {
    bridge,
    sessions,
    sent,
    spawns,
    options: {
      sessionId: "mosh-test-session",
      hostname: "example.com",
      username: "alice",
      moshClientPath,
      cols: 80,
      rows: 24,
    },
    event: { sender: { id: 42 } },
  };
}

test("startMoshSession handshake path returns the same shape as the legacy path", async (t) => {
  const h = makeHarness(t);
  const result = await h.bridge.startMoshSession(h.event, h.options);
  assert.deepEqual(result, { sessionId: "mosh-test-session" });
});

test("startMoshSession handshake path honors configured PATH during discovery", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mosh-session-path-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const binDir = path.join(tmp, "bin");
  const sshPath = path.join(binDir, "ssh");
  const moshClientPath = path.join(binDir, "mosh-client");
  writeExecutable(sshPath);
  writeExecutable(moshClientPath);

  const oldPath = process.env.PATH;
  process.env.PATH = "";
  t.after(() => { process.env.PATH = oldPath; });

  const spawns = [];
  const bridge = loadBridgeWithFakePty(spawns);
  const sessions = new Map();
  const sent = [];
  bridge.init({
    sessions,
    electronModule: {
      webContents: {
        fromId() {
          return { send: (channel, payload) => sent.push({ channel, payload }) };
        },
      },
    },
  });

  const result = await bridge.startMoshSession(
    { sender: { id: 42 } },
    {
      sessionId: "mosh-path-session",
      hostname: "example.com",
      username: "alice",
      cols: 80,
      rows: 24,
      env: { PATH: binDir },
    },
  );

  assert.deepEqual(result, { sessionId: "mosh-path-session" });
  assert.equal(spawns[0].command, sshPath);

  spawns[0].emitData("MOSH CONNECT 60002 ABCDEFGHIJKLMNOPQRSTUV==\r\n");
  spawns[0].emitExit({ exitCode: 0, signal: 0 });

  assert.equal(spawns[1].command, moshClientPath);
});

test("startMoshSession handshake path sends the existing exit event on failure", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(h.event, h.options);

  h.spawns[0].emitExit({ exitCode: 255, signal: 0 });

  const exit = h.sent.find((evt) => evt.channel === "netcatty:exit");
  assert.ok(exit);
  assert.equal(exit.payload.sessionId, "mosh-test-session");
  assert.equal(exit.payload.reason, "error");
});

test("startMoshSession handshake path sends the existing exit event after mosh-client exits", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(h.event, h.options);

  h.spawns[0].emitData("MOSH CONNECT 60002 ABCDEFGHIJKLMNOPQRSTUV==\r\n");
  h.spawns[0].emitExit({ exitCode: 0, signal: 0 });

  assert.equal(h.spawns.length, 2);
  h.spawns[1].emitExit({ exitCode: 0, signal: 0 });

  const exit = h.sent.find((evt) => evt.channel === "netcatty:exit");
  assert.ok(exit);
  assert.equal(exit.payload.sessionId, "mosh-test-session");
  assert.equal(exit.payload.reason, "exited");
});
