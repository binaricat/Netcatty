"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createFileOpsApi } = require("./fileOps.cjs");
const { createPreloadApi } = require("../../preload/api.cjs");

const options = { directory: "/home/app", paths: ["file", "folder"], archiveName: "backup.tar.gz", format: "tar.gz" };

function createApi({ client = { client: { exec() {} } }, stdout = "NETCATTY_ARCHIVE_RESULT:OK\n", error, encoding = "utf-8" } = {}) {
  const calls = [];
  const api = createFileOpsApi({
    sftpClients: new Map(client ? [["sftp-1", client]] : []),
    resolveEncodingForRequest: () => encoding,
    throwIfAborted(signal) { if (signal?.aborted) throw new Error("Aborted"); },
    execRemoteShellCommand: async (sshClient, command, execOptions) => {
      calls.push({ sshClient, command, options: execOptions });
      if (error) throw error;
      return { stdout, code: 0 };
    },
  });
  return { api, calls };
}

test("archive creation passes options through preload and the bounded remote executor", async () => {
  const { api, calls } = createApi();
  let invoked;
  const bridge = createPreloadApi({
    ipcRenderer: {
      on() {},
      invoke(channel, payload) {
        invoked = { channel, payload };
        return api.createSftpArchive(null, payload);
      },
    },
    webUtils: {},
  });
  assert.deepEqual(await bridge.createSftpArchive("sftp-1", options, "utf-8"), { success: true });
  assert.equal(invoked.channel, "netcatty:sftp:createArchive");
  assert.deepEqual(invoked.payload, { sftpId: "sftp-1", options, encoding: "utf-8" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /tar -czf/);
  assert.equal(calls[0].options.openingTimeoutMs, 15_000);
  assert.equal(calls[0].options.runTimeoutMs, 30 * 60_000);
  assert.equal(calls[0].options.maxOutputBytes, 64 * 1024);
});

test("archive conflicts survive IPC as structured EEXIST results", async () => {
  const { api } = createApi({ stdout: "NETCATTY_ARCHIVE_RESULT:EEXIST\n" });
  const result = await api.createSftpArchive(null, { sftpId: "sftp-1", options });
  assert.equal(result.success, false);
  assert.equal(result.code, "EEXIST");
});

test("archive creation requires a session and exec channel", async () => {
  const missing = createApi({ client: null });
  await assert.rejects(() => missing.api.createSftpArchive(null, { sftpId: "none", options }), /session not found/);
  const noExec = createApi({ client: {} });
  await assert.rejects(() => noExec.api.createSftpArchive(null, { sftpId: "sftp-1", options }), /SSH exec unavailable/);
  assert.equal(missing.calls.length + noExec.calls.length, 0);
});

test("archive creation never opens a second channel on single-channel SSH", async () => {
  for (const client of [
    { __netcattySingleChannelSsh: true, client: { exec() {} } },
    { client: { __netcattySingleChannelSsh: true, exec() {} } },
  ]) {
    const { api, calls } = createApi({ client });
    await assert.rejects(
      () => api.createSftpArchive(null, { sftpId: "sftp-1", options }),
      (error) => error.code === "ERR_SFTP_SINGLE_CHANNEL_EXEC",
    );
    assert.equal(calls.length, 0);
  }
});

test("invalid sources and cancelled requests never execute a shell command", async () => {
  const { api, calls } = createApi();
  await assert.rejects(() => api.createSftpArchive(null, { sftpId: "sftp-1", options: { ...options, paths: ["../outside"] } }), /inside/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() => api.createSftpArchive(null, { sftpId: "sftp-1", options, abortSignal: abort.signal }), /Aborted/);
  assert.equal(calls.length, 0);
});

test("remote errors or missing completion acknowledgements cannot report success", async () => {
  const failure = createApi({ error: new Error("zip unavailable") });
  await assert.rejects(() => failure.api.createSftpArchive(null, { sftpId: "sftp-1", options }), /zip unavailable/);
  const incomplete = createApi({ stdout: "" });
  await assert.rejects(() => incomplete.api.createSftpArchive(null, { sftpId: "sftp-1", options }), /did not confirm/);
});

test("archive creation resolves the session's filename encoding", async () => {
  const { api, calls } = createApi({ encoding: "gb18030" });
  await api.createSftpArchive(null, { sftpId: "sftp-1", options: { ...options, paths: ["\u4e2d\u6587"] }, encoding: "auto" });
  assert.match(calls[0].command, /base64 -d/);
  assert.ok(!calls[0].command.includes("\u4e2d\u6587"));
});
