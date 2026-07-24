const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { PassThrough, Readable, Writable } = require("node:stream");

const transferBridge = require("./transferBridge.cjs");
const tempDirBridge = require("./tempDirBridge.cjs");
const {
  TRANSFER_CHUNK_SIZE,
  UPLOAD_TRANSFER_CONCURRENCY,
} = require("./transferLimits.cjs");

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

test("resumable SFTP uploads use the configured per-file request concurrency", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-test-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  // Need more than one fanout wave so the concurrency cap is observable.
  const fileSize = UPLOAD_TRANSFER_CONCURRENCY * TRANSFER_CHUNK_SIZE * 2;
  const localPath = path.join(tempDir, "large.bin");
  await fs.promises.writeFile(localPath, Buffer.alloc(fileSize));

  let activeWrites = 0;
  let observedConcurrency = 0;
  let observedChunkSize = 0;
  const pendingWrites = [];
  let holdWrites = true;
  const fastSftp = createFastSftp({
    open(_remotePath, flags, callback) {
      assert.equal(flags, "w");
      callback(null, Buffer.from("remote-handle"));
    },
    write(_handle, _buffer, _offset, length, _position, callback) {
      activeWrites += 1;
      observedConcurrency = Math.max(observedConcurrency, activeWrites);
      observedChunkSize = Math.max(observedChunkSize, length);
      if (holdWrites) {
        pendingWrites.push(() => {
          activeWrites -= 1;
          callback(null);
        });
        return;
      }
      setImmediate(() => {
        activeWrites -= 1;
        callback(null);
      });
    },
    close(_handle, callback) {
      callback(null);
    },
  });
  const client = {
    sftp: createFastSftp({}),
    stat() {
      return Promise.resolve({ size: fileSize });
    },
    rename() {
      return Promise.resolve();
    },
    delete() {
      return Promise.resolve();
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const running = transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: "upload-large",
      sourcePath: localPath,
      targetPath: "/tmp/large.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
      resumable: true,
    },
  );

  const readyDeadline = Date.now() + 1000;
  while (pendingWrites.length < UPLOAD_TRANSFER_CONCURRENCY && Date.now() < readyDeadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pendingWrites.length, UPLOAD_TRANSFER_CONCURRENCY);
  assert.equal(observedConcurrency, UPLOAD_TRANSFER_CONCURRENCY);
  assert.equal(observedChunkSize, TRANSFER_CHUNK_SIZE);
  holdWrites = false;
  for (const complete of pendingWrites.splice(0)) complete();
  const result = await running;
  assert.equal(result.error, undefined);
});

test("fast resumable uploads pause only after in-flight ranges are durable", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-fast-upload-pause-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  // First in-flight wave must be smaller than the file so pause can land mid-transfer.
  const payload = Buffer.alloc(UPLOAD_TRANSFER_CONCURRENCY * TRANSFER_CHUNK_SIZE * 2, 13);
  const localPath = path.join(tempDir, "upload.bin");
  await fs.promises.writeFile(localPath, payload);
  const pendingWrites = [];
  let holdWrites = true;
  let durableBytes = 0;
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(null, Buffer.from("remote-handle"));
    },
    write(_handle, _buffer, _offset, length, position, callback) {
      const complete = () => {
        durableBytes = Math.max(durableBytes, position + length);
        callback(null);
      };
      if (holdWrites) pendingWrites.push(complete);
      else setImmediate(complete);
    },
    close(_handle, callback) {
      callback(null);
    },
  });
  const client = {
    sftp: createFastSftp({}),
    stat() {
      return Promise.resolve({ size: durableBytes });
    },
    rename() {
      return Promise.resolve();
    },
    delete() {
      return Promise.resolve();
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const running = transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: "upload-fast-paused",
      sourcePath: localPath,
      targetPath: "/tmp/upload.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
      totalBytes: payload.length,
      resumable: true,
    },
  );

  const readyDeadline = Date.now() + 1000;
  while (pendingWrites.length < UPLOAD_TRANSFER_CONCURRENCY && Date.now() < readyDeadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pendingWrites.length, UPLOAD_TRANSFER_CONCURRENCY);

  const pausing = transferBridge.pauseTransfer(null, { transferId: "upload-fast-paused" });
  holdWrites = false;
  for (const complete of pendingWrites.splice(0)) complete();
  const paused = await pausing;
  assert.equal(paused.success, true);
  assert.equal(paused.checkpointBytes, UPLOAD_TRANSFER_CONCURRENCY * TRANSFER_CHUNK_SIZE);

  assert.deepEqual(
    await transferBridge.resumeTransfer(null, { transferId: "upload-fast-paused" }),
    { success: true },
  );
  assert.equal((await running).error, undefined);
  assert.equal(durableBytes, payload.length);
});

test("resuming while a fast pause is pending settles the pause request", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-pause-resume-race-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const payload = Buffer.alloc(32 * 1024, 67);
  const localPath = path.join(tempDir, "upload.bin");
  await fs.promises.writeFile(localPath, payload);
  let finishWrite = null;
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(null, Buffer.from("remote-handle"));
    },
    write(_handle, _buffer, _offset, _length, _position, callback) {
      finishWrite = () => callback(null);
    },
    close(_handle, callback) {
      callback(null);
    },
  });
  const client = {
    sftp: createFastSftp({}),
    stat() {
      return Promise.resolve({ size: payload.length });
    },
    rename() {
      return Promise.resolve();
    },
    delete() {
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
  const running = transferBridge.startTransfer(
    { sender },
    {
      transferId: "pause-resume-race",
      sourcePath: localPath,
      targetPath: "/tmp/upload.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
      totalBytes: payload.length,
      resumable: true,
    },
  );
  const deadline = Date.now() + 1000;
  while (!finishWrite && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(typeof finishWrite, "function");

  const pausing = transferBridge.pauseTransfer(null, { transferId: "pause-resume-race" });
  assert.deepEqual(
    await transferBridge.resumeTransfer(null, { transferId: "pause-resume-race" }),
    { success: true },
  );
  assert.deepEqual(await pausing, {
    success: false,
    reason: "Pause was superseded by resume",
  });

  finishWrite();
  assert.equal((await running).error, undefined);
});

test("resuming during pause fingerprinting prevents a stale pause success", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-late-pause-race-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const payload = Buffer.alloc(UPLOAD_TRANSFER_CONCURRENCY * TRANSFER_CHUNK_SIZE * 2, 71);
  const localPath = path.join(tempDir, "upload.bin");
  await fs.promises.writeFile(localPath, payload);
  const pendingWrites = [];
  let holdWrites = true;
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(null, Buffer.from("remote-handle"));
    },
    write(_handle, _buffer, _offset, _length, _position, callback) {
      if (holdWrites) pendingWrites.push(callback);
      else setImmediate(() => callback(null));
    },
    close(_handle, callback) {
      callback(null);
    },
  });
  const client = {
    sftp: createFastSftp({}),
    stat() {
      return Promise.resolve({ size: payload.length });
    },
    rename() {
      return Promise.resolve();
    },
    delete() {
      return Promise.resolve();
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const originalCreateReadStream = fs.createReadStream;
  let fingerprintStream = null;
  fs.createReadStream = (filePath, options) => {
    if (filePath !== localPath || options) return originalCreateReadStream(filePath, options);
    fingerprintStream = new Readable({ read() {} });
    return fingerprintStream;
  };

  let running;
  try {
    running = transferBridge.startTransfer(
      { sender: createSender() },
      {
        transferId: "late-pause-race",
        sourcePath: localPath,
        targetPath: "/tmp/upload.bin",
        sourceType: "local",
        targetType: "sftp",
        targetSftpId: "target",
        totalBytes: payload.length,
        resumable: true,
      },
    );
    const writeDeadline = Date.now() + 1000;
    while (pendingWrites.length < UPLOAD_TRANSFER_CONCURRENCY && Date.now() < writeDeadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(pendingWrites.length, UPLOAD_TRANSFER_CONCURRENCY);

    const pausing = transferBridge.pauseTransfer(null, { transferId: "late-pause-race" });
    holdWrites = false;
    for (const callback of pendingWrites.splice(0)) callback(null);
    const fingerprintDeadline = Date.now() + 1000;
    while (!fingerprintStream && Date.now() < fingerprintDeadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(fingerprintStream);

    const resuming = transferBridge.resumeTransfer(null, { transferId: "late-pause-race" });
    fingerprintStream.push(payload);
    fingerprintStream.push(null);
    assert.deepEqual(await resuming, { success: true });
    assert.deepEqual(await pausing, {
      success: false,
      reason: "Pause was superseded by resume",
    });
  } finally {
    fs.createReadStream = originalCreateReadStream;
  }

  assert.equal((await running).error, undefined);
});

test("failed resumable upload opens close their isolated channel", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-upload-open-fail-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const localPath = path.join(tempDir, "upload.bin");
  await fs.promises.writeFile(localPath, Buffer.alloc(32 * 1024, 23));
  let endedChannels = 0;
  let hadOpenErrorListener = false;
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      hadOpenErrorListener = fastSftp.listenerCount("error") > 0;
      const error = new Error("permission denied");
      if (hadOpenErrorListener) fastSftp.emit("error", error);
      callback(error);
    },
    end() {
      endedChannels += 1;
    },
  });
  const client = {
    // Stream fallback also rejects so the transfer still fails after cleanup.
    sftp: createFastSftp({
      createWriteStream() {
        const writeStream = new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error("permission denied"));
          },
        });
        queueMicrotask(() => writeStream.destroy(new Error("permission denied")));
        return writeStream;
      },
    }),
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const result = await transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: "upload-open-fail",
      sourcePath: localPath,
      targetPath: "/tmp/upload.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
      totalBytes: 32 * 1024,
      resumable: true,
    },
  );

  assert.match(result.error || "", /permission denied/);
  assert.equal(hadOpenErrorListener, true);
  // concurrent-isolated + fastPut-isolated each open/end their own channel.
  assert.ok(endedChannels >= 1, `expected isolated channels to end, got ${endedChannels}`);
});

