import assert from "node:assert/strict";
import test from "node:test";
import {
  canReplaceSftpConflict,
  shouldUnlinkSftpConflictBeforeReplace,
} from "./sftpConflict";

test("replace accepts symlinks for either incoming kind", () => {
  assert.equal(canReplaceSftpConflict(false, "symlink"), true);
  assert.equal(canReplaceSftpConflict(true, "symlink"), true);
});

test("replace fails closed when a folder conflict has no confirmed destination type", () => {
  assert.equal(canReplaceSftpConflict(true, undefined), false);
  assert.equal(canReplaceSftpConflict(false, undefined), true);
});

test("replace unlinks only confirmed symlink conflicts", () => {
  assert.equal(shouldUnlinkSftpConflictBeforeReplace("symlink"), true);
  assert.equal(shouldUnlinkSftpConflictBeforeReplace("file"), false);
  assert.equal(shouldUnlinkSftpConflictBeforeReplace("directory"), false);
  assert.equal(shouldUnlinkSftpConflictBeforeReplace(undefined), false);
});
