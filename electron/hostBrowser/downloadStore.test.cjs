"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { createDownloadStore } = require("./downloadStore.cjs");
const { reserveDownloadFile } = require("./downloadFile.cjs");
const { getTempFilePath } = require("../bridges/tempDirBridge.cjs");

test("download history stays local to its host and survives restart", () => {
  const directory = fs.mkdtempSync(getTempFilePath("host-browser-downloads-"));
  try {
    const app = { getPath: () => directory };
    const file = path.join(directory, "download.bin");
    fs.writeFileSync(file, "downloaded");
    const first = createDownloadStore(app);
    first.upsert({ id: "one", hostId: "host-a", filename: "download.bin", status: "completed",
      savePath: file, received: 10, total: 10, startedAt: 100 });
    first.upsert({ id: "two", hostId: "host-b", filename: "other.bin", status: "waiting", startedAt: 200 });
    assert.equal(first.list("host-b").length, 1);
    const restored = createDownloadStore(app);
    assert.equal(restored.list("host-a")[0].status, "completed");
    assert.equal(restored.list("host-b")[0].status, "interrupted");
    fs.unlinkSync(file);
    assert.equal(restored.list("host-a")[0].missing, true);
    restored.clearFinished("host-a");
    assert.equal(restored.list("host-a").length, 0);
    assert.equal(restored.list("host-b").length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("automatic downloads reserve separate names without replacing existing files", (t) => {
  const directory = fs.mkdtempSync(getTempFilePath("host-browser-download-names-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "report.txt"), "existing file");
  fs.mkdirSync(path.join(directory, "report (1).txt"));
  const first = reserveDownloadFile(directory, "report.txt");
  const second = reserveDownloadFile(directory, "report.txt");
  assert.equal(path.basename(first.savePath), "report (2).txt");
  assert.equal(path.basename(second.savePath), "report (3).txt");
  assert.equal(fs.readFileSync(path.join(directory, "report.txt"), "utf8"), "existing file");
  first.cleanupEmpty();
  assert.equal(fs.existsSync(first.savePath), false);
  fs.writeFileSync(second.savePath, "downloaded content");
  second.cleanupEmpty();
  assert.equal(fs.readFileSync(second.savePath, "utf8"), "downloaded content");
});

test("cleanup removes only its own empty reservation", (t) => {
  const directory = fs.mkdtempSync(getTempFilePath("host-browser-download-cleanup-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const reserved = reserveDownloadFile(directory, "../report.txt");
  assert.equal(reserved.savePath, path.join(directory, "report.txt"));
  const otherFile = path.join(directory, "replacement");
  fs.writeFileSync(otherFile, "");
  fs.renameSync(otherFile, reserved.savePath);
  reserved.cleanupEmpty();
  assert.equal(fs.existsSync(reserved.savePath), true, "a replacement made by someone else is left alone");
});