test("failed local upload opens close their isolated channel", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-local-open-fail-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const localPath = path.join(tempDir, "upload.bin");
  await fs.promises.writeFile(localPath, Buffer.alloc(32 * 1024, 71));
  let endedChannels = 0;
  const fastSftp = createFastSftp({
    end() {
      endedChannels += 1;
    },
  });
  const client = {
    sftp: createFastSftp({}),
    delete() {
      return Promise.resolve();
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const originalOpen = fs.promises.open;
  fs.promises.open = async (filePath, ...args) => {
    if (filePath === localPath) throw new Error("local source unavailable");
    return originalOpen(filePath, ...args);
  };
  let result;
  try {
    result = await transferBridge.startTransfer(
      { sender: createSender() },
      {
        transferId: "upload-local-open-fail",
        sourcePath: localPath,
        targetPath: "/tmp/upload.bin",
        sourceType: "local",
        targetType: "sftp",
        targetSftpId: "target",
        totalBytes: 32 * 1024,
        resumable: true,
      },
    );
  } finally {
    fs.promises.open = originalOpen;
  }

  assert.match(result.error || "", /local source unavailable/);
  assert.equal(endedChannels, 1);
});

test("failed local open for resumable upload still ends the isolated channel", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-upload-local-open-fail-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  // Create the source so preflight can proceed, then delete it as soon as the
  // isolated channel opens so uploadFileResumableFast fails on local open.
  const localPath = path.join(tempDir, "source.bin");
  await fs.promises.writeFile(localPath, Buffer.alloc(32 * 1024, 7));
  let endedChannels = 0;
  let remoteOpenAttempts = 0;
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      remoteOpenAttempts += 1;
      callback(null, Buffer.from("remote-handle"));
    },
    end() {
      endedChannels += 1;
    },
  });
  const client = {
    sftp: createFastSftp({
      createWriteStream() {
        // Stream fallback after range-path failure — keep it error-safe.
        const writeStream = new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error("stream fallback after missing local open"));
          },
        });
        return writeStream;
      },
    }),
    client: {
      sftp(callback) {
        fs.promises.unlink(localPath).finally(() => {
          callback(null, fastSftp);
        });
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const result = await transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: "upload-local-open-fail",
      sourcePath: localPath,
      targetPath: "/tmp/upload.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
      totalBytes: 32 * 1024,
      resumable: true,
      skipAdmission: true,
    },
  );

  assert.ok(result.error, "expected transfer to fail when local source disappears");
  // Critical: isolated channel must not leak when local open fails first.
  assert.ok(endedChannels >= 1, `expected isolated channel end, got ${endedChannels}`);
  assert.equal(remoteOpenAttempts, 0);
});

test("cancel during stalled resumable upload OPEN ends the isolated channel", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-upload-open-stall-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const localPath = path.join(tempDir, "upload.bin");
  await fs.promises.writeFile(localPath, Buffer.alloc(32 * 1024, 29));
  let endedChannels = 0;
  let releaseOpen = null;
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      releaseOpen = () => callback(new Error("channel closed during open"));
    },
    end() {
      endedChannels += 1;
      // Simulate ssh2 failing the pending OPEN when the channel ends.
      releaseOpen?.();
      releaseOpen = null;
    },
  });
  const client = {
    sftp: createFastSftp({
      createWriteStream() {
        const writeStream = new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error("should not stream-fallback after cancel"));
          },
        });
        return writeStream;
      },
    }),
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const sender = createSender();
  const running = transferBridge.startTransfer(
    { sender },
    {
      transferId: "upload-open-stall-cancel",
      sourcePath: localPath,
      targetPath: "/tmp/upload.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
      totalBytes: 32 * 1024,
      resumable: true,
      skipAdmission: true,
    },
  );

  const readyDeadline = Date.now() + 1000;
  while (!releaseOpen && Date.now() < readyDeadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(releaseOpen, "expected remote OPEN to stall");

  await transferBridge.cancelTransfer(null, { transferId: "upload-open-stall-cancel" });
  const result = await running;
  assert.match(result.error || "", /cancel|closed/i);
  assert.ok(endedChannels >= 1, `expected isolated channel end on cancel, got ${endedChannels}`);
  assert.ok(sender.sent.some((entry) => entry.channel === "netcatty:transfer:cancelled"));
  assert.equal(sender.sent.some((entry) => entry.channel === "netcatty:transfer:error"), false);
});

test("resumable SFTP uploads fail closed when pipelined strategies fail (no serial stream)", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-upload-fail-closed-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const payload = Buffer.from("complete fallback upload");
  const localPath = path.join(tempDir, "upload.bin");
  await fs.promises.writeFile(localPath, payload);
  let endedChannels = 0;
  let createWriteStreamCalls = 0;
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(new Error("server rejected random-access writes"));
    },
    end() {
      endedChannels += 1;
    },
  });
  const client = {
    sftp: createFastSftp({
      open(_remotePath, _flags, callback) {
        callback(new Error("server rejected random-access writes"));
      },
      createWriteStream() {
        createWriteStreamCalls += 1;
        throw new Error("serial WriteStream must not run");
      },
    }),
    stat() {
      return Promise.resolve({ size: 0 });
    },
    rename() {
      return Promise.resolve();
    },
    delete() {
      return Promise.resolve();
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const result = await transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: "upload-fail-closed",
      sourcePath: localPath,
      targetPath: "/tmp/upload.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
      totalBytes: payload.length,
      resumable: true,
    },
  );

  assert.match(result.error || "", /pipelined upload failed|rejected random-access/i);
  assert.equal(createWriteStreamCalls, 0);
  assert.ok(endedChannels >= 1, `expected isolated channels to end, got ${endedChannels}`);
});

test("resumable concurrent uploads reject a source rewritten mid-transfer", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-upload-source-change-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const payload = Buffer.alloc(64 * 1024, 41);
  const localPath = path.join(tempDir, "upload.bin");
  await fs.promises.writeFile(localPath, payload);
  let rewritten = false;
  let promoted = false;
  let stagedDeleted = false;
  let remoteBytes = 0;
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(null, Buffer.from("remote-handle"));
    },
    write(_handle, _buffer, _offset, length, position, callback) {
      remoteBytes = Math.max(remoteBytes, position + length);
      if (!rewritten && position === 0) {
        rewritten = true;
        fs.writeFileSync(localPath, Buffer.alloc(payload.length, 42));
      }
      callback(null);
    },
    close(_handle, callback) {
      callback(null);
    },
  });
  const client = {
    sftp: createFastSftp({}),
    stat() {
      return Promise.resolve({ size: remoteBytes });
    },
    rename() {
      promoted = true;
      return Promise.resolve();
    },
    delete() {
      stagedDeleted = true;
      return Promise.resolve();
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const result = await transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: "upload-source-change",
      sourcePath: localPath,
      targetPath: "/tmp/upload.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
      totalBytes: payload.length,
      resumable: true,
    },
  );

  assert.equal(rewritten, true);
  assert.match(result.error || "", /source|content|changed|fingerprint|mismatch/i);
  assert.equal(promoted, false);
  assert.equal(stagedDeleted, true);
});

test("resumable fast uploads fail closed when isolated channel errors (no serial stream)", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-upload-channel-error-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const payload = Buffer.alloc(32 * 1024, 31);
  const localPath = path.join(tempDir, "upload.bin");
  await fs.promises.writeFile(localPath, payload);
  let hadErrorListener = false;
  let createWriteStreamCalls = 0;
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(null, Buffer.from("remote-handle"));
    },
    write(_handle, _buffer, _offset, _length, _position, callback) {
      hadErrorListener = fastSftp.listenerCount("error") > 0;
      const error = new Error("isolated channel failed");
      queueMicrotask(() => {
        if (hadErrorListener) fastSftp.emit("error", error);
        callback(error);
      });
    },
    close(_handle, callback) {
      callback(null);
    },
    end() {},
  });
  const client = {
    sftp: createFastSftp({
      open(_remotePath, _flags, callback) {
        callback(new Error("shared open also fails"));
      },
      createWriteStream() {
        createWriteStreamCalls += 1;
        throw new Error("serial WriteStream must not run");
      },
    }),
    stat() {
      return Promise.resolve({ size: 0 });
    },
    rename() {
      return Promise.resolve();
    },
    delete() {
      return Promise.resolve();
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const result = await transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: "upload-channel-error",
      sourcePath: localPath,
      targetPath: "/tmp/upload.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
      totalBytes: payload.length,
      resumable: true,
    },
  );

  assert.match(result.error || "", /pipelined upload failed|isolated channel failed/i);
  assert.equal(hadErrorListener, true);
  assert.equal(createWriteStreamCalls, 0);
});

test("resumable concurrent range failure does not complete via serial stream", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-upload-sparse-fail-closed-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const payload = Buffer.alloc(3 * 32 * 1024, 41);
  const localPath = path.join(tempDir, "upload.bin");
  await fs.promises.writeFile(localPath, payload);
  let secondWriteCallback = null;
  let createWriteStreamCalls = 0;
  let remoteBytes = 0;
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(null, Buffer.from("remote-handle"));
    },
    write(_handle, _buffer, _offset, length, position, callback) {
      if (position === 32 * 1024) {
        secondWriteCallback = callback;
        return;
      }
      remoteBytes = Math.max(remoteBytes, position + length);
      callback(null);
      if (position === 2 * 32 * 1024) {
        queueMicrotask(() => secondWriteCallback(new Error("second range failed")));
      }
    },
    close(_handle, callback) {
      callback(null);
    },
    end() {},
  });
  const client = {
    sftp: createFastSftp({
      open(_remotePath, _flags, callback) {
        callback(new Error("shared open also fails"));
      },
      createWriteStream() {
        createWriteStreamCalls += 1;
        throw new Error("serial WriteStream must not run");
      },
    }),
    stat() {
      return Promise.resolve({ size: remoteBytes });
    },
    rename() {
      return Promise.resolve();
    },
    delete() {
      return Promise.resolve();
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const result = await transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: "upload-sparse-fail-closed",
      sourcePath: localPath,
      targetPath: "/tmp/upload.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
      totalBytes: payload.length,
      resumable: true,
    },
  );

  assert.match(result.error || "", /pipelined upload failed|second range failed/i);
  assert.equal(createWriteStreamCalls, 0);
});

