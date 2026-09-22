"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const compressUploadBridge = require("./compressUploadBridge.cjs");

test("compressed commits to the same remote folder are serialized", async () => {
  let active = 0;
  let maxActive = 0;
  const order = [];
  const run = compressUploadBridge._runWithCompressionTargetLockForTests;
  const first = run("sftp-1:/target/folder", null, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push("first-end");
    active -= 1;
  });
  const second = run("sftp-1:/target/folder", null, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push("second-start");
    active -= 1;
  });
  await Promise.all([first, second]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
  assert.equal(compressUploadBridge._getCompressionTargetLockCountForTests(), 0);
});

test("compressed commits through different SFTP channels share the endpoint target lock", async () => {
  compressUploadBridge.init({
    sftpClients: new Map([
      ["window-a-sftp", { __netcattyEndpointKey: "host|route|auth" }],
      ["window-b-sftp", { __netcattyEndpointKey: "host|route|auth" }],
    ]),
    transferBridge: {},
  });
  const resolveKey = compressUploadBridge._resolveCompressionTargetKeyForTests;
  const firstKey = resolveKey("window-a-sftp", "/target/./nested/..", "folder");
  const secondKey = resolveKey("window-b-sftp", "/target", "folder");
  assert.equal(firstKey, secondKey);

  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  const run = compressUploadBridge._runWithCompressionTargetLockForTests;
  const first = run(firstKey, null, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => { releaseFirst = resolve; });
    active -= 1;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = run(secondKey, null, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    active -= 1;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxActive, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(maxActive, 1);
});

test("an aborted lock waiter cannot let a later compressed commit bypass the active owner", async () => {
  const run = compressUploadBridge._runWithCompressionTargetLockForTests;
  let releaseFirst;
  let thirdStarted = false;
  const first = run("sftp-1:/target/abort", null, () => new Promise((resolve) => {
    releaseFirst = resolve;
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const second = run("sftp-1:/target/abort", controller.signal, async () => {});
  controller.abort(new Error("cancelled waiter"));
  await assert.rejects(second, /cancelled waiter/);
  const third = run("sftp-1:/target/abort", null, async () => { thirdStarted = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(thirdStarted, false);
  releaseFirst();
  await Promise.all([first, third]);
  assert.equal(thirdStarted, true);
});

test("worker-backed compressed pause and resume publish ordered lifecycle", async () => {
  const handlers = new Map();
  const events = [];
  let finishStart;
  const startGate = new Promise((resolve) => { finishStart = resolve; });
  compressUploadBridge.init({
    sftpClients: new Map(),
    transferBridge: {
      acquireTransferSessionLeases(_leaseId, payload) { return [payload.targetSftpId]; },
      releaseTransferSessionLeases() {},
      broadcastGlobalTransferEvent(event) { events.push(event); },
    },
  });
  compressUploadBridge.registerHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, {
    terminalWorkerManager: {
      async request(channel) {
        if (channel === "netcatty:compress:start") return startGate;
        if (channel === "netcatty:compress:pause") {
          return { success: true, deferred: false };
        }
        return { success: true };
      },
    },
  });

  const starting = handlers.get("netcatty:compress:start")(
    { sender: { id: 1 } },
    { compressionId: "compressed-worker" },
  );
  await handlers.get("netcatty:compress:pause")(
    { sender: { id: 1 } },
    { compressionId: "compressed-worker" },
  );
  await handlers.get("netcatty:compress:resume")(
    { sender: { id: 1 } },
    { compressionId: "compressed-worker" },
  );

  assert.deepEqual(events, [
    {
      type: "pausing",
      transferId: "compressed-worker",
      lifecycleEpoch: 1,
      lifecycleState: "pausing",
    },
    {
      type: "paused",
      transferId: "compressed-worker",
      lifecycleEpoch: 1,
      lifecycleState: "paused",
    },
    {
      type: "resumed",
      transferId: "compressed-worker",
      lifecycleEpoch: 2,
      lifecycleState: "transferring",
    },
  ]);
  finishStart({ compressionId: "compressed-worker", success: true });
  await starting;
  assert.equal(compressUploadBridge._getWorkerCompressionLifecycleEpochCountForTests(), 0);
});

test("worker compression lifecycle epochs survive a reused id and clear after the latest start settles", async () => {
  const handlers = new Map();
  let finishFirst;
  let finishSecond;
  const firstGate = new Promise((resolve) => { finishFirst = resolve; });
  const secondGate = new Promise((resolve) => { finishSecond = resolve; });
  let startCalls = 0;
  compressUploadBridge.registerHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, {
    terminalWorkerManager: {
      request(channel) {
        if (channel === "netcatty:compress:start") {
          startCalls += 1;
          return startCalls === 1 ? firstGate : secondGate;
        }
        return Promise.resolve({ success: true });
      },
    },
  });

  const firstStarting = handlers.get("netcatty:compress:start")(
    { sender: { id: 1 } },
    { compressionId: "compression-cache-lifetime" },
  );
  const secondStarting = handlers.get("netcatty:compress:start")(
    { sender: { id: 1 } },
    { compressionId: "compression-cache-lifetime" },
  );
  assert.equal(compressUploadBridge._getWorkerCompressionLifecycleEpochCountForTests(), 1);

  finishFirst({ compressionId: "compression-cache-lifetime", success: true });
  await firstStarting;
  assert.equal(
    compressUploadBridge._getWorkerCompressionLifecycleEpochCountForTests(),
    1,
    "an older completion must not clear the newer start's lifecycle state",
  );

  finishSecond({ compressionId: "compression-cache-lifetime", success: true });
  await secondStarting;
  assert.equal(compressUploadBridge._getWorkerCompressionLifecycleEpochCountForTests(), 0);
});

test("worker compression lifecycle epoch clears after a synchronous start failure", () => {
  const handlers = new Map();
  compressUploadBridge.registerHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, {
    terminalWorkerManager: {
      request(channel) {
        if (channel === "netcatty:compress:start") throw new Error("worker unavailable");
        return Promise.resolve({ success: true });
      },
    },
  });

  assert.throws(() => handlers.get("netcatty:compress:start")(
    { sender: { id: 1 } },
    { compressionId: "compression-cache-sync-failure" },
  ), /worker unavailable/);
  assert.equal(compressUploadBridge._getWorkerCompressionLifecycleEpochCountForTests(), 0);
});

test("cancelling while the remote tar probe is pending publishes cancelled", async () => {
  const handlers = new Map();
  const events = [];
  let remoteProbeStarted;
  const remoteProbeGate = new Promise((resolve) => { remoteProbeStarted = resolve; });
  const remoteStream = new (require("node:events").EventEmitter)();
  remoteStream.stderr = new (require("node:events").EventEmitter)();
  remoteStream.close = () => {};
  remoteStream.end = () => {};
  remoteStream.destroy = () => {};
  const sender = { id: 1, send() {} };

  compressUploadBridge.init({
    sftpClients: new Map([["sftp-probe", {
      client: {
        exec(_command, callback) {
          callback(null, remoteStream);
          remoteProbeStarted();
        },
      },
    }]]),
    transferBridge: {
      acquireTransferSessionLeases(_leaseId, payload) { return [payload.targetSftpId]; },
      releaseTransferSessionLeases() {},
      broadcastGlobalTransferEvent(event) { events.push(event); },
    },
  });
  compressUploadBridge.registerHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  });

  const starting = handlers.get("netcatty:compress:start")({ sender }, {
    compressionId: "cancel-during-probe",
    folderPath: "/unused",
    targetPath: "/unused",
    sftpId: "sftp-probe",
    folderName: "unused",
    totalBytes: 1,
  });
  await remoteProbeGate;
  await handlers.get("netcatty:compress:cancel")({ sender }, {
    compressionId: "cancel-during-probe",
  });
  await starting;

  assert.equal(events.at(-1)?.type, "cancelled");
  assert.equal(events.some((event) => event.type === "failed"), false);
});

test("compressed upload holds its SFTP session until remote extraction settles", async (t) => {
  const handlers = new Map();
  const calls = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-compress-lease-"));
  const folderPath = path.join(root, "folder");
  fs.mkdirSync(folderPath);
  fs.writeFileSync(path.join(folderPath, "file.txt"), "payload");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let extractionStarted;
  const extractionGate = new Promise((resolve) => { extractionStarted = resolve; });
  let cleanupStarted;
  const cleanupGate = new Promise((resolve) => { cleanupStarted = resolve; });
  const streams = [];
  const cleanupStreams = [];
  let extractionStream = null;
  const makeStream = () => {
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.close = () => stream.emit("close", 1);
    stream.end = () => {};
    stream.destroy = () => {};
    streams.push(stream);
    return stream;
  };
  const sshClient = {
    exec(command, callback) {
      const stream = makeStream();
      callback(null, stream);
      if (command === "tar --version") {
        process.nextTick(() => {
          stream.emit("data", Buffer.from("tar"));
          stream.emit("close", 0);
        });
      } else if (command.includes("tar -xzf")) {
        extractionStream = stream;
        extractionStarted();
      } else {
        cleanupStreams.push(stream);
        cleanupStarted();
      }
    },
  };

  compressUploadBridge.init({
    sftpClients: new Map([["sftp-compressed", {
      client: sshClient,
      __netcattyEndpointKey: "endpoint:compressed",
    }]]),
    transferBridge: {
      acquireTransferSessionLeases(leaseId, payload) {
        calls.push(`acquire:${leaseId}:${payload.targetSftpId}`);
        return [payload.targetSftpId];
      },
      releaseTransferSessionLeases(leaseId, sftpIds) {
        calls.push(`release:${leaseId}:${sftpIds.join(",")}`);
      },
      async startInternalTransfer() {
        calls.push("upload");
        return { success: true };
      },
      async cancelTransfer() { return { success: true }; },
      broadcastGlobalTransferEvent() {},
    },
  });
  compressUploadBridge.registerHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  });

  const sender = { id: 1, send() {} };
  const starting = handlers.get("netcatty:compress:start")({ sender }, {
    compressionId: "compressed-lifecycle",
    folderPath,
    targetPath: "/tmp",
    sftpId: "sftp-compressed",
    folderName: "folder",
    totalBytes: 7,
  });
  let startSettled = false;
  void starting.then(() => { startSettled = true; }, () => { startSettled = true; });
  await extractionGate;

  assert.deepEqual(calls, [
    "acquire:compress-lifecycle:compressed-lifecycle:sftp-compressed",
    "upload",
  ]);

  extractionStream.emit("close", 0);
  await cleanupGate;
  assert.deepEqual(
    calls,
    [
      "acquire:compress-lifecycle:compressed-lifecycle:sftp-compressed",
      "upload",
    ],
    "the outer SFTP lease must remain held while remote cleanup is still running",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(startSettled, false, "compressed upload must await remote cleanup before releasing its lease");
  for (const stream of cleanupStreams) stream.emit("close", 0);
  await starting;

  assert.deepEqual(calls, [
    "acquire:compress-lifecycle:compressed-lifecycle:sftp-compressed",
    "upload",
    "release:compress-lifecycle:compressed-lifecycle:sftp-compressed",
  ]);
});

