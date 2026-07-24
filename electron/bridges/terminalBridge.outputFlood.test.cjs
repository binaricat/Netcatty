const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { FLOW_HIGH_WATER_MARK } = require("./terminalFlowAck.cjs");

class FakePty {
  constructor() {
    this.pid = 4242;
    this.dataHandlers = [];
    this.exitHandlers = [];
    this.paused = false;
  }

  onData(handler) {
    this.dataHandlers.push(handler);
  }

  onExit(handler) {
    this.exitHandlers.push(handler);
  }

  write() {}

  resize() {}

  kill() {}

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  emitData(data) {
    for (const handler of this.dataHandlers) handler(data);
  }

  emitExit(evt = { exitCode: 0, signal: 0 }) {
    for (const handler of this.exitHandlers) handler(evt);
  }
}

function loadBridgeWithFakes(spawns, sentries) {
  const bridgePath = require.resolve("./terminalBridge.cjs");
  delete require.cache[bridgePath];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "node-pty") {
      return {
        spawn(...spawnArgs) {
          const pty = new FakePty();
          pty.spawnArgs = spawnArgs;
          spawns.push(pty);
          return pty;
        },
      };
    }

    if (request === "serialport") {
      return { SerialPort: class { static async list() { return []; } } };
    }

    if (request === "./nodePtySpawnHelperPermissions.cjs") {
      return { ensureNodePtySpawnHelperExecutable() {} };
    }

    if (request === "./zmodemHelper.cjs") {
      return {
        createZmodemSentry(options) {
          const sentry = {
            active: false,
            consumeCalls: [],
            consume(data) {
              this.consumeCalls.push(data);
              const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
              options.onData(raw);
            },
            isActive() {
              return this.active;
            },
            cancel() {},
          };
          sentries.push(sentry);
          return sentry;
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

test("Windows local terminals enable the bundled ConPTY implementation required for clear", () => {
  const spawns = [];
  const sentries = [];
  const sessions = new Map();
  const bridge = loadBridgeWithFakes(spawns, sentries);
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  try {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    bridge.init({
      sessions,
      electronModule: {
        webContents: {
          fromId: () => ({ send() {} }),
        },
      },
    });
    bridge.startLocalSession(
      { sender: { id: 7 } },
      { sessionId: "windows-clear", shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" },
    );

    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].spawnArgs[2].useConptyDll, true);
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
});

test("local terminal buffers incoming flood while renderer flow is paused", () => {
  const spawns = [];
  const sentries = [];
  const sent = [];
  const sessions = new Map();
  const bridge = loadBridgeWithFakes(spawns, sentries);

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

  bridge.startLocalSession(
    { sender: { id: 7 } },
    { sessionId: "local-flood", shell: "/bin/sh", cols: 80, rows: 24 },
  );

  bridge.setSessionFlowPaused(
    { sender: {} },
    { sessionId: "local-flood", paused: true },
  );
  spawns[0].emitData(Buffer.from("ordinary flood"));

  assert.equal(sentries[0].consumeCalls.length, 1);
  assert.deepEqual(sent, []);
  bridge.setSessionFlowPaused(
    { sender: {} },
    { sessionId: "local-flood", paused: false },
  );
  assert.deepEqual(sent.map((item) => item.payload.data), ["ordinary flood"]);

  sentries[0].active = true;
  spawns[0].emitData(Buffer.from("transfer bytes"));

  assert.equal(sentries[0].consumeCalls.length, 2);
});

test("local terminal keeps source paused while paced backlog absorbs fresh flood", () => {
  const spawns = [];
  const sentries = [];
  const sent = [];
  const sessions = new Map();
  const bridge = loadBridgeWithFakes(spawns, sentries);

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

  bridge.startLocalSession(
    { sender: { id: 7 } },
    { sessionId: "local-flood-paced-fresh", shell: "/bin/sh", cols: 80, rows: 24 },
  );

  bridge.setSessionFlowPaused(
    { sender: {} },
    { sessionId: "local-flood-paced-fresh", paused: true },
  );
  spawns[0].emitData(Buffer.from("a".repeat(FLOW_HIGH_WATER_MARK + 10)));

  const session = sessions.get("local-flood-paced-fresh");
  assert.equal(spawns[0].paused, true);
  assert.equal(session.flowState.bufferedBytes, FLOW_HIGH_WATER_MARK + 10);
  assert.deepEqual(sent, []);

  bridge.setSessionFlowPaused(
    { sender: {} },
    { sessionId: "local-flood-paced-fresh", paused: false },
  );

  assert.equal(sent.length, 1);
  assert.equal(spawns[0].paused, true);

  spawns[0].emitData(Buffer.from("b".repeat(FLOW_HIGH_WATER_MARK)));

  assert.equal(sent.length, 1);
  assert.equal(spawns[0].paused, true);
  assert.ok(session.flowState.bufferedBytes >= FLOW_HIGH_WATER_MARK);
});

test("closing a local terminal discards buffered output instead of flushing it", () => {
  const spawns = [];
  const sentries = [];
  const sent = [];
  const sessions = new Map();
  const bridge = loadBridgeWithFakes(spawns, sentries);

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

  bridge.startLocalSession(
    { sender: { id: 7 } },
    { sessionId: "local-flood-close", shell: "/bin/sh", cols: 80, rows: 24 },
  );

  spawns[0].emitData(Buffer.from("pending tail"));
  bridge.closeSession({ sender: {} }, { sessionId: "local-flood-close" });

  assert.deepEqual(sent, [{
    channel: "netcatty:exit",
    payload: { sessionId: "local-flood-close", exitCode: 0, reason: "closed" },
  }]);
});

test("app cleanup discards buffered output instead of flushing it", () => {
  const spawns = [];
  const sentries = [];
  const sent = [];
  const sessions = new Map();
  const bridge = loadBridgeWithFakes(spawns, sentries);

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

  bridge.startLocalSession(
    { sender: { id: 7 } },
    { sessionId: "local-flood-cleanup", shell: "/bin/sh", cols: 80, rows: 24 },
  );

  spawns[0].emitData(Buffer.from("pending tail"));
  bridge.cleanupAllSessions();

  assert.deepEqual(sent, []);
  assert.equal(sessions.size, 0);
});

test("local terminal exit waits for paced buffered output drain", async () => {
  const spawns = [];
  const sentries = [];
  const sent = [];
  const sessions = new Map();
  const bridge = loadBridgeWithFakes(spawns, sentries);

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

  bridge.startLocalSession(
    { sender: { id: 7 } },
    { sessionId: "local-flood-exit", shell: "/bin/sh", cols: 80, rows: 24 },
  );

  const output = "x".repeat(2_400_000);
  spawns[0].emitData(Buffer.from(output));
  spawns[0].emitExit({ exitCode: 0, signal: 0 });

  assert.equal(sent.some((item) => item.channel === "netcatty:exit"), false);

  bridge.ackSessionFlow(
    { sender: {} },
    { sessionId: "local-flood-exit", bytes: output.length },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  const data = sent
    .filter((item) => item.channel === "netcatty:data")
    .map((item) => item.payload.data)
    .join("");
  assert.equal(data, output);
  assert.equal(sent.some((item) => item.channel === "netcatty:exit"), true);
  assert.equal(sessions.has("local-flood-exit"), false);
});

test("local terminal exit completes while renderer flow is paused", () => {
  const spawns = [];
  const sentries = [];
  const sent = [];
  const sessions = new Map();
  const bridge = loadBridgeWithFakes(spawns, sentries);

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

  bridge.startLocalSession(
    { sender: { id: 7 } },
    { sessionId: "local-paused-exit", shell: "/bin/sh", cols: 80, rows: 24 },
  );

  bridge.setSessionFlowPaused(
    { sender: {} },
    { sessionId: "local-paused-exit", paused: true },
  );
  spawns[0].emitData(Buffer.from("pending output"));
  spawns[0].emitExit({ exitCode: 0, signal: 0 });

  assert.equal(sent.some((item) => item.channel === "netcatty:data"), false);
  assert.equal(sent.some((item) => item.channel === "netcatty:exit"), true);
  assert.equal(sessions.has("local-paused-exit"), false);
});
