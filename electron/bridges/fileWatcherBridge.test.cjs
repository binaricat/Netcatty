"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const fileWatcherBridge = require("./fileWatcherBridge.cjs");

function createHarness(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-filewatch-test-"));
  const localPath = path.join(tempDir, "edit.txt");
  fs.writeFileSync(localPath, "initial");

  const listenersByPath = new Map();
  const originalWatchFile = fs.watchFile;
  const originalUnwatchFile = fs.unwatchFile;
  fs.watchFile = (filePath, _options, listener) => {
    const listeners = listenersByPath.get(filePath) ?? new Set();
    listeners.add(listener);
    listenersByPath.set(filePath, listeners);
  };
  fs.unwatchFile = (filePath, listener) => {
    const listeners = listenersByPath.get(filePath);
    if (!listeners) return;
    if (typeof listener === "function") listeners.delete(listener);
    else listeners.clear();
    if (listeners.size === 0) listenersByPath.delete(filePath);
  };

  const handlers = new Map();
  fileWatcherBridge.init({
    sftpClients: new Map(),
    electronModule: {},
    transferBridge: require("./transferBridge.cjs"),
  });
  fileWatcherBridge.registerHandlers({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  });

  const sender = new EventEmitter();
  sender.id = Math.floor(Math.random() * 1_000_000) + 1;
  sender.isDestroyed = () => false;
  sender.send = () => {};
  const event = { sender };

  t.after(() => {
    fileWatcherBridge.stopWatchersForSession(`sftp-${sender.id}`, false);
    fs.watchFile = originalWatchFile;
    fs.unwatchFile = originalUnwatchFile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return {
    event,
    handlers,
    listenersByPath,
    localPath,
    sender,
    sftpId: `sftp-${sender.id}`,
  };
}

test("opening the same external edit twice reuses one polling watcher", async (t) => {
  const harness = createHarness(t);
  const payload = {
    localPath: harness.localPath,
    remotePath: "/remote/edit.txt",
    sftpId: harness.sftpId,
    encoding: "utf-8",
  };

  const first = await harness.handlers.get("netcatty:filewatch:start")(harness.event, payload);
  const second = await harness.handlers.get("netcatty:filewatch:start")(harness.event, payload);
  const listed = await harness.handlers.get("netcatty:filewatch:list")(harness.event, {});

  assert.equal(second.watchId, first.watchId);
  assert.equal(harness.listenersByPath.get(harness.localPath)?.size, 1);
  assert.equal(listed.length, 1);
});

test("concurrent identical starts still install only one polling watcher", async (t) => {
  const harness = createHarness(t);
  const payload = {
    localPath: harness.localPath,
    remotePath: "/remote/concurrent.txt",
    sftpId: harness.sftpId,
    encoding: "utf-8",
  };

  const [first, second] = await Promise.all([
    harness.handlers.get("netcatty:filewatch:start")(harness.event, payload),
    harness.handlers.get("netcatty:filewatch:start")(harness.event, payload),
  ]);

  assert.equal(second.watchId, first.watchId);
  assert.equal(harness.listenersByPath.get(harness.localPath)?.size, 1);
});

test("stopping one watch removes only its listener from a shared local path", async (t) => {
  const harness = createHarness(t);
  const first = await harness.handlers.get("netcatty:filewatch:start")(harness.event, {
    localPath: harness.localPath,
    remotePath: "/remote/first.txt",
    sftpId: harness.sftpId,
    encoding: "utf-8",
  });
  const second = await harness.handlers.get("netcatty:filewatch:start")(harness.event, {
    localPath: harness.localPath,
    remotePath: "/remote/second.txt",
    sftpId: harness.sftpId,
    encoding: "utf-8",
  });

  assert.notEqual(first.watchId, second.watchId);
  assert.equal(harness.listenersByPath.get(harness.localPath)?.size, 2);

  await harness.handlers.get("netcatty:filewatch:stop")(harness.event, { watchId: first.watchId });
  const listed = await harness.handlers.get("netcatty:filewatch:list")(harness.event, {});

  assert.equal(harness.listenersByPath.get(harness.localPath)?.size, 1);
  assert.deepEqual(listed.map((watch) => watch.watchId), [second.watchId]);
});

test("destroying the owner window releases its external file watches", async (t) => {
  const harness = createHarness(t);
  await harness.handlers.get("netcatty:filewatch:start")(harness.event, {
    localPath: harness.localPath,
    remotePath: "/remote/edit.txt",
    sftpId: harness.sftpId,
    encoding: "utf-8",
  });

  harness.sender.emit("destroyed");
  await new Promise((resolve) => setImmediate(resolve));

  const listed = await harness.handlers.get("netcatty:filewatch:list")(harness.event, {});
  assert.equal(listed.length, 0);
  assert.equal(harness.listenersByPath.has(harness.localPath), false);
});

test("closing an SFTP session releases every watcher for that session", async (t) => {
  const harness = createHarness(t);
  const stoppedEvents = [];
  harness.sender.send = (channel, payload) => {
    if (channel === "netcatty:filewatch:stopped") stoppedEvents.push(payload);
  };
  await harness.handlers.get("netcatty:filewatch:start")(harness.event, {
    localPath: harness.localPath,
    remotePath: "/remote/first.txt",
    sftpId: harness.sftpId,
    encoding: "utf-8",
  });
  await harness.handlers.get("netcatty:filewatch:start")(harness.event, {
    localPath: harness.localPath,
    remotePath: "/remote/second.txt",
    sftpId: harness.sftpId,
    encoding: "utf-8",
  });

  fileWatcherBridge.stopWatchersForSession(harness.sftpId, false);

  const listed = await harness.handlers.get("netcatty:filewatch:list")(harness.event, {});
  assert.equal(listed.length, 0);
  assert.equal(harness.listenersByPath.has(harness.localPath), false);
  assert.equal(stoppedEvents.length, 2);
  assert.deepEqual(new Set(stoppedEvents.map((event) => event.sftpId)), new Set([harness.sftpId]));
});

test("worker proxy releases renderer-owned watchers when its window is destroyed", async () => {
  const handlers = new Map();
  const requests = [];
  const terminalWorkerManager = {
    request(channel, payload, options) {
      requests.push({ channel, payload, options });
      return Promise.resolve(channel === "netcatty:filewatch:start" ? { watchId: "worker-watch" } : null);
    },
  };
  fileWatcherBridge.registerHandlers({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  }, { terminalWorkerManager });
  const sender = new EventEmitter();
  sender.id = 72;
  const event = { sender };

  await handlers.get("netcatty:filewatch:start")(event, {
    localPath: "/tmp/edit.txt",
    remotePath: "/remote/edit.txt",
    sftpId: "sftp-worker",
  });
  sender.emit("destroyed");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(requests.at(-1), {
    channel: "netcatty:filewatch:releaseOwner",
    payload: { webContentsId: 72, cleanupTempFiles: true },
    options: { webContentsId: 72 },
  });
});

test("session close cancels a watch whose initial stat is still pending", async (t) => {
  const harness = createHarness(t);
  const originalStat = fs.promises.stat;
  let finishStat;
  fs.promises.stat = () => new Promise((resolve) => {
    finishStat = () => resolve({ mtimeMs: 1, size: 7 });
  });
  t.after(() => { fs.promises.stat = originalStat; });

  const starting = harness.handlers.get("netcatty:filewatch:start")(harness.event, {
    localPath: harness.localPath,
    remotePath: "/remote/pending.txt",
    sftpId: harness.sftpId,
    encoding: "utf-8",
  });
  await new Promise((resolve) => setImmediate(resolve));
  fileWatcherBridge.stopWatchersForSession(harness.sftpId, true);
  finishStat();

  await assert.rejects(starting, /cancelled|closed/i);
  const listed = await harness.handlers.get("netcatty:filewatch:list")(harness.event, {});
  assert.equal(listed.length, 0);
  assert.equal(harness.listenersByPath.has(harness.localPath), false);
});

for (const warning of [undefined, "Upload completed; remove backup /remote/.netcatty-backup-edit.txt manually."]) {
test(`external edit sync streams without buffering and ${warning ? "preserves a cleanup warning" : "reports clean success"}`, async (t) => {
  const harness = createHarness(t);
  const transferBridge = require("./transferBridge.cjs");
  const originalStartInternalTransfer = transferBridge.startInternalTransfer;
  const originalReadFile = fs.promises.readFile;
  let directPutCalls = 0;
  let wholeFileReadCalls = 0;
  const internalTransfers = [];
  const sent = [];

  transferBridge.startInternalTransfer = async (_event, payload) => {
    internalTransfers.push(payload);
    return { transferId: payload.transferId, ...(warning ? { warning } : {}) };
  };
  fs.promises.readFile = async (...args) => {
    wholeFileReadCalls += 1;
    return originalReadFile(...args);
  };
  harness.sender.send = (channel, payload) => {
    sent.push({ channel, payload });
  };
  fileWatcherBridge.init({
    sftpClients: new Map([[
      harness.sftpId,
      {
        put: async () => { directPutCalls += 1; },
      },
    ]]),
    electronModule: {},
    transferBridge,
  });
  t.after(() => {
    transferBridge.startInternalTransfer = originalStartInternalTransfer;
    fs.promises.readFile = originalReadFile;
  });

  await harness.handlers.get("netcatty:filewatch:start")(harness.event, {
    localPath: harness.localPath,
    remotePath: "/remote/edit.txt",
    sftpId: harness.sftpId,
    encoding: "utf-8",
  });
  const listener = [...harness.listenersByPath.get(harness.localPath)][0];
  const previousStat = fs.statSync(harness.localPath);
  fs.writeFileSync(harness.localPath, "modified external edit");
  const currentStat = fs.statSync(harness.localPath);
  listener(
    currentStat,
    previousStat,
  );

  const deadline = Date.now() + 2_000;
  while (!sent.some((event) => event.channel === "netcatty:filewatch:synced")) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for external edit sync");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(internalTransfers.length, 1);
  assert.equal(internalTransfers[0].sourcePath, harness.localPath);
  assert.equal(internalTransfers[0].targetPath, "/remote/edit.txt");
  assert.equal(internalTransfers[0].sourceType, "local");
  assert.equal(internalTransfers[0].targetType, "sftp");
  assert.equal(internalTransfers[0].targetSftpId, harness.sftpId);
  assert.equal(wholeFileReadCalls, 0);
  assert.equal(directPutCalls, 0);
  assert.equal(sent.find((event) => event.channel === "netcatty:filewatch:synced")?.payload.warning, warning);
  assert.equal(sent.some((event) => event.channel === "netcatty:filewatch:error"), false);
});
}

test("closing the SFTP session cancels an active external edit stream", async (t) => {
  const harness = createHarness(t);
  const transferBridge = require("./transferBridge.cjs");
  const originalStartInternalTransfer = transferBridge.startInternalTransfer;
  const originalCancelTransfer = transferBridge.cancelTransfer;
  let activeTransferId;
  let finishTransfer;
  const cancelledTransferIds = [];

  transferBridge.startInternalTransfer = async (_event, payload) => {
    activeTransferId = payload.transferId;
    return new Promise((resolve) => {
      finishTransfer = resolve;
    });
  };
  transferBridge.cancelTransfer = async (_event, payload) => {
    cancelledTransferIds.push(payload.transferId);
    finishTransfer?.({ transferId: payload.transferId, cancelled: true, error: "Transfer cancelled" });
    return { success: true };
  };
  fileWatcherBridge.init({
    sftpClients: new Map([[harness.sftpId, {}]]),
    electronModule: {},
    transferBridge,
  });
  t.after(() => {
    transferBridge.startInternalTransfer = originalStartInternalTransfer;
    transferBridge.cancelTransfer = originalCancelTransfer;
  });

  await harness.handlers.get("netcatty:filewatch:start")(harness.event, {
    localPath: harness.localPath,
    remotePath: "/remote/edit.txt",
    sftpId: harness.sftpId,
    encoding: "utf-8",
  });
  const listener = [...harness.listenersByPath.get(harness.localPath)][0];
  const previousStat = fs.statSync(harness.localPath);
  fs.writeFileSync(harness.localPath, "modified before close");
  listener(fs.statSync(harness.localPath), previousStat);

  const startDeadline = Date.now() + 2_000;
  while (!activeTransferId) {
    if (Date.now() >= startDeadline) throw new Error("Timed out waiting for external edit stream");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  fileWatcherBridge.stopWatchersForSession(harness.sftpId, false);
  const cancelDeadline = Date.now() + 1_000;
  while (cancelledTransferIds.length === 0) {
    if (Date.now() >= cancelDeadline) throw new Error("Timed out waiting for stream cancellation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(cancelledTransferIds, [activeTransferId]);
});

test("session cleanup retries a temporarily locked external edit file", async (t) => {
  const harness = createHarness(t);
  const originalUnlink = fs.promises.unlink;
  let unlinkAttempts = 0;
  fs.promises.unlink = async (filePath) => {
    if (filePath !== harness.localPath) return originalUnlink(filePath);
    unlinkAttempts += 1;
    if (unlinkAttempts === 1) {
      const error = new Error("file is still in use");
      error.code = "EBUSY";
      throw error;
    }
    return originalUnlink(filePath);
  };
  t.after(() => { fs.promises.unlink = originalUnlink; });

  await harness.handlers.get("netcatty:filewatch:registerTempFile")(harness.event, {
    sftpId: harness.sftpId,
    localPath: harness.localPath,
  });
  await harness.handlers.get("netcatty:filewatch:start")(harness.event, {
    localPath: harness.localPath,
    remotePath: "/remote/edit.txt",
    sftpId: harness.sftpId,
    encoding: "utf-8",
  });

  fileWatcherBridge.stopWatchersForSession(harness.sftpId, true);

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await fs.promises.stat(harness.localPath);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(unlinkAttempts >= 2, "a transient Windows file lock must be retried");
  await assert.rejects(fs.promises.stat(harness.localPath), { code: "ENOENT" });
});

test("failed external app launch can unregister and immediately delete its temp file", async (t) => {
  const harness = createHarness(t);
  await harness.handlers.get("netcatty:filewatch:registerTempFile")(harness.event, {
    sftpId: harness.sftpId,
    localPath: harness.localPath,
  });
  const result = await harness.handlers.get("netcatty:filewatch:unregisterTempFile")(harness.event, {
    sftpId: harness.sftpId,
    localPath: harness.localPath,
  });
  assert.equal(result.success, true);
  assert.equal(result.retained, false);
  await assert.rejects(fs.promises.stat(harness.localPath), { code: "ENOENT" });
});

test("cleanup stops all active watchers and clears tracked temp files", async (t) => {
  const harness = createHarness(t);
  assert.equal(typeof fileWatcherBridge.cleanup, "function");

  await harness.handlers.get("netcatty:filewatch:registerTempFile")(harness.event, {
    sftpId: harness.sftpId,
    localPath: harness.localPath,
  });
  await harness.handlers.get("netcatty:filewatch:start")(harness.event, {
    localPath: harness.localPath,
    remotePath: "/remote/cleanup.txt",
    sftpId: harness.sftpId,
    encoding: "utf-8",
  });

  assert.equal(harness.listenersByPath.get(harness.localPath)?.size, 1);

  fileWatcherBridge.cleanup();

  const listed = await harness.handlers.get("netcatty:filewatch:list")(harness.event, {});
  assert.equal(listed.length, 0);
  assert.equal(harness.listenersByPath.has(harness.localPath), false);

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await fs.promises.stat(harness.localPath);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await assert.rejects(fs.promises.stat(harness.localPath), { code: "ENOENT" });
});
