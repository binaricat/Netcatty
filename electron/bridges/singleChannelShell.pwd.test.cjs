"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractInteractivePwd } = require("./singleChannelShell.cjs");

test("extractInteractivePwd keeps the pwd line and ignores a prompt", () => {
  const buffer = "pwd\r\n/root #\r\n/root\r\n[root@host root]# ";
  assert.equal(extractInteractivePwd(buffer), "/root");
});

test("extractInteractivePwd waits for a complete line", () => {
  assert.equal(extractInteractivePwd("pwd\n/ro"), null);
  assert.equal(extractInteractivePwd("pwd\n/root\n"), "/root");
});

test("extractInteractivePwd keeps a path that contains spaces", () => {
  assert.equal(extractInteractivePwd("pwd\n/home/my docs\n"), "/home/my docs");
});
