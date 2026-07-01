const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  createZmodemDownloadDirectorySelector,
  createZmodemUploadFileSelector,
  normalizeParentPortMessage,
} = require("./process.cjs");

function createParentPort() {
  const messages = [];
  const listeners = new Map();
  return {
    messages,
    on(channel, callback) {
      listeners.set(channel, callback);
    },
    postMessage(message) {
      messages.push(message);
    },
    emitMessage(message) {
      listeners.get("message")?.(message);
    },
  };
}

test("normalizeParentPortMessage unwraps Electron utility process MessageEvent data", () => {
  assert.deepEqual(
    normalizeParentPortMessage({ data: { kind: "zmodem-upload-dialog-result" } }),
    { kind: "zmodem-upload-dialog-result" },
  );
  assert.deepEqual(
    normalizeParentPortMessage({ kind: "request" }),
    { kind: "request" },
  );
});

test("terminal worker installs DH compatibility before SSH bridges load", () => {
  assert.equal(crypto.createDiffieHellmanGroup.__boringSslDhCompat, true);
});

test("ZMODEM upload selector resolves dialog results delivered as MessageEvent data", async () => {
  const parentPort = createParentPort();
  const selectUploadFiles = createZmodemUploadFileSelector(parentPort, {
    randomUUID: () => "dialog-1",
  });

  const promise = selectUploadFiles(7);
  assert.deepEqual(parentPort.messages, [{
    kind: "zmodem-upload-dialog",
    requestId: "dialog-1",
    webContentsId: 7,
  }]);

  parentPort.emitMessage({
    data: {
      kind: "zmodem-upload-dialog-result",
      requestId: "dialog-1",
      result: { canceled: false, filePaths: ["/tmp/upload.txt"] },
    },
  });

  assert.deepEqual(await promise, {
    canceled: false,
    filePaths: ["/tmp/upload.txt"],
  });
});

test("ZMODEM download selector resolves directory dialog results delivered as MessageEvent data", async () => {
  const parentPort = createParentPort();
  const selectDownloadDirectory = createZmodemDownloadDirectorySelector(parentPort, {
    randomUUID: () => "download-dialog-1",
  });

  const promise = selectDownloadDirectory(7);
  assert.deepEqual(parentPort.messages, [{
    kind: "zmodem-download-dialog",
    requestId: "download-dialog-1",
    webContentsId: 7,
  }]);

  parentPort.emitMessage({
    data: {
      kind: "zmodem-download-dialog-result",
      requestId: "download-dialog-1",
      result: { canceled: false, filePaths: ["/tmp/downloads"] },
    },
  });

  assert.deepEqual(await promise, {
    canceled: false,
    filePaths: ["/tmp/downloads"],
  });
});
