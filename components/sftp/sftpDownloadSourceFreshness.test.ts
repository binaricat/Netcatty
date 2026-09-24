import assert from "node:assert/strict";
import test from "node:test";

import {
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