test("resumable fast uploads reject a source that grows during transfer", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-upload-source-growth-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const payload = Buffer.alloc(32 * 1024, 59);
  const localPath = path.join(tempDir, "upload.bin");
  await fs.promises.writeFile(localPath, payload);
  let sourceGrew = false;
  let promoted = false;
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(null, Buffer.from("remote-handle"));
    },
    write(_handle, _buffer, _offset, _length, _position, callback) {
      if (!sourceGrew) {
        sourceGrew = true;
        fs.appendFileSync(localPath, Buffer.from([1]));
      }
      callback(null);
    },
    close(_handle, callback) {
      callback(null);
    },
  });
  const client = {
    sftp: createFastSftp({}),
    stat() {
      return Promise.resolve({ size: payload.length });
    },
    rename() {
      promoted = true;
      return Promise.resolve();
    },
    delete() {
      return Promise.resolve();
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const result = await transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: "upload-source-growth",
      sourcePath: localPath,
      targetPath: "/tmp/upload.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
      totalBytes: payload.length,
      resumable: true,
    },
  );

  assert.match(result.error || "", /source size changed/);
  assert.equal(promoted, false);
});

test("resumable fast uploads reject same-size changes outside old sample regions", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-upload-metadata-change-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const payload = Buffer.alloc(8 * TRANSFER_CHUNK_SIZE, 73);
  const localPath = path.join(tempDir, "upload.bin");
  await fs.promises.writeFile(localPath, payload);
  const frozenStat = await fs.promises.stat(localPath);
  let changeStarted = false;
  let changed = false;
  let promoted = false;
  let stagedDeleted = false;
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(null, Buffer.from("remote-handle"));
    },
    write(_handle, _buffer, _offset, _length, _position, callback) {
      if (changeStarted) {
        callback(null);
        return;
      }
      changeStarted = true;
      // Rewrite only the second chunk. The old start/middle/end sampling did
      // not cover this range, and restoring mtime models a coarse filesystem.
      fs.promises.open(localPath, "r+")
        .then(async (handle) => {
          try {
            await handle.write(
              Buffer.alloc(TRANSFER_CHUNK_SIZE, 74),
              0,
              TRANSFER_CHUNK_SIZE,
              TRANSFER_CHUNK_SIZE,
            );
          } finally {
            await handle.close();
          }
        })
        .then(() => fs.promises.utimes(localPath, frozenStat.atime, frozenStat.mtime))
        .then(() => {
          changed = true;
          callback(null);
        }, callback);
    },
    close(_handle, callback) {
      callback(null);
    },
  });
  const client = {
    sftp: createFastSftp({}),
    stat() {
      return Promise.resolve({ size: payload.length });
    },
    rename() {
      promoted = true;
      return Promise.resolve();
    },
    delete() {
      stagedDeleted = true;
      return Promise.resolve();
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const result = await transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: "upload-metadata-change",
      sourcePath: localPath,
      targetPath: "/tmp/upload.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
      totalBytes: payload.length,
      resumable: true,
    },
  );

  assert.equal(changed, true);
  assert.match(result.error || "", /source.*changed/i);
  assert.equal(promoted, false);
  assert.equal(stagedDeleted, true);
});

test("resumable fast downloads clear staged data after a same-second source change", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-download-source-change-"));
  const transferId = "download-source-change";
  const targetPath = path.join(tempDir, "download.bin");
  const stagedPath = tempDirBridge.getTransferTempFilePath(transferId, path.basename(targetPath));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    await fs.promises.rm(stagedPath, { force: true });
  });
  await fs.promises.writeFile(targetPath, "original");

  const payload = Buffer.alloc(32 * 1024, 61);
  const latestPayload = Buffer.alloc(payload.length, 62);
  let reads = 0;
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(null, Buffer.from("remote-handle"));
    },
    read(_handle, buffer, offset, length, position, callback) {
      const currentPayload = reads++ === 0 ? payload : latestPayload;
      currentPayload.copy(buffer, offset, position, position + length);
      callback(null, length, buffer, position);
    },
    close(_handle, callback) {
      callback(new Error("remote close failed"));
    },
  });
  const client = {
    sftp: createFastSftp({}),
    stat() {
      return Promise.resolve({ size: payload.length, mtime: 1 });
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["source", client]]) });

  const result = await transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId,
      sourcePath: "/tmp/source.bin",
      targetPath,
      sourceType: "sftp",
      targetType: "local",
      sourceSftpId: "source",
      totalBytes: payload.length,
      resumable: true,
    },
  );

  assert.match(result.error || "", /source.*changed/);
  assert.equal(await fs.promises.readFile(targetPath, "utf8"), "original");
  await assert.rejects(fs.promises.stat(stagedPath), { code: "ENOENT" });
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

test("uploads prefer concurrent shared channel over serial WriteStream", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-shared-concurrent-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const payload = Buffer.alloc(UPLOAD_TRANSFER_CONCURRENCY * TRANSFER_CHUNK_SIZE, 91);
  const localPath = path.join(tempDir, "upload.bin");
  await fs.promises.writeFile(localPath, payload);

  let maxInFlight = 0;
  let activeWrites = 0;
  let createWriteStreamCalls = 0;
  const sharedSftp = createFastSftp({
    open(_remotePath, flags, callback) {
      assert.equal(flags, "w");
      callback(null, Buffer.from("shared-handle"));
    },
    write(_handle, _buffer, _offset, length, _position, callback) {
      activeWrites += 1;
      maxInFlight = Math.max(maxInFlight, activeWrites);
      setImmediate(() => {
        activeWrites -= 1;
        callback(null);
      });
    },
    close(_handle, callback) {
      callback(null);
    },
    createWriteStream() {
      createWriteStreamCalls += 1;
      throw new Error("serial WriteStream must not be used when concurrent works");
    },
  });

  const client = {
    // Force the isolated-channel path to be unavailable (sudo / no secondary channel).
    __netcattySudoMode: true,
    sftp: sharedSftp,
    stat() {
      return Promise.resolve({ size: payload.length });
    },
    rename() {
      return Promise.resolve();
    },
    delete() {
      return Promise.resolve();
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const result = await transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: "upload-shared-concurrent",
      sourcePath: localPath,
      targetPath: "/tmp/upload.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
      totalBytes: payload.length,
      resumable: true,
    },
  );

  assert.equal(result.error, undefined);
  assert.equal(createWriteStreamCalls, 0);
  // Pipelined fanout must be multi-WRITE (not serial 1-in-flight).
  assert.ok(
    maxInFlight >= 2,
    `expected pipelined concurrency >= 2, got ${maxInFlight}`,
  );
  assert.ok(
    maxInFlight <= UPLOAD_TRANSFER_CONCURRENCY,
    `expected concurrency <= ${UPLOAD_TRANSFER_CONCURRENCY}, got ${maxInFlight}`,
  );
});

test("shared upload errors wait for all in-flight WRITEs before returning", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-shared-error-drain-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const fileSize = 4 * TRANSFER_CHUNK_SIZE;
  const localPath = path.join(tempDir, "upload.bin");
  await fs.promises.writeFile(localPath, Buffer.alloc(fileSize, 13));

  const pendingWriteCallbacks = [];
  let triggerFirstError;
  const firstErrorTriggered = new Promise((resolve) => {
    triggerFirstError = resolve;
  });
  let firstErrorScheduled = false;
  const sharedSftp = createFastSftp({
    open(_remotePath, flags, callback) {
      assert.equal(flags, "w");
      callback(null, Buffer.from("shared-handle"));
    },
    write(_handle, _buffer, _offset, _length, _position, callback) {
      pendingWriteCallbacks.push(callback);
      if (!firstErrorScheduled && pendingWriteCallbacks.length === 4) {
        firstErrorScheduled = true;
        setImmediate(() => {
          const fail = pendingWriteCallbacks.shift();
          fail(new Error("shared WRITE failed"));
          triggerFirstError();
        });
      }
    },
    close(_handle, callback) {
      callback(null);
    },
  });

  const client = {
    __netcattySudoMode: true,
    sftp: sharedSftp,
    stat() {
      return Promise.resolve({ size: 0 });
    },
    delete() {
      return Promise.resolve();
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  let transferSettled = false;
  const running = transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: "upload-shared-error-drain",
      sourcePath: localPath,
      targetPath: "/tmp/upload.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
      totalBytes: fileSize,
      resumable: true,
    },
  ).finally(() => {
    transferSettled = true;
  });

  await firstErrorTriggered;
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const settledBeforeRemainingWrites = transferSettled;
  for (const callback of pendingWriteCallbacks.splice(0)) callback(null);

  const result = await running;
  assert.equal(settledBeforeRemainingWrites, false);
  assert.match(result.error || "", /shared WRITE failed|pipelined upload failed/i);
});

test("sudo SFTP sessions without open/write fail closed (no serial WriteStream)", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-sudo-fail-closed-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const localPath = path.join(tempDir, "payload.bin");
  const payload = Buffer.alloc(64 * 1024, 7);
  await fs.promises.writeFile(localPath, payload);

  let createWriteStreamCalls = 0;
  const streamOnlySftp = createFastSftp({
    createWriteStream() {
      createWriteStreamCalls += 1;
      throw new Error("serial WriteStream must not run");
    },
  });

  const client = {
    // Isolated channel skipped; shared sftp has only createWriteStream.
    __netcattySudoMode: true,
    sftp: streamOnlySftp,
    stat() {
      return Promise.resolve({ size: 0 });
    },
    rename() {
      return Promise.resolve();
    },
    delete() {
      return Promise.resolve();
    },
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const sender = createSender();
  const result = await transferBridge.startTransfer(
    { sender },
    {
      transferId: "upload-sudo-fail-closed",
      sourcePath: localPath,
      targetPath: "/tmp/payload.bin",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "target",
      totalBytes: payload.length,
      resumable: true,
    },
  );

  assert.match(result.error || "", /pipelined upload failed|open\/write missing/i);
  assert.equal(createWriteStreamCalls, 0);
  assert.ok(sender.sent.some((entry) => entry.channel === "netcatty:transfer:error"));
});