test("compressed upload never deletes AppleDouble files across the target parent", async (t) => {
  const remoteCommands = [];
  const harness = createSuccessfulCompressionHarness(t, {
    onRemoteCommand(command) { remoteCommands.push(command); },
  });

  const result = await harness.handlers.get("netcatty:compress:start")({ sender: harness.sender }, {
    compressionId: "no-parent-cleanup",
    folderPath: harness.folderPath,
    targetPath: "/srv/shared",
    sftpId: "sftp-harness",
    folderName: "folder",
    totalBytes: 7,
  });

  assert.equal(result.success, true);
  assert.equal(
    remoteCommands.some((command) => /\bfind\b[\s\S]*\._\*/.test(command)),
    false,
    "cleanup must not scan and delete pre-existing ._* files under the whole target parent",
  );
  assert.equal(
    remoteCommands.some((command) => /^rm -f /.test(command)),
    true,
    "the uploaded archive still receives a bounded best-effort cleanup",
  );
});

function createSuccessfulCompressionHarness(t, { onRemoteCommand, onUpload } = {}) {
  const handlers = new Map();
  const events = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-compress-harness-"));
  const folderPath = path.join(root, "folder");
  fs.mkdirSync(folderPath);
  fs.writeFileSync(path.join(folderPath, "file.txt"), "payload");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sshClient = {
    writable: true,
    exec(command, callback) {
      onRemoteCommand?.(command);
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      stream.end = () => {};
      stream.destroy = () => {};
      callback(null, stream);
      process.nextTick(() => {
        if (command === "tar --version") stream.emit("data", Buffer.from("tar"));
        stream.emit("close", 0);
      });
    },
  };
  compressUploadBridge._resetCompressionSupportCacheForTests?.();
  compressUploadBridge.init({
    sftpClients: new Map([["sftp-harness", {
      client: sshClient,
      __netcattyEndpointKey: "endpoint:harness",
    }]]),
    transferBridge: {
      acquireTransferSessionLeases(_leaseId, payload) { return [payload.targetSftpId]; },
      releaseTransferSessionLeases() {},
      broadcastGlobalTransferEvent(event) { events.push(event); },
      async startInternalTransfer(_event, payload) {
        onUpload?.(payload);
        return { success: true };
      },
      async cancelTransfer() { return { success: true }; },
    },
  });
  compressUploadBridge.registerHandlers({ handle(channel, handler) { handlers.set(channel, handler); } });
  return { handlers, events, folderPath, sender: { id: 1, send() {} } };
}

