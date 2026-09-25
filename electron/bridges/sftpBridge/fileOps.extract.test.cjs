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


test("extractSftpArchive sends tar through the idle terminal on single-channel SSH", async () => {
  const { EventEmitter } = require("node:events");
  const shell = require("../singleChannelShell.cjs");
  const writes = [];
  const stream = new EventEmitter();
  stream.writable = true;
  stream.write = (line) => {
    writes.push(String(line));
    const marker = String(line).match(/NETCATTY_EXTRACT_[a-z0-9_]+/i);
    if (marker) {
      process.nextTick(() => stream.emit("data", Buffer.from("\n" + marker[0] + " 0\n")));
    }
    return true;
  };
  shell.init(new Map([[
    "term-1",
    {
      singleChannelSsh: true,
      connRef: { endpointKey: "ep-extract" },
      _promptTrackTail: "[dev@host ~]$ ",
      stream,
    },
  ]]));
  let execCalls = 0;
  const { api, commands } = createExtractApi({
    clients: new Map([[
      "sftp-1",
      {
        __netcattySingleChannelSsh: true,
        __netcattyEndpointKey: "ep-extract",
        client: { exec() { execCalls += 1; } },
      },
    ]]),
  });
  const result = await api.extractSftpArchive(null, {
    sftpId: "sftp-1",
    path: "/home/app/backup.tar.gz",
  });
  assert.deepEqual(result, { success: true });
  assert.equal(commands.length, 0);
  assert.equal(execCalls, 0);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /tar -xzf /);
});