test("resumable SFTP downloads preserve a 2MB request window on high-latency paths", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-test-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const payload = Buffer.alloc(4 * 1024 * 1024, 7);
  let activeReads = 0;
  let observedConcurrency = 0;
  let observedChunkSize = 0;
  const fastSftp = createFastSftp({
    open(_remotePath, flags, callback) {
      assert.equal(flags, "r");
      callback(null, Buffer.from("remote-handle"));
    },
    read(_handle, buffer, offset, length, position, callback) {
      activeReads += 1;
      observedConcurrency = Math.max(observedConcurrency, activeReads);
      observedChunkSize = Math.max(observedChunkSize, length);
      payload.copy(buffer, offset, position, position + length);
      setImmediate(() => {
        activeReads -= 1;
        callback(null, length, buffer, position);
      });
    },
    close(_handle, callback) {
      callback(null);
    },
  });
  const client = {
    sftp: createFastSftp({
      createReadStream() {
        return Readable.from(payload);
      },
    }),
    stat(_path) {
      return Promise.resolve({ size: payload.length });
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
      resumable: true,
    },
  );

  assert.equal(result.error, undefined);
  assert.equal(observedChunkSize, 32 * 1024);
  assert.equal(observedConcurrency * observedChunkSize, 2 * 1024 * 1024);
  assert.deepEqual(await fs.promises.readFile(path.join(tempDir, "large.bin")), payload);
});

test("fast resumable downloads pause only at a complete checkpoint", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-fast-pause-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const payload = Buffer.alloc(4 * 1024 * 1024, 11);
  const pendingReads = [];
  let holdReads = true;
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(null, Buffer.from("remote-handle"));
    },
    read(_handle, buffer, offset, length, position, callback) {
      const complete = () => {
        payload.copy(buffer, offset, position, position + length);
        callback(null, length, buffer, position);
      };
      if (holdReads) pendingReads.push(complete);
      else setImmediate(complete);
    },
    close(_handle, callback) {
      callback(null);
    },
  });
  const client = {
    sftp: createFastSftp({
      createReadStream() {
        return Readable.from(payload);
      },
    }),
    stat() {
      return Promise.resolve({ size: payload.length });
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["source", client]]) });

  const targetPath = path.join(tempDir, "large.bin");
  const running = transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: "download-fast-paused",
      sourcePath: "/tmp/large.bin",
      targetPath,
      sourceType: "sftp",
      targetType: "local",
      sourceSftpId: "source",
      totalBytes: payload.length,
      resumable: true,
    },
  );

  const readyDeadline = Date.now() + 1000;
  while (pendingReads.length < 64 && Date.now() < readyDeadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pendingReads.length, 64);

  const originalStat = fs.promises.stat;
  fs.promises.stat = async (filePath) => {
    if (String(filePath).includes("download-fast-paused")) {
      throw new Error("fast range checkpoints must not be inferred from file size");
    }
    return originalStat(filePath);
  };
  const pausing = transferBridge.pauseTransfer(null, { transferId: "download-fast-paused" });
  holdReads = false;
  for (const complete of pendingReads.splice(0)) complete();
  let paused;
  try {
    paused = await pausing;
  } finally {
    fs.promises.stat = originalStat;
  }
  assert.equal(paused.success, true);
  assert.equal(paused.checkpointBytes, 2 * 1024 * 1024);

  assert.deepEqual(
    await transferBridge.resumeTransfer(null, { transferId: "download-fast-paused" }),
    { success: true },
  );
  assert.equal((await running).error, undefined);
  assert.deepEqual(await fs.promises.readFile(targetPath), payload);
});

test("fast resumable downloads fall back from the highest contiguous checkpoint", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-contiguous-fallback-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const payload = Buffer.alloc(3 * 32 * 1024, 17);
  let fallbackStart = null;
  let secondReadCallback = null;
  let targetPath = null;
  let stagedPath = null;
  const progress = [];
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(null, Buffer.from("remote-handle"));
    },
    read(_handle, buffer, offset, length, position, callback) {
      if (position === 32 * 1024) {
        secondReadCallback = callback;
        return;
      }
      payload.copy(buffer, offset, position, position + length);
      callback(null, length, buffer, position);
      if (position === 2 * 32 * 1024) {
        queueMicrotask(() => secondReadCallback(new Error("second range failed")));
      }
    },
    close(_handle, callback) {
      callback(null);
    },
  });
  const client = {
    sftp: createFastSftp({
      createReadStream(_remotePath, options) {
        fallbackStart = options.start;
        assert.equal(fs.statSync(stagedPath).size, options.start);
        return Readable.from(payload.subarray(options.start));
      },
    }),
    stat() {
      return Promise.resolve({ size: payload.length });
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["source", client]]) });

  targetPath = path.join(tempDir, "fallback.bin");
  stagedPath = tempDirBridge.getTransferTempFilePath(
    "download-contiguous-fallback",
    path.basename(targetPath),
  );
  const result = await transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: "download-contiguous-fallback",
      sourcePath: "/tmp/source.bin",
      targetPath,
      sourceType: "sftp",
      targetType: "local",
      sourceSftpId: "source",
      totalBytes: payload.length,
      resumable: true,
    },
    (transferred) => progress.push(transferred),
  );

  assert.equal(result.error, undefined);
  assert.equal(fallbackStart, 32 * 1024);
  const firstPastCheckpoint = progress.findIndex((transferred) => transferred > fallbackStart);
  assert.ok(firstPastCheckpoint >= 0);
  assert.ok(progress.slice(firstPastCheckpoint + 1).includes(fallbackStart));
  assert.deepEqual(await fs.promises.readFile(targetPath), payload);
});

test("resumable download fallback rejects a remote source changed during streaming", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-download-fallback-change-"));
  const transferId = "download-fallback-change";
  const targetPath = path.join(tempDir, "download.bin");
  const stagedPath = tempDirBridge.getTransferTempFilePath(transferId, path.basename(targetPath));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    await fs.promises.rm(stagedPath, { force: true });
  });
  await fs.promises.writeFile(targetPath, "original");

  const payload = Buffer.alloc(32 * 1024, 51);
  let sourceChanged = false;
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(null, Buffer.from("remote-handle"));
    },
    read(_handle, _buffer, _offset, _length, _position, callback) {
      callback(new Error("range download unavailable"));
    },
  });
  const client = {
    sftp: createFastSftp({
      createReadStream() {
        sourceChanged = true;
        return Readable.from(payload);
      },
    }),
    stat() {
      return Promise.resolve({
        size: payload.length,
        mtimeMs: sourceChanged ? 2 : 1,
        ctimeMs: sourceChanged ? 2 : 1,
      });
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["source", client]]) });

  const result = await transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId,
      sourcePath: "/tmp/source.bin",
      targetPath,
      sourceType: "sftp",
      targetType: "local",
      sourceSftpId: "source",
      totalBytes: payload.length,
      resumable: true,
    },
  );

  assert.equal(sourceChanged, true);
  assert.match(result.error || "", /source.*changed/i);
  assert.equal(await fs.promises.readFile(targetPath, "utf8"), "original");
  assert.equal(fs.existsSync(stagedPath), false);
});

test("range-failure fallback truncates sparse local tail before streaming", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-sparse-tail-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  // Two chunks: finish the second first, then fail the first so contiguous stays 0
  // while the local file already has a sparse tail past the durable checkpoint.
  const chunk = 32 * 1024;
  const payload = Buffer.alloc(2 * chunk, 17);
  let firstReadCallback = null;
  let fallbackStart = null;
  let sizeAtFallback = null;
  const transferId = "download-sparse-tail";
  const targetPath = path.join(tempDir, "sparse.bin");
  // Resumable downloads stage under the transfer temp path, not the final target.
  const stagedPath = tempDirBridge.getTransferTempFilePath(transferId, path.basename(targetPath));
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(null, Buffer.from("remote-handle"));
    },
    read(_handle, buffer, offset, length, position, callback) {
      if (position === 0) {
        firstReadCallback = () => callback(new Error("first range failed"));
        // Complete the later range first, then fail the first.
        queueMicrotask(() => {
          // second range is already in flight separately
        });
        return;
      }
      payload.copy(buffer, offset, position, position + length);
      callback(null, length, buffer, position);
      queueMicrotask(() => firstReadCallback?.());
    },
    close(_handle, callback) {
      callback(null);
    },
  });
  const client = {
    sftp: createFastSftp({
      createReadStream(_remotePath, options) {
        fallbackStart = options.start;
        // Capture *staged* size when stream fallback opens (post-truncate).
        try {
          sizeAtFallback = fs.statSync(stagedPath).size;
        } catch {
          sizeAtFallback = -1;
        }
        return Readable.from(payload.subarray(options.start || 0));
      },
    }),
    stat() {
      return Promise.resolve({ size: payload.length });
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["source", client]]) });

  const result = await transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId,
      sourcePath: "/tmp/source.bin",
      targetPath,
      sourceType: "sftp",
      targetType: "local",
      sourceSftpId: "source",
      totalBytes: payload.length,
      resumable: true,
    },
  );

  assert.equal(result.error, undefined, result.error);
  assert.equal(fallbackStart, 0);
  // Contiguous checkpoint never advanced past 0; sparse tail must be truncated
  // on the staged .part (final target is only written at promote time).
  assert.equal(sizeAtFallback, 0);
  assert.deepEqual(await fs.promises.readFile(targetPath), payload);
});

