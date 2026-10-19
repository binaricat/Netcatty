"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const transferBridge = require("./transferBridge.cjs");
const tempDirBridge = require("./tempDirBridge.cjs");

for (const scenario of ["already-ended", "end-during-open", "close-during-open"]) {
  test(`SFTP download settles when its read channel is ${scenario}`, async (t) => {
    const transferId = `closed-read-${randomUUID()}`;
    const targetPath = tempDirBridge.getTempFilePath("closed-read.bin");
    const stagePath = tempDirBridge.getTransferTempFilePath(transferId, path.basename(targetPath));
    let timer;
    let running;
    t.after(async () => {
      clearTimeout(timer);
      await transferBridge.cancelTransfer({}, { transferId });
      await running;
      await fs.rm(targetPath, { force: true });
      await fs.rm(stagePath, { force: true });
    });
    const sftp = new EventEmitter();
    sftp.readable = scenario !== "already-ended";
    sftp.readdir = (_path, callback) => callback(null, []);
    sftp.stat = (_path, callback) => callback(null, { size: 1 });
    sftp.mkdir = (_path, callback) => callback(null);
    sftp.unlink = (_path, callback) => callback(null);
    sftp.open = () => {
      // ssh2 cannot respond to a new request once its channel has ended.
      if (scenario === "already-ended") return;
      queueMicrotask(() => {
        sftp.readable = false;
        sftp.emit(scenario === "end-during-open" ? "end" : "close");
      });
    };
    sftp.read = () => assert.fail("a closed channel must not start body reads");
    const client = {
      sftp,
      __netcattySudoMode: true,
      stat: async () => ({ size: 1 }),
    };
    transferBridge.init({ sftpClients: new Map([["source", client]]) });
    running = transferBridge.startTransfer({ sender: { send() {} } }, {
      transferId,
      sourceType: "sftp",
      targetType: "local",
      sourceSftpId: "source",
      sourcePath: "/source.bin",
      targetPath,
      totalBytes: 1,
      resumable: true,
    });
    const result = await Promise.race([
      running,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("download hung after its channel closed")), 500);
      }),
    ]);
    assert.match(result.error || "", /SFTP channel closed/i);
    assert.equal(sftp.listenerCount("end"), 0);
    assert.equal(sftp.listenerCount("close"), 0);
    assert.equal(sftp.listenerCount("error"), 0);
  });
}
