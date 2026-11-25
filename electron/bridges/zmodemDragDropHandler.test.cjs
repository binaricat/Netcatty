"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { handleZmodemDragDropUpload } = require("./zmodemDragDropHandler.cjs");

test("handleZmodemDragDropUpload rejects missing session or already-active transfer", async () => {
  const sessions = new Map();
  const tempDirBridge = { getTempFilePath: () => "" };

  const missing = await handleZmodemDragDropUpload(
    { sessions, tempDirBridge, fs, path },
    { sessionId: "missing", files: [] },
  );
  assert.deepEqual(missing, {
    success: false,
    error: "ZMODEM upload is not available for this session",
  });

  sessions.set("busy", {
    zmodemSentry: {
      isActive: () => true,
      queueDragDropUpload: () => {},
    },
  });
  const active = await handleZmodemDragDropUpload(
    { sessions, tempDirBridge, fs, path },
    { sessionId: "busy", files: [] },
  );
  assert.deepEqual(active, {
    success: false,
    error: "ZMODEM transfer already in progress",
  });
});

test("handleZmodemDragDropUpload materializes buffer files, skips unreadable paths, and queues upload", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-dd-"));
  try {
    const existingPath = path.join(tmpDir, "existing.txt");
    fs.writeFileSync(existingPath, "hello");
    const queued = [];
    const sessions = new Map([
      [
        "s1",
        {
          zmodemSentry: {
            isActive: () => false,
            queueDragDropUpload: (opts) => queued.push(opts),
          },
        },
      ],
    ]);
    const tempDirBridge = {
      getTempFilePath: (name) => path.join(tmpDir, `tmp-${name}`),
    };

    const result = await handleZmodemDragDropUpload(
      { sessions, tempDirBridge, fs, path },
      {
        sessionId: "s1",
        files: [
          { name: "existing.txt", path: existingPath },
          { name: "missing.txt", path: path.join(tmpDir, "does-not-exist.txt") },
          { name: "blob.bin", remoteName: "custom.bin", data: Uint8Array.from([1, 2, 3]) },
        ],
      },
    );

    assert.deepEqual(result, { success: true });
    assert.equal(queued.length, 1);
    const materializedPath = path.join(tmpDir, "tmp-blob.bin");
    assert.deepEqual(queued[0], {
      filePaths: [existingPath, materializedPath],
      remoteNames: ["existing.txt", "custom.bin"],
      uploadCommand: "rz -y\r",
      tempPaths: [materializedPath],
    });
    assert.deepEqual(fs.readFileSync(materializedPath), Buffer.from([1, 2, 3]));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("handleZmodemDragDropUpload cleans up materialized temp files when queueing throws", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-dd-err-"));
  try {
    const sessions = new Map([
      [
        "s1",
        {
          zmodemSentry: {
            isActive: () => false,
            queueDragDropUpload: () => {
              throw new Error("queue rejected");
            },
          },
        },
      ],
    ]);
    const tempPath = path.join(tmpDir, "tmp-fail.bin");
    const tempDirBridge = { getTempFilePath: () => tempPath };

    const result = await handleZmodemDragDropUpload(
      { sessions, tempDirBridge, fs, path },
      {
        sessionId: "s1",
        files: [{ name: "fail.bin", data: Uint8Array.from([9, 8]) }],
        uploadCommand: "rz -e\r",
      },
    );

    assert.deepEqual(result, { success: false, error: "queue rejected" });
    assert.equal(fs.existsSync(tempPath), false, "materialized temp file must be unlinked on failure");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
