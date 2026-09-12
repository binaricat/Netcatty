"use strict";

/**
 * Session-backed SFTP clients (openForSession / terminal reuse) are not
 * ssh2-sftp-client instances. They must still expose pipelined fastPut so
 * uploadLocal stays on the high-throughput path
 * (#2449 fail-closed alignment; no serial WriteStream crawl).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sftpBridge = require("./sftpBridge.cjs");
const transferBridge = require("./transferBridge.cjs");
const tempDirBridge = require("./tempDirBridge.cjs");
const {
  buildConnectionReuseEndpoint,
  normalizeEndpoint,
} = require("./sshConnectionPool.cjs");
const {
  TRANSFER_CHUNK_SIZE,
  UPLOAD_TRANSFER_CONCURRENCY,
} = require("./transferLimits.cjs");

function createSessionChannel(options = {}) {
  const fastPutCalls = [];
  const remoteFiles = new Map();
  const remoteMeta = new Map(); // path -> { mode, isSymlink }
  const chmodCalls = [];
  const { Readable } = require("node:stream");
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
    createReadStream(targetPath) {
      const data = remoteFiles.get(targetPath);
      if (!data) {
        const stream = new Readable({ read() {} });
        queueMicrotask(() => {
          const err = new Error(`ENOENT ${targetPath}`);
          err.code = 2;
          stream.destroy(err);
        });
        return stream;
      }
      return Readable.from([Buffer.from(data)]);
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
        mtime: meta.mtime ?? 0,
        uid: meta.uid ?? 0,
        gid: meta.gid ?? 0,
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
        mtime: meta?.mtime ?? 0,
        uid: meta?.uid ?? 0,
        gid: meta?.gid ?? 0,
        isDirectory: () => false,
        isFile: () => !meta?.isSymlink,
        isSymbolicLink: () => !!meta?.isSymlink,
      });
    },
    readlink(targetPath, callback) {
      const meta = remoteMeta.get(targetPath);
      if (!meta?.isSymlink) {
        const err = new Error(`ENOENT ${targetPath}`);
        err.code = 2;
        callback(err);
        return;
      }
      callback(null, meta.linkPath || "/missing-target");
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

test("openSftpForSession rejects a same-target session reached through a different jump route", async () => {
  let openedChannel = false;
  const connection = {
    sftp(callback) {
      openedChannel = true;
      callback(null, createSessionChannel().channel);
    },
  };
  const base = {
    hostId: "same-host",
    hostname: "target.example",
    port: 22,
    username: "alice",
    authMethod: "password",
    password: "target-password",
    verifyHostKeys: true,
  };
  const actualEndpoint = normalizeEndpoint(buildConnectionReuseEndpoint({
    ...base,
    jumpHosts: [{
      hostId: "jump-a",
      hostname: "jump-a.example",
      username: "jump-user",
      password: "jump-a-password",
    }],
  }));
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["split-route-session", {
      conn: connection,
      _reuseEndpoint: actualEndpoint,
    }]]),
    sftpClients: new Map(),
  });

  await assert.rejects(
    sftpBridge.openSftpForSession(null, {
      sessionId: "split-route-session",
      expectedEndpoint: {
        ...base,
        jumpHosts: [{
          hostId: "jump-b",
          hostname: "jump-b.example",
          username: "jump-user",
          password: "jump-b-password",
        }],
      },
    }),
    (err) => err?.code === "ERR_SFTP_SOURCE_ROUTE_MISMATCH",
  );
  assert.equal(openedChannel, false, "the mismatched transport must not be borrowed even briefly");
});

test("openSftpForSession skips a mismatched source hint and reuses another session with the full route identity", async () => {
  let wrongRouteOpened = false;
  let matchingRouteOpened = false;
  const wrongConnection = {
    sftp(callback) {
      wrongRouteOpened = true;
      callback(null, createSessionChannel().channel);
    },
  };
  const matchingConnection = {
    sftp(callback) {
      matchingRouteOpened = true;
      callback(null, createSessionChannel().channel);
    },
  };
  const base = {
    hostId: "same-host",
    hostname: "target.example",
    port: 22,
    username: "alice",
    authMethod: "password",
    password: "target-password",
    verifyHostKeys: true,
    knownHosts: [{
      hostname: "target.example",
      port: 22,
      keyType: "ssh-ed25519",
      fingerprint: "target-fingerprint",
    }],
  };
  const wrongEndpoint = normalizeEndpoint(buildConnectionReuseEndpoint({
    ...base,
    proxy: {
      type: "socks5",
      host: "proxy-a.example",
      port: 1080,
      username: "proxy-user",
      password: "proxy-a-password",
    },
    jumpHosts: [{
      hostId: "jump-a",
      hostname: "jump-a.example",
      username: "jump-user",
      password: "jump-a-password",
    }],
  }));
  const matchingOptions = {
    ...base,
    proxy: {
      type: "socks5",
      host: "proxy-b.example",
      port: 1080,
      username: "proxy-user",
      password: "proxy-b-password",
    },
    jumpHosts: [{
      hostId: "jump-b",
      hostname: "jump-b.example",
      username: "jump-user",
      password: "jump-b-password",
    }],
  };
  const matchingEndpoint = normalizeEndpoint(buildConnectionReuseEndpoint(matchingOptions));
  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([
      ["wrong-source-hint", { conn: wrongConnection, _reuseEndpoint: wrongEndpoint }],
      ["matching-source", { conn: matchingConnection, _reuseEndpoint: matchingEndpoint }],
    ]),
    sftpClients,
  });

  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "wrong-source-hint",
    expectedEndpoint: matchingOptions,
    fileProtocol: "sftp",
  });

  assert.equal(wrongRouteOpened, false, "the endpoint-only source hint must never be borrowed");
  assert.equal(matchingRouteOpened, true, "a session with the complete matching identity should be reused");
  assert.match(opened.sftpId, /^matching-source-sftp-/);
  assert.equal(opened.sourceSessionId, "matching-source");
  assert.equal(sftpClients.has(opened.sftpId), true);
  await sftpBridge.closeSftp(null, { sftpId: opened.sftpId });
});

test("strict openSftpForSession never substitutes another matching live session", async () => {
  let alternateOpened = false;
  const connection = {
    sftp(callback) {
      alternateOpened = true;
      callback(null, createSessionChannel().channel);
    },
  };
  const options = {
    hostId: "same-host",
    hostname: "target.example",
    port: 22,
    username: "alice",
    authMethod: "password",
    password: "target-password",
    verifyHostKeys: false,
  };
  const endpoint = normalizeEndpoint(buildConnectionReuseEndpoint(options));
  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["matching-alternate", { conn: connection, _reuseEndpoint: endpoint }]]),
    sftpClients,
  });

  await assert.rejects(
    sftpBridge.openSftpForSession(null, {
      sessionId: "missing-requested-session",
      expectedEndpoint: options,
      requireExactSourceSession: true,
      fileProtocol: "sftp",
    }),
    (error) => error?.code === "ERR_SFTP_SOURCE_ROUTE_MISMATCH",
  );

  assert.equal(alternateOpened, false);
  assert.equal(sftpClients.size, 0);
});

test("openSftpForSession reuses the hinted session when its full route and security identity match", async () => {
  let openedChannel = false;
  const connection = {
    sftp(callback) {
      openedChannel = true;
      callback(null, createSessionChannel().channel);
    },
  };
  const options = {
    hostId: "same-host",
    hostname: "target.example",
    port: 22,
    username: "alice",
    authMethod: "password",
    password: "target-password",
    requiresMfa: true,
    verifyHostKeys: true,
    keepaliveInterval: 15,
    keepaliveCountMax: 4,
    proxy: {
      type: "http",
      host: "proxy.example",
      port: 8080,
      username: "proxy-user",
      password: "proxy-password",
    },
    jumpHosts: [{
      hostId: "jump",
      hostname: "jump.example",
      username: "jump-user",
      password: "jump-password",
    }],
  };
  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["matching-source", {
      conn: connection,
      _reuseEndpoint: normalizeEndpoint(buildConnectionReuseEndpoint(options)),
    }]]),
    sftpClients,
  });

  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "matching-source",
    expectedEndpoint: options,
    fileProtocol: "sftp",
  });

  assert.equal(openedChannel, true);
  assert.match(opened.sftpId, /^matching-source-sftp-/);
  assert.equal(opened.sourceSessionId, "matching-source");
  await sftpBridge.closeSftp(null, { sftpId: opened.sftpId });
});

test("downloadSftpToLocal aborts while initial SFTP metadata is stalled", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-sftp-stat-abort-"));
  t.after(async () => fs.promises.rm(tempRoot, { recursive: true, force: true }));
  let markStatStarted;
  const statStarted = new Promise((resolve) => { markStatStarted = resolve; });
  const client = {
    sftp: createSessionChannel().channel,
    stat() {
      markStatStarted();
      return new Promise(() => {});
    },
  };
  sftpBridge.init({
    electronModule: {},
    sessions: new Map(),
    sftpClients: new Map([["stalled-stat", client]]),
  });
  const controller = new AbortController();
  const download = sftpBridge.downloadSftpToLocal(null, {
    sftpId: "stalled-stat",
    remotePath: "/tmp/source.bin",
    localPath: path.join(tempRoot, "target.bin"),
    abortSignal: controller.signal,
  });

  await statStarted;
  controller.abort();
  await assert.rejects(
    () => Promise.race([
      download,
      new Promise((_, reject) => setTimeout(() => reject(new Error("cancel timed out")), 500)),
    ]),
    /cancel|abort/i,
  );
});

test("aborted session open closes a channel that arrives after the client is discarded", async () => {
  let releaseOpen;
  let markOpenStarted;
  const openStarted = new Promise((resolve) => { markOpenStarted = resolve; });
  const connection = {
    sftp(callback) {
      releaseOpen = callback;
      markOpenStarted();
    },
  };
  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-late-open", { conn: connection }]]),
    sftpClients,
  });
  const controller = new AbortController();
  const opening = sftpBridge.openSftpForSession(null, {
    sessionId: "session-late-open",
    fileProtocol: "sftp",
    abortSignal: controller.signal,
  });

  await openStarted;
  controller.abort(new Error("stop opening"));
  await assert.rejects(opening, /stop opening/);

  const created = createSessionChannel();
  let endCalls = 0;
  created.channel.end = () => { endCalls += 1; };
  releaseOpen(null, created.channel);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(endCalls, 1);
  assert.equal(sftpClients.size, 0);
});

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
  // Size-based uploads stream the live local path (no content snapshot).
  assert.equal(fastPutCalls[0].localPath, localPath);
  // Final path after staged rename
  assert.ok(remoteFiles.has("/home/alice/payload.bin"));
  assert.deepEqual(remoteFiles.get("/home/alice/payload.bin"), payload);
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

  const encodedStage = Buffer.from([0x81, 0x40]);
  const encodedFinal = Buffer.from([0x81, 0x41]);
  const encodedBackup = Buffer.from([0x81, 0x42]);
  const channel = {
    readdir(_path, cb) { cb(null, []); },
    mkdir(_path, cb) { cb(null); },
    unlink(_path, cb) { cb(null); },
    stat(_path, cb) { cb(null, { size: 1, isDirectory: false }); },
  };
  const encodedClient = {
    sftp: channel,
    async stat() { return { size: 1, isDirectory: false }; },
    async rename(from, to) {
      if (from === encodedFinal && to === encodedBackup) return;
      if (from === encodedStage && to === encodedFinal) throw new Error("promote failed");
      if (from === encodedBackup && to === encodedFinal) throw new Error("restore failed");
    },
    async delete() {},
  };
  await assert.rejects(
    () => sftpBridge._renameRemotePathForTests(
      encodedClient,
      encodedStage,
      encodedFinal,
      encodedBackup,
      {
        stagePath: "/目录/.netcatty-upload-stage.part",
        backupPath: "/目录/.netcatty-backup-file.bak",
        finalPath: "/目录/文件.txt",
      },
    ),
    (error) => {
      assert.match(error.message, /\/目录\/\.netcatty-upload-stage\.part/);
      assert.match(error.message, /\/目录\/\.netcatty-backup-file\.bak/);
      return true;
    },
  );
});

test("SFTP rename fallback retries backup cleanup and reports a recoverable persistent failure", async () => {
  const makeClient = (persistent) => {
    const files = new Map([
      ["/tmp/stage", Buffer.from("new")],
      ["/tmp/final", Buffer.from("old")],
    ]);
    let promoteAttempts = 0;
    let deleteAttempts = 0;
    return {
      files,
      get deleteAttempts() { return deleteAttempts; },
      client: {
        sftp: {
          readdir(_path, cb) { cb(null, []); },
          mkdir(_path, cb) { cb(null); },
          unlink(_path, cb) { cb(null); },
          stat(targetPath, cb) {
            if (!files.has(targetPath)) {
              const error = new Error("ENOENT");
              error.code = 2;
              cb(error);
              return;
            }
            cb(null, { size: files.get(targetPath).length, isDirectory: false });
          },
        },
        async stat(targetPath) {
          return { size: files.get(targetPath)?.length || 0, isDirectory: false };
        },
        async rename(from, to) {
          if (from === "/tmp/stage" && to === "/tmp/final" && promoteAttempts++ === 0) {
            throw new Error("overwrite unsupported");
          }
          if (!files.has(from)) throw new Error("ENOENT");
          files.set(to, files.get(from));
          files.delete(from);
        },
        async delete(targetPath) {
          deleteAttempts += 1;
          if (persistent || deleteAttempts < 3) throw new Error("backup busy");
          files.delete(targetPath);
        },
      },
    };
  };

  const transient = makeClient(false);
  await sftpBridge._renameRemotePathForTests(
    transient.client,
    "/tmp/stage",
    "/tmp/final",
    "/tmp/backup",
    { finalPath: "/tmp/final", backupPath: "/tmp/backup" },
  );
  assert.equal(transient.deleteAttempts, 3);
  assert.deepEqual(transient.files.get("/tmp/final"), Buffer.from("new"));
  assert.equal(transient.files.has("/tmp/backup"), false);

  const persistent = makeClient(true);
  await assert.rejects(
    () => sftpBridge._renameRemotePathForTests(
      persistent.client,
      "/tmp/stage",
      "/tmp/final",
      "/tmp/backup",
      { finalPath: "/tmp/final", backupPath: "/tmp/backup" },
    ),
    (error) => {
      assert.equal(error.recoverable, true);
      assert.equal(error.remoteFinalPath, "/tmp/final");
      assert.equal(error.remoteBackupPath, "/tmp/backup");
      return true;
    },
  );
  assert.equal(persistent.deleteAttempts, 3);
  assert.deepEqual(persistent.files.get("/tmp/final"), Buffer.from("new"));
  assert.deepEqual(persistent.files.get("/tmp/backup"), Buffer.from("old"));
});

function createScpBackupCleanupHarness({ persistent }) {
  const finalPath = "/tmp/scp-final.bin";
  const backupPath = sftpBridge._buildBackupRemotePathForTests(finalPath);
  const files = new Map([[finalPath, Buffer.from("old")]]);
  let backupDeleteAttempts = 0;
  let uploadCalls = 0;
  const missing = (candidate) => {
    const error = new Error(`ENOENT: ${candidate}`);
    error.code = "ENOENT";
    return error;
  };
  const backend = {
    async stat(candidate) {
      if (!files.has(candidate)) throw missing(candidate);
      return {
        type: "file",
        isDirectory: false,
        isSymbolicLink: false,
        size: files.get(candidate).length,
        mode: 0o100644,
        permissions: "rw-r--r--",
        modifyTime: 1,
      };
    },
    async chmod() {},
    async rename(from, to) {
      if (!files.has(from)) throw missing(from);
      if (files.has(to)) throw new Error(`EEXIST: ${to}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async remove(candidate) {
      if (candidate === backupPath) {
        backupDeleteAttempts += 1;
        if (persistent || backupDeleteAttempts < 3) throw new Error("backup cleanup unavailable");
      }
      files.delete(candidate);
    },
  };
  const client = {
    __netcattyFileProtocol: "scp",
    __netcattyScpBackend: backend,
  };
  const upload = () => sftpBridge.runRemoteUploadTransaction(client, "/tmp/local.bin", finalPath, {
    expectedSize: 3,
    async uploadFile(_encodedPath, uploadTarget) {
      uploadCalls += 1;
      files.set(uploadTarget.logicalPath, Buffer.from("new"));
    },
  });
  return {
    finalPath,
    backupPath,
    files,
    upload,
    get backupDeleteAttempts() { return backupDeleteAttempts; },
    get uploadCalls() { return uploadCalls; },
  };
}

test("SCP upload retries transient backup cleanup", async () => {
  const harness = createScpBackupCleanupHarness({ persistent: false });
  await harness.upload();
  assert.equal(harness.backupDeleteAttempts, 3);
  assert.deepEqual(harness.files.get(harness.finalPath), Buffer.from("new"));
  assert.equal(harness.files.has(harness.backupPath), false);
});

test("SCP persistent cleanup failure remains recoverable and repeated upload creates no new backup", async () => {
  const harness = createScpBackupCleanupHarness({ persistent: true });
  await assert.rejects(harness.upload, (error) => {
    assert.equal(error.recoverable, true);
    assert.equal(error.remoteFinalPath, harness.finalPath);
    assert.equal(error.remoteBackupPath, harness.backupPath);
    return true;
  });
  assert.deepEqual(harness.files.get(harness.finalPath), Buffer.from("new"));
  assert.deepEqual(harness.files.get(harness.backupPath), Buffer.from("old"));
  assert.equal(harness.uploadCalls, 1);

  await assert.rejects(harness.upload, /backup cleanup unavailable/);
  assert.equal(harness.uploadCalls, 1, "the next attempt must reconcile the stable backup before uploading");
  assert.deepEqual(
    [...harness.files.keys()].filter((candidate) => candidate.includes(".netcatty-backup-")),
    [harness.backupPath],
  );
});

test("SCP upload stops when the destination type cannot be inspected", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-scp-stat-fail-"));
  t.after(async () => fs.promises.rm(tempRoot, { recursive: true, force: true }));
  const localPath = path.join(tempRoot, "local.bin");
  await fs.promises.writeFile(localPath, Buffer.from("payload"));
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
      localPath,
      remotePath: "/tmp/remote.bin",
      encoding: "utf-8",
    }),
    /temporary stat failure/,
  );
  assert.equal(uploadCalls, 0);
});

test("SCP upload does not replace a symlink that appears before promotion", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-scp-symlink-race-"));
  t.after(async () => fs.promises.rm(tempRoot, { recursive: true, force: true }));
  const localPath = path.join(tempRoot, "local.bin");
  await fs.promises.writeFile(localPath, Buffer.from("payload"));
  let targetStatCalls = 0;
  let renameCalls = 0;
  let removedStage = false;
  const backend = {
    async stat(remotePath) {
      const candidate = String(remotePath);
      if (candidate.includes(".netcatty-backup-")) {
        const error = new Error("ENOENT");
        error.code = "ENOENT";
        throw error;
      }
      if (candidate.includes(".netcatty-upload-")) {
        return { type: "file", isDirectory: false, size: 7 };
      }
      targetStatCalls += 1;
      if (targetStatCalls === 1) return { type: "file", isDirectory: false };
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
      localPath,
      remotePath: "/tmp/remote.bin",
      encoding: "utf-8",
    }),
    /changed to a symlink/,
  );
  assert.equal(renameCalls, 0);
  assert.equal(removedStage, true);
});

test("SCP upload cancelled during the final target check does not promote", async () => {
  const controller = new AbortController();
  let targetStatCalls = 0;
  let renameCalls = 0;
  let removedStage = false;
  const backend = {
    async stat(remotePath) {
      const candidate = String(remotePath);
      if (candidate.includes(".netcatty-backup-")) {
        const error = new Error("ENOENT");
        error.code = "ENOENT";
        throw error;
      }
      if (candidate.includes(".netcatty-upload-")) {
        return { type: "file", isDirectory: false, size: 7 };
      }
      targetStatCalls += 1;
      if (targetStatCalls > 1) controller.abort();
      return { type: "file", isDirectory: false, size: 3 };
    },
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

  await assert.rejects(
    () => sftpBridge.runRemoteUploadTransaction(client, "/tmp/local.bin", "/tmp/remote.bin", {
      signal: controller.signal,
      expectedSize: 7,
      async uploadFile() {},
    }),
    /abort/i,
  );
  assert.equal(renameCalls, 0);
  assert.equal(removedStage, true);
});

test("SCP upload aborts while staged size verification is pending", async () => {
  const controller = new AbortController();
  let removedStage = false;
  const backend = {
    async stat(remotePath, options = {}) {
      if (!String(remotePath).includes(".netcatty-upload-")) {
        const error = new Error("No such file");
        error.code = "ENOENT";
        throw error;
      }
      await new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error("Transfer cancelled"));
          return;
        }
        options.signal?.addEventListener(
          "abort",
          () => reject(new Error("Transfer cancelled")),
          { once: true },
        );
      });
    },
    async remove(remotePath) {
      if (String(remotePath).includes(".netcatty-upload-")) removedStage = true;
    },
  };
  const client = {
    __netcattyFileProtocol: "scp",
    __netcattyScpBackend: backend,
  };
  const upload = sftpBridge.runRemoteUploadTransaction(
    client,
    "/tmp/local.bin",
    "/tmp/remote.bin",
    {
      signal: controller.signal,
      expectedSize: 7,
      async uploadFile() {},
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(() => upload, /cancel|abort/i);
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

test("truncated write-in-place uploads never delete the symlink destination", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-symlink-size-failure-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });

  const localPath = path.join(tempRoot, "cfg.json");
  const payload = Buffer.from('{"expected":"full-content"}');
  await fs.promises.writeFile(localPath, payload);

  const { channel, fastPutCalls, remoteFiles, remoteMeta } = createSessionChannel();
  const remotePath = "/etc/app/config.json";
  remoteMeta.set(remotePath, { isSymlink: true, mode: 0o120777 });
  remoteFiles.set(remotePath, Buffer.from("old-target"));
  channel.fastPut = (_localPath, uploadedPath, opts, callback) => {
    fastPutCalls.push({ localPath: _localPath, remotePath: uploadedPath });
    const truncated = payload.subarray(0, 3);
    remoteFiles.set(uploadedPath, truncated);
    opts?.step?.(truncated.length, truncated.length, payload.length);
    queueMicrotask(() => callback(null));
  };

  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-link-size", { conn: { sftp: (callback) => callback(null, channel) } }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-link-size",
    fileProtocol: "sftp",
  });

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: opened.sftpId,
      localPath,
      remotePath,
      encoding: "utf-8",
    }),
    /size mismatch/i,
  );
  assert.equal(fastPutCalls.length, 1);
  assert.equal(remoteMeta.get(remotePath)?.isSymlink, true);
  assert.equal(remoteFiles.has(remotePath), true);
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

test("new files stage safely when readlink distinguishes them without lstat", async (t) => {
  for (const variant of ["missing-method", "runtime-unsupported"]) {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), `netcatty-new-no-lstat-${variant}-`));
    t.after(async () => {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    });
    tempDirBridge.init?.({ getPath: () => tempRoot });

    const localPath = path.join(tempRoot, "new.bin");
    const payload = Buffer.from(`new-${variant}`);
    await fs.promises.writeFile(localPath, payload);
    const { channel, fastPutCalls, remoteFiles } = createSessionChannel();
    if (variant === "missing-method") {
      channel.lstat = undefined;
    } else {
      channel.lstat = (_targetPath, callback) => {
        const err = new Error("SSH_FX_OP_UNSUPPORTED");
        err.code = 8;
        callback(err);
      };
    }

    const sftpClients = new Map();
    sftpBridge.init({
      electronModule: { webContents: { fromId: () => null } },
      sessions: new Map([[`session-${variant}`, { conn: { sftp: (cb) => cb(null, channel) } }]]),
      sftpClients,
    });
    const opened = await sftpBridge.openSftpForSession(null, {
      sessionId: `session-${variant}`,
      fileProtocol: "sftp",
    });

    await sftpBridge.uploadLocalToSftp(null, {
      sftpId: opened.sftpId,
      localPath,
      remotePath: `/tmp/${variant}.bin`,
      encoding: "utf-8",
    });
    assert.equal(fastPutCalls.length, 1);
    assert.match(fastPutCalls[0].remotePath, /\.netcatty-upload-.*\.part$/);
    assert.deepEqual(remoteFiles.get(`/tmp/${variant}.bin`), payload);
  }
});

test("no-lstat fallback writes through a broken symlink instead of replacing it", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-broken-link-no-lstat-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });
  const localPath = path.join(tempRoot, "payload.bin");
  await fs.promises.writeFile(localPath, Buffer.from("new-target"));

  const created = createSessionChannel();
  const remotePath = "/tmp/broken-link";
  created.remoteMeta.set(remotePath, { isSymlink: true, mode: 0o120777 });
  created.channel.lstat = undefined;
  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-broken-link", { conn: { sftp: (cb) => cb(null, created.channel) } }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-broken-link",
    fileProtocol: "sftp",
  });

  await sftpBridge.uploadLocalToSftp(null, {
    sftpId: opened.sftpId,
    localPath,
    remotePath,
    encoding: "utf-8",
  });
  assert.equal(created.fastPutCalls.length, 1);
  assert.equal(created.fastPutCalls[0].remotePath, remotePath);
  assert.equal(created.remoteMeta.get(remotePath)?.isSymlink, true);
});

test("upload stops when neither lstat nor readlink can classify a missing target", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-no-link-inspection-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });
  const localPath = path.join(tempRoot, "payload.bin");
  await fs.promises.writeFile(localPath, Buffer.from("payload"));

  const created = createSessionChannel();
  created.channel.lstat = undefined;
  created.channel.readlink = undefined;
  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-no-link-inspection", {
      conn: { sftp: (callback) => callback(null, created.channel) },
    }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-no-link-inspection",
    fileProtocol: "sftp",
  });

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: opened.sftpId,
      localPath,
      remotePath: "/tmp/new.bin",
      encoding: "utf-8",
    }),
    /cannot safely distinguish/i,
  );
  assert.equal(created.fastPutCalls.length, 0);
  assert.equal(created.remoteFiles.has("/tmp/new.bin"), false);
});

test("permission failure during final target recheck never falls back to direct write", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-recheck-permission-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });

  const localPath = path.join(tempRoot, "data.bin");
  await fs.promises.writeFile(localPath, Buffer.from("new-data"));
  const created = createSessionChannel();
  created.remoteFiles.set("/tmp/data.bin", Buffer.from("old-data"));
  created.remoteMeta.set("/tmp/data.bin", { mode: 0o100644 });
  const originalLstat = created.channel.lstat.bind(created.channel);
  let lstatCalls = 0;
  created.channel.lstat = (targetPath, callback) => {
    if (String(targetPath) === "/tmp/data.bin") lstatCalls += 1;
    if (lstatCalls >= 2 && String(targetPath) === "/tmp/data.bin") {
      const err = new Error("Permission denied");
      err.code = "EACCES";
      callback(err);
      return;
    }
    originalLstat(targetPath, callback);
  };

  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-recheck-permission", { conn: { sftp: (cb) => cb(null, created.channel) } }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-recheck-permission",
    fileProtocol: "sftp",
  });

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: opened.sftpId,
      localPath,
      remotePath: "/tmp/data.bin",
      encoding: "utf-8",
    }),
    /Permission denied/,
  );
  assert.equal(created.fastPutCalls.length, 1);
  assert.match(created.fastPutCalls[0].remotePath, /\.netcatty-upload-/);
  assert.deepEqual(created.remoteFiles.get("/tmp/data.bin"), Buffer.from("old-data"));
});

test("staged SFTP upload stops if the destination becomes a symlink", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-sftp-symlink-race-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });

  const localPath = path.join(tempRoot, "cfg.json");
  await fs.promises.writeFile(localPath, Buffer.from("new-content"));
  let channelRef = null;
  const created = createSessionChannel({
    onFastPut(_local, remotePath) {
      if (String(remotePath).includes(".netcatty-upload-")) {
        created.remoteMeta.set("/etc/app/config.json", { isSymlink: true, mode: 0o120777 });
      }
      return null;
    },
  });
  channelRef = created.channel;
  created.remoteFiles.set("/etc/app/config.json", Buffer.from("old-content"));
  created.remoteMeta.set("/etc/app/config.json", { mode: 0o100644 });

  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-symlink-race", { conn: { sftp: (cb) => cb(null, channelRef) } }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-symlink-race",
    fileProtocol: "sftp",
  });

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: opened.sftpId,
      localPath,
      remotePath: "/etc/app/config.json",
      encoding: "utf-8",
    }),
    /changed to a symlink/,
  );
  assert.deepEqual(created.remoteFiles.get("/etc/app/config.json"), Buffer.from("old-content"));
  assert.equal(
    [...created.remoteFiles.keys()].some((key) => String(key).includes(".netcatty-upload-")),
    false,
  );
});

test("staged SFTP upload preserves a regular destination replaced during upload", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-regular-target-race-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });
  const localPath = path.join(tempRoot, "payload.bin");
  await fs.promises.writeFile(localPath, Buffer.from("uploaded-data"));
  const remotePath = "/etc/app/config.json";
  const replacement = Buffer.from("new-state");
  const created = createSessionChannel({
    onFastPut(_local, uploadPath) {
      if (String(uploadPath).includes(".netcatty-upload-")) {
        created.remoteFiles.set(remotePath, replacement);
        created.remoteMeta.set(remotePath, { mode: 0o100644, mtime: 2, uid: 1000, gid: 1000 });
      }
      return null;
    },
  });
  created.remoteFiles.set(remotePath, Buffer.from("old-state"));
  created.remoteMeta.set(remotePath, { mode: 0o100644, mtime: 1, uid: 1000, gid: 1000 });

  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-regular-race", { conn: { sftp: (cb) => cb(null, created.channel) } }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-regular-race",
    fileProtocol: "sftp",
  });

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: opened.sftpId,
      localPath,
      remotePath,
      encoding: "utf-8",
    }),
    /destination changed during upload/i,
  );
  assert.deepEqual(created.remoteFiles.get(remotePath), replacement);
  assert.equal(
    [...created.remoteFiles.keys()].some((key) => String(key).includes(".netcatty-upload-")),
    false,
  );
});

test("staged SFTP upload detects same-metadata destination content replacement", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-same-meta-race-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });
  const localPath = path.join(tempRoot, "payload.bin");
  await fs.promises.writeFile(localPath, Buffer.from("uploaded-data"));
  const remotePath = "/etc/app/config.json";
  // Same length/mode/owner/mtime as the original — metadata-only snapshots miss this.
  const replacement = Buffer.from("new-state");
  const created = createSessionChannel({
    onFastPut(_local, uploadPath) {
      if (String(uploadPath).includes(".netcatty-upload-")) {
        created.remoteFiles.set(remotePath, replacement);
        created.remoteMeta.set(remotePath, { mode: 0o100644, mtime: 1, uid: 1000, gid: 1000 });
      }
      return null;
    },
  });
  created.remoteFiles.set(remotePath, Buffer.from("old-state"));
  created.remoteMeta.set(remotePath, { mode: 0o100644, mtime: 1, uid: 1000, gid: 1000 });

  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-same-meta-race", { conn: { sftp: (cb) => cb(null, created.channel) } }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-same-meta-race",
    fileProtocol: "sftp",
  });

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: opened.sftpId,
      localPath,
      remotePath,
      encoding: "utf-8",
    }),
    /destination changed during upload/i,
  );
  assert.deepEqual(created.remoteFiles.get(remotePath), replacement);
  assert.equal(
    [...created.remoteFiles.keys()].some((key) => String(key).includes(".netcatty-upload-")),
    false,
  );
});

test("staged SFTP upload detects same-size rewrite when remote inode is stable", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-stable-ino-race-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });
  const localPath = path.join(tempRoot, "payload.bin");
  await fs.promises.writeFile(localPath, Buffer.from("uploaded-data"));
  const remotePath = "/etc/app/config.json";
  const replacement = Buffer.from("new-state");
  const created = createSessionChannel({
    onFastPut(_local, uploadPath) {
      if (String(uploadPath).includes(".netcatty-upload-")) {
        // Same inode/fileId/size/mode/mtime — only content changes.
        created.remoteFiles.set(remotePath, replacement);
        created.remoteMeta.set(remotePath, {
          mode: 0o100644,
          mtime: 1,
          uid: 1000,
          gid: 1000,
          ino: 4242,
          fileId: "stable-file-id",
        });
      }
      return null;
    },
  });
  created.remoteFiles.set(remotePath, Buffer.from("old-state"));
  created.remoteMeta.set(remotePath, {
    mode: 0o100644,
    mtime: 1,
    uid: 1000,
    gid: 1000,
    ino: 4242,
    fileId: "stable-file-id",
  });
  const baseStat = created.channel.stat.bind(created.channel);
  const baseLstat = created.channel.lstat.bind(created.channel);
  const withStableIds = (targetPath, callback, base) => {
    base(targetPath, (error, attrs) => {
      if (error) {
        callback(error);
        return;
      }
      const meta = created.remoteMeta.get(targetPath) || {};
      callback(null, {
        ...attrs,
        ino: meta.ino,
        fileId: meta.fileId,
      });
    });
  };
  created.channel.stat = (targetPath, callback) => withStableIds(targetPath, callback, baseStat);
  created.channel.lstat = (targetPath, callback) => withStableIds(targetPath, callback, baseLstat);

  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-stable-ino-race", { conn: { sftp: (cb) => cb(null, created.channel) } }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-stable-ino-race",
    fileProtocol: "sftp",
  });

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: opened.sftpId,
      localPath,
      remotePath,
      encoding: "utf-8",
    }),
    /destination changed during upload/i,
  );
  assert.deepEqual(created.remoteFiles.get(remotePath), replacement);
  assert.equal(
    [...created.remoteFiles.keys()].some((key) => String(key).includes(".netcatty-upload-")),
    false,
  );
});

test("destination content hashing aborts when the upload signal is cancelled", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-dest-hash-abort-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });
  const localPath = path.join(tempRoot, "payload.bin");
  await fs.promises.writeFile(localPath, Buffer.from("uploaded-data"));
  const remotePath = "/etc/app/config.json";
  const { Readable } = require("node:stream");
  let markHashStarted;
  const hashStarted = new Promise((resolve) => { markHashStarted = resolve; });
  let streamDestroyed = false;
  const created = createSessionChannel();
  created.remoteFiles.set(remotePath, Buffer.alloc(64 * 1024, 7));
  created.remoteMeta.set(remotePath, { mode: 0o100644, mtime: 1, uid: 1000, gid: 1000 });
  created.channel.createReadStream = () => {
    const stream = new Readable({
      read() {
        // Never push — simulate a stalled destination hash read.
      },
    });
    stream.destroy = ((originalDestroy) => function destroyPatched(err) {
      streamDestroyed = true;
      return originalDestroy.call(this, err);
    })(stream.destroy.bind(stream));
    markHashStarted();
    return stream;
  };

  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-dest-hash-abort", { conn: { sftp: (cb) => cb(null, created.channel) } }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-dest-hash-abort",
    fileProtocol: "sftp",
  });
  const controller = new AbortController();
  const upload = sftpBridge.uploadLocalToSftp(null, {
    sftpId: opened.sftpId,
    localPath,
    remotePath,
    encoding: "utf-8",
    abortSignal: controller.signal,
  });
  await hashStarted;
  controller.abort();
  await assert.rejects(
    () => Promise.race([
      upload,
      new Promise((_, reject) => setTimeout(() => reject(new Error("cancel timed out")), 1000)),
    ]),
    /abort|cancel/i,
  );
  assert.equal(streamDestroyed, true);
});

test("staged SFTP upload does not recreate a destination deleted during upload", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-deleted-target-race-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });
  const localPath = path.join(tempRoot, "payload.bin");
  await fs.promises.writeFile(localPath, Buffer.from("uploaded-data"));
  const remotePath = "/etc/app/config.json";
  const created = createSessionChannel({
    onFastPut(_local, uploadPath) {
      if (String(uploadPath).includes(".netcatty-upload-")) {
        created.remoteFiles.delete(remotePath);
        created.remoteMeta.delete(remotePath);
      }
      return null;
    },
  });
  created.remoteFiles.set(remotePath, Buffer.from("old-state"));
  created.remoteMeta.set(remotePath, { mode: 0o100644, mtime: 1, uid: 1000, gid: 1000 });

  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-deleted-race", { conn: { sftp: (cb) => cb(null, created.channel) } }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-deleted-race",
    fileProtocol: "sftp",
  });

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: opened.sftpId,
      localPath,
      remotePath,
      encoding: "utf-8",
    }),
    /destination disappeared during upload/i,
  );
  assert.equal(created.remoteFiles.has(remotePath), false);
  assert.equal(
    [...created.remoteFiles.keys()].some((key) => String(key).includes(".netcatty-upload-")),
    false,
  );
});

test("staged SFTP upload rechecks a replaced destination after mode setup", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-mode-target-race-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });
  const localPath = path.join(tempRoot, "payload.bin");
  await fs.promises.writeFile(localPath, Buffer.from("uploaded-data"));
  const remotePath = "/etc/app/config.json";
  const replacement = Buffer.from("new-state");
  const created = createSessionChannel();
  created.remoteFiles.set(remotePath, Buffer.from("old-state"));
  created.remoteMeta.set(remotePath, { mode: 0o100755, mtime: 1, uid: 1000, gid: 1000 });
  const baseChmod = created.channel.chmod.bind(created.channel);
  created.channel.chmod = (chmodPath, mode, callback) => {
    baseChmod(chmodPath, mode, (error) => {
      if (String(chmodPath).includes(".netcatty-upload-")) {
        created.remoteFiles.set(remotePath, replacement);
        created.remoteMeta.set(remotePath, { mode: 0o100755, mtime: 2, uid: 1000, gid: 1000 });
      }
      callback(error);
    });
  };

  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-mode-race", { conn: { sftp: (cb) => cb(null, created.channel) } }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-mode-race",
    fileProtocol: "sftp",
  });

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: opened.sftpId,
      localPath,
      remotePath,
      encoding: "utf-8",
    }),
    /destination changed during upload/i,
  );
  assert.deepEqual(created.remoteFiles.get(remotePath), replacement);
  assert.equal(
    [...created.remoteFiles.keys()].some((key) => String(key).includes(".netcatty-upload-")),
    false,
  );
});

test("no-lstat staged upload stops if a broken symlink appears before promotion", async (t) => {
  for (const variant of ["missing-method", "runtime-unsupported"]) {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), `netcatty-late-broken-link-${variant}-`));
    t.after(async () => {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    });
    tempDirBridge.init?.({ getPath: () => tempRoot });
    const localPath = path.join(tempRoot, "payload.bin");
    await fs.promises.writeFile(localPath, Buffer.from("new-content"));
    const remotePath = `/tmp/${variant}.bin`;
    const created = createSessionChannel({
      onFastPut(_local, fastPutPath) {
        if (String(fastPutPath).includes(".netcatty-upload-")) {
          created.remoteMeta.set(remotePath, { isSymlink: true, mode: 0o120777 });
        }
        return null;
      },
    });
    if (variant === "missing-method") {
      created.channel.lstat = undefined;
    } else {
      created.channel.lstat = (_targetPath, callback) => {
        const error = new Error("SSH_FX_OP_UNSUPPORTED");
        error.code = 8;
        callback(error);
      };
    }
    const sftpClients = new Map();
    sftpBridge.init({
      electronModule: { webContents: { fromId: () => null } },
      sessions: new Map([[`session-${variant}`, {
        conn: { sftp: (callback) => callback(null, created.channel) },
      }]]),
      sftpClients,
    });
    const opened = await sftpBridge.openSftpForSession(null, {
      sessionId: `session-${variant}`,
      fileProtocol: "sftp",
    });

    await assert.rejects(
      () => sftpBridge.uploadLocalToSftp(null, {
        sftpId: opened.sftpId,
        localPath,
        remotePath,
        encoding: "utf-8",
      }),
      /changed to a symlink/,
    );
    assert.equal(created.remoteMeta.get(remotePath)?.isSymlink, true);
    assert.equal(created.remoteFiles.has(remotePath), false);
    assert.equal(
      [...created.remoteFiles.keys()].some((key) => String(key).includes(".netcatty-upload-")),
      false,
    );
  }
});

test("abort during staged mode setup prevents promotion", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-sftp-mode-abort-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });

  const localPath = path.join(tempRoot, "tool");
  await fs.promises.writeFile(localPath, Buffer.from("new-tool"));
  const controller = new AbortController();
  const { channel, remoteFiles, remoteMeta } = createSessionChannel();
  remoteFiles.set("/usr/local/bin/tool", Buffer.from("old-tool"));
  remoteMeta.set("/usr/local/bin/tool", { mode: 0o100755 });
  const originalChmod = channel.chmod.bind(channel);
  channel.chmod = (targetPath, mode, callback) => {
    controller.abort();
    originalChmod(targetPath, mode, callback);
  };

  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-mode-abort", { conn: { sftp: (cb) => cb(null, channel) } }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-mode-abort",
    fileProtocol: "sftp",
  });

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: opened.sftpId,
      localPath,
      remotePath: "/usr/local/bin/tool",
      encoding: "utf-8",
      abortSignal: controller.signal,
    }),
    /abort|cancel/i,
  );
  assert.deepEqual(remoteFiles.get("/usr/local/bin/tool"), Buffer.from("old-tool"));
});

test("parent-dir permission on staged path does not risk an in-place create race", async (t) => {
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

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: opened.sftpId,
      localPath,
      remotePath: "/ro-dir/file.bin",
      encoding: "utf-8",
    }),
    /Permission denied/,
  );

  assert.equal(fastPutCalls.length, 1, "must not directly create after the staged attempt fails");
  assert.match(fastPutCalls[0].remotePath, /\.netcatty-upload-.*\.part$/);
  assert.equal(remoteFiles.has("/ro-dir/file.bin"), false);
});

test("staged permission failure preserves an existing destination", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-inplace-mode-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });

  const localPath = path.join(tempRoot, "tool.bin");
  const payload = Buffer.from("replaced-bytes");
  await fs.promises.writeFile(localPath, payload);

  const { channel, fastPutCalls, remoteFiles, remoteMeta, chmodCalls } = createSessionChannel({
    onFastPut(_local, remotePath) {
      if (String(remotePath).includes(".netcatty-upload-")) {
        const err = new Error("Permission denied");
        err.code = 3;
        return { error: err };
      }
      // Simulate servers that recreate the inode on in-place OPEN|CREAT|TRUNC
      // with umask defaults (losing the prior executable bit).
      remoteMeta.set("/usr/local/bin/tool", { mode: 0o100644 });
      return null;
    },
  });
  remoteMeta.set("/usr/local/bin/tool", { mode: 0o100755 });
  remoteFiles.set("/usr/local/bin/tool", Buffer.from("old-tool"));

  const connection = {
    sftp(callback) { callback(null, channel); },
  };
  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-inplace-mode", { conn: connection }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-inplace-mode",
    fileProtocol: "sftp",
  });

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: opened.sftpId,
      localPath,
      remotePath: "/usr/local/bin/tool",
      encoding: "utf-8",
    }),
    /Permission denied/,
  );
  assert.equal(fastPutCalls.length, 1, "must not directly overwrite the existing file");
  assert.match(fastPutCalls[0].remotePath, /\.netcatty-upload-.*\.part$/);
  assert.deepEqual(chmodCalls, []);
  assert.equal(remoteMeta.get("/usr/local/bin/tool")?.mode & 0o777, 0o755);
  assert.deepEqual(remoteFiles.get("/usr/local/bin/tool"), Buffer.from("old-tool"));
});

test("staged permission failure does not reach a later mode restore failure", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-inplace-mode-fail-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });

  const localPath = path.join(tempRoot, "tool.bin");
  await fs.promises.writeFile(localPath, Buffer.from("replaced-bytes"));
  const { channel, remoteFiles, remoteMeta } = createSessionChannel({
    onFastPut(_local, remotePath) {
      if (String(remotePath).includes(".netcatty-upload-")) {
        const err = new Error("Permission denied");
        err.code = 3;
        return { error: err };
      }
      remoteMeta.set("/usr/local/bin/tool", { mode: 0o100644 });
      return null;
    },
  });
  remoteMeta.set("/usr/local/bin/tool", { mode: 0o100755 });
  remoteFiles.set("/usr/local/bin/tool", Buffer.from("old-tool"));
  channel.chmod = (_targetPath, _mode, callback) => {
    const error = new Error("in-place chmod failed");
    error.code = "EIO";
    callback(error);
  };

  const sftpClients = new Map();
  sftpBridge.init({
    electronModule: { webContents: { fromId: () => null } },
    sessions: new Map([["session-inplace-mode-fail", { conn: { sftp: (cb) => cb(null, channel) } }]]),
    sftpClients,
  });
  const opened = await sftpBridge.openSftpForSession(null, {
    sessionId: "session-inplace-mode-fail",
    fileProtocol: "sftp",
  });

  await assert.rejects(
    () => sftpBridge.uploadLocalToSftp(null, {
      sftpId: opened.sftpId,
      localPath,
      remotePath: "/usr/local/bin/tool",
      encoding: "utf-8",
    }),
    /Permission denied/,
  );
  assert.deepEqual(remoteFiles.get("/usr/local/bin/tool"), Buffer.from("old-tool"));
  assert.equal(remoteMeta.get("/usr/local/bin/tool")?.mode & 0o777, 0o755);
});

test("SCP staged permission failure preserves an existing destination", async () => {
  const finalPath = "/usr/local/bin/tool";
  const files = new Map([[finalPath, Buffer.from("old")]]);
  const modes = new Map([[finalPath, 0o100755]]);
  const chmodCalls = [];
  let uploadCalls = 0;
  const missing = (candidate) => {
    const error = new Error(`ENOENT: ${candidate}`);
    error.code = "ENOENT";
    return error;
  };
  const backend = {
    async stat(candidate) {
      if (!files.has(candidate)) throw missing(candidate);
      return {
        type: "file",
        isDirectory: false,
        isSymbolicLink: false,
        size: files.get(candidate).length,
        mode: modes.get(candidate) ?? 0o100644,
        permissions: "rwxr-xr-x",
        modifyTime: 1,
      };
    },
    async chmod(candidate, mode) {
      chmodCalls.push({ path: candidate, mode });
      modes.set(candidate, 0o100000 | (mode & 0o7777));
    },
    async rename(from, to) {
      if (!files.has(from)) throw missing(from);
      if (files.has(to)) throw new Error(`EEXIST: ${to}`);
      files.set(to, files.get(from));
      files.delete(from);
      if (modes.has(from)) {
        modes.set(to, modes.get(from));
        modes.delete(from);
      }
    },
    async remove(candidate) {
      files.delete(candidate);
      modes.delete(candidate);
    },
  };
  const client = {
    __netcattyFileProtocol: "scp",
    __netcattyScpBackend: backend,
  };

  await assert.rejects(
    () => sftpBridge.runRemoteUploadTransaction(client, "/tmp/local.bin", finalPath, {
      expectedSize: 3,
      async uploadFile(_path, uploadTarget) {
        uploadCalls += 1;
        if (uploadTarget.generatedStagePath) {
          const err = new Error("Permission denied creating stage");
          err.code = "EACCES";
          throw err;
        }
        files.set(uploadTarget.logicalPath, Buffer.from("new"));
        modes.set(uploadTarget.logicalPath, 0o100644);
      },
    }),
    /Permission denied creating stage/,
  );
  assert.equal(uploadCalls, 1);
  assert.deepEqual(files.get(finalPath), Buffer.from("old"));
  assert.deepEqual(chmodCalls, []);
  assert.equal(modes.get(finalPath) & 0o777, 0o755);
});

test("SCP staged permission failure never commits an existing destination", async () => {
  const finalPath = "/usr/local/bin/tool";
  const files = new Map([[finalPath, Buffer.from("old")]]);
  const modes = new Map([[finalPath, 0o100755]]);
  const chmodCalls = [];
  const controller = new AbortController();
  const missing = (candidate) => {
    const error = new Error(`ENOENT: ${candidate}`);
    error.code = "ENOENT";
    return error;
  };
  const backend = {
    async stat(candidate) {
      if (!files.has(candidate)) throw missing(candidate);
      return {
        type: "file",
        isDirectory: false,
        isSymbolicLink: false,
        size: files.get(candidate).length,
        mode: modes.get(candidate) ?? 0o100644,
        permissions: "rwxr-xr-x",
        modifyTime: 1,
      };
    },
    async chmod(candidate, mode, options = {}) {
      if (options.signal?.aborted) {
        throw new Error("Transfer cancelled");
      }
      chmodCalls.push({ path: candidate, mode, hadSignal: Boolean(options.signal) });
      modes.set(candidate, 0o100000 | (mode & 0o7777));
    },
    async rename(from, to) {
      if (!files.has(from)) throw missing(from);
      if (files.has(to)) throw new Error(`EEXIST: ${to}`);
      files.set(to, files.get(from));
      files.delete(from);
      if (modes.has(from)) {
        modes.set(to, modes.get(from));
        modes.delete(from);
      }
    },
    async remove(candidate) {
      files.delete(candidate);
      modes.delete(candidate);
    },
  };
  const client = {
    __netcattyFileProtocol: "scp",
    __netcattyScpBackend: backend,
  };

  let committed = false;
  await assert.rejects(
    () => sftpBridge.runRemoteUploadTransaction(client, "/tmp/local.bin", finalPath, {
      expectedSize: 3,
      signal: controller.signal,
      commitPromotion() {
        committed = true;
      },
      async uploadFile(_path, uploadTarget) {
        if (uploadTarget.generatedStagePath) {
          const err = new Error("Permission denied creating stage");
          err.code = "EACCES";
          throw err;
        }
        files.set(uploadTarget.logicalPath, Buffer.from("new"));
        modes.set(uploadTarget.logicalPath, 0o100644);
      },
    }),
    /Permission denied creating stage/,
  );
  assert.equal(committed, false);
  assert.deepEqual(chmodCalls, []);
  assert.equal(modes.get(finalPath) & 0o777, 0o755);
  assert.deepEqual(files.get(finalPath), Buffer.from("old"));
});

test("no-lstat new upload aborted during staged size verify leaves no final", async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-late-abort-promote-"));
  t.after(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
  tempDirBridge.init?.({ getPath: () => tempRoot });

  const localPath = path.join(tempRoot, "payload.bin");
  const payload = Buffer.from("late-abort-payload");
  await fs.promises.writeFile(localPath, payload);

  const { channel, fastPutCalls, remoteFiles } = createSessionChannel();
  channel.lstat = undefined;
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
