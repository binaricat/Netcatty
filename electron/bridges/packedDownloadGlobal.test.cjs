"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { createPreloadApi } = require("../preload/api.cjs");
const sftpBridge = require("./sftpBridge.cjs");
const transferBridge = require("./transferBridge.cjs");
const { setPackedDownloadLifecycle } = require("./sftpBridge/packedDownloadLifecycle.cjs");

test("real preload and main worker handlers share packed jobs and route controls through their owner", async t => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const requests = [], updates = [[], []], observers = [];
  let finishStream, workerEvent;
  const terminalWorkerManager = {
    onWorkerRendererEvent(listener) { workerEvent = listener; },
    onWorkerExit() {},
    async request(channel, payload, options) {
      requests.push({ channel, payload, options });
      if (channel === "netcatty:sftp:downloadPacked") {
        workerEvent({ channel: "netcatty:sftp:packedProgress", payload: { transferId: payload.transferId, phase: "receiving", bytes: 9 } });
        return new Promise(resolve => { finishStream = resolve; });
      }
      if (channel === "netcatty:sftp:cancelPacked") { finishStream({ status: "cancelled" }); return; }
      throw new Error(`Unexpected worker request ${channel}`);
    },
  };
  const oldBroadcast = transferBridge.broadcastGlobalTransferEvent;
  transferBridge.broadcastGlobalTransferEvent = (event) => {
    for (const listeners of observers) for (const listener of listeners) listener(event);
  };
  t.after(() => { transferBridge.broadcastGlobalTransferEvent = oldBroadcast; setPackedDownloadLifecycle(null); });
  sftpBridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: {} });
  sftpBridge.registerHandlers(ipcMain, { terminalWorkerManager });
  transferBridge.registerHandlers(ipcMain, { terminalWorkerManager });
  const apis = [11, 22].map((id, index) => {
    const sender = Object.assign(new EventEmitter(), { id, isDestroyed: () => false });
    const listeners = new Set();
    observers.push(listeners);
    const renderer = Object.assign(new EventEmitter(), {
      invoke: (channel, payload) => Promise.resolve(handlers.get(channel)({ sender }, payload)),
    });
    const api = createPreloadApi({ ipcRenderer: renderer, globalSftpTransferListeners: listeners });
    api.onGlobalSftpTransferEvent(update => updates[index].push(update));
    return api;
  });
  const metadata = { transferId: "shared", fileName: "compose", sourcePath: "/srv/compose", targetPath: "/tmp/compose",
    sourceConnectionId: "detached-ssh", packedTargetPaths: ["/tmp/compose"] };
  await apis[1].registerPackedDownload(metadata);
  assert.equal(updates[0][0].type, "queued");
  assert.equal(updates[0][0].controlKind, "packed-download");
  const paused = await apis[0].pauseTransfer("shared");
  assert.equal(paused.success, false);
  assert.equal(requests.length, 0, "cannot reach ordinary worker pause for packed work");
  const running = apis[1].downloadPackedSftp({ transferId: "shared", sftpId: "sftp-2", remoteDirectory: "/srv", names: ["compose"], localDirectory: "/tmp" });
  await Promise.resolve();
  await apis[0].cancelTransfer("shared");
  assert.deepEqual(await running, { status: "cancelled" });
  const control = requests.find(request => request.channel === "netcatty:sftp:cancelPacked");
  assert.equal(control.options.webContentsId, 22, "main forwards cross-window cancel using the original owner");
  assert.deepEqual(updates[0].map(event => event.type), ["queued", "started", "progress", "cancelled"]);
  assert.deepEqual(updates[0], updates[1]);
  await apis[1].finishPackedDownload("shared", { status: "cancelled" });

  await apis[1].registerPackedDownload({ ...metadata, transferId: "queued" });
  await apis[0].cancelTransfer("queued");
  assert.equal(updates[0].at(-1).type, "cancelled");
  assert.equal(requests.filter(request => request.channel === "netcatty:sftp:downloadPacked").length, 1);
  await apis[1].finishPackedDownload("queued", { status: "cancelled" });
});
