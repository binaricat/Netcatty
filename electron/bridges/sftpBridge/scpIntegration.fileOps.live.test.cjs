/**
 * Real-host integration through fileOps entry points (list/mkdir/write/rename/delete)
 * used by UI IPC — same scpBackend under the hood, different ship surface.
 *
 * Env: NETCATTY_SCP_IT_HOST / USER / PASSWORD (same as scpIntegration.live.test.cjs)
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client: SSHClient } = require("ssh2");
const { createScpBackend, createSshExecAdapters } = require("./scpBackend.cjs");
const { createFileOpsApi } = require("./fileOps.cjs");

const HOST = process.env.NETCATTY_SCP_IT_HOST || "";
const USER = process.env.NETCATTY_SCP_IT_USER || "root";
const PASSWORD = process.env.NETCATTY_SCP_IT_PASSWORD || "";
const PORT = Number(process.env.NETCATTY_SCP_IT_PORT || 22);
const ENABLED = process.env.NETCATTY_SCP_IT === "1" || (HOST && PASSWORD);
const remotePrefix = `/tmp/netcatty-scp-fileops-it-${Date.now()}-${process.pid}`;

function connectSsh() {
  return new Promise((resolve, reject) => {
    const client = new SSHClient();
    const timer = setTimeout(() => {
      try { client.end(); } catch { /* ignore */ }
      reject(new Error("SSH timeout"));
    }, 20000);
    client
      .on("ready", () => { clearTimeout(timer); resolve(client); })
      .on("error", (err) => { clearTimeout(timer); reject(err); })
      .connect({
        host: HOST,
        port: PORT,
        username: USER,
        password: PASSWORD,
        readyTimeout: 15000,
        tryKeyboard: true,
        hostVerifier: () => true,
      });
    client.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => {
      finish(prompts.map(() => PASSWORD));
    });
  });
}

const suite = ENABLED ? describe : describe.skip;

suite("real SCP via fileOps IPC surface", () => {
  let ssh;
  let sftpClients;
  let api;
  let localTmp;
  const sftpId = "scp-it-fileops-1";

  before(async () => {
    localTmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-scp-fileops-"));
    ssh = await connectSsh();
    const backend = createScpBackend(createSshExecAdapters(ssh));
    sftpClients = new Map();
    sftpClients.set(sftpId, {
      client: ssh,
      sftp: null,
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
      async end() {},
    });
    api = createFileOpsApi({
      get sftpClients() { return sftpClients; },
      get electronModule() {
        return { webContents: { fromId: () => ({ send: () => {} }) } };
      },
      fileWatcherBridge: { stopWatchersForSession: () => {} },
      fs,
      path,
      Buffer,
      console,
      setTimeout,
      clearTimeout,
      jumpConnectionsMap: new Map(),
      sftpEncodingState: new Map(),
      normalizeEncoding: (e) => e || "utf-8",
      isAsciiString: () => true,
      requireSftpChannel: async () => { throw new Error("SFTP channel not used in SCP mode"); },
      resolveEncodingForRequest: () => "utf-8",
      updateResolvedEncoding: () => "utf-8",
      encodePath: (p) => p,
      decodeName: (n) => n,
      detectEncodingFromList: () => null,
      statResultFromAttrs: (a) => a,
      normalizeRemotePathString: async (_c, p) => p,
      collectReadable: async () => Buffer.alloc(0),
      writeToWritable: async () => {},
      throwIfAborted: () => {},
      pipeStreams: async () => {},
      ensureRemoteDirForSession: async () => true,
      removeRemotePathInternal: async () => {},
      renameRemotePath: async () => {},
      realpathAsync: async () => "/",
      statAsync: async () => ({}),
      readdirAsync: async () => [],
      mkdirAsync: async () => {},
      rmdirAsync: async () => {},
      unlinkAsync: async () => {},
      openFileAsync: async () => ({}),
      writeFileChunkAsync: async () => {},
      closeFileAsync: async () => {},
      createAbortError: (_s, m) => new Error(m),
      copySftpEncodingState: () => {},
      clearSftpEncodingState: () => {},
      safeSend: () => {},
      tempDirBridge: { getTempFilePath: (n) => path.join(localTmp, n) },
      randomUUID: () => "it-uuid",
    });
    await api.mkdirSftp(null, { sftpId, path: remotePrefix });
  });

  after(async () => {
    try {
      await api.deleteSftp(null, { sftpId, path: remotePrefix });
    } catch (err) {
      console.warn("[scp-fileops-it] cleanup:", err.message);
    }
    try { ssh?.end(); } catch { /* ignore */ }
    try { fs.rmSync(localTmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("mkdir list write rename delete via fileOps", async () => {
    const sub = `${remotePrefix}/ops`;
    await api.mkdirSftp(null, { sftpId, path: sub });
    const listed = await api.listSftp(null, { sftpId, path: remotePrefix });
    assert.ok(listed.some((e) => e.name === "ops"));

    const fileA = `${sub}/a.txt`;
    const fileB = `${sub}/b.txt`;
    await api.writeSftp(null, { sftpId, path: fileA, content: "via-fileops\n" });
    const content = await api.readSftp(null, { sftpId, path: fileA });
    assert.equal(content, "via-fileops\n");

    await api.renameSftp(null, { sftpId, oldPath: fileA, newPath: fileB });
    const afterRename = await api.listSftp(null, { sftpId, path: sub });
    const names = afterRename.map((e) => e.name);
    assert.ok(names.includes("b.txt"));
    assert.ok(!names.includes("a.txt"));

    await api.deleteSftp(null, { sftpId, path: fileB });
    const afterDel = (await api.listSftp(null, { sftpId, path: sub })).map((e) => e.name);
    assert.ok(!afterDel.includes("b.txt"));
    console.log("[scp-fileops-it] ops ok", { names, afterDel });
  });
});
