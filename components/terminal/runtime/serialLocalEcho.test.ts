import assert from "node:assert/strict";
import test from "node:test";

import { formatSerialLocalEcho, backspaceCellsForChar } from "./serialLocalEcho";

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

test("formatSerialLocalEcho returns empty for empty input", () => {
  assert.equal(formatSerialLocalEcho(""), "");
});

test("formatSerialLocalEcho erases 1 cell by default for backspace", () => {
  assert.equal(formatSerialLocalEcho("\x7f"), "\b \b");
  assert.equal(formatSerialLocalEcho("\x7f", 1), "\b \b");
});

test("formatSerialLocalEcho erases 2 cells for wide-character backspace", () => {
  // CJK ideograph = 2 cells; backspace must erase both.
  assert.equal(formatSerialLocalEcho("\x7f", 2), "\b \b\b \b");
  assert.equal(formatSerialLocalEcho("\b", 2), "\b \b\b \b");
});

test("backspaceCellsForChar returns 1 for ASCII characters", () => {
  assert.equal(backspaceCellsForChar("a"), 1);
  assert.equal(backspaceCellsForChar(" "), 1);
  assert.equal(backspaceCellsForChar("."), 1);
});

test("backspaceCellsForChar returns 2 for CJK characters", () => {
  assert.equal(backspaceCellsForChar("你"), 2);
  assert.equal(backspaceCellsForChar("好"), 2);
  assert.equal(backspaceCellsForChar("中"), 2);
});

test("backspaceCellsForChar returns 2 for emoji", () => {
  assert.equal(backspaceCellsForChar("\u{1F600}"), 2);
});
