import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSftpDownloadDialogDirectoryOptions,
  normalizeSftpDefaultDownloadDirectory,
} from "./sftpDownloadLocation";

test("normalizeSftpDefaultDownloadDirectory trims strings and rejects other values", () => {
  assert.equal(normalizeSftpDefaultDownloadDirectory("  /Users/me/Downloads  "), "/Users/me/Downloads");
  assert.equal(normalizeSftpDefaultDownloadDirectory("   "), "");
  assert.equal(normalizeSftpDefaultDownloadDirectory(null), "");
  assert.equal(normalizeSftpDefaultDownloadDirectory(undefined), "");
  assert.equal(normalizeSftpDefaultDownloadDirectory(42), "");
});

test("buildSftpDownloadDialogDirectoryOptions always falls back to system Downloads", () => {
  assert.deepEqual(buildSftpDownloadDialogDirectoryOptions(null), { fallbackDirectory: "downloads" });
  assert.deepEqual(buildSftpDownloadDialogDirectoryOptions(""), { fallbackDirectory: "downloads" });
  assert.deepEqual(buildSftpDownloadDialogDirectoryOptions("D:\\Downloads\\servers "), {
    preferredDirectory: "D:\\Downloads\\servers",
    fallbackDirectory: "downloads",
  });
});
