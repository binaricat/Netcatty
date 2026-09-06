"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

/**
 * broadcastGlobalTransferEvent only loads electron when process.versions.electron
 * is set (avoids install.js downloads in bare Node unit tests).
 */
function withElectronVersionStub() {
  const previous = process.versions.electron;
  Object.defineProperty(process.versions, "electron", {
    configurable: true,
    enumerable: true,
    value: previous || "test",
  });
  return () => {
    if (previous === undefined) {
      delete process.versions.electron;
    } else {
      Object.defineProperty(process.versions, "electron", {
        configurable: true,
        enumerable: true,
        value: previous,
      });
    }
  };
}

/**
 * Drive the shipped broadcastGlobalTransferEvent entry point with a stubbed
 * electron BrowserWindow — proves fan-out does not require a panel sender.
 */
test("broadcastGlobalTransferEvent fans progress to all live BrowserWindows", () => {
  const sent = [];
  const restoreElectronVersion = withElectronVersionStub();
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") {
      return {
        BrowserWindow: {
          getAllWindows() {
            return [
              {
                isDestroyed: () => false,
                webContents: {
                  isDestroyed: () => false,
                  send(channel, payload) {
                    sent.push({ channel, payload });
                  },
                },
              },
              {
                isDestroyed: () => true,
                webContents: { isDestroyed: () => false, send() { throw new Error("dead"); } },
              },
            ];
          },
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    // Fresh load so the stub is used.
    const bridgePath = path.join(__dirname, "transferBridge.cjs");
    delete require.cache[require.resolve(bridgePath)];
    const bridge = require(bridgePath);
    assert.equal(typeof bridge.broadcastGlobalTransferEvent, "function");

    bridge.broadcastGlobalTransferEvent({
      type: "progress",
      transferId: "t-fanout",
      transferred: 50,
      totalBytes: 100,
      speed: 10,
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].channel, "netcatty:sftp:global-transfer");
    assert.equal(sent[0].payload.transferId, "t-fanout");
    assert.equal(sent[0].payload.type, "progress");
    assert.equal(sent[0].payload.transferred, 50);
  } finally {
    Module._load = originalLoad;
    restoreElectronVersion();
    try {
      delete require.cache[require.resolve(path.join(__dirname, "transferBridge.cjs"))];
    } catch { /* ignore */ }
  }
});

test("broadcastGlobalTransferEvent no-ops without transferId", () => {
  const bridge = require("./transferBridge.cjs");
  assert.doesNotThrow(() => bridge.broadcastGlobalTransferEvent({ type: "progress" }));
  assert.doesNotThrow(() => bridge.broadcastGlobalTransferEvent(null));
});

test("same-host cp capability cache follows the live SFTP client, not a recycled session id", async () => {
  const bridge = require("./transferBridge.cjs");
  const sftpClients = new Map();
  bridge.init({ sftpClients });

  const makeClient = (exitCode, calls) => ({
    client: {
      exec(_command, callback) {
        calls.count += 1;
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        stream.close = () => {};
        callback(null, stream);
        queueMicrotask(() => stream.emit("close", exitCode));
      },
    },
  });
  const firstCalls = { count: 0 };
  const secondCalls = { count: 0 };
  const event = { sender: { send() {} } };
  const payload = {
    sftpId: "recycled-sftp-id",
    sourcePath: "/source",
    targetPath: "/target",
    encoding: "utf-8",
  };

  sftpClients.set(payload.sftpId, makeClient(127, firstCalls));
  assert.equal((await bridge.sameHostCopyDirectory(event, payload)).success, false);
  assert.equal(firstCalls.count, 1);

  sftpClients.set(payload.sftpId, makeClient(0, secondCalls));
  assert.equal((await bridge.sameHostCopyDirectory(event, payload)).success, true);
  assert.equal(secondCalls.count, 1, "a replacement connection must probe cp again");
});

test("worker transfer lifecycle epochs survive a reused id and clear after the latest start settles", async () => {
  const bridgePath = path.join(__dirname, "transferBridge.cjs");
  delete require.cache[require.resolve(bridgePath)];
  const bridge = require(bridgePath);
  const handlers = new Map();
  let finishFirst;
  let finishSecond;
  const firstGate = new Promise((resolve) => { finishFirst = resolve; });
  const secondGate = new Promise((resolve) => { finishSecond = resolve; });
  let startCalls = 0;

  bridge.registerHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, {
    terminalWorkerManager: {
      request(channel) {
        if (channel === "netcatty:transfer:start") {
          startCalls += 1;
          return startCalls === 1 ? firstGate : secondGate;
        }
        return Promise.resolve({ success: true });
      },
    },
  });

  const firstStarting = handlers.get("netcatty:transfer:start")(
    { sender: { id: 1 } },
    { transferId: "worker-cache-lifetime", skipAdmission: true },
  );
  const secondStarting = handlers.get("netcatty:transfer:start")(
    { sender: { id: 1 } },
    { transferId: "worker-cache-lifetime", skipAdmission: true },
  );
  assert.equal(bridge._getWorkerTransferLifecycleEpochCountForTests(), 1);

  finishFirst({ transferId: "worker-cache-lifetime" });
  await firstStarting;
  assert.equal(
    bridge._getWorkerTransferLifecycleEpochCountForTests(),
    1,
    "an older completion must not clear the newer start's lifecycle state",
  );

  finishSecond({ transferId: "worker-cache-lifetime" });
  await secondStarting;
  assert.equal(bridge._getWorkerTransferLifecycleEpochCountForTests(), 0);
});

