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
  const fastSftp = createFastSftp({
    fastPut(_localPath, _remotePath, options, done) {
      observedConcurrency = options.concurrency;
      options.step?.(1024 * 1024, 1024 * 1024, 1024 * 1024);
      queueMicrotask(() => done());
    },
  });
  const client = {
    sftp: createFastSftp({}),
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
