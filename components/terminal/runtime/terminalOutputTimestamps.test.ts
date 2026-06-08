import test from "node:test";
import assert from "node:assert/strict";

import {
  createTerminalOutputTimestampPrefixer,
  formatTerminalOutputTimestamp,
  stripTerminalOutputTimestamps,
} from "./terminalOutputTimestamps.ts";

test("formats terminal output timestamps as bracketed local time", () => {
  assert.equal(
    formatTerminalOutputTimestamp(new Date(2026, 5, 6, 9, 8, 7)),
    "\x1b[2;90m[09:08:07] \x1b[22;39m",
  );
});

test("prefixes each non-empty terminal output line across chunks", () => {
  const prefixer = createTerminalOutputTimestampPrefixer({
    now: () => new Date(2026, 5, 6, 10, 11, 12),
  });

  assert.equal(prefixer.append("hello"), "\x1b[2;90m[10:11:12] \x1b[22;39mhello");
  assert.equal(prefixer.append(" world\r\nnext"), " world\r\n\x1b[2;90m[10:11:12] \x1b[22;39mnext");
  assert.equal(prefixer.append("\r\n"), "\r\n");
});

test("does not timestamp blank lines or repeated carriage-return updates", () => {
  const prefixer = createTerminalOutputTimestampPrefixer({
    now: () => new Date(2026, 5, 6, 1, 2, 3),
  });

  assert.equal(
    prefixer.append("\r\n\r\nprogress 1\rprogress 2\n"),
    "\r\n\r\n\x1b[2;90m[01:02:03] \x1b[22;39mprogress 1\rprogress 2\n",
  );
});

test("waits until printable output after leading terminal controls", () => {
  const prefixer = createTerminalOutputTimestampPrefixer({
    now: () => new Date(2026, 5, 6, 4, 5, 6),
  });

  assert.equal(
    prefixer.append("\x1b[?2004l\rpermission denied\r\n\x1b[01;32muser@host\x1b[00m$ "),
    "\x1b[?2004l\r\x1b[2;90m[04:05:06] \x1b[22;39mpermission denied\r\n\x1b[01;32m\x1b[2;90m[04:05:06] \x1b[22;39m\x1b[1;32muser@host\x1b[00m$ ",
  );
});

test("does not split timestamps into fragmented terminal controls", () => {
  const prefixer = createTerminalOutputTimestampPrefixer({
    now: () => new Date(2026, 5, 6, 7, 8, 9),
  });

  assert.equal(prefixer.append("\x1b"), "");
  assert.equal(
    prefixer.append("[?2004l\rhello"),
    "\x1b[?2004l\r\x1b[2;90m[07:08:09] \x1b[22;39mhello",
  );
  assert.equal(prefixer.append("\r\n\x1b[01;"), "\r\n");
  assert.equal(
    prefixer.append("32muser"),
    "\x1b[01;32m\x1b[2;90m[07:08:09] \x1b[22;39m\x1b[1;32muser",
  );
});

test("keeps long terminal control strings untouched across chunks", () => {
  const prefixer = createTerminalOutputTimestampPrefixer({
    now: () => new Date(2026, 5, 6, 8, 9, 10),
  });

  assert.equal(prefixer.append("\x1bPtmux;payload"), "");
  assert.equal(
    prefixer.append("\x1b\\hello"),
    "\x1bPtmux;payload\x1b\\\x1b[2;90m[08:09:10] \x1b[22;39mhello",
  );
});

test("keeps alternate screen output untouched and resumes after exit", () => {
  const prefixer = createTerminalOutputTimestampPrefixer({
    now: () => new Date(2026, 5, 6, 11, 12, 13),
  });

  assert.equal(
    prefixer.append("\x1b[?1049hvim screen\r\nstill vim"),
    "\x1b[?1049hvim screen\r\nstill vim",
  );
  assert.equal(
    prefixer.append("\x1b[?1049lprompt"),
    "\x1b[?1049l\x1b[2;90m[11:12:13] \x1b[22;39mprompt",
  );
});

test("restores active text color after timestamp color", () => {
  const prefixer = createTerminalOutputTimestampPrefixer({
    now: () => new Date(2026, 5, 6, 14, 15, 16),
  });

  assert.equal(
    prefixer.append("\x1b[31mred\r\nnext"),
    "\x1b[31m\x1b[2;90m[14:15:16] \x1b[22;39m\x1b[31mred\r\n\x1b[2;90m[14:15:16] \x1b[22;39m\x1b[31mnext",
  );
});

test("does not timestamp output that has no printable text", () => {
  const prefixer = createTerminalOutputTimestampPrefixer({
    now: () => new Date(2026, 5, 6, 17, 18, 19),
  });

  assert.equal(prefixer.append("\x07\b\x1b[0m\r\n"), "\x07\b\x1b[0m\r\n");
  assert.equal(prefixer.append("visible"), "\x1b[2;90m[17:18:19] \x1b[22;39mvisible");
});

test("timestamps printable text after leading invisible controls", () => {
  const prefixer = createTerminalOutputTimestampPrefixer({
    now: () => new Date(2026, 5, 6, 20, 21, 22),
  });

  assert.equal(prefixer.append("\x07visible"), "\x07\x1b[2;90m[20:21:22] \x1b[22;39mvisible");
  prefixer.reset();
  assert.equal(prefixer.append("\bvisible"), "\b\x1b[2;90m[20:21:22] \x1b[22;39mvisible");
});

test("timestamps before a leading tab", () => {
  const prefixer = createTerminalOutputTimestampPrefixer({
    now: () => new Date(2026, 5, 6, 23, 24, 25),
  });

  assert.equal(prefixer.append("\tvisible"), "\x1b[2;90m[23:24:25] \x1b[22;39m\tvisible");
});

test("stripTerminalOutputTimestamps removes timestamp prefixes from each line", () => {
  assert.equal(
    stripTerminalOutputTimestamps("[09:08:07] hello"),
    "hello",
  );
  assert.equal(
    stripTerminalOutputTimestamps("[09:08:07] hello\n[10:11:12] world"),
    "hello\nworld",
  );
});

test("stripTerminalOutputTimestamps preserves non-timestamp lines", () => {
  assert.equal(
    stripTerminalOutputTimestamps("hello world"),
    "hello world",
  );
});

test("stripTerminalOutputTimestamps handles mixed content", () => {
  assert.equal(
    stripTerminalOutputTimestamps("[09:08:07] line one\nplain line\n[10:11:12] line three"),
    "line one\nplain line\nline three",
  );
});

test("stripTerminalOutputTimestamps does not strip in-line [HH:MM:SS] patterns", () => {
  assert.equal(
    stripTerminalOutputTimestamps("output at [09:08:07] and done"),
    "output at [09:08:07] and done",
  );
});