test("S2S upload-phase concurrent failure does not truncate the complete local temp source", async (t) => {
  const transferId = `s2s-no-truncate-${crypto.randomUUID()}`;
  const payload = Buffer.alloc(64 * 1024, 23);
  const localStage = tempDirBridge.getTransferTempFilePath(transferId, "payload.bin");
  await fs.promises.writeFile(localStage, payload);
  t.after(async () => {
    await fs.promises.unlink(localStage).catch(() => {});
  });

  let sizeAfterFail = null;
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(null, Buffer.from("remote-handle"));
    },
    write(_handle, _buffer, _offset, _length, position, callback) {
      if (position === 0) {
        callback(new Error("first upload range failed"));
        return;
      }
      callback(null);
    },
    close(_handle, callback) {
      callback(null);
    },
    end() {},
  });
  const sourceClient = {
    sftp: createFastSftp({}),
    stat: async () => ({ size: payload.length }),
  };
  const targetClient = {
    sftp: createFastSftp({
      open(_remotePath, _flags, callback) {
        callback(new Error("shared open also fails"));
      },
      createWriteStream() {
        throw new Error("serial WriteStream must not run");
      },
    }),
    stat: async () => ({ size: 0 }),
    rename: async () => {},
    delete: async () => {},
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({
    sftpClients: new Map([
      ["source", sourceClient],
      ["target", targetClient],
    ]),
  });

  const result = await transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId,
      sourcePath: "/source/payload.bin",
      targetPath: "/target/payload.bin",
      sourceType: "sftp",
      targetType: "sftp",
      sourceSftpId: "source",
      targetSftpId: "target",
      totalBytes: payload.length,
      resumable: true,
      resumeStage: "upload",
      downloadCheckpointBytes: payload.length,
      uploadCheckpointBytes: 0,
      checkpointBytes: 0,
    },
  );

  try {
    sizeAfterFail = fs.statSync(localStage).size;
  } catch {
    sizeAfterFail = -1;
  }
  // Fail closed — local S2S temp is the fully-downloaded source, never truncated.
  assert.match(result.error || "", /pipelined upload failed|first upload range failed/i);
  assert.equal(sizeAfterFail, payload.length);
});

test("cancelled fast resumable downloads release their isolated channel", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-cancel-release-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const payload = Buffer.alloc(32 * 1024, 19);
  let openedChannels = 0;
  let fallbackReads = 0;
  let cancelRead = null;
  const firstChannel = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(null, Buffer.from("first-handle"));
    },
    read(_handle, _buffer, _offset, _length, _position, callback) {
      cancelRead = () => callback(new Error("channel cancelled"));
    },
    end() {
      cancelRead?.();
    },
  });
  const secondChannel = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(null, Buffer.from("second-handle"));
    },
    read(_handle, buffer, offset, length, position, callback) {
      payload.copy(buffer, offset, position, position + length);
      callback(null, length, buffer, position);
    },
    close(_handle, callback) {
      callback(null);
    },
  });
  const client = {
    sftp: createFastSftp({
      createReadStream(_remotePath, options) {
        if (options?.start !== undefined) fallbackReads += 1;
        return Readable.from(payload);
      },
    }),
    stat() {
      return Promise.resolve({ size: payload.length });
    },
    client: {
      sftp(callback) {
        openedChannels += 1;
        callback(null, openedChannels === 1 ? firstChannel : secondChannel);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["source", client]]) });

  const first = transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: "download-cancel-release-first",
      sourcePath: "/tmp/source.bin",
      targetPath: path.join(tempDir, "first.bin"),
      sourceType: "sftp",
      targetType: "local",
      sourceSftpId: "source",
      totalBytes: payload.length,
      resumable: true,
    },
  );
  const readyDeadline = Date.now() + 1000;
  while (!cancelRead && Date.now() < readyDeadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(typeof cancelRead, "function");
  await transferBridge.cancelTransfer(null, { transferId: "download-cancel-release-first" });
  assert.equal((await first).error, "Transfer cancelled");

  const second = await transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: "download-cancel-release-second",
      sourcePath: "/tmp/source.bin",
      targetPath: path.join(tempDir, "second.bin"),
      sourceType: "sftp",
      targetType: "local",
      sourceSftpId: "source",
      totalBytes: payload.length,
      resumable: true,
    },
  );

  assert.equal(second.error, undefined);
  assert.equal(openedChannels, 2);
  assert.equal(fallbackReads, 0);
});

test("SFTP downloads fall back to a compatible stream after fastGet fails", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-fallback-test-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const expected = Buffer.from("complete fallback download");
  let fastGetAttempts = 0;
  const fastSftp = createFastSftp({
    fastGet(_remotePath, localPath, _options, done) {
      fastGetAttempts += 1;
      fs.promises.writeFile(localPath, "partial").then(
        () => done(new Error("server rejected concurrent reads")),
        done,
      );
    },
  });
  const client = {
    sftp: createFastSftp({
      createReadStream() {
        const { Readable } = require("node:stream");
        return Readable.from(expected);
      },
    }),
    stat() {
      return Promise.resolve({ size: expected.length });
    },
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["source", client]]) });

  const targetPath = path.join(tempDir, "fallback.bin");
  const result = await transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: "download-fallback",
      sourcePath: "/tmp/fallback.bin",
      targetPath,
      sourceType: "sftp",
      targetType: "local",
      sourceSftpId: "source",
      totalBytes: expected.length,
    },
  );

  assert.equal(result.error, undefined);
  assert.equal(fastGetAttempts, 1);
  assert.deepEqual(await fs.promises.readFile(targetPath), expected);
});

test("SFTP downloads keep concurrent files moving within the fast-channel budget", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-budget-test-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const completions = [];
  let activeFastGets = 0;
  let maxActiveFastGets = 0;
  let openedChannels = 0;
  let fallbackReads = 0;
  const fastSftp = createFastSftp({
    fastGet(_remotePath, localPath, _options, done) {
      activeFastGets += 1;
      maxActiveFastGets = Math.max(maxActiveFastGets, activeFastGets);
      completions.push(async () => {
        await fs.promises.writeFile(localPath, "downloaded");
        activeFastGets -= 1;
        done();
      });
    },
  });
  const client = {
    sftp: createFastSftp({
      createReadStream() {
        fallbackReads += 1;
        const { Readable } = require("node:stream");
        return Readable.from("downloaded");
      },
    }),
    stat() {
      return Promise.resolve({ size: 10 });
    },
    client: {
      sftp(callback) {
        openedChannels += 1;
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["source", client]]) });

  const start = (id) => transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: id,
      sourcePath: `/tmp/${id}.bin`,
      targetPath: path.join(tempDir, `${id}.bin`),
      sourceType: "sftp",
      targetType: "local",
      sourceSftpId: "source",
      totalBytes: 10,
      // Isolate the fast-channel budget test from global file admission.
      skipAdmission: true,
    },
  );

  const first = start("download-one");
  const firstDeadline = Date.now() + 1000;
  while (completions.length < 1 && Date.now() < firstDeadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(completions.length, 1);
  assert.equal(openedChannels, 1);
  const second = start("download-two");
  const secondResult = await second;
  assert.equal(secondResult.error, undefined);
  assert.equal(fallbackReads, 1);

  await completions[0]();
  assert.equal((await first).error, undefined);
  assert.equal(maxActiveFastGets, 1);
  assert.equal(openedChannels, 1);
});

test("idle fast-download channels are discarded when a delayed error arrives", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-idle-error-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const payload = Buffer.from("downloaded");
  const channels = [];
  let endedChannels = 0;
  const client = {
    sftp: createFastSftp({}),
    stat() {
      return Promise.resolve({ size: payload.length });
    },
    client: {
      sftp(callback) {
        const channel = createFastSftp({
          fastGet(_remotePath, localPath, _options, done) {
            fs.promises.writeFile(localPath, payload).then(() => done(), done);
          },
          end() {
            endedChannels += 1;
          },
        });
        channels.push(channel);
        callback(null, channel);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["source", client]]) });

  const start = (id) => transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: id,
      sourcePath: `/tmp/${id}.bin`,
      targetPath: path.join(tempDir, `${id}.bin`),
      sourceType: "sftp",
      targetType: "local",
      sourceSftpId: "source",
      totalBytes: payload.length,
    },
  );

  assert.equal((await start("idle-error-first")).error, undefined);
  assert.equal(channels.length, 1);
  assert.ok(channels[0].listenerCount("error") > 0);
  channels[0].emit("error", new Error("delayed idle failure"));
  assert.equal(endedChannels, 1);

  assert.equal((await start("idle-error-second")).error, undefined);
  assert.equal(channels.length, 2);
  channels[1].emit("error", new Error("test cleanup"));
});

test("SFTP downloads cancelled while opening do not block the session", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-open-cancel-test-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  let delayedOpen = null;
  let abandonedChannelClosed = false;
  let openCalls = 0;
  const abandonedSftp = createFastSftp({
    end() {
      abandonedChannelClosed = true;
    },
  });
  const workingSftp = createFastSftp({
    fastGet(_remotePath, localPath, _options, done) {
      fs.promises.writeFile(localPath, "downloaded").then(
        () => done(),
        done,
      );
    },
  });
  const client = {
    sftp: createFastSftp({}),
    stat() {
      return Promise.resolve({ size: 10 });
    },
    client: {
      sftp(callback) {
        openCalls += 1;
        if (openCalls === 1) {
          delayedOpen = callback;
        } else {
          callback(null, workingSftp);
        }
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["source", client]]) });

  const start = (id) => transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId: id,
      sourcePath: `/tmp/${id}.bin`,
      targetPath: path.join(tempDir, `${id}.bin`),
      sourceType: "sftp",
      targetType: "local",
      sourceSftpId: "source",
      totalBytes: 10,
    },
  );

  const cancelledPromise = start("download-opening");
  const deadline = Date.now() + 1000;
  while (!delayedOpen && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(typeof delayedOpen, "function");
  await transferBridge.cancelTransfer(null, { transferId: "download-opening" });
  delayedOpen(null, abandonedSftp);

  const cancelled = await cancelledPromise;
  assert.equal(cancelled.error, "Transfer cancelled");
  assert.equal(abandonedChannelClosed, true);

  const next = await Promise.race([
    start("download-after-cancel"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("next download remained blocked")), 1000)),
  ]);
  assert.equal(next.error, undefined);
  assert.equal(openCalls, 2);
});