test("support preflight is reused by the immediately following compressed start", async (t) => {
  let remoteProbeCalls = 0;
  const harness = createSuccessfulCompressionHarness(t, {
    onRemoteCommand(command) {
      if (command === "tar --version") remoteProbeCalls += 1;
    },
  });
  const support = await harness.handlers.get("netcatty:compress:checkSupport")(
    { sender: harness.sender },
    { sftpId: "sftp-harness" },
  );
  assert.equal(support.supported, true);

  const result = await harness.handlers.get("netcatty:compress:start")({ sender: harness.sender }, {
    compressionId: "cached-support-start",
    folderPath: harness.folderPath,
    targetPath: "/tmp",
    sftpId: "sftp-harness",
    folderName: "folder",
    totalBytes: 7,
  });

  assert.equal(result.success, true);
  assert.equal(remoteProbeCalls, 1);
});

test("remote archive paths are unique for concurrent operation identities", async (t) => {
  const uploadedPaths = [];
  const harness = createSuccessfulCompressionHarness(t, {
    onUpload(payload) { uploadedPaths.push(payload.targetPath); },
  });

  await Promise.all([
    harness.handlers.get("netcatty:compress:start")({ sender: harness.sender }, {
      compressionId: "archive-one",
      folderPath: harness.folderPath,
      targetPath: "/tmp",
      sftpId: "sftp-harness",
      folderName: "folder",
      totalBytes: 7,
    }),
    harness.handlers.get("netcatty:compress:start")({ sender: harness.sender }, {
      compressionId: "archive-two",
      folderPath: harness.folderPath,
      targetPath: "/tmp",
      sftpId: "sftp-harness",
      folderName: "folder",
      totalBytes: 7,
    }),
  ]);

  assert.equal(uploadedPaths.length, 2);
  assert.notEqual(uploadedPaths[0], uploadedPaths[1]);
});

