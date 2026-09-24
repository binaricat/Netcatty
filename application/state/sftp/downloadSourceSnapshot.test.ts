import assert from "node:assert/strict";
import test from "node:test";

import { resolveDownloadSourceSnapshot } from "./downloadSourceSnapshot.ts";

const stat = (overrides: Partial<SftpStatResult> = {}): SftpStatResult => ({
  name: "f",
  size: 50_000,
  type: "file",
  lastModified: 0,
  sizeKnown: true,
  ...overrides,
});

for (const listedSize of [25_000, 100_000]) {
  test(`recreated file uses the current 50k size rather than listed ${listedSize}`, async () => {
    const snapshot = await resolveDownloadSourceSnapshot(
      async (_id, path, encoding) => {
        assert.equal(path, "/tmp/f");
        assert.equal(encoding, "auto");
        return stat();
      },
      "sftp-1", "/tmp/f", "auto",
    );
    assert.deepEqual(snapshot, { size: 50_000, isDirectory: false });
    assert.notEqual(snapshot.size, listedSize);
  });
}

test("a stale file entry replaced by a directory uses directory routing", async () => {
  const snapshot = await resolveDownloadSourceSnapshot(
    async () => stat({ size: 0, type: "directory" }),
    "sftp-1", "/tmp/x", "auto",
  );
  assert.deepEqual(snapshot, { size: 0, isDirectory: true });
});

test("a stale directory entry replaced by a file uses file routing", async () => {
  const snapshot = await resolveDownloadSourceSnapshot(
    async () => stat({ size: 12, type: "file" }),
    "sftp-1", "/tmp/x", "auto",
  );
  assert.deepEqual(snapshot, { size: 12, isDirectory: false });
});

test("missing, failed and unsupported stats reject instead of using a stale listing", async () => {
  const rejected = [
    undefined,
    async () => null as unknown as SftpStatResult,
    async () => { throw new Error("File not found"); },
    async () => stat({ type: "symlink" }),
    async () => stat({ size: Number.NaN }),
    async () => stat({ size: -1 }),
  ];
  for (const candidate of rejected) {
    await assert.rejects(
      resolveDownloadSourceSnapshot(candidate, "sftp-1", "/tmp/f", "auto"),
      /Cannot verify the current remote source before download/,
    );
  }
});

test("stat-less SCP file leaves sizing to the transfer instead of using listed bytes", async () => {
  const snapshot = await resolveDownloadSourceSnapshot(
    async () => stat({ size: 0, sizeKnown: false }),
    "scp-1", "/tmp/f", "auto",
  );
  assert.deepEqual(snapshot, { size: undefined, isDirectory: false });
});

test("SCP links retain their resolved file or directory routing without using link size", async () => {
  for (const target of ["file", "directory"] as const) {
    const snapshot = await resolveDownloadSourceSnapshot(
      async () => stat({ type: "symlink", size: 8 }),
      "scp-1", "/tmp/link", "auto",
      async (_id, parent, encoding) => {
        assert.equal(parent, "/tmp");
        assert.equal(encoding, "auto");
        return [{ name: "link", type: "symlink", linkTarget: target, size: "8 bytes", lastModified: "" }];
      },
    );
    assert.deepEqual(snapshot, { size: undefined, isDirectory: target === "directory" });
  }
});

test("SCP link whose current target cannot be confirmed stops safely", async () => {
  for (const entries of [
    [],
    [{ name: "link", type: "symlink" as const, linkTarget: null, size: "8 bytes", lastModified: "" }],
    [{ name: "link", type: "file" as const, size: "8 bytes", lastModified: "" }],
  ]) {
    await assert.rejects(
      resolveDownloadSourceSnapshot(
        async () => stat({ type: "symlink" }),
        "scp-1", "/tmp/link", "auto", async () => entries,
      ),
      /Cannot verify the current remote source before download/,
    );
  }
});

test("directory routing does not require a file byte count", async () => {
  const snapshot = await resolveDownloadSourceSnapshot(
    async () => stat({ size: Number.NaN, sizeKnown: false, type: "directory" }),
    "sftp-1", "/tmp/d", "auto",
  );
  assert.deepEqual(snapshot, { size: 0, isDirectory: true });
});