test("resumable stream transfers pause without losing their checkpoint and continue", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-pause-test-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const source = new PassThrough();
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  let readStreamCalls = 0;
  const sftp = createFastSftp({
    createReadStream() {
      readStreamCalls += 1;
      return readStreamCalls === 1 ? source : Readable.from(Buffer.from("abcdef"));
    },
    createWriteStream() { return sink; },
  });
  const client = {
    sftp,
    stat() { return Promise.resolve({ size: 6 }); },
    client: { sftp(callback) { callback(new Error("isolated channel unavailable")); } },
  };
  transferBridge.init({ sftpClients: new Map([["source", client]]) });

  const sender = createSender();
  const running = transferBridge.startTransfer(
    { sender },
    {
      transferId: "download-paused",
      sourcePath: "/tmp/source.bin",
      targetPath: path.join(tempDir, "target.bin"),
      sourceType: "sftp",
      targetType: "local",
      sourceSftpId: "source",
      totalBytes: 6,
      resumable: true,
    },
  );

  const readyDeadline = Date.now() + 1000;
  while (source.listenerCount("data") === 0 && Date.now() < readyDeadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(source.listenerCount("data") > 0);
  source.write(Buffer.from("abc"));
  await new Promise((resolve) => setImmediate(resolve));
  const paused = await transferBridge.pauseTransfer(null, { transferId: "download-paused" });
  assert.deepEqual(paused, {
    success: true,
    checkpointBytes: 3,
    resumeStage: "direct",
    downloadCheckpointBytes: 0,
    uploadCheckpointBytes: 0,
    sourceFingerprint: `sha256:${crypto.createHash("sha256").update("abcdef").digest("hex")}`,
  });

  source.write(Buffer.from("def"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    await transferBridge.pauseTransfer(null, { transferId: "download-paused" }),
    {
      success: true,
      checkpointBytes: 3,
      resumeStage: "direct",
      downloadCheckpointBytes: 0,
      uploadCheckpointBytes: 0,
      sourceFingerprint: `sha256:${crypto.createHash("sha256").update("abcdef").digest("hex")}`,
    },
  );

  assert.deepEqual(await transferBridge.resumeTransfer(null, { transferId: "download-paused" }), { success: true });
  source.end();
  assert.equal((await running).error, undefined);
});

test("stream local-copy pause survives write-stream drain without auto-resuming the pipe", async (t) => {
  // Regression for transfer-list pause (#2458): Node's .pipe() resumes the source
  // on destination 'drain'. SFTP upload no longer uses serial WriteStream; cover
  // unpipe on local→local copies (same pauseTransfer path). Mock write stream
  // still persists bytes so pause checkpoint stat succeeds.
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-pipe-pause-local-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const payload = Buffer.alloc(256 * 1024, 91);
  const sourcePath = path.join(tempDir, "source.bin");
  const targetPath = path.join(tempDir, "target.bin");
  await fs.promises.writeFile(sourcePath, payload);

  let durableBytes = 0;
  const pendingWriteCallbacks = [];
  let holdWrites = true;
  let activeWriteStream = null;
  const originalCreateWriteStream = fs.createWriteStream;
  t.after(() => {
    fs.createWriteStream = originalCreateWriteStream;
  });
  fs.createWriteStream = (filePath, options) => {
    const real = originalCreateWriteStream(filePath, options);
    activeWriteStream = new Writable({
      highWaterMark: 16,
      write(chunk, encoding, callback) {
        real.write(chunk, encoding, (err) => {
          if (err) return callback(err);
          durableBytes += chunk.length;
          activeWriteStream.bytesWritten = durableBytes;
          if (holdWrites) {
            pendingWriteCallbacks.push(callback);
            return;
          }
          callback();
        });
      },
      final(callback) {
        real.end(callback);
      },
      destroy(err, callback) {
        real.destroy(err);
        callback(err);
      },
    });
    activeWriteStream.bytesWritten = 0;
    return activeWriteStream;
  };

  transferBridge.init({ sftpClients: new Map() });
  const sender = createSender();
  const running = transferBridge.startTransfer(
    { sender },
    {
      transferId: "local-pipe-pause",
      sourcePath,
      targetPath,
      sourceType: "local",
      targetType: "local",
      totalBytes: payload.length,
      resumable: true,
    },
  );

  const backpressureDeadline = Date.now() + 2000;
  while (pendingWriteCallbacks.length === 0 && Date.now() < backpressureDeadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(pendingWriteCallbacks.length > 0, "write stream should be backpressured");
  const bytesWhenPauseRequested = durableBytes;

  const pausing = transferBridge.pauseTransfer(null, { transferId: "local-pipe-pause" });
  holdWrites = false;
  for (const callback of pendingWriteCallbacks.splice(0)) callback();
  const paused = await pausing;
  assert.equal(paused.success, true, paused.reason);
  const checkpoint = paused.checkpointBytes;
  assert.ok(checkpoint >= bytesWhenPauseRequested);
  assert.ok(
    checkpoint < payload.length,
    "pause must stop before the copy finishes under backpressure",
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    durableBytes,
    checkpoint,
    "paused stream copy must not keep writing after drain",
  );

  assert.deepEqual(
    await transferBridge.resumeTransfer(null, { transferId: "local-pipe-pause" }),
    { success: true },
  );
  assert.equal((await running).error, undefined);
  assert.equal(durableBytes, payload.length);
});

test("repeated resume does not double-pipe the same stream pair", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-double-resume-local-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const payload = Buffer.alloc(256 * 1024, 77);
  const sourcePath = path.join(tempDir, "source.bin");
  const targetPath = path.join(tempDir, "target.bin");
  await fs.promises.writeFile(sourcePath, payload);

  let durableBytes = 0;
  const pendingWriteCallbacks = [];
  let holdWrites = true;
  let pipeCount = 0;
  let activeWriteStream = null;
  const originalCreateWriteStream = fs.createWriteStream;
  t.after(() => {
    fs.createWriteStream = originalCreateWriteStream;
  });
  fs.createWriteStream = (filePath, options) => {
    const real = originalCreateWriteStream(filePath, options);
    activeWriteStream = new Writable({
      highWaterMark: 16,
      write(chunk, encoding, callback) {
        real.write(chunk, encoding, (err) => {
          if (err) return callback(err);
          durableBytes += chunk.length;
          activeWriteStream.bytesWritten = durableBytes;
          if (holdWrites) {
            pendingWriteCallbacks.push(callback);
            return;
          }
          callback();
        });
      },
      final(callback) {
        real.end(callback);
      },
      destroy(err, callback) {
        real.destroy(err);
        callback(err);
      },
    });
    activeWriteStream.bytesWritten = 0;
    return activeWriteStream;
  };
  const originalReadablePipe = Readable.prototype.pipe;
  t.after(() => {
    Readable.prototype.pipe = originalReadablePipe;
  });
  Readable.prototype.pipe = function patchedPipe(dest, ...args) {
    if (dest === activeWriteStream) pipeCount += 1;
    return originalReadablePipe.apply(this, [dest, ...args]);
  };

  transferBridge.init({ sftpClients: new Map() });
  const sender = createSender();
  const running = transferBridge.startTransfer(
    { sender },
    {
      transferId: "local-double-resume",
      sourcePath,
      targetPath,
      sourceType: "local",
      targetType: "local",
      totalBytes: payload.length,
      resumable: true,
    },
  );

  const backpressureDeadline = Date.now() + 2000;
  while (pendingWriteCallbacks.length === 0 && Date.now() < backpressureDeadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(pendingWriteCallbacks.length > 0, "write stream should be backpressured");

  const pausing = transferBridge.pauseTransfer(null, { transferId: "local-double-resume" });
  holdWrites = false;
  for (const callback of pendingWriteCallbacks.splice(0)) callback();
  const paused = await pausing;
  assert.equal(paused.success, true, paused.reason);
  const pipesAfterPause = pipeCount;

  assert.deepEqual(
    await transferBridge.resumeTransfer(null, { transferId: "local-double-resume" }),
    { success: true },
  );
  assert.deepEqual(
    await transferBridge.resumeTransfer(null, { transferId: "local-double-resume" }),
    { success: true },
  );
  assert.equal(
    pipeCount,
    pipesAfterPause + 1,
    "second resume must not call pipe() again on the same pair",
  );

  assert.equal((await running).error, undefined);
  assert.equal(durableBytes, payload.length);
});

test("resumable downloads never promote a partial staged file", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-partial-test-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const targetPath = path.join(tempDir, "target.bin");
  await fs.promises.writeFile(targetPath, Buffer.from("original"));
  const source = new PassThrough();
  const sftp = createFastSftp({ createReadStream() { return source; } });
  const client = {
    sftp,
    stat() { return Promise.resolve({ size: 6 }); },
    client: { sftp(callback) { callback(new Error("isolated channel unavailable")); } },
  };
  transferBridge.init({ sftpClients: new Map([["source", client]]) });

  const sender = createSender();
  const running = transferBridge.startTransfer(
    { sender },
    {
      transferId: "download-partial",
      sourcePath: "/tmp/source.bin",
      targetPath,
      sourceType: "sftp",
      targetType: "local",
      sourceSftpId: "source",
      totalBytes: 6,
      resumable: true,
    },
  );
  const readyDeadline = Date.now() + 1000;
  while (source.listenerCount("data") === 0 && Date.now() < readyDeadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  source.end(Buffer.from("abc"));

  const result = await running;
  assert.match(result.error || "", /full source|size mismatch/i);
  assert.equal(await fs.promises.readFile(targetPath, "utf8"), "original");
  assert.equal(sender.sent.some((entry) => entry.channel === "netcatty:transfer:complete"), false);
});

test("old-style transfers explicitly reject pause", async () => {
  transferBridge.init({ sftpClients: new Map() });
  assert.deepEqual(
    await transferBridge.pauseTransfer(null, { transferId: "missing" }),
    { success: false, reason: "Transfer is no longer active" },
  );
});

test("server-to-server upload resume uses its own checkpoint instead of overall progress", async (t) => {
  const transferId = `server-copy-${crypto.randomUUID()}`;
  const sourcePath = "/source/payload.bin";
  const targetPath = "/target/payload.bin";
  const payload = Buffer.from("abcdef");
  const localStage = tempDirBridge.getTransferTempFilePath(transferId, "payload.bin");
  await fs.promises.writeFile(localStage, payload);
  t.after(async () => { await fs.promises.unlink(localStage).catch(() => {}); });

  let remote = Buffer.alloc(0);
  let promoted = false;
  const targetSftp = createFastSftp({
    open(_path, flags, callback) {
      callback(null, Buffer.from("target-handle"));
    },
    write(_handle, buffer, offset, length, position, callback) {
      const chunk = buffer.subarray(offset, offset + length);
      if (remote.length < position) {
        remote = Buffer.concat([remote, Buffer.alloc(position - remote.length)]);
      }
      remote = Buffer.concat([
        remote.subarray(0, position),
        chunk,
        remote.subarray(position + chunk.length),
      ]);
      callback(null);
    },
    close(_handle, callback) {
      callback(null);
    },
  });
  const sourceClient = { sftp: createFastSftp({}), stat: async () => ({ size: payload.length }) };
  const targetClient = {
    __netcattySudoMode: true,
    sftp: targetSftp,
    stat: async () => ({ size: remote.length }),
    rename: async () => { promoted = true; },
    delete: async () => {},
  };
  transferBridge.init({ sftpClients: new Map([["source", sourceClient], ["target", targetClient]]) });

  const result = await transferBridge.startTransfer({ sender: createSender() }, {
    transferId,
    sourcePath,
    targetPath,
    sourceType: "sftp",
    targetType: "sftp",
    sourceSftpId: "source",
    targetSftpId: "target",
    totalBytes: payload.length,
    resumable: true,
    resumeStage: "upload",
    checkpointBytes: payload.length / 2,
    downloadCheckpointBytes: payload.length,
    uploadCheckpointBytes: 0,
  });

  assert.equal(result.error, undefined, result.error);
  assert.deepEqual(remote, payload);
  assert.equal(promoted, true);
});

test("server-to-server concurrent failure does not complete via serial stream", async (t) => {
  const transferId = `server-copy-fail-closed-${crypto.randomUUID()}`;
  const sourcePath = "/source/payload.bin";
  const targetPath = "/target/payload.bin";
  const payload = Buffer.alloc(3 * 32 * 1024, 53);
  const localStage = tempDirBridge.getTransferTempFilePath(transferId, path.basename(sourcePath));
  await fs.promises.writeFile(localStage, payload);
  t.after(async () => { await fs.promises.unlink(localStage).catch(() => {}); });

  let secondWriteCallback = null;
  let remoteBytes = 0;
  let createWriteStreamCalls = 0;
  const fastSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(null, Buffer.from("remote-handle"));
    },
    write(_handle, _buffer, _offset, length, position, callback) {
      if (position === 32 * 1024) {
        secondWriteCallback = callback;
        return;
      }
      remoteBytes = Math.max(remoteBytes, position + length);
      callback(null);
      if (position === 2 * 32 * 1024) {
        queueMicrotask(() => secondWriteCallback(new Error("second range failed")));
      }
    },
    close(_handle, callback) {
      callback(null);
    },
    end() {},
  });
  const targetSftp = createFastSftp({
    open(_remotePath, _flags, callback) {
      callback(new Error("shared open also fails"));
    },
    createWriteStream() {
      createWriteStreamCalls += 1;
      throw new Error("serial WriteStream must not run");
    },
  });
  const sourceClient = {
    sftp: createFastSftp({}),
    stat: async () => ({ size: payload.length }),
  };
  const targetClient = {
    sftp: targetSftp,
    stat: async () => ({ size: remoteBytes }),
    rename: async () => {},
    delete: async () => {},
    client: {
      sftp(callback) {
        callback(null, fastSftp);
      },
    },
  };
  transferBridge.init({ sftpClients: new Map([["source", sourceClient], ["target", targetClient]]) });

  const result = await transferBridge.startTransfer(
    { sender: createSender() },
    {
      transferId,
      sourcePath,
      targetPath,
      sourceType: "sftp",
      targetType: "sftp",
      sourceSftpId: "source",
      targetSftpId: "target",
      totalBytes: payload.length,
      resumable: true,
      resumeStage: "upload",
      downloadCheckpointBytes: payload.length,
      uploadCheckpointBytes: 0,
    },
  );

  assert.match(result.error || "", /pipelined upload failed|second range failed/i);
  assert.equal(createWriteStreamCalls, 0);
  // Local S2S temp (full download) must survive failed upload attempts.
  assert.equal(fs.statSync(localStage).size, payload.length);
});

