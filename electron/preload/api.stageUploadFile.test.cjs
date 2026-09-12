"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createPreloadApi } = require("./api.cjs");

function createFile(name, chunks) {
  let index = 0;
  return {
    name,
    stream: () => ({
      getReader: () => ({
        async read() {
          if (index >= chunks.length) return { done: true };
          return { done: false, value: Uint8Array.from(chunks[index++]) };
        },
        releaseLock() {},
      }),
    }),
  };
}

function createBlockingFile(name) {
  let markReadStarted;
  let finishRead;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  return {
    file: {
      name,
      stream: () => ({
        getReader: () => ({
          read() {
            markReadStarted();
            return new Promise((resolve) => { finishRead = resolve; });
          },
          cancel() {
            finishRead?.({ done: true });
            return Promise.resolve();
          },
          releaseLock() {},
        }),
      }),
    },
    readStarted,
  };
}

test("superseding pathless upload staging uses an independent temp file", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-preload-stage-race-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const created = [];
  const deleted = [];
  const ipcRenderer = {
    on() {},
    removeListener() {},
    async invoke(channel, payload) {
      if (channel === "netcatty:tempdir:createUploadPath") {
        const localPath = path.join(dir, `${payload.transferId}_${payload.fileName}.part`);
        created.push({ payload, localPath });
        return localPath;
      }
      if (channel === "netcatty:deleteTempFile") {
        deleted.push(payload.filePath);
        await fs.promises.unlink(payload.filePath).catch(() => {});
        return { success: true };
      }
      throw new Error(`Unexpected IPC call: ${channel}`);
    },
  };
  const api = createPreloadApi({ ipcRenderer, webUtils: {} });
  const firstFile = createBlockingFile("same.bin");

  const first = api.stageUploadFile(firstFile.file, "same-transfer");
  await firstFile.readStarted;
  const second = api.stageUploadFile(createFile("same.bin", [[4, 5, 6]]), "same-transfer");

  await assert.rejects(first, /superseded/i);
  const secondPath = await second;

  assert.equal(created.length, 2);
  assert.notEqual(created[0].payload.transferId, created[1].payload.transferId);
  assert.notEqual(created[0].localPath, created[1].localPath);
  assert.equal(secondPath, created[1].localPath);
  assert.deepEqual(await fs.promises.readFile(secondPath), Buffer.from([4, 5, 6]));
  await assert.rejects(fs.promises.stat(created[0].localPath), { code: "ENOENT" });
  assert.deepEqual(deleted, [created[0].localPath]);
});

test("failed upload path allocation releases the staging controller", async () => {
  const api = createPreloadApi({
    webUtils: {},
    ipcRenderer: {
      on() {},
      removeListener() {},
      async invoke(channel) {
        if (channel === "netcatty:tempdir:createUploadPath") throw new Error("path unavailable");
        throw new Error(`Unexpected IPC call: ${channel}`);
      },
    },
  });

  await assert.rejects(api.stageUploadFile(createFile("file.bin", [[1]]), "failed-path"), /path unavailable/);
  assert.deepEqual(await api.cancelStagedUploadFile("failed-path"), { success: false });
});

test("native tree scans use a bridge-safe cancellation id", async () => {
  const sent = [];
  const invoked = [];
  const api = createPreloadApi({
    webUtils: {},
    ipcRenderer: {
      on() {},
      removeListener() {},
      send(...args) { sent.push(args); },
      async invoke(channel, payload) {
        invoked.push({ channel, payload });
        return [];
      },
    },
  });

  await api.listLocalTree("/tmp/project", {
    scanId: "scan-123",
    onProgress: () => {},
  });
  await api.cancelLocalTreeScan("scan-123");

  assert.deepEqual(invoked, [{
    channel: "netcatty:local:tree",
    payload: {
      path: "/tmp/project",
      progressChannel: "netcatty:local:tree-progress:scan-123",
      entriesChannel: undefined,
      cancelChannel: "netcatty:local:tree-cancel:scan-123",
      limits: undefined,
    },
  }]);
  assert.deepEqual(sent, [["netcatty:local:tree-cancel:scan-123"]]);
});

test("listLocalTree keeps the entries listener until the tree-end marker arrives", async () => {
  const listeners = new Map();
  const batches = [];
  let removed = false;
  const api = createPreloadApi({
    webUtils: {},
    ipcRenderer: {
      on(channel, handler) {
        listeners.set(channel, handler);
      },
      removeListener(channel) {
        if (channel.startsWith("netcatty:local:tree-entries:")) removed = true;
        listeners.delete(channel);
      },
      send() {},
      async invoke(channel, payload) {
        assert.equal(channel, "netcatty:local:tree");
        const entriesChannel = payload.entriesChannel;
        const handler = listeners.get(entriesChannel);
        assert.equal(typeof handler, "function");
        // Simulate the invoke reply racing ahead of a late nested batch.
        queueMicrotask(() => {
          handler({}, [
            {
              localPath: "/tmp/project/nested/deep.txt",
              relativePath: "project/nested/deep.txt",
              type: "file",
              size: 1,
              lastModified: 1,
            },
          ]);
          handler({}, { type: "tree-end" });
        });
        return [];
      },
    },
  });

  await api.listLocalTree("/tmp/project", {
    scanId: "scan-nested",
    onEntries: (batch) => {
      batches.push(batch);
    },
  });

  assert.equal(batches.length, 1);
  assert.equal(batches[0][0].relativePath, "project/nested/deep.txt");
  assert.equal(removed, true);
});

test("openSftpForSession keeps the SSH source session id when options include an SFTP session id", async () => {
  const invoked = [];
  const api = createPreloadApi({
    webUtils: {},
    ipcRenderer: {
      on() {},
      removeListener() {},
      async invoke(channel, payload) {
        invoked.push({ channel, payload });
        return { sftpId: "opened-sftp" };
      },
    },
  });

  const sftpId = await api.openSftpForSession("ssh-session-1", {
    sessionId: "sftp-left-browse-session",
    hostname: "192.168.9.138",
    port: 22,
    username: "zlhrs",
  });

  assert.equal(sftpId, "opened-sftp");
  assert.equal(invoked.length, 1);
  assert.equal(invoked[0].channel, "netcatty:sftp:openForSession");
  assert.equal(invoked[0].payload.sessionId, "ssh-session-1");
  assert.equal(invoked[0].payload.expectedEndpoint.sessionId, "sftp-left-browse-session");
});

test("strict openSftpForSession closes and rejects a mismatched source result", async () => {
  const invoked = [];
  const api = createPreloadApi({
    webUtils: {},
    ipcRenderer: {
      on() {},
      removeListener() {},
      async invoke(channel, payload) {
        invoked.push({ channel, payload });
        if (channel === "netcatty:sftp:openForSession") {
          return { sftpId: "wrong-route-sftp", sourceSessionId: "other-session" };
        }
        return { success: true };
      },
    },
  });

  await assert.rejects(
    api.openSftpForSession("requested-session", {
      hostname: "target.example",
      username: "alice",
      requireExactSourceSession: true,
    }),
    /requested terminal connection is no longer available/,
  );

  assert.equal(invoked[0].payload.requireExactSourceSession, true);
  assert.deepEqual(invoked[1], {
    channel: "netcatty:sftp:close",
    payload: { sftpId: "wrong-route-sftp" },
  });
});
