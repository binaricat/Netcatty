import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SFTP_TREE_FOLDER_DOUBLE_CLICK_BEHAVIOR,
  isSftpTreeFolderDoubleClickBehavior,
  parseSftpTreeFolderDoubleClickBehavior,
} from "./sftpTreeFolderDoubleClick.ts";

test("tree folder double-click defaults to navigate and validates allowed values", () => {
  assert.equal(DEFAULT_SFTP_TREE_FOLDER_DOUBLE_CLICK_BEHAVIOR, "navigate");
  assert.equal(isSftpTreeFolderDoubleClickBehavior("navigate"), true);
  assert.equal(isSftpTreeFolderDoubleClickBehavior("expand"), true);
  assert.equal(isSftpTreeFolderDoubleClickBehavior("open"), false);
  assert.equal(isSftpTreeFolderDoubleClickBehavior(""), false);
  assert.equal(isSftpTreeFolderDoubleClickBehavior(null), false);
  assert.equal(isSftpTreeFolderDoubleClickBehavior(undefined), false);
});

test("parseSftpTreeFolderDoubleClickBehavior falls back to default for invalid inputs", () => {
  assert.equal(parseSftpTreeFolderDoubleClickBehavior("navigate"), "navigate");
  assert.equal(parseSftpTreeFolderDoubleClickBehavior("expand"), "expand");
  assert.equal(parseSftpTreeFolderDoubleClickBehavior("invalid"), "navigate");
  assert.equal(parseSftpTreeFolderDoubleClickBehavior(null), "navigate");
  assert.equal(parseSftpTreeFolderDoubleClickBehavior(undefined), "navigate");
});
