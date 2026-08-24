const assert = require("node:assert/strict");
const test = require("node:test");

const { createFileOpsApi } = require("./fileOps.cjs");

test("home discovery accepts a virtual SFTP root when SSH exec is unavailable", async () => {
  const channel = {};
  const listed = [];
  const api = createFileOpsApi({
    sftpClients: new Map([["jumpserver", { sftp: channel }]]),
    throwIfAborted() {},
    requireSftpChannel: async () => channel,
    realpathAsync: async (resolvedChannel, remotePath) => {
      assert.equal(resolvedChannel, channel);
      assert.equal(remotePath, ".");
      return "/";
    },
    readdirAsync: async (resolvedChannel, remotePath) => {
      listed.push([resolvedChannel, remotePath]);
      return [{ filename: "data" }];
    },
  });

  const result = await api.getSftpHomeDir(null, { sftpId: "jumpserver" });

  assert.deepEqual(result, { success: true, homeDir: "/" });
  assert.deepEqual(listed, [[channel, "/"]]);
});

test("home discovery rejects non-listable root so candidate probing can run", async () => {
  const channel = {};
  const api = createFileOpsApi({
    sftpClients: new Map([["restricted", { sftp: channel }]]),
    throwIfAborted() {},
    requireSftpChannel: async () => channel,
    realpathAsync: async () => "/",
    readdirAsync: async () => {
      const error = new Error("Permission denied");
      error.code = "EACCES";
      throw error;
    },
  });

  const result = await api.getSftpHomeDir(null, { sftpId: "restricted" });

  assert.equal(result.success, false);
  assert.match(result.error || "", /Could not determine home directory/);
});

test("home discovery still accepts non-root realpath without listing", async () => {
  const channel = {};
  let readdirCalls = 0;
  const api = createFileOpsApi({
    sftpClients: new Map([["normal", { sftp: channel }]]),
    throwIfAborted() {},
    requireSftpChannel: async () => channel,
    realpathAsync: async () => "/home/deploy",
    readdirAsync: async () => {
      readdirCalls += 1;
      return [];
    },
  });

  const result = await api.getSftpHomeDir(null, { sftpId: "normal" });

  assert.deepEqual(result, { success: true, homeDir: "/home/deploy" });
  assert.equal(readdirCalls, 0);
});

test("statSftp follows symlinks and reports target size for resume sizing", async () => {
  const channel = { stat() {}, lstat() {} };
  let lstatCalls = 0;
  let statCalls = 0;
  const api = createFileOpsApi({
    sftpClients: new Map([["sftp-1", { sftp: channel }]]),
    path: require("node:path"),
    requireSftpChannel: async () => channel,
    resolveEncodingForRequest: () => "utf-8",
    encodePath: (remotePath) => remotePath,
    lstatAsync: async () => {
      lstatCalls += 1;
      return {
        size: 11,
        mode: 0o120777,
        mtime: 10,
        isDirectory: () => false,
        isSymbolicLink: () => true,
      };
    },
    statAsync: async () => {
      statCalls += 1;
      return {
        size: 42,
        mode: 0o100644,
        mtime: 20,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      };
    },
    statResultFromAttrs: (attrs) => ({
      size: attrs.size,
      modifyTime: attrs.mtime * 1000,
      mode: attrs.mode,
      isDirectory: attrs.isDirectory(),
      isSymbolicLink: attrs.isSymbolicLink(),
    }),
  });

  const result = await api.statSftp(null, {
    sftpId: "sftp-1",
    path: "/usr/local/bin/tool",
  });

  assert.equal(statCalls, 1);
  assert.equal(lstatCalls, 0, "shared stat must follow for resume/sizing");
  assert.equal(result.type, "file");
  assert.equal(result.size, 42);
});