test("a late cancel after completion cannot overwrite the completed terminal event", async (t) => {
  const harness = createSuccessfulCompressionHarness(t);
  await harness.handlers.get("netcatty:compress:start")({ sender: harness.sender }, {
    compressionId: "completed-before-cancel",
    folderPath: harness.folderPath,
    targetPath: "/tmp",
    sftpId: "sftp-harness",
    folderName: "folder",
    totalBytes: 7,
  });
  const terminalBefore = harness.events.filter((event) => (
    event.transferId === "completed-before-cancel"
    && ["completed", "cancelled", "failed"].includes(event.type)
  ));
  assert.deepEqual(terminalBefore.map((event) => event.type), ["completed"]);

  await harness.handlers.get("netcatty:compress:cancel")({ sender: harness.sender }, {
    compressionId: "completed-before-cancel",
  });
  const terminalAfter = harness.events.filter((event) => (
    event.transferId === "completed-before-cancel"
    && ["completed", "cancelled", "failed"].includes(event.type)
  ));
  assert.deepEqual(terminalAfter.map((event) => event.type), ["completed"]);
});

test("compressed upload skips remote tar exec on single-channel SSH", async () => {
  let execCalls = 0;
  compressUploadBridge._resetCompressionSupportCacheForTests();
  compressUploadBridge.init({
    sftpClients: new Map([
      ["sftp-1", {
        __netcattySingleChannelSsh: true,
        client: {
          exec() {
            execCalls += 1;
            throw new Error("must not exec on single-channel SSH");
          },
        },
      }],
    ]),
    transferBridge: {},
  });

  const result = await compressUploadBridge._checkCompressedUploadSupportForTests(null, {
    sftpId: "sftp-1",
  });

  assert.equal(result.supported, false);
  assert.equal(result.remoteTar, false);
  assert.equal(execCalls, 0);
});
