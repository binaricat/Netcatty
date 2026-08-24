"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createFileOpsApi } = require("./fileOps.cjs");

function createExtractApi({ execImpl, clients } = {}) {
  const commands = [];
  const optionsLog = [];
  const api = createFileOpsApi({
    sftpClients: clients || new Map([
      ["sftp-1", { client: { exec() {} } }],
    ]),
    resolveEncodingForRequest: () => "utf-8",
    throwIfAborted: () => {},
    encodePath: (value) => value,
    requireSftpChannel: async () => ({}),
    lstatAsync: async () => ({ size: 1024 }),
    isScpModeClient: () => false,
    execRemoteShellCommand: async (_ssh, command, options) => {
      commands.push(command);
      optionsLog.push(options);
      if (typeof execImpl === "function") return execImpl(command);
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  return { api, commands, optionsLog };
}

test("extractSftpArchive runs a quoted remote tar command", async () => {
  const { api, commands, optionsLog } = createExtractApi();
  const result = await api.extractSftpArchive(null, {
    sftpId: "sftp-1",
    path: "/home/app/backup.tar.gz",
  });
  assert.deepEqual(result, { success: true });
  assert.equal(commands.length, 1);
  assert.match(commands[0], /tar -xzf '\/home\/app\/backup\.tar\.gz' -C '\/home\/app'/);
  assert.equal(optionsLog[0].discardStdout, true);
});

test("extractSftpArchive rejects unsupported files", async () => {
  const { api, commands } = createExtractApi();
  await assert.rejects(
    () => api.extractSftpArchive(null, { sftpId: "sftp-1", path: "/home/app/notes.txt" }),
    /Unsupported archive type/,
  );
  assert.equal(commands.length, 0);
});

test("extractSftpArchive requires an open SFTP session", async () => {
  const { api } = createExtractApi({ clients: new Map() });
  await assert.rejects(
    () => api.extractSftpArchive(null, { sftpId: "missing", path: "/tmp/a.zip" }),
    /SFTP session not found/,
  );
});