test("lstatSftp classifies symlinks without following the target", async () => {
  const channel = { lstat() {} };
  let lstatCalls = 0;
  let statCalls = 0;
  const api = createFileOpsApi({
    sftpClients: new Map([["sftp-1", { sftp: channel }]]),
    path: require("node:path"),
    requireSftpChannel: async () => channel,
    resolveEncodingForRequest: () => "utf-8",
    encodePath: (remotePath) => remotePath,
    lstatAsync: async () => {
      lstatCalls += 1;
      return {
        size: 11,
        mode: 0o120777,
        mtime: 10,
        isDirectory: () => false,
        isSymbolicLink: () => true,
      };
    },
    statAsync: async () => {
      statCalls += 1;
      return {
        size: 42,
        mode: 0o100644,
        mtime: 20,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      };
    },
    statResultFromAttrs: (attrs) => ({
      size: attrs.size,
      modifyTime: attrs.mtime * 1000,
      mode: attrs.mode,
      isDirectory: attrs.isDirectory(),
      isSymbolicLink: attrs.isSymbolicLink(),
    }),
  });

  const result = await api.lstatSftp(null, {
    sftpId: "sftp-1",
    path: "/usr/local/bin/tool",
  });

  assert.equal(lstatCalls, 1);
  assert.equal(statCalls, 0, "must not follow the symlink with STAT");
  assert.equal(result.type, "symlink");
  assert.equal(result.size, 11);
});

test("lstatSftp refuses followed STAT when LSTAT is unsupported", async () => {
  const channel = { lstat() {}, stat() {} };
  let statCalls = 0;
  const api = createFileOpsApi({
    sftpClients: new Map([["sftp-1", { sftp: channel }]]),
    path: require("node:path"),
    requireSftpChannel: async () => channel,
    resolveEncodingForRequest: () => "utf-8",
    encodePath: (remotePath) => remotePath,
    lstatAsync: async () => {
      const error = new Error("SSH_FX_OP_UNSUPPORTED");
      error.code = 8;
      throw error;
    },
    statAsync: async () => {
      statCalls += 1;
      return {
        size: 42,
        mode: 0o100644,
        mtime: 20,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      };
    },
    statResultFromAttrs: (attrs) => ({
      size: attrs.size,
      modifyTime: attrs.mtime * 1000,
      mode: attrs.mode,
      isDirectory: attrs.isDirectory(),
      isSymbolicLink: attrs.isSymbolicLink(),
    }),
  });

  await assert.rejects(
    () => api.lstatSftp(null, { sftpId: "sftp-1", path: "/usr/local/bin/tool" }),
    (error) => {
      assert.equal(error.code, "ENOTSUP");
      assert.equal(error.lstatUnavailable, true);
      assert.match(String(error.message), /does not support LSTAT/i);
      return true;
    },
  );
  assert.equal(statCalls, 0, "must not classify via followed STAT");
});

test("lstatSftp returns null for SSH_FX_NO_SUCH_FILE even with a localized message", async () => {
  const channel = { lstat() {} };
  const api = createFileOpsApi({
    sftpClients: new Map([["sftp-1", { sftp: channel }]]),
    requireSftpChannel: async () => channel,
    resolveEncodingForRequest: () => "utf-8",
    encodePath: (remotePath) => remotePath,
    lstatAsync: async () => {
      const error = new Error("File not found");
      error.code = 2;
      throw error;
    },
  });

  const result = await api.lstatSftp(null, {
    sftpId: "sftp-1",
    path: "/usr/local/bin/new-file.sh",
  });
  assert.equal(result, null);
});

test("lstatSftp still throws permission errors on an existing path", async () => {
  const channel = { lstat() {} };
  const api = createFileOpsApi({
    sftpClients: new Map([["sftp-1", { sftp: channel }]]),
    requireSftpChannel: async () => channel,
    resolveEncodingForRequest: () => "utf-8",
    encodePath: (remotePath) => remotePath,
    lstatAsync: async () => {
      const error = new Error("Permission denied");
      error.code = "EACCES";
      throw error;
    },
  });

  await assert.rejects(
    () => api.lstatSftp(null, { sftpId: "sftp-1", path: "/root/secret" }),
    (error) => {
      assert.equal(error.code, "EACCES");
      assert.match(String(error.message), /Permission denied/);
      return true;
    },
  );
});