test("worker transfer lifecycle epoch clears after a synchronous start failure", () => {
  const bridgePath = path.join(__dirname, "transferBridge.cjs");
  delete require.cache[require.resolve(bridgePath)];
  const bridge = require(bridgePath);
  const handlers = new Map();
  bridge.registerHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, {
    terminalWorkerManager: {
      request(channel) {
        if (channel === "netcatty:transfer:start") throw new Error("worker unavailable");
        return Promise.resolve({ success: true });
      },
    },
  });

  assert.throws(() => handlers.get("netcatty:transfer:start")(
    { sender: { id: 1 } },
    { transferId: "worker-cache-sync-failure", skipAdmission: true },
  ), /worker unavailable/);
  assert.equal(bridge._getWorkerTransferLifecycleEpochCountForTests(), 0);
});

test("worker-backed pause and resume fan authoritative lifecycle to every window", async () => {
  const sent = [];
  const restoreElectronVersion = withElectronVersionStub();
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") {
      return {
        BrowserWindow: {
          getAllWindows: () => [{
            isDestroyed: () => false,
            webContents: {
              isDestroyed: () => false,
              send(channel, payload) { sent.push({ channel, payload }); },
            },
          }],
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  const bridgePath = path.join(__dirname, "transferBridge.cjs");
  try {
    delete require.cache[require.resolve(bridgePath)];
    const bridge = require(bridgePath);
    const handlers = new Map();
    let finishStart;
    const startGate = new Promise((resolve) => { finishStart = resolve; });
    bridge.registerHandlers({
      handle(channel, handler) { handlers.set(channel, handler); },
    }, {
      terminalWorkerManager: {
        async request(channel) {
          if (channel === "netcatty:transfer:start") return startGate;
          if (channel === "netcatty:transfer:pause") {
            return { success: true, checkpointBytes: 50, resumeStage: "upload" };
          }
          return { success: true };
        },
      },
    });

    const starting = handlers.get("netcatty:transfer:start")(
      { sender: { id: 1 } },
      { transferId: "worker-transfer", skipAdmission: true },
    );
    await handlers.get("netcatty:transfer:pause")(
      { sender: { id: 1 } },
      { transferId: "worker-transfer" },
    );
    await handlers.get("netcatty:transfer:resume")(
      { sender: { id: 1 } },
      { transferId: "worker-transfer" },
    );

    const lifecycle = sent
      .filter((entry) => entry.channel === "netcatty:sftp:global-transfer")
      .map((entry) => entry.payload);
    assert.deepEqual(lifecycle, [
      {
        type: "pausing",
        transferId: "worker-transfer",
        lifecycleEpoch: 1,
        lifecycleState: "pausing",
      },
      {
        type: "paused",
        transferId: "worker-transfer",
        checkpointBytes: 50,
        resumeStage: "upload",
        downloadCheckpointBytes: undefined,
        uploadCheckpointBytes: undefined,
        sourceFingerprint: undefined,
        lifecycleEpoch: 1,
        lifecycleState: "paused",
      },
      {
        type: "resumed",
        transferId: "worker-transfer",
        lifecycleEpoch: 2,
        lifecycleState: "transferring",
      },
    ]);
    finishStart({ transferId: "worker-transfer" });
    await starting;
    assert.equal(bridge._getWorkerTransferLifecycleEpochCountForTests(), 0);
  } finally {
    Module._load = originalLoad;
    restoreElectronVersion();
    delete require.cache[require.resolve(bridgePath)];
  }
});

for (const latestAction of ["pause", "resume", "cancel"]) {
  test(`stale worker pause retains latest ${latestAction} after that newer request has settled`, async (t) => {
    const bridgePath = require.resolve("./transferBridge.cjs");
    delete require.cache[bridgePath];
    t.after(() => { delete require.cache[bridgePath]; });
    const bridge = require(bridgePath);
    const handlers = new Map();
    let finishFirst;
    const firstGate = new Promise((resolve) => { finishFirst = resolve; });
    let requests = 0;
    bridge.registerHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
      terminalWorkerManager: { request: async () => ++requests === 1 ? firstGate : { success: true } },
    });
    const payload = { transferId: `worker-last-action-${latestAction}` };
    const first = handlers.get("netcatty:transfer:pause")(null, payload);
    await handlers.get(`netcatty:transfer:${latestAction}`)(null, payload);
    finishFirst({ success: true });
    const stale = await first;
    assert.equal(stale.superseded, true);
    assert.equal(stale.supersededBy, latestAction, "completed newer request must retain intent for older pending replies");
  });
}

