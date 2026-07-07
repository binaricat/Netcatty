import test from "node:test";
import assert from "node:assert/strict";

import { formatSerialLocalEcho } from "./serialLocalEcho";

test("formatSerialLocalEcho echoes printable input and normalizes newlines", () => {
  assert.equal(formatSerialLocalEcho("show version"), "show version");
  assert.equal(formatSerialLocalEcho("\r"), "\r\n");
  assert.equal(formatSerialLocalEcho("\n"), "\r\n");
  assert.equal(formatSerialLocalEcho("\r\n"), "\r\n");
  assert.equal(formatSerialLocalEcho("one\ntwo"), "one\r\ntwo");
});

test("formatSerialLocalEcho renders local editing control keys", () => {
  assert.equal(formatSerialLocalEcho("\x7f"), "\b \b");
  assert.equal(formatSerialLocalEcho("\b"), "\b \b");
  assert.equal(formatSerialLocalEcho("\x03"), "^C");
});

test("formatSerialLocalEcho ignores single non-display control input", () => {
  assert.equal(formatSerialLocalEcho("\x15"), "");
});