test("upload resume after hard quit clamps checkpoint to durable remote .part size", async (t) => {
  // Simulates force-quit mid-upload: UI progress saved a high checkpoint, but
  // only a shorter prefix made it into the remote staged .part file.
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-crash-resume-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const transferId = `crash-resume-${crypto.randomUUID()}`;
  const sourcePath = path.join(tempDir, "source.bin");
  const payload = Buffer.from("abcdefghij"); // 10 bytes
  await fs.promises.writeFile(sourcePath, payload);

  // Durable remote has first 4 bytes; claimed checkpoint is 8 (progress ahead).
  let remote = Buffer.from("abcd");
  let promoted = false;
  let minWritePosition = Infinity;
  const concurrentSftp = createFastSftp({
    open(_path, flags, callback) {
      callback(null, Buffer.from("resume-handle"));
    },
    write(_handle, buffer, offset, length, position, callback) {
      minWritePosition = Math.min(minWritePosition, position);
      const chunk = buffer.subarray(offset, offset + length);
      if (remote.length < position) {
        remote = Buffer.concat([remote, Buffer.alloc(position - remote.length)]);
      }
      remote = Buffer.concat([
        remote.subarray(0, position),
        chunk,
        remote.subarray(position + chunk.length),
      ]);
      callback(null);
    },
    close(_handle, callback) {
      callback(null);
    },
    // Resume safety samples the durable remote prefix via createReadStream.
    createReadStream(_path, options = {}) {
      const start = options.start || 0;
      const end = options.end;
      const slice = end === undefined ? remote.subarray(start) : remote.subarray(start, end + 1);
      return Readable.from([slice]);
    },
    createWriteStream() {
      throw new Error("serial WriteStream must not run");
    },
  });
  const client = {
    __netcattySudoMode: true, // shared concurrent path only
    sftp: concurrentSftp,
    // First stats clamp checkpoint from claimed 8 down to durable remote size 4.
    stat: async () => ({ size: remote.length }),
    rename: async () => { promoted = true; },
    delete: async () => {},
  };
  transferBridge.init({ sftpClients: new Map([["target", client]]) });

  const result = await transferBridge.startTransfer({ sender: createSender() }, {
    transferId,
    sourcePath,
    targetPath: "/root/source.bin",
    sourceType: "local",
    targetType: "sftp",
    targetSftpId: "target",
    totalBytes: payload.length,
    resumable: true,
    checkpointBytes: 8, // ahead of durable remote size 4
  });

  assert.equal(result.error, undefined, result.error);
  assert.deepEqual(remote, payload);
  assert.equal(promoted, true);
  // Resume must not rewrite the durable prefix from offset 0.
  assert.ok(minWritePosition >= 4, `expected resume from >=4, got ${minWritePosition}`);
});

test("local resume after hard quit clamps checkpoint to durable staged file size", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-local-crash-"));
  t.after(async () => { await fs.promises.rm(tempDir, { recursive: true, force: true }); });
  const transferId = `local-crash-${crypto.randomUUID()}`;
  const sourcePath = path.join(tempDir, "source.bin");
  const targetPath = path.join(tempDir, "target.bin");
  const stagedPath = tempDirBridge.getTransferTempFilePath(transferId, "target.bin");
  await fs.promises.writeFile(sourcePath, Buffer.from("abcdef"));
  // Durable staged file is shorter than claimed checkpoint (crash / unflushed write).
  await fs.promises.writeFile(stagedPath, Buffer.from("ab"));
  t.after(async () => { await fs.promises.unlink(stagedPath).catch(() => {}); });

  transferBridge.init({ sftpClients: new Map() });
  const result = await transferBridge.startTransfer({ sender: createSender() }, {
    transferId,
    sourcePath,
    targetPath,
    sourceType: "local",
    targetType: "local",
    totalBytes: 6,
    resumable: true,
    checkpointBytes: 5,
  });

  assert.equal(result.error, undefined, result.error);
  assert.equal(await fs.promises.readFile(targetPath, "utf8"), "abcdef");
});

test("resume rejects a same-size temporary prefix that does not match the source", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-prefix-test-"));
  t.after(async () => { await fs.promises.rm(tempDir, { recursive: true, force: true }); });
  const transferId = `prefix-${crypto.randomUUID()}`;
  const sourcePath = path.join(tempDir, "source.bin");
  const targetPath = path.join(tempDir, "target.bin");
  const stagedPath = tempDirBridge.getTransferTempFilePath(transferId, "target.bin");
  await fs.promises.writeFile(sourcePath, Buffer.from("abcdef"));
  await fs.promises.writeFile(stagedPath, Buffer.from("xyz"));
  t.after(async () => { await fs.promises.unlink(stagedPath).catch(() => {}); });

  transferBridge.init({ sftpClients: new Map() });
  const result = await transferBridge.startTransfer({ sender: createSender() }, {
    transferId,
    sourcePath,
    targetPath,
    sourceType: "local",
    targetType: "local",
    totalBytes: 6,
    resumable: true,
    checkpointBytes: 3,
  });

  assert.match(result.error || "", /saved content does not match/i);
  assert.equal(await fs.promises.readFile(sourcePath, "utf8"), "abcdef");
});

