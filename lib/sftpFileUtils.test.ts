import test from "node:test";
import assert from "node:assert/strict";

import { getFileExtension, hasFileExtension } from "./sftpFileUtils.ts";

test("hasFileExtension identifies extensionless and dotted filenames", () => {
  assert.equal(hasFileExtension("nginx"), false);
  assert.equal(hasFileExtension("my-binary"), false);
  assert.equal(hasFileExtension(".git"), false);
  assert.equal(getFileExtension("nginx"), "file");

  assert.equal(hasFileExtension("readme.txt"), true);
  assert.equal(hasFileExtension(".bashrc"), false);
  assert.equal(hasFileExtension("archive.tar.gz"), true);
});
