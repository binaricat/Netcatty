"use strict";

/**
 * Session-backed SFTP clients (openForSession / terminal reuse) are not
 * ssh2-sftp-client instances. They must still expose pipelined fastPut so
 * uploadLocal / writeSftpBinaryWithProgress do not throw after serial put
 * was removed (#2449 fail-closed alignment).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sftpBridge = require("./sftpBridge.cjs");
const tempDirBridge = require("./tempDirBridge.cjs");
const {
  TRANSFER_CHUNK_SIZE,
  UPLOAD_TRANSFER_CONCURRENCY,
} = require("./transferLimits.cjs");

function createSessionChannel(options = {}) {
  const fastPutCalls = [];
  const remoteFiles = new Map();
  const remoteMeta = new Map(); // path -> { mode, isSymlink }
  const chmodCalls = [];
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
      remoteMeta.delete(targetPath);
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
      const meta = remoteMeta.get(targetPath) || {};
      callback(null, {
        size: data.length,
        mode: meta.mode ?? 0o100644,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => !!meta.isSymlink,
      });
    },
    lstat(targetPath, callback) {
      const meta = remoteMeta.get(targetPath);
      const data = remoteFiles.get(targetPath);
      if (!data && !meta) {
        const err = new Error(`ENOENT ${targetPath}`);
        err.code = 2;
        callback(err);
        return;
      }
      callback(null, {
        size: data ? data.length : 0,
        mode: meta?.isSymlink ? 0o120777 : (meta?.mode ?? 0o100644),
        isDirectory: () => false,
        isFile: () => !meta?.isSymlink,
        isSymbolicLink: () => !!meta?.isSymlink,
      });
    },
    fastPut(localPath, remotePath, opts, callback) {
      fastPutCalls.push({
        localPath,
        remotePath,
        concurrency: opts?.concurrency,
        chunkSize: opts?.chunkSize,
      });
      if (typeof options.onFastPut === "function") {
        const intercept = options.onFastPut(localPath, remotePath);
        if (intercept?.error) {
          queueMicrotask(() => callback(intercept.error));
          return;
        }
      }
      try {
        const data = fs.readFileSync(localPath);
        remoteFiles.set(remotePath, data);
        if (!remoteMeta.has(remotePath)) {
          remoteMeta.set(remotePath, { mode: 0o100644 });
        }
        if (typeof opts?.step === "function") {
          opts.step(data.length, data.length, data.length);
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
      const sourceMeta = remoteMeta.get(from);
      remoteFiles.set(to, remoteFiles.get(from));
      remoteFiles.delete(from);
      remoteMeta.set(to, sourceMeta || { mode: 0o100644 });
      remoteMeta.delete(from);
      callback(null);
    },
    chmod(targetPath, mode, callback) {
      chmodCalls.push({ targetPath, mode });
      const prev = remoteMeta.get(targetPath) || {};
      remoteMeta.set(targetPath, { ...prev, mode });
      callback(null);
    },
    end() {},
  };
  return { channel, fastPutCalls, remoteFiles, remoteMeta, chmodCalls };
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
  // New destinations stage to a remote .part path, then rename into place.
  assert.match(fastPutCalls[0].remotePath, /\.netcatty-upload-.*\.part$/);
  assert.notEqual(fastPutCalls[0].remotePath, "/home/alice/mem.bin");
  assert.ok(remoteFiles.has("/home/alice/mem.bin"));
  assert.deepEqual(remoteFiles.get("/home/alice/mem.bin"), payload);
});

test("existing destinations stage then restore mode after rename", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-stage-meta-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });

  const localPath = path.join(tempRoot, "exec.bin");
  const payload = Buffer.from("#!/bin/sh\necho hi\n");
  await fs.promises.writeFile(localPath, payload);

  const { channel, fastPutCalls, remoteFiles, remoteMeta, chmodCalls } = createSessionChannel();
  remoteFiles.set("/usr/local/bin/tool", Buffer.from("old"));
  remoteMeta.set("/usr/local/bin/tool", { mode: 0o100755 });

  const connection = {
    sftp(callback) { callback(null, channel); },
  };
  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-mode", { conn: connection }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-mode",
    fileProtocol: "sftp",
  });

  await sftpBridge.uploadLocalToSftp(null, {
    sftpId: opened.sftpId,
    localPath,
    remotePath: "/usr/local/bin/tool",
    encoding: "utf-8",
  });

  assert.equal(fastPutCalls.length, 1);
  assert.match(fastPutCalls[0].remotePath, /\.netcatty-upload-.*\.part$/);
  assert.ok(remoteFiles.has("/usr/local/bin/tool"));
  assert.deepEqual(remoteFiles.get("/usr/local/bin/tool"), payload);
  // Stage+rename replaces the inode; restore prior mode bits afterwards.
  assert.ok(
    chmodCalls.some((c) => String(c.targetPath).includes(".netcatty-upload-") && (c.mode & 0o777) === 0o755),
    `expected mode restore via chmod, got ${JSON.stringify(chmodCalls)}`,
  );
  assert.equal(remoteMeta.get("/usr/local/bin/tool")?.mode & 0o777, 0o755);
});

test("mode restore failure leaves the existing destination untouched", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-stage-mode-fail-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });

  const localPath = path.join(tempRoot, "tool");
  await fs.promises.writeFile(localPath, Buffer.from("new-tool"));
  const { channel, remoteFiles, remoteMeta } = createSessionChannel();
  remoteFiles.set("/usr/local/bin/tool", Buffer.from("old-tool"));
  remoteMeta.set("/usr/local/bin/tool", { mode: 0o100755 });
  channel.chmod = (_targetPath, _mode, callback) => {
    const err = new Error("chmod failed");
    err.code = "EIO";
    callback(err);
  };

  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-mode-fail", { conn: { sftp: (cb) => cb(null, channel) } }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-mode-fail",
    fileProtocol: "sftp",
  });

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: opened.sftpId,
      localPath,
      remotePath: "/usr/local/bin/tool",
      encoding: "utf-8",
    }),
    /chmod failed/,
  );
  assert.deepEqual(remoteFiles.get("/usr/local/bin/tool"), Buffer.from("old-tool"));
  assert.equal(
    [...remoteFiles.keys()].some((key) => String(key).includes(".netcatty-upload-")),
    false,
  );
});

test("failed promotion and failed restore preserve both recovery files", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-stage-restore-fail-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });

  const localPath = path.join(tempRoot, "data.bin");
  await fs.promises.writeFile(localPath, Buffer.from("new-data"));
  const { channel, remoteFiles, remoteMeta } = createSessionChannel();
  const finalPath = "/tmp/data.bin";
  remoteFiles.set(finalPath, Buffer.from("old-data"));
  remoteMeta.set(finalPath, { mode: 0o100644 });
  const originalRename = channel.rename.bind(channel);
  let stagePromoteAttempts = 0;
  channel.rename = (from, to, callback) => {
    const fromString = String(from);
    const toString = String(to);
    if (fromString.includes(".netcatty-upload-") && toString === finalPath) {
      stagePromoteAttempts += 1;
      callback(new Error("stage promote failed"));
      return;
    }
    if (fromString.includes(".netcatty-backup-") && toString === finalPath) {
      callback(new Error("backup restore failed"));
      return;
    }
    originalRename(from, to, callback);
  };

  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-restore-fail", { conn: { sftp: (cb) => cb(null, channel) } }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-restore-fail",
    fileProtocol: "sftp",
  });

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: opened.sftpId,
      localPath,
      remotePath: finalPath,
      encoding: "utf-8",
    }),
    /could not be restored/,
  );
  assert.ok(stagePromoteAttempts >= 2);
  assert.equal(remoteFiles.has(finalPath), false);
  assert.ok(
    [...remoteFiles.entries()].some(([key, value]) => String(key).includes(".netcatty-upload-") && value.equals(Buffer.from("new-data"))),
  );
  assert.ok(
    [...remoteFiles.entries()].some(([key, value]) => String(key).includes(".netcatty-backup-") && value.equals(Buffer.from("old-data"))),
  );
});

test("rename fallback replaces safely and restores the old target on promotion failure", async () => {
  const makeClient = ({ failEveryStagePromotion = false } = {}) => {
    const files = new Map([
      ["/tmp/stage", Buffer.from("new")],
      ["/tmp/final", Buffer.from("old")],
    ]);
    let stagePromotionAttempts = 0;
    const channel = {
      readdir(_path, cb) { cb(null, []); },
      mkdir(_path, cb) { cb(null); },
      unlink(targetPath, cb) { files.delete(targetPath); cb(null); },
      stat(targetPath, cb) {
        if (!files.has(targetPath)) {
          const err = new Error("ENOENT");
          err.code = 2;
          cb(err);
          return;
        }
        cb(null, { size: files.get(targetPath).length, isDirectory: false });
      },
    };
    return {
      files,
      client: {
        sftp: channel,
        async stat(targetPath) {
          return { size: files.get(targetPath)?.length || 0, isDirectory: false };
        },
        async rename(from, to) {
          if (from === "/tmp/stage" && to === "/tmp/final") {
            stagePromotionAttempts += 1;
            if (stagePromotionAttempts === 1 || failEveryStagePromotion) {
              throw new Error("overwrite unsupported");
            }
          }
          if (!files.has(from)) throw new Error("ENOENT");
          files.set(to, files.get(from));
          files.delete(from);
        },
        async delete(targetPath) {
          files.delete(targetPath);
        },
      },
    };
  };

  const successful = makeClient();
  await sftpBridge._renameRemotePathForTests(
    successful.client,
    "/tmp/stage",
    "/tmp/final",
    "/tmp/backup",
  );
  assert.deepEqual(successful.files.get("/tmp/final"), Buffer.from("new"));
  assert.equal(successful.files.has("/tmp/backup"), false);

  const restored = makeClient({ failEveryStagePromotion: true });
  await assert.rejects(
    () => sftpBridge._renameRemotePathForTests(
      restored.client,
      "/tmp/stage",
      "/tmp/final",
      "/tmp/backup",
    ),
    /overwrite unsupported/,
  );
  assert.deepEqual(restored.files.get("/tmp/final"), Buffer.from("old"));
  assert.deepEqual(restored.files.get("/tmp/stage"), Buffer.from("new"));
  assert.equal(restored.files.has("/tmp/backup"), false);
});

test("SCP upload stops when the destination type cannot be inspected", async () => {
  let uploadCalls = 0;
  const backend = {
    async stat() {
      throw new Error("temporary stat failure");
    },
    async uploadFile() {
      uploadCalls += 1;
    },
  };
  const client = {
    __netcattyFileProtocol: "scp",
    __netcattyScpBackend: backend,
  };
  sftpBridge.init({
    electronModule: {},
    sessions: new Map(),
    sftpClients: new Map([["scp-stat-fail", client]]),
  });

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: "scp-stat-fail",
      localPath: "/tmp/local.bin",
      remotePath: "/tmp/remote.bin",
      encoding: "utf-8",
    }),
    /temporary stat failure/,
  );
  assert.equal(uploadCalls, 0);
});

test("SCP upload does not replace a symlink that appears before promotion", async () => {
  let statCalls = 0;
  let renameCalls = 0;
  let removedStage = false;
  const backend = {
    async stat() {
      statCalls += 1;
      if (statCalls === 1) return { type: "file", isDirectory: false };
      return { type: "symlink", isDirectory: false, isSymbolicLink: true };
    },
    async uploadFile() {},
    async rename() {
      renameCalls += 1;
    },
    async remove(remotePath) {
      if (String(remotePath).includes(".netcatty-upload-")) removedStage = true;
    },
  };
  const client = {
    __netcattyFileProtocol: "scp",
    __netcattyScpBackend: backend,
  };
  sftpBridge.init({
    electronModule: {},
    sessions: new Map(),
    sftpClients: new Map([["scp-symlink-race", client]]),
  });

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: "scp-symlink-race",
      localPath: "/tmp/local.bin",
      remotePath: "/tmp/remote.bin",
      encoding: "utf-8",
    }),
    /changed to a symlink/,
  );
  assert.equal(renameCalls, 0);
  assert.equal(removedStage, true);
});

test("staged basenames stay within the remote NAME_MAX budget", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-long-name-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });

  const longBase = `${"a".repeat(240)}.bin`;
  const localPath = path.join(tempRoot, "payload.bin");
  await fs.promises.writeFile(localPath, Buffer.from("x"));

  const { channel, fastPutCalls, remoteFiles } = createSessionChannel();
  const connection = {
    sftp(callback) { callback(null, channel); },
  };
  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-long", { conn: connection }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-long",
    fileProtocol: "sftp",
  });

  await sftpBridge.uploadLocalToSftp(null, {
    sftpId: opened.sftpId,
    localPath,
    remotePath: `/tmp/${longBase}`,
    encoding: "utf-8",
  });

  assert.equal(fastPutCalls.length, 1);
  const stagedBase = path.posix.basename(fastPutCalls[0].remotePath);
  assert.ok(Buffer.byteLength(stagedBase, "utf8") <= 255, stagedBase);
  assert.ok(remoteFiles.has(`/tmp/${longBase}`));
});

test("symlink destinations are written in-place (not replaced by rename)", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-symlink-upload-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });

  const localPath = path.join(tempRoot, "cfg.json");
  const payload = Buffer.from('{"ok":true}');
  await fs.promises.writeFile(localPath, payload);

  const { channel, fastPutCalls, remoteFiles, remoteMeta } = createSessionChannel();
  // Symlink at the destination path; real content elsewhere.
  remoteMeta.set("/etc/app/config.json", { isSymlink: true, mode: 0o120777 });
  remoteFiles.set("/etc/app/config.json", Buffer.from("link-placeholder"));

  const connection = {
    sftp(callback) { callback(null, channel); },
  };
  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-link", { conn: connection }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-link",
    fileProtocol: "sftp",
  });

  await sftpBridge.uploadLocalToSftp(null, {
    sftpId: opened.sftpId,
    localPath,
    remotePath: "/etc/app/config.json",
    encoding: "utf-8",
  });

  assert.equal(fastPutCalls.length, 1);
  assert.equal(fastPutCalls[0].remotePath, "/etc/app/config.json");
  assert.deepEqual(remoteFiles.get("/etc/app/config.json"), payload);
});

test("lstat unsupported falls back to stat and preserves an existing destination", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-lstat-fallback-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });

  const localPath = path.join(tempRoot, "cfg.json");
  const payload = Buffer.from('{"fallback":true}');
  await fs.promises.writeFile(localPath, payload);

  const { channel, fastPutCalls, remoteFiles, remoteMeta } = createSessionChannel();
  remoteFiles.set("/etc/app/config.json", Buffer.from("old-target-content"));
  remoteMeta.set("/etc/app/config.json", { isSymlink: true, mode: 0o120777 });
  channel.lstat = (_targetPath, callback) => {
    const err = new Error("SSH_FX_OP_UNSUPPORTED");
    err.code = 8;
    callback(err);
  };

  const connection = {
    sftp(callback) { callback(null, channel); },
  };
  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-lstat-fallback", { conn: connection }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-lstat-fallback",
    fileProtocol: "sftp",
  });

  await sftpBridge.uploadLocalToSftp(null, {
    sftpId: opened.sftpId,
    localPath,
    remotePath: "/etc/app/config.json",
    encoding: "utf-8",
  });

  assert.equal(fastPutCalls.length, 1);
  assert.equal(fastPutCalls[0].remotePath, "/etc/app/config.json");
  assert.deepEqual(remoteFiles.get("/etc/app/config.json"), payload);
});

test("parent-dir permission on staged path falls back to in-place for new files", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-stage-perm-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });

  const localPath = path.join(tempRoot, "data.bin");
  const payload = Buffer.from("new-content");
  await fs.promises.writeFile(localPath, payload);

  const { channel, fastPutCalls, remoteFiles } = createSessionChannel({
    onFastPut(_local, remotePath) {
      if (String(remotePath).includes(".netcatty-upload-")) {
        const err = new Error("Permission denied");
        err.code = 3;
        return { error: err };
      }
      return null;
    },
  });
  // Destination does not exist → staging is attempted first.

  const connection = {
    sftp(callback) { callback(null, channel); },
  };
  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-perm", { conn: connection }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-perm",
    fileProtocol: "sftp",
  });

  await sftpBridge.uploadLocalToSftp(null, {
    sftpId: opened.sftpId,
    localPath,
    remotePath: "/ro-dir/file.bin",
    encoding: "utf-8",
  });

  assert.ok(fastPutCalls.length >= 2, "expected staged attempt then in-place");
  assert.match(fastPutCalls[0].remotePath, /\.netcatty-upload-.*\.part$/);
  assert.equal(fastPutCalls[fastPutCalls.length - 1].remotePath, "/ro-dir/file.bin");
  assert.deepEqual(remoteFiles.get("/ro-dir/file.bin"), payload);
});

test("late abort during staged size verify does not promote .part", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-late-abort-promote-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });

  const localPath = path.join(tempRoot, "payload.bin");
  const payload = Buffer.from("late-abort-payload");
  await fs.promises.writeFile(localPath, payload);

  const { channel, fastPutCalls, remoteFiles } = createSessionChannel();
  const controller = new AbortController();
  let renameCalled = false;
  const origStat = channel.stat.bind(channel);
  const origRename = channel.rename.bind(channel);
  channel.stat = (targetPath, callback) => {
    if (String(targetPath).includes(".netcatty-upload-")) {
      // Abort while size verification is in flight so the post-stat check must
      // block promotion (throwIfAborted after await client.stat).
      controller.abort();
      queueMicrotask(() => origStat(targetPath, callback));
      return;
    }
    return origStat(targetPath, callback);
  };
  channel.rename = (from, to, callback) => {
    renameCalled = true;
    return origRename(from, to, callback);
  };

  const connection = {
    sftp(callback) { callback(null, channel); },
  };
  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-late-abort", { conn: connection }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-late-abort",
    fileProtocol: "sftp",
  });

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: opened.sftpId,
      localPath,
      remotePath: "/tmp/late-abort.bin",
      encoding: "utf-8",
      abortSignal: controller.signal,
    }),
    /abort|cancel/i,
  );

  assert.equal(fastPutCalls.length, 1);
  assert.match(fastPutCalls[0].remotePath, /\.netcatty-upload-.*\.part$/);
  assert.equal(renameCalled, false);
  assert.equal(remoteFiles.has("/tmp/late-abort.bin"), false);
});

test("size-mismatch on path containing 'access' does not fall back to in-place", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-access-name-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });

  const localPath = path.join(tempRoot, "payload.bin");
  const payload = Buffer.from("twelve-bytes"); // 12 bytes
  await fs.promises.writeFile(localPath, payload);

  const { channel, fastPutCalls } = createSessionChannel();
  // Make staged-path stat report a wrong size so size-verify throws a message
  // containing the path word "access" — must NOT be treated as permission.
  const origStat = channel.stat.bind(channel);
  channel.stat = (targetPath, callback) => {
    if (String(targetPath).includes(".netcatty-upload-")) {
      callback(null, {
        size: 1,
        mode: 0o100644,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      });
      return;
    }
    return origStat(targetPath, callback);
  };

  const connection = {
    sftp(callback) { callback(null, channel); },
  };
  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-access", { conn: connection }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-access",
    fileProtocol: "sftp",
  });

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: opened.sftpId,
      localPath,
      remotePath: "/tmp/access-denied-name.bin",
      encoding: "utf-8",
    }),
    /size mismatch/i,
  );
  // Only the staged attempt — no in-place fallback write to the final path.
  assert.equal(fastPutCalls.length, 1);
  assert.match(fastPutCalls[0].remotePath, /\.netcatty-upload-.*\.part$/);
});

test("pipelinedUploadLocalFile aborts in-flight fastPut when AbortSignal fires", async () => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-abort-fastput-"));
  const localPath = path.join(tempRoot, "abort.bin");
  await fs.promises.writeFile(localPath, Buffer.alloc(64 * 1024, 3));

  let ended = false;
  let fastPutStarted = false;
  const channel = {
    readdir(_p, cb) { cb(null, []); },
    mkdir(_p, cb) { cb(null); },
    unlink(_p, cb) { cb(null); },
    stat(_p, cb) {
      const err = new Error("ENOENT");
      err.code = 2;
      cb(err);
    },
    fastPut(_local, _remote, _opts, callback) {
      fastPutStarted = true;
      // Stay pending until end() cancels the transfer.
      this._pendingCallback = callback;
    },
    end() {
      ended = true;
      const cb = this._pendingCallback;
      this._pendingCallback = null;
      if (typeof cb === "function") {
        const err = new Error("SFTP channel closed");
        queueMicrotask(() => cb(err));
      }
    },
  };
  const bareClient = {
    __netcattySessionBacked: true,
    sftp: null,
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

  const controller = new AbortController();
  const uploadPromise = sftpBridge.pipelinedUploadLocalFile(
    bareClient,
    localPath,
    "/tmp/abort-out.bin",
    {
      concurrency: UPLOAD_TRANSFER_CONCURRENCY,
      chunkSize: TRANSFER_CHUNK_SIZE,
      signal: controller.signal,
    },
  );

  // Allow fastPut to start, then abort.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fastPutStarted, true);
  controller.abort();

  await assert.rejects(uploadPromise, /abort|cancel/i);
  assert.equal(ended, true);

  await fs.promises.rm(tempRoot, { recursive: true, force: true });
});

test("shared-channel fastPut cancel force-settles when callback stalls", async () => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-shared-abort-bound-"));
  const localPath = path.join(tempRoot, "stall.bin");
  await fs.promises.writeFile(localPath, Buffer.alloc(8 * 1024, 5));

  let ended = false;
  let unlinkedPath = null;
  const channel = {
    readdir(_p, cb) { cb(null, []); },
    mkdir(_p, cb) { cb(null); },
    unlink(targetPath, cb) {
      unlinkedPath = targetPath;
      cb(null);
    },
    stat(_p, cb) {
      const err = new Error("ENOENT");
      err.code = 2;
      cb(err);
    },
    // Never invoke the callback — simulates a stalled shared-channel fastPut.
    fastPut() {},
    end() {
      ended = true;
    },
  };
  // No client.sftp() for a second channel → acquireUpload uses shared channel.
  const sharedOnlyClient = {
    __netcattySudoMode: true,
    sftp: channel,
    client: null,
  };

  sftpBridge.init({
    electronModule: {},
    sessions: new Map(),
    sftpClients: new Map(),
  });

  const controller = new AbortController();
  const uploadPromise = sftpBridge.pipelinedUploadLocalFile(
    sharedOnlyClient,
    localPath,
    "/tmp/stall-out.bin",
    {
      concurrency: UPLOAD_TRANSFER_CONCURRENCY,
      chunkSize: TRANSFER_CHUNK_SIZE,
      signal: controller.signal,
    },
  );

  await new Promise((r) => setImmediate(r));
  controller.abort();

  const started = Date.now();
  await assert.rejects(uploadPromise, /abort|cancel/i);
  const elapsed = Date.now() - started;
  // Must settle via the 2s force-finish path, not hang forever.
  assert.ok(elapsed < 5000, `cancel took too long: ${elapsed}ms`);
  // Shared channel must not be ended (would kill browse/sudo session).
  assert.equal(ended, false);
  // Final destinations must not be unlinked on shared-channel force-settle.
  assert.equal(unlinkedPath, null);

  await fs.promises.rm(tempRoot, { recursive: true, force: true });
});

test("shared-channel force-settle unlinks explicitly generated stage paths", async () => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-shared-stage-unlink-"));
  const localPath = path.join(tempRoot, "stall.bin");
  await fs.promises.writeFile(localPath, Buffer.alloc(4 * 1024, 9));

  let unlinkedPath = null;
  const channel = {
    readdir(_p, cb) { cb(null, []); },
    mkdir(_p, cb) { cb(null); },
    unlink(targetPath, cb) {
      unlinkedPath = targetPath;
      cb(null);
    },
    stat(_p, cb) {
      const err = new Error("ENOENT");
      err.code = 2;
      cb(err);
    },
    fastPut() {},
    end() {},
  };
  const sharedOnlyClient = {
    __netcattySudoMode: true,
    sftp: channel,
    client: null,
  };

  sftpBridge.init({
    electronModule: {},
    sessions: new Map(),
    sftpClients: new Map(),
  });

  const controller = new AbortController();
  const stagedPath = "/tmp/.netcatty-upload-deadbeef-stall.bin.part";
  const uploadPromise = sftpBridge.pipelinedUploadLocalFile(
    sharedOnlyClient,
    localPath,
    stagedPath,
    {
      concurrency: UPLOAD_TRANSFER_CONCURRENCY,
      chunkSize: TRANSFER_CHUNK_SIZE,
      signal: controller.signal,
      generatedStagePath: true,
    },
  );

  await new Promise((r) => setImmediate(r));
  controller.abort();
  await assert.rejects(uploadPromise, /abort|cancel/i);
  assert.equal(unlinkedPath, stagedPath);

  await fs.promises.rm(tempRoot, { recursive: true, force: true });
});

test("shared-channel cancel never unlinks a caller path that resembles a stage", async () => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-shared-stage-lookalike-"));
  const localPath = path.join(tempRoot, "stall.bin");
  await fs.promises.writeFile(localPath, Buffer.alloc(4 * 1024, 11));

  let unlinkedPath = null;
  const channel = {
    readdir(_p, cb) { cb(null, []); },
    mkdir(_p, cb) { cb(null); },
    unlink(targetPath, cb) {
      unlinkedPath = targetPath;
      cb(null);
    },
    stat(_p, cb) {
      const err = new Error("ENOENT");
      err.code = 2;
      cb(err);
    },
    fastPut() {},
    end() {},
  };
  const sharedOnlyClient = {
    __netcattySudoMode: true,
    sftp: channel,
    client: null,
  };

  sftpBridge.init({
    electronModule: {},
    sessions: new Map(),
    sftpClients: new Map(),
  });

  const controller = new AbortController();
  const callerPath = "/tmp/.netcatty-upload-deadbeef-user-file.part";
  const uploadPromise = sftpBridge.pipelinedUploadLocalFile(
    sharedOnlyClient,
    localPath,
    callerPath,
    {
      concurrency: UPLOAD_TRANSFER_CONCURRENCY,
      chunkSize: TRANSFER_CHUNK_SIZE,
      signal: controller.signal,
    },
  );

  await new Promise((r) => setImmediate(r));
  controller.abort();
  await assert.rejects(uploadPromise, /abort|cancel/i);
  assert.equal(unlinkedPath, null);

  await fs.promises.rm(tempRoot, { recursive: true, force: true });
});

test("shared-channel fastPut error force-settles when callback stalls", async () => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-shared-error-bound-"));
  const localPath = path.join(tempRoot, "err.bin");
  await fs.promises.writeFile(localPath, Buffer.alloc(4 * 1024, 7));

  let ended = false;
  const channel = new EventEmitter();
  Object.assign(channel, {
    readdir(_p, cb) { cb(null, []); },
    mkdir(_p, cb) { cb(null); },
    unlink(_p, cb) { cb(null); },
    stat(_p, cb) {
      const err = new Error("ENOENT");
      err.code = 2;
      cb(err);
    },
    // Emit channel error and never invoke the fastPut callback.
    fastPut() {
      queueMicrotask(() => channel.emit("error", new Error("channel failed")));
    },
    end() {
      ended = true;
    },
  });
  const sharedOnlyClient = {
    __netcattySudoMode: true,
    sftp: channel,
    client: null,
  };

  sftpBridge.init({
    electronModule: {},
    sessions: new Map(),
    sftpClients: new Map(),
  });

  const uploadPromise = sftpBridge.pipelinedUploadLocalFile(
    sharedOnlyClient,
    localPath,
    "/tmp/err-out.bin",
    {
      concurrency: UPLOAD_TRANSFER_CONCURRENCY,
      chunkSize: TRANSFER_CHUNK_SIZE,
    },
  );

  const started = Date.now();
  await assert.rejects(uploadPromise, /channel failed|SFTP channel/i);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `error settle took too long: ${elapsed}ms`);
  assert.equal(ended, false);

  await fs.promises.rm(tempRoot, { recursive: true, force: true });
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
