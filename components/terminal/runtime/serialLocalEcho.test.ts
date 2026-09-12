import assert from "node:assert/strict";
import test from "node:test";

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

test("serial byte deletion metadata is forwarded through the runtime input loop", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
  assert.match(source, /writeToSession\(id, chunk, \{ sensitive, serialEraseChar \}\)/);
});
