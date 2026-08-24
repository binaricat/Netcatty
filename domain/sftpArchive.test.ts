import test from "node:test";
import assert from "node:assert/strict";

import { getSftpArchiveKind, isExtractableArchive } from "./sftpArchive.ts";

test("SFTP extract menu matches compound archive suffixes", () => {
  assert.equal(getSftpArchiveKind("backup.tar.gz"), "tar.gz");
  assert.equal(getSftpArchiveKind("logs.tgz"), "tar.gz");
  assert.equal(getSftpArchiveKind("src.tar.bz2"), "tar.bz2");
  assert.equal(getSftpArchiveKind("app.zip"), "zip");
  assert.equal(getSftpArchiveKind("notes.txt.gz"), "gz");
  assert.equal(isExtractableArchive("/var/tmp/payload.tar.xz"), true);
  assert.equal(isExtractableArchive("readme.md"), false);
  assert.equal(isExtractableArchive(".zip"), false);
});
