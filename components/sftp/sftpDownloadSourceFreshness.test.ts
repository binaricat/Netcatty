import assert from "node:assert/strict";
import test from "node:test";

import {
  DOWNLOAD_TARGET_MEMORY_LIMIT,
  getRememberedDownloadTargetDir,
  makeDownloadTargetMemoryKey,
  rememberDownloadTargetDir,
  resolveDownloadSourceSnapshot,
} from "./sftpDownloadSourceFreshness.ts";

const stat = (overrides: Partial<SftpStatResult> & { size: number; type: SftpStatResult["type"] }) => ({
  name: "f",
  size: overrides.size,
  type: overrides.type,
  lastModified: 0,
  sizeKnown: true,
  ...overrides,
});

test("fresh snapshot reports the re-statted size and directory classification", async () => {
  const snapshot = await resolveDownloadSourceSnapshot(
    async () => stat({ size: 12, type: "file" }),
    "sftp-1",
    "/tmp/a.log",
    "auto",
  );
  assert.deepEqual(snapshot, { size: 12, isDirectory: false });
});

test("fresh snapshot corrects a stale file entry that became a directory", async () => {
  const snapshot = await resolveDownloadSourceSnapshot(
    async () => stat({ size: 0, type: "directory" }),
    "sftp-1",
    "/tmp/x",
    "auto",
  );
  assert.deepEqual(snapshot, { size: 0, isDirectory: true });
});

test("symlink entries keep the listed classification", async () => {
  const snapshot = await resolveDownloadSourceSnapshot(
    async () => stat({ size: 4, type: "symlink" }),
    "sftp-1",
    "/tmp/link",
    "auto",
  );
  assert.deepEqual(snapshot, { size: 4, isDirectory: null });
});

test("unknown size (sizeKnown=false) and stat failures fall back to the listed entry", async () => {
  const unknown = await resolveDownloadSourceSnapshot(
    async () => stat({ size: 0, type: "file", sizeKnown: false }),
    "sftp-1",
    "/tmp/f",
    "auto",
  );
  assert.deepEqual(unknown, { size: null, isDirectory: false });

  const failing = await resolveDownloadSourceSnapshot(
    async () => {
      throw new Error("SFTP session not found");
    },
    "sftp-1",
    "/tmp/f",
    "auto",
  );
  assert.deepEqual(failing, { size: null, isDirectory: null });

  const missing = await resolveDownloadSourceSnapshot(undefined, "sftp-1", "/tmp/f", "auto");
  assert.deepEqual(missing, { size: null, isDirectory: null });

  const nullStat = await resolveDownloadSourceSnapshot(
    async () => null as unknown as SftpStatResult,
    "sftp-1",
    "/tmp/f",
    "auto",
  );
  assert.deepEqual(nullStat, { size: null, isDirectory: null });
});

test("target dir memory keys on host + source path and is LRU-bounded", () => {
  const key = makeDownloadTargetMemoryKey("host-1", "/tmp/f.log");
  assert.equal(getRememberedDownloadTargetDir(key), undefined);

  rememberDownloadTargetDir(key, "/downloads");
  assert.equal(getRememberedDownloadTargetDir(key), "/downloads");
  // Re-remembering refreshes instead of failing.
  rememberDownloadTargetDir(key, "/other");
  assert.equal(getRememberedDownloadTargetDir(key), "/other");

  const first = makeDownloadTargetMemoryKey("host-1", "/first");
  rememberDownloadTargetDir(first, "/a");
  for (let i = 0; i < DOWNLOAD_TARGET_MEMORY_LIMIT; i++) {
    rememberDownloadTargetDir(makeDownloadTargetMemoryKey("host-2", `/p/${i}`), `/d/${i}`);
  }
  // Oldest entry was evicted; the most recent insertions survive.
  assert.equal(getRememberedDownloadTargetDir(first), undefined);
  const lastKey = makeDownloadTargetMemoryKey("host-2", `/p/${DOWNLOAD_TARGET_MEMORY_LIMIT - 1}`);
  assert.equal(getRememberedDownloadTargetDir(lastKey), `/d/${DOWNLOAD_TARGET_MEMORY_LIMIT - 1}`);
});
