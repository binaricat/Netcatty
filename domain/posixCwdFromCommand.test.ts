import test from "node:test";
import assert from "node:assert/strict";
import { commandReportsDirectoryChange } from "./posixCwdFromCommand.ts";

test("commandReportsDirectoryChange selects cd pushd and popd only", () => {
  assert.equal(commandReportsDirectoryChange("cd ~"), true);
  assert.equal(commandReportsDirectoryChange("cd"), true);
  assert.equal(commandReportsDirectoryChange("pushd /tmp"), true);
  assert.equal(commandReportsDirectoryChange("popd"), true);
  assert.equal(commandReportsDirectoryChange("ll"), false);
  assert.equal(commandReportsDirectoryChange("cd /tmp && ls"), true);
  assert.equal(commandReportsDirectoryChange("ls && cd ~"), true);
  assert.equal(commandReportsDirectoryChange("cd /tmp; ls"), true);
  assert.equal(commandReportsDirectoryChange("cd /tmp || ls"), true);
  assert.equal(commandReportsDirectoryChange('cd "/tmp/a|b"'), true);
  assert.equal(commandReportsDirectoryChange("cd /tmp # | cat"), true);
  assert.equal(commandReportsDirectoryChange("cd /tmp && (ls | head)"), true);
  assert.equal(commandReportsDirectoryChange("cd /tmp | ls"), false);
  assert.equal(commandReportsDirectoryChange("cd /tmp &"), false);
  assert.equal(commandReportsDirectoryChange("cd /tmp && ls &"), false);
  assert.equal(commandReportsDirectoryChange("echo cd /tmp"), false);
  assert.equal(commandReportsDirectoryChange("(cd /tmp)"), false);
  assert.equal(commandReportsDirectoryChange('cd "/tmp'), false);
});