test("bridge admission applies one global concurrency limit across callers", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-admission-test-"));
  t.after(async () => { await fs.promises.rm(tempDir, { recursive: true, force: true }); });
  const firstSource = new PassThrough();
  const secondSource = new PassThrough();
  const sftp = createFastSftp({
    createReadStream(remotePath) {
      return remotePath === "/first" ? firstSource : secondSource;
    },
  });
  const client = { sftp, stat: async () => ({ size: 1 }) };
  transferBridge.init({ sftpClients: new Map([["source", client]]) });

  const start = (id, remotePath) => transferBridge.startTransfer({ sender: createSender() }, {
    transferId: id,
    sourcePath: remotePath,
    targetPath: path.join(tempDir, `${id}.bin`),
    sourceType: "sftp",
    targetType: "local",
    sourceSftpId: "source",
    totalBytes: 1,
    resumable: true,
    globalConcurrency: 1,
  });
  const first = start("admission-first", "/first");
  while (firstSource.listenerCount("data") === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = start("admission-second", "/second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSource.listenerCount("data"), 0);
  firstSource.end(Buffer.from("a"));
  assert.equal((await first).error, undefined);
  while (secondSource.listenerCount("data") === 0) await new Promise((resolve) => setImmediate(resolve));
  secondSource.end(Buffer.from("b"));
  assert.equal((await second).error, undefined);
});

test("bridge admission gives different remote sessions independent concurrency", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-per-session-test-"));
  t.after(async () => { await fs.promises.rm(tempDir, { recursive: true, force: true }); });
  const sourceA = new PassThrough();
  const sourceB = new PassThrough();
  const makeClient = (source) => ({
    sftp: createFastSftp({ createReadStream() { return source; } }),
    stat: async () => ({ size: 1 }),
  });
  transferBridge.init({ sftpClients: new Map([
    ["source-a", makeClient(sourceA)],
    ["source-b", makeClient(sourceB)],
  ]) });

  const start = (id, sourceSftpId, source) => transferBridge.startTransfer({ sender: createSender() }, {
    transferId: id,
    sourcePath: `/${id}`,
    targetPath: path.join(tempDir, `${id}.bin`),
    sourceType: "sftp",
    targetType: "local",
    sourceSftpId,
    totalBytes: 1,
    resumable: true,
    globalConcurrency: 1,
  }).finally(() => source.destroy());
  const first = start("per-session-a", "source-a", sourceA);
  const second = start("per-session-b", "source-b", sourceB);
  const deadline = Date.now() + 500;
  while ((sourceA.listenerCount("data") === 0 || sourceB.listenerCount("data") === 0) && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const bothStarted = sourceA.listenerCount("data") > 0 && sourceB.listenerCount("data") > 0;
  sourceA.end(Buffer.from("a"));
  sourceB.end(Buffer.from("b"));
  await Promise.all([first, second]);
  assert.equal(bothStarted, true);
});

test("clearPendingCancel allows intentional same-id start after a pre-start cancel", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-clear-pending-"));
  t.after(async () => { await fs.promises.rm(tempDir, { recursive: true, force: true }); });
  const source = new PassThrough();
  const sftp = createFastSftp({
    createReadStream() {
      return source;
    },
  });
  transferBridge.init({ sftpClients: new Map([["source", { sftp, stat: async () => ({ size: 1 }) }]]) });

  await transferBridge.cancelTransfer(null, { transferId: "retry-same-id" });
  transferBridge.clearPendingCancel("retry-same-id");
  const resultPromise = transferBridge.startTransfer({ sender: createSender() }, {
    transferId: "retry-same-id",
    sourcePath: "/remote",
    targetPath: path.join(tempDir, "out.bin"),
    sourceType: "sftp",
    targetType: "local",
    sourceSftpId: "source",
    totalBytes: 1,
    skipAdmission: true,
  });
  while (source.listenerCount("data") === 0) await new Promise((resolve) => setImmediate(resolve));
  source.end(Buffer.from("a"));
  const result = await resultPromise;
  assert.equal(result.cancelled, undefined);
  assert.equal(result.error, undefined);
});

test("cancel before skipAdmission start rejects the transfer without writing", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-pending-cancel-"));
  t.after(async () => { await fs.promises.rm(tempDir, { recursive: true, force: true }); });
  const source = new PassThrough();
  const sftp = createFastSftp({
    createReadStream() {
      return source;
    },
  });
  transferBridge.init({ sftpClients: new Map([["source", { sftp, stat: async () => ({ size: 1 }) }]]) });

  await transferBridge.cancelTransfer(null, { transferId: "pending-cancel-1" });
  const result = await transferBridge.startTransfer({ sender: createSender() }, {
    transferId: "pending-cancel-1",
    sourcePath: "/remote",
    targetPath: path.join(tempDir, "out.bin"),
    sourceType: "sftp",
    targetType: "local",
    sourceSftpId: "source",
    totalBytes: 1,
    skipAdmission: true,
  });
  assert.equal(result.cancelled, true);
  assert.equal(source.listenerCount("data"), 0);
});

test("pausing a queued admission job preserves the payload checkpoint", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-queued-checkpoint-"));
  t.after(async () => { await fs.promises.rm(tempDir, { recursive: true, force: true }); });
  const firstSource = new PassThrough();
  const secondSource = new PassThrough();
  const sftp = createFastSftp({
    createReadStream(remotePath) {
      return remotePath === "/first" ? firstSource : secondSource;
    },
  });
  transferBridge.init({ sftpClients: new Map([["source", { sftp, stat: async () => ({ size: 1 }) }]]) });
  const start = (id, remotePath, checkpointBytes) => transferBridge.startTransfer({ sender: createSender() }, {
    transferId: id,
    sourcePath: remotePath,
    targetPath: path.join(tempDir, `${id}.bin`),
    sourceType: "sftp",
    targetType: "local",
    sourceSftpId: "source",
    totalBytes: 1,
    resumable: true,
    checkpointBytes,
    globalConcurrency: 1,
  });

  const first = start("queued-ckpt-first", "/first", 0);
  while (firstSource.listenerCount("data") === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = start("queued-ckpt-second", "/second", 42);
  const paused = await transferBridge.pauseTransfer(null, { transferId: "queued-ckpt-second" });
  assert.equal(paused.success, true);
  assert.equal(paused.checkpointBytes, 42);
  assert.equal((await transferBridge.cancelTransfer(null, { transferId: "queued-ckpt-second" })).success, true);
  assert.equal((await second).cancelled, true);
  firstSource.end(Buffer.from("a"));
  assert.equal((await first).error, undefined);
});

test("queued admission jobs can be paused, resumed, prioritized, and cancelled before opening a stream", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-transfer-queued-controls-"));
  t.after(async () => { await fs.promises.rm(tempDir, { recursive: true, force: true }); });
  const firstSource = new PassThrough();
  const secondSource = new PassThrough();
  const sftp = createFastSftp({
    createReadStream(remotePath) {
      return remotePath === "/first" ? firstSource : secondSource;
    },
  });
  transferBridge.init({ sftpClients: new Map([["source", { sftp, stat: async () => ({ size: 1 }) }]]) });
  const start = (id, remotePath) => transferBridge.startTransfer({ sender: createSender() }, {
    transferId: id,
    sourcePath: remotePath,
    targetPath: path.join(tempDir, `${id}.bin`),
    sourceType: "sftp",
    targetType: "local",
    sourceSftpId: "source",
    totalBytes: 1,
    resumable: true,
    globalConcurrency: 1,
  });

  const first = start("queued-control-first", "/first");
  while (firstSource.listenerCount("data") === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = start("queued-control-second", "/second");
  assert.equal((await transferBridge.pauseTransfer(null, { transferId: "queued-control-second" })).success, true);
  assert.equal(secondSource.listenerCount("data"), 0);
  assert.equal((await transferBridge.resumeTransfer(null, { transferId: "queued-control-second" })).success, true);
  assert.equal((await transferBridge.prioritizeTransfer(null, { transferId: "queued-control-second" })).success, true);
  assert.equal((await transferBridge.cancelTransfer(null, { transferId: "queued-control-second" })).success, true);
  assert.equal((await second).cancelled, true);
  firstSource.end(Buffer.from("a"));
  assert.equal((await first).error, undefined);
  assert.equal(secondSource.listenerCount("data"), 0);
});

test("transfer session leases hold SFTP ids across soft-close until release", async (t) => {
  const {
    sftpTransferSessionLeaseStore,
  } = require("./sftpTransferSessionLease.cjs");
  sftpTransferSessionLeaseStore.resetForTests();
  t.after(() => sftpTransferSessionLeaseStore.resetForTests());

  let hardCloseCalls = 0;
  const sftpBridge = require("./sftpBridge.cjs");
  const originalClose = sftpBridge.closeSftp;
  sftpBridge.closeSftp = async (_event, payload) => {
    if (payload?.force) {
      hardCloseCalls += 1;
      sftpTransferSessionLeaseStore.clear(payload.sftpId);
      return { success: true, deferred: false };
    }
    if (sftpTransferSessionLeaseStore.markSoftClosed(payload.sftpId)) {
      return {
        success: true,
        deferred: true,
        leaseCount: sftpTransferSessionLeaseStore.getLeaseCount(payload.sftpId),
      };
    }
    return { success: true, deferred: false };
  };
  t.after(() => {
    sftpBridge.closeSftp = originalClose;
  });

  assert.deepEqual(
    transferBridge.listTransferSftpIds({ sourceSftpId: "s1", targetSftpId: "s2", sourceHostId: "h" }),
    ["s1", "s2"],
  );

  // Hold two transfers on s1 before soft-close (re-acquire after soft-close
  // would clear the deferred flag by design).
  transferBridge.acquireTransferSessionLeases("xfer-1", {
    sourceSftpId: "s1",
    targetSftpId: "s2",
  });
  transferBridge.acquireTransferSessionLeases("xfer-2", { sourceSftpId: "s1" });
  assert.equal(sftpTransferSessionLeaseStore.getLeaseCount("s1"), 2);
  assert.equal(sftpTransferSessionLeaseStore.getLeaseCount("s2"), 1);

  const soft = await sftpBridge.closeSftp(null, { sftpId: "s1" });
  assert.equal(soft.deferred, true);
  assert.equal(sftpTransferSessionLeaseStore.isSoftClosed("s1"), true);
  assert.equal(hardCloseCalls, 0);

  transferBridge.releaseTransferSessionLeases("xfer-1", ["s1", "s2"]);
  assert.equal(hardCloseCalls, 0);
  assert.equal(sftpTransferSessionLeaseStore.isHeld("s1"), true);
  assert.equal(sftpTransferSessionLeaseStore.isHeld("s2"), false);

  // Last release on soft-closed session triggers hard close.
  transferBridge.releaseTransferSessionLeases("xfer-2", ["s1"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hardCloseCalls, 1);
  assert.equal(sftpTransferSessionLeaseStore.isHeld("s1"), false);
});