for (const outcome of ["resume-success", "pause-success", "pause-failure", "pause-error", "resume-error"]) {
  test(`worker ${outcome} arriving after a newer pause cannot broadcast resumed`, async (t) => {
    const sent = [];
    const restore = withElectronVersionStub();
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === "electron") return { BrowserWindow: { getAllWindows: () => [{
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: (_channel, payload) => sent.push(payload) },
      }] } };
      return originalLoad(request, parent, isMain);
    };
    const bridgePath = require.resolve("./transferBridge.cjs");
    delete require.cache[bridgePath];
    t.after(() => { Module._load = originalLoad; restore(); delete require.cache[bridgePath]; });
    const bridge = require(bridgePath);
    const handlers = new Map();
    let resolveFirst;
    let rejectFirst;
    const firstGate = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
    let requests = 0;
    bridge.registerHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
      terminalWorkerManager: { request: async () => ++requests === 1 ? firstGate : { success: true } },
    });
    const payload = { transferId: `worker-order-${outcome}` };
    const channel = outcome.startsWith("resume") ? "resume" : "pause";
    const first = handlers.get(`netcatty:transfer:${channel}`)(null, payload).catch(() => null);
    await handlers.get("netcatty:transfer:pause")(null, payload);
    const afterPause = sent.length;
    if (outcome.endsWith("error")) rejectFirst(new Error("channel closed"));
    else resolveFirst({ success: outcome.endsWith("success"), reason: "pause unavailable" });
    assert.deepEqual(await first, { success: false, superseded: true, supersededBy: "pause" });
    assert.equal(sent.slice(afterPause).some((event) => event.type === "resumed"), false);
    assert.equal(sent.at(-1).type, "paused");
  });
}

for (const action of ["pause", "resume"]) {
  test(`superseded result follows rollback after latest ${action} fails`, async (t) => {
    const bridgePath = require.resolve("./transferBridge.cjs");
    delete require.cache[bridgePath];
    t.after(() => { delete require.cache[bridgePath]; });
    const bridge = require(bridgePath);
    const handlers = new Map();
    let finish;
    let calls = 0;
    bridge.registerHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
      terminalWorkerManager: { request: () => ++calls === 1
        ? new Promise(resolve => { finish = resolve; })
        : Promise.resolve({ success: false, reason: "unavailable" }) },
    });
    const payload = { transferId: `rollback-${action}` };
    const older = handlers.get("netcatty:transfer:pause")(null, payload);
    await handlers.get(`netcatty:transfer:${action}`)(null, payload);
    finish({ success: true });
    assert.equal((await older).supersededBy, action === "pause" ? "resume" : "pause");
  });
}