test("lstatSftp refuses a channel without native LSTAT", async () => {
  const channel = { stat() {} };
  let lstatCalls = 0;
  const api = createFileOpsApi({
    sftpClients: new Map([["sftp-1", { sftp: channel }]]),
    requireSftpChannel: async () => channel,
    lstatAsync: async () => { lstatCalls += 1; },
  });

  await assert.rejects(
    () => api.lstatSftp(null, { sftpId: "sftp-1", path: "/usr/local/bin/tool" }),
    (error) => {
      assert.equal(error.code, "ENOTSUP");
      assert.equal(error.lstatUnavailable, true);
      return true;
    },
  );
  assert.equal(lstatCalls, 0, "must not call the followed-stat fallback");
});

test("expected symlink delete refuses a replacement file", async () => {
  const channel = { lstat() {} };
  let unlinkCalls = 0;
  const api = createFileOpsApi({
    sftpClients: new Map([["sftp-1", { sftp: channel }]]),
    throwIfAborted() {},
    requireSftpChannel: async () => channel,
    resolveEncodingForRequest: () => "utf-8",
    encodePath: (remotePath) => remotePath,
    lstatAsync: async () => ({
      size: 4,
      mode: 0o100644,
      mtime: 20,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    }),
    statResultFromAttrs: (attrs) => ({
      size: attrs.size,
      modifyTime: attrs.mtime * 1000,
      mode: attrs.mode,
      isDirectory: attrs.isDirectory(),
      isSymbolicLink: attrs.isSymbolicLink(),
    }),
    unlinkAsync: async () => { unlinkCalls += 1; },
  });

  await assert.rejects(
    () => api.deleteSftp(null, {
      sftpId: "sftp-1",
      path: "/usr/local/bin/tool",
      expectedType: "symlink",
    }),
    (error) => {
      assert.equal(error.code, "ESTALE");
      return true;
    },
  );
  assert.equal(unlinkCalls, 0);
});

test("SCP expected symlink delete stays non-recursive after the type check", async () => {
  let unlinkCalls = 0;
  let removeCalls = 0;
  const backend = {
    async stat() {
      return { isDirectory: false, isSymbolicLink: true };
    },
    async unlink(remotePath, options) {
      unlinkCalls += 1;
      assert.equal(remotePath, "/usr/local/bin/tool");
      assert.equal(options.encoding, "utf-8");
    },
    async remove() {
      removeCalls += 1;
    },
  };
  const client = {
    __netcattyFileProtocol: "scp",
    __netcattyScpBackend: backend,
  };
  const api = createFileOpsApi({
    sftpClients: new Map([["scp-1", client]]),
    throwIfAborted() {},
    resolveEncodingForRequest: () => "utf-8",
  });

  await api.deleteSftp(null, {
    sftpId: "scp-1",
    path: "/usr/local/bin/tool",
    expectedType: "symlink",
  });

  assert.equal(unlinkCalls, 1);
  assert.equal(removeCalls, 0);
});

test("expected symlink delete refuses a channel without native LSTAT", async () => {
  const channel = { stat() {} };
  const api = createFileOpsApi({
    sftpClients: new Map([["sftp-1", { sftp: channel }]]),
    throwIfAborted() {},
    requireSftpChannel: async () => channel,
    resolveEncodingForRequest: () => "utf-8",
    encodePath: (remotePath) => remotePath,
  });

  await assert.rejects(
    () => api.deleteSftp(null, {
      sftpId: "sftp-1",
      path: "/usr/local/bin/tool",
      expectedType: "symlink",
    }),
    (error) => {
      assert.equal(error.code, "ENOTSUP");
      return true;
    },
  );
});

