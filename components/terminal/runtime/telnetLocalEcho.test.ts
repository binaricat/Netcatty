import test from "node:test";
import assert from "node:assert/strict";

import { formatTelnetLocalEcho } from "./telnetLocalEcho";

test("formatTelnetLocalEcho echoes printable input and newlines", () => {
  assert.equal(formatTelnetLocalEcho("ps\r"), "ps\r\n");
  assert.equal(formatTelnetLocalEcho("one\ntwo"), "one\r\ntwo");
});

test("formatTelnetLocalEcho renders local editing control keys", () => {
  assert.equal(formatTelnetLocalEcho("\x7f"), "\b \b");
  assert.equal(formatTelnetLocalEcho("\b"), "\b \b");
  assert.equal(formatTelnetLocalEcho("\x03"), "^C");
});

test("formatTelnetLocalEcho ignores non-display escape input", () => {
  assert.equal(formatTelnetLocalEcho("\x1b[A"), "");
  assert.equal(formatTelnetLocalEcho("\x1bOP"), "");
  assert.equal(formatTelnetLocalEcho("\x1bb"), "");
});
