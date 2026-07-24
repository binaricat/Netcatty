"use strict";

/**
 * Session-backed SFTP clients (openForSession / terminal reuse) are not
 * ssh2-sftp-client instances. They must still expose pipelined fastPut so
 * uploadLocal / writeSftpBinaryWithProgress do not throw after serial put
 * was removed (#2449 fail-closed alignment).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sftpBridge = require("./sftpBridge.cjs");
const tempDirBridge = require("./tempDirBridge.cjs");
const {
  TRANSFER_CHUNK_SIZE,
  UPLOAD_TRANSFER_CONCURRENCY,
} = require("./transferLimits.cjs");

function createSessionChannel() {
  const fastPutCalls = [];
  const remoteFiles = new Map();
  const channel = {
    // hasSftpChannelApi requires these four methods.
    readdir(_targetPath, callback) {
      callback(null, []);
    },
    mkdir(_targetPath, callback) {
      callback(null);
    },
    unlink(targetPath, callback) {
      remoteFiles.delete(targetPath);
      callback(null);
    },
    stat(targetPath, callback) {
      const data = remoteFiles.get(targetPath);
      if (!data) {
        const err = new Error(`ENOENT ${targetPath}`);
        err.code = 2;
        callback(err);
        return;
      }
      callback(null, {
        size: data.length,
        isDirectory: () => false,
        isFile: () => true,
      });
    },
    fastPut(localPath, remotePath, options, callback) {
      fastPutCalls.push({
        localPath,
        remotePath,
        concurrency: options?.concurrency,
        chunkSize: options?.chunkSize,
      });
      try {
        const data = fs.readFileSync(localPath);
        remoteFiles.set(remotePath, data);
        if (typeof options?.step === "function") {
          options.step(data.length, data.length, data.length);
        }
        queueMicrotask(() => callback(null));
      } catch (err) {
        queueMicrotask(() => callback(err));
      }
    },
    rename(from, to, callback) {
      if (!remoteFiles.has(from)) {
        const err = new Error(`ENOENT ${from}`);
        err.code = 2;
        callback(err);
        return;
      }
      remoteFiles.set(to, remoteFiles.get(from));
      remoteFiles.delete(from);
      callback(null);
    },
    end() {},
  };
  return { channel, fastPutCalls, remoteFiles };
}

test("session-backed uploadLocalToSftp uses pipelined fastPut on the raw SFTP channel", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-session-upload-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });

  const localPath = path.join(tempRoot, "payload.bin");
  const payload = Buffer.alloc(48 * 1024, 17);
  await fs.promises.writeFile(localPath, payload);

  const { channel, fastPutCalls, remoteFiles } = createSessionChannel();
  const connection = {
    sftp(callback) {
      callback(null, channel);
    },
  };
  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-upload", { conn: connection }]]),
    sftpClients,
  });

  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-upload",
    fileProtocol: "sftp",
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.fileProtocol, "sftp");

  // Session-backed wrapper must expose fastPut (not only raw channel).
  const client = sftpClients.get(opened.sftpId);
  assert.equal(typeof client.fastPut, "function");
  assert.equal(client.__netcattySessionBacked, true);

  const result = await sftpBridge.uploadLocalToSftp(null, {
    sftpId: opened.sftpId,
    localPath,
    remotePath: "/home/alice/payload.bin",
    encoding: "utf-8",
  });

  assert.equal(result.success, true);
  assert.equal(fastPutCalls.length, 1);
  assert.equal(fastPutCalls[0].concurrency, UPLOAD_TRANSFER_CONCURRENCY);
  assert.equal(fastPutCalls[0].chunkSize, TRANSFER_CHUNK_SIZE);
  assert.equal(fastPutCalls[0].localPath, localPath);
  // Final path after staged rename
  assert.ok(remoteFiles.has("/home/alice/payload.bin"));
  assert.equal(remoteFiles.get("/home/alice/payload.bin").length, payload.length);
});

test("session-backed writeSftpBinaryWithProgress uses pipelined fastPut", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-session-write-progress-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });
  // ensureTempDir may be required by getTempFilePath
  if (typeof tempDirBridge.ensureTempDir === "function") {
    tempDirBridge.ensureTempDir();
  }

  const payload = Buffer.alloc(40 * 1024, 29);
  const { channel, fastPutCalls, remoteFiles } = createSessionChannel();
  const connection = {
    sftp(callback) {
      callback(null, channel);
    },
  };
  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: {
      webContents: {
        fromId: () => ({ send() {} }),
      },
    },
    sessions: new Map([["session-write", { conn: connection }]]),
    sftpClients,
  });

  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-write",
    fileProtocol: "sftp",
  });

  let progressError = null;
  const result = await sftpBridge.writeSftpBinaryWithProgress(
    { sender: { id: 1 } },
    {
      sftpId: opened.sftpId,
      path: "/home/alice/mem.bin",
      content: payload,
      transferId: "mem-upload-1",
      encoding: "utf-8",
      onProgress() {},
      onComplete() {},
      onError(message) {
        progressError = message;
      },
    },
  );

  assert.equal(progressError, null, progressError);
  assert.equal(result.success, true, result.error || progressError || "upload failed");
  assert.equal(fastPutCalls.length, 1);
  assert.equal(fastPutCalls[0].concurrency, UPLOAD_TRANSFER_CONCURRENCY);
  assert.equal(fastPutCalls[0].chunkSize, TRANSFER_CHUNK_SIZE);
  assert.ok(remoteFiles.has("/home/alice/mem.bin"));
  assert.deepEqual(remoteFiles.get("/home/alice/mem.bin"), payload);
});

test("pipelinedUploadLocalFile falls back to raw sftp.fastPut when client.fastPut is missing", async () => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-raw-fastput-"));
  const localPath = path.join(tempRoot, "raw.bin");
  await fs.promises.writeFile(localPath, Buffer.from("hello-raw"));

  let sawRawFastPut = false;
  const channel = {
    readdir(_p, cb) { cb(null, []); },
    mkdir(_p, cb) { cb(null); },
    unlink(_p, cb) { cb(null); },
    stat(_p, cb) {
      const err = new Error("ENOENT");
      err.code = 2;
      cb(err);
    },
    fastPut(local, remote, _opts, callback) {
      sawRawFastPut = local === localPath && remote === "/tmp/out.bin";
      queueMicrotask(() => callback(null));
    },
  };
  // Bare client with only raw channel.fastPut (no high-level client.fastPut).
  const bareClient = {
    sftp: channel,
    client: {
      sftp(cb) {
        cb(null, channel);
      },
    },
  };

  sftpBridge.init({
    electronModule: {},
    sessions: new Map(),
    sftpClients: new Map(),
  });

  await sftpBridge.pipelinedUploadLocalFile(bareClient, localPath, "/tmp/out.bin", {
    concurrency: UPLOAD_TRANSFER_CONCURRENCY,
    chunkSize: TRANSFER_CHUNK_SIZE,
  });
  assert.equal(sawRawFastPut, true);

  await fs.promises.rm(tempRoot, { recursive: true, force: true });
});