test("non-UTF-8 expected symlink delete refuses a replacement file", async () => {
  const channel = { lstat() {} };
  let removeCalls = 0;
  const api = createFileOpsApi({
    sftpClients: new Map([["sftp-1", { sftp: channel }]]),
    throwIfAborted() {},
    requireSftpChannel: async () => channel,
    resolveEncodingForRequest: () => "gb18030",
    normalizeRemotePathString: async (_client, remotePath) => remotePath,
    encodePath: (remotePath) => Buffer.from(remotePath),
    lstatAsync: async () => ({
      size: 4,
      mode: 0o100644,
      mtime: 20,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    }),
    statResultFromAttrs: (attrs) => ({
      size: attrs.size,
      modifyTime: attrs.mtime * 1000,
      mode: attrs.mode,
      isDirectory: attrs.isDirectory(),
      isSymbolicLink: attrs.isSymbolicLink(),
    }),
    removeRemotePathInternal: async () => { removeCalls += 1; },
  });

  await assert.rejects(
    () => api.deleteSftp(null, {
      sftpId: "sftp-1",
      path: "/remote/tool",
      encoding: "gb18030",
      expectedType: "symlink",
    }),
    (error) => {
      assert.equal(error.code, "ESTALE");
      return true;
    },
  );
  assert.equal(removeCalls, 0);
});

test("non-UTF-8 expected symlink delete stays non-recursive after the type check", async () => {
  const channel = { lstat() {} };
  let unlinkCalls = 0;
  let removeCalls = 0;
  const api = createFileOpsApi({
    sftpClients: new Map([["sftp-1", { sftp: channel }]]),
    throwIfAborted() {},
    requireSftpChannel: async () => channel,
    resolveEncodingForRequest: () => "gb18030",
    normalizeRemotePathString: async (_client, remotePath) => remotePath,
    encodePath: (remotePath) => Buffer.from(remotePath),
    lstatAsync: async () => ({
      size: 4,
      mode: 0o120777,
      mtime: 20,
      isDirectory: () => false,
      isSymbolicLink: () => true,
    }),
    statResultFromAttrs: (attrs) => ({
      size: attrs.size,
      modifyTime: attrs.mtime * 1000,
      mode: attrs.mode,
      isDirectory: attrs.isDirectory(),
      isSymbolicLink: attrs.isSymbolicLink(),
    }),
    unlinkAsync: async (_sftp, encodedPath) => {
      unlinkCalls += 1;
      assert.equal(encodedPath.toString(), "/remote/tool");
    },
    removeRemotePathInternal: async () => { removeCalls += 1; },
  });

  await api.deleteSftp(null, {
    sftpId: "sftp-1",
    path: "/remote/tool",
    encoding: "gb18030",
    expectedType: "symlink",
  });

  assert.equal(unlinkCalls, 1);
  assert.equal(removeCalls, 0);
});

test("listSftp includes owner from longname and falls back to uid", async () => {
  const channel = {
    readdir(_path, callback) {
      callback(null, [
        {
          filename: "root.txt",
          longname: "-rw-r--r--    1 root     root         12 Jan  1 00:00 root.txt",
          attrs: {
            size: 12,
            mtime: 1700000000,
            uid: 0,
            mode: 0o100644,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          },
        },
        {
          filename: "uid-only.bin",
          longname: "",
          attrs: {
            size: 1,
            mtime: 1700000000,
            uid: 1000,
            mode: 0o100644,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          },
        },
      ]);
    },
  };
  const api = createFileOpsApi({
    sftpClients: new Map([["sftp-1", { sftp: channel }]]),
    path: require("node:path"),
    normalizeEncoding: (value) => value || "utf-8",
    resolveEncodingForRequest: () => "utf-8",
    encodePath: (remotePath) => remotePath,
    requireSftpChannel: async () => channel,
    detectEncodingFromList: () => "utf-8",
    updateResolvedEncoding: (_id, _req, detected) => detected,
    decodeName: (raw) => (raw ? Buffer.from(raw).toString("utf8") : ""),
    isAsciiString: () => true,
    sftpEncodingState: new Map(),
  });

  const entries = await api.listSftp(null, { sftpId: "sftp-1", path: "/home" });
  assert.equal(entries[0].name, "root.txt");
  assert.equal(entries[0].owner, "root");
  assert.equal(entries[1].name, "uid-only.bin");
  assert.equal(entries[1].owner, "1000");
});
