const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const transferBridge = require("./transferBridge.cjs");

function createSender() {
  return {
    sent: [],
    send(channel, payload) {
      this.sent.push({ channel, payload });
    },
  };
}

function createFastSftp(overrides) {
  const sftp = new EventEmitter();
  sftp.readdir = (_path, callback) => callback(null, []);
  sftp.stat = (_path, callback) => callback(null, { size: 1024 * 1024 });
  sftp.mkdir = (_path, callback) => callback(null);
  sftp.unlink = (_path, callback) => callback(null);
  sftp.end = () => {};
  Object.assign(sftp, overrides);
  return sftp;
}

test("SFTP uploads use conservative per-file request concurrency", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-test-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const localPath = path.join(tempDir, "large.bin");
  await fs.promises.writeFile(localPath, Buffer.alloc(1024 * 1024));

  let observedConcurrency = 0;
  let observedChunkSize = 0;
  const fastSftp = createFastSftp({
    fastPut(_localPath, _remotePath, options, done) {
      observedConcurrency = options.concurrency;
      observedChunkSize = options.chunkSize;
      options.step?.(1024 * 1024, 1024 * 1024, 1024 * 1024);
      queueMicrotask(() => done());
    },
  });
  const client = {
    sftp: createFastSftp({}),
    stat() {
      return Promise.resolve({ size: 1024 * 1024 });
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const sender = createSender();
  const result = await transferBridge.startTransfer(
    { sender },
    {
      transferId: "upload-large",
      sourcePath: localPath,
      targetPath: "/tmp/large.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
    },
  );

  assert.equal(result.error, undefined);
  assert.equal(observedConcurrency, 4);
  assert.equal(observedChunkSize, 32 * 1024);
});

test("SFTP uploads fail when remote size does not match local size", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-size-test-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const localPath = path.join(tempDir, "archive.zip");
  await fs.promises.writeFile(localPath, Buffer.alloc(1024 * 1024));

  let deletedRemotePath = null;
  const fastSftp = createFastSftp({
    fastPut(_localPath, _remotePath, options, done) {
      options.step?.(1024 * 1024, 1024 * 1024, 1024 * 1024);
      queueMicrotask(() => done());
    },
  });
  const client = {
    sftp: createFastSftp({}),
    stat() {
      // Simulate a truncated remote file after a "successful" fastPut.
      return Promise.resolve({ size: 512 * 1024 });
    },
    delete(remotePath) {
      deletedRemotePath = remotePath;
      return Promise.resolve();
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const sender = createSender();
  const result = await transferBridge.startTransfer(
    { sender },
    {
      transferId: "upload-truncated",
      sourcePath: localPath,
      targetPath: "/tmp/archive.zip",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
    },
  );

  assert.match(result.error || "", /Upload size mismatch/);
  assert.equal(deletedRemotePath, "/tmp/archive.zip");
  assert.ok(sender.sent.some((entry) => entry.channel === "netcatty:transfer:error"));
});

test("SFTP stream-fallback uploads wait for close after finish", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-stream-test-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const localPath = path.join(tempDir, "payload.bin");
  const payload = Buffer.alloc(64 * 1024, 7);
  await fs.promises.writeFile(localPath, payload);

  let resolveClose;
  const closeGate = new Promise((resolve) => {
    resolveClose = resolve;
  });
  let sawFinishBeforeClose = false;
  let remoteBytes = 0;

  const streamSftp = createFastSftp({
    createWriteStream() {
      const { Writable } = require("node:stream");
      const writeStream = new Writable({
        autoDestroy: false,
        emitClose: false,
        write(chunk, _encoding, callback) {
          remoteBytes += chunk.length;
          callback();
        },
      });
      // Match ssh2 WriteStream: finish does not imply the remote handle is closed yet.
      writeStream.on("finish", () => {
        sawFinishBeforeClose = true;
        setTimeout(() => {
          writeStream.emit("close");
          resolveClose();
        }, 25);
      });
      return writeStream;
    },
  });

  const client = {
    // Force the sequential stream fallback (no isolated fastPut channel).
    __netcattySudoMode: true,
    sftp: streamSftp,
    stat() {
      return Promise.resolve({ size: remoteBytes });
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const sender = createSender();
  let transferSettled = false;
  const transferPromise = transferBridge.startTransfer(
    { sender },
    {
      transferId: "upload-stream-fallback",
      sourcePath: localPath,
      targetPath: "/tmp/payload.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
      totalBytes: payload.length,
    },
  ).finally(() => {
    transferSettled = true;
  });

  // Wait until finish has been observed, then confirm we have not completed yet.
  const finishDeadline = Date.now() + 1000;
  while (!sawFinishBeforeClose && Date.now() < finishDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(sawFinishBeforeClose, true);
  assert.equal(transferSettled, false);

  await closeGate;
  // Give the close handler a turn to settle the transfer.
  const result = await transferPromise;
  assert.equal(result.error, undefined);
  assert.equal(remoteBytes, payload.length);
  assert.ok(sender.sent.some((entry) => entry.channel === "netcatty:transfer:complete"));
});

test("SFTP stream-fallback uploads accept ssh2 close without finish", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-ssh2-close-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const localPath = path.join(tempDir, "payload.bin");
  const payload = Buffer.alloc(64 * 1024, 9);
  await fs.promises.writeFile(localPath, payload);

  let remoteBytes = 0;
  let sawFinish = false;
  const streamSftp = createFastSftp({
    createWriteStream() {
      const { Writable } = require("node:stream");
      const writeStream = new Writable({
        autoDestroy: false,
        emitClose: false,
        write(chunk, _encoding, callback) {
          remoteBytes += chunk.length;
          callback();
        },
        final(callback) {
          // ssh2 closes the remote handle from _final. On current Node versions,
          // destroying here suppresses the normal Writable "finish" event.
          this.destroy();
          callback();
        },
        destroy(error, callback) {
          queueMicrotask(() => {
            callback(error);
            if (!error) this.emit("close");
          });
        },
      });
      writeStream.on("finish", () => {
        sawFinish = true;
      });
      return writeStream;
    },
  });

  const client = {
    __netcattySudoMode: true,
    sftp: streamSftp,
    stat() {
      return Promise.resolve({ size: remoteBytes });
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const sender = createSender();
  const result = await transferBridge.startTransfer(
    { sender },
    {
      transferId: "upload-stream-close-only",
      sourcePath: localPath,
      targetPath: "/tmp/payload.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
      totalBytes: payload.length,
    },
  );

  assert.equal(sawFinish, false);
  assert.equal(remoteBytes, payload.length);
  assert.equal(result.error, undefined);
  assert.ok(sender.sent.some((entry) => entry.channel === "netcatty:transfer:complete"));
});

test("SFTP stream-fallback uploads fail on premature close", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-premature-close-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const localPath = path.join(tempDir, "payload.bin");
  await fs.promises.writeFile(localPath, Buffer.alloc(8 * 1024, 3));

  const streamSftp = createFastSftp({
    createWriteStream() {
      const { Writable } = require("node:stream");
      const writeStream = new Writable({
        autoDestroy: false,
        emitClose: false,
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      writeStream.on("finish", () => {
        // Intentionally skip finish-before-close ordering by closing without finish first
        // is covered by destroying before end; here emit close without marking finish path
        // via an early close from the producer side.
      });
      // Close before any finish event.
      queueMicrotask(() => writeStream.emit("close"));
      return writeStream;
    },
  });

  const client = {
    __netcattySudoMode: true,
    sftp: streamSftp,
    stat() {
      return Promise.resolve({ size: 0 });
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const sender = createSender();
  const result = await transferBridge.startTransfer(
    { sender },
    {
      transferId: "upload-premature-close",
      sourcePath: localPath,
      targetPath: "/tmp/payload.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
    },
  );

  assert.match(result.error || "", /closed before finish/);
  assert.ok(sender.sent.some((entry) => entry.channel === "netcatty:transfer:error"));
});

test("SFTP downloads use conservative per-file request concurrency", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-test-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  let observedConcurrency = 0;
  const fastSftp = createFastSftp({
    fastGet(_remotePath, localPath, options, done) {
      observedConcurrency = options.concurrency;
      options.step?.(1024 * 1024, 1024 * 1024, 1024 * 1024);
      fs.promises.writeFile(localPath, Buffer.alloc(1024 * 1024)).then(
        () => done(),
        (err) => done(err),
      );
    },
  });
  const client = {
    sftp: createFastSftp({}),
    stat(_path) {
      return Promise.resolve({ size: 1024 * 1024 });
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["source", client]]) });

  const sender = createSender();
  const result = await transferBridge.startTransfer(
    { sender },
    {
      transferId: "download-large",
      sourcePath: "/tmp/large.bin",
      targetPath: path.join(tempDir, "large.bin"),
      sourceType: "sftp",
      targetType: "local",
      sourceSftpId: "source",
    },
  );

  assert.equal(result.error, undefined);
  assert.equal(observedConcurrency, 4);
});
