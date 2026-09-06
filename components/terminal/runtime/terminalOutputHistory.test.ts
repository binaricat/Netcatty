import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OUTPUT_HISTORY_MAX_LINES,
  createTerminalOutputHistoryPreview,
  nextOutputHistoryPreviewTop,
  stripTerminalDisplayToPlainText,
  wrapOutputHistoryLineToRows,
} from "./terminalOutputHistory.ts";

test("display chunks reduce to plain transcript text", () => {
  assert.deepEqual(
    stripTerminalDisplayToPlainText("\x1b[32mhello\x1b[0m world\r\n"),
    { text: "hello world\r\n", pending: "" },
  );
  assert.equal(
    stripTerminalDisplayToPlainText("\x1b]0;title\x07tail").text,
    "tail",
  );
  assert.equal(
    stripTerminalDisplayToPlainText("\x1b]0;title\x1b\\tail").text,
    "tail",
  );
  assert.equal(stripTerminalDisplayToPlainText("a\x07b\x00c").text, "abc");
});

test("escape sequences split across chunks are not leaked into the transcript", () => {
  const first = stripTerminalDisplayToPlainText("ok\x1b[3");
  assert.equal(first.text, "ok");
  assert.equal(first.pending, "\x1b[3");

  const second = stripTerminalDisplayToPlainText("1mred", first.pending);
  assert.equal(second.text, "red");
  assert.equal(second.pending, "");
});

test("escape sequences with intermediate bytes are consumed through their final byte", () => {
  // ESC ( B designates G0 (ncurses / terminal reset emit it constantly).
  assert.equal(stripTerminalDisplayToPlainText("\x1b(Bplain").text, "plain");
  // ESC # 8 is DECALN.
  assert.equal(stripTerminalDisplayToPlainText("\x1b#8plain").text, "plain");
  // Two-byte escapes without intermediates keep working.
  assert.equal(stripTerminalDisplayToPlainText("\x1bMplain").text, "plain");

  const first = stripTerminalDisplayToPlainText("ok\x1b(");
  assert.equal(first.text, "ok");
  assert.equal(first.pending, "\x1b(");
  assert.equal(stripTerminalDisplayToPlainText("Btail", first.pending).text, "tail");
});

test("a cursor-addressed frame without newlines stays inside the character budget", () => {
  const history = createTerminalOutputHistoryPreview({ maxChars: 64 });
  for (let frame = 0; frame < 200; frame += 1) {
    history.append(`\x1b[Hframe ${frame} ${"x".repeat(80)}`);
  }

  const transcript = [...history.getLines()].join("");
  assert.ok(transcript.length <= 2 * 64, `unbounded open line: ${transcript.length}`);
  // The newest frame still lands in the retained tail.
  assert.ok(transcript.includes("frame 199"), transcript.slice(-200));
});

test("8-bit control strings are consumed through their terminator", () => {
  // C1 OSC (0x9d) with C1 ST (0x9c) must not leak its payload.
  assert.equal(stripTerminalDisplayToPlainText("\x9d0;SECRET\x9ctail").text, "tail");
  // DCS (0x90), SOS (0x98), PM (0x9e) and APC (0x9f) use the same terminator.
  assert.equal(stripTerminalDisplayToPlainText("\x90payload\x9ctail").text, "tail");
  assert.equal(stripTerminalDisplayToPlainText("\x98payload\x9ctail").text, "tail");
  assert.equal(stripTerminalDisplayToPlainText("\x9epayload\x9ctail").text, "tail");
  assert.equal(stripTerminalDisplayToPlainText("\x9fpayload\x9ctail").text, "tail");

  const first = stripTerminalDisplayToPlainText("ok\x9d0;title");
  assert.equal(first.text, "ok");
  assert.equal(first.pending, "\x9d0;title");
  assert.equal(stripTerminalDisplayToPlainText("\x9ctail", first.pending).text, "tail");
});

test("tabs expand to terminal tab stops so preview rows wrap as they render", () => {
  const history = createTerminalOutputHistoryPreview();
  history.append("a\tb\n");
  history.append("abc\td\n");
  assert.deepEqual([...history.getLines()], ["a       b", "abc     d"]);
});

test("tab stops advance by cell columns, not characters", () => {
  const history = createTerminalOutputHistoryPreview();
  history.append("中\tb\n");
  assert.deepEqual([...history.getLines()], ["中      b"]);
});

test("an oversized control string split across chunks leaks no payload", () => {
  const payload = "y".repeat(5000);
  const first = stripTerminalDisplayToPlainText(`ok\x1b]52;c;${payload}`);
  assert.equal(first.text, "ok");
  assert.equal(first.pending.length, 4096);
  assert.equal(first.pending.startsWith("\x1b]"), true);

  const second = stripTerminalDisplayToPlainText("\x07tail", first.pending);
  assert.equal(second.text, "tail");
});

test("a span longer than the remaining budget continues into the next line", () => {
  const history = createTerminalOutputHistoryPreview({ maxChars: 16 });
  history.append("aaaaaaaaaaaaaaaaTTTTTTTT\n");
  assert.ok([...history.getLines()].join("").includes("TTTTTTTT"));
});

test("erase-in-line after a carriage return drops the stale suffix", () => {
  const history = createTerminalOutputHistoryPreview();
  history.append("downloading 100%\rdownloading 5%\x1b[K\n");
  assert.deepEqual([...history.getLines()], ["downloading 5%"]);

  history.clear();
  history.append("keep\r\x1b[2Knew\n");
  assert.deepEqual([...history.getLines()], ["new"]);
});

test("clear resets the tab stop column with the rest of the line state", () => {
  const history = createTerminalOutputHistoryPreview();
  history.append("abc");
  history.clear();
  history.append("\tb\n");
  assert.deepEqual([...history.getLines()], ["        b"]);
});

test("bare carriage returns overwrite the line they restart", () => {
  const history = createTerminalOutputHistoryPreview();
  history.append("downloading 10%\r");
  history.append("downloading 55%\r");
  history.append("downloading 100%\r\n");
  history.append("done\n");
  assert.deepEqual([...history.getLines()], ["downloading 100%", "done"]);
});

test("history keeps a bounded tail of lines", () => {
  const history = createTerminalOutputHistoryPreview({ maxLines: 3 });
  for (let index = 0; index < 6; index += 1) history.append(`line ${index}\n`);
  assert.deepEqual(
    [...history.getLines()],
    ["line 3", "line 4", "line 5"],
  );
});

test("preview rows wrap long lines and flag the continuation rows", () => {
  const history = createTerminalOutputHistoryPreview();
  history.append("ok\n");
  history.append("abcdefgh\n");

  const window = history.getPreviewRows({ cols: 4, rows: 3, top: 0 });
  assert.equal(window.totalRows, 3);
  assert.deepEqual(
    window.rows.map((row) => row.text),
    ["ok", "abcd", "efgh"],
  );
  assert.deepEqual(
    window.rows.map((row) => row.isWrapped),
    [false, false, true],
  );
});

test("preview windows clamp to the retained rows and pad short output", () => {
  const history = createTerminalOutputHistoryPreview();
  history.append("one\ntwo\n");

  assert.deepEqual(
    history.getPreviewRows({ cols: 10, rows: 2, top: 99 }).rows.map((row) => row.text),
    ["one", "two"],
  );
  assert.deepEqual(
    history.getPreviewRows({ cols: 10, rows: 4, top: 0 }).rows.map((row) => row.text),
    ["one", "two", "", ""],
  );
});

test("preview rows keep wide characters intact at a column boundary", () => {
  // Four columns hold two CJK cells per row; the glyphs are never split.
  assert.deepEqual(wrapOutputHistoryLineToRows("中文中文中文", 4), ["中文", "中文", "中文"]);
  const history = createTerminalOutputHistoryPreview();
  history.append("中文中文中文\n");
  assert.deepEqual(
    history.getPreviewRows({ cols: 4, rows: 3, top: 0 }).rows.map((row) => row.text),
    ["中文", "中文", "中文"],
  );
});

test("wheel steps walk the preview from the newest row upwards", () => {
  const history = createTerminalOutputHistoryPreview();
  for (let index = 0; index < 6; index += 1) history.append(`row ${index}\n`);

  const totalRows = history.getPreviewRows({ cols: 20, rows: 2, top: 0 }).totalRows;
  assert.equal(totalRows, 6);

  const bottom = nextOutputHistoryPreviewTop({
    currentTop: null,
    lines: 0,
    rows: 2,
    totalRows,
  });
  assert.equal(bottom, 4);
  assert.deepEqual(
    history.getPreviewRows({ cols: 20, rows: 2, top: bottom }).rows.map((row) => row.text),
    ["row 4", "row 5"],
  );

  const up = nextOutputHistoryPreviewTop({ currentTop: bottom, lines: -3, rows: 2, totalRows });
  assert.equal(up, 1);
  const top = nextOutputHistoryPreviewTop({ currentTop: up, lines: -30, rows: 2, totalRows });
  assert.equal(top, 0);
});

test("clear drops retained transcript and pending escapes", () => {
  const history = createTerminalOutputHistoryPreview();
  history.append(`keep\n`);
  history.clear();
  history.append("\x1b[3");
  assert.deepEqual([...history.getLines()], []);
  assert.equal(
    history.getPreviewRows({ cols: 10, rows: 2, top: 0 }).totalRows,
    0,
  );
});

test("default retention bounds the preview history", () => {
  assert.equal(DEFAULT_OUTPUT_HISTORY_MAX_LINES > 0, true);

  const history = createTerminalOutputHistoryPreview({ maxLines: 2, maxChars: 6 });
  history.append("aaaaaaaa\n");
  history.append("bbbbbbbb\n");
  history.append("cccccccc\n");
  // Retained lines plus the open line stay within twice the character budget,
  // and the newest text survives.
  const transcript = [...history.getLines()].join("");
  assert.ok(transcript.length <= 2 * 6, transcript);
  assert.ok(transcript.includes("cc"), transcript);
});
test("Vim absolute row moves separate printed rows across arbitrary chunks", () => {
  const input = '\x1b[2;1HSMOKE-VIM-002\x1b[2;14H\x1b[K\x1b[3;1HSMOKE-VIM-003\x1b[3;14H\x1b[K\x1b[4;1HSMOKE-VIM-004';
  for (let split = 0; split <= input.length; split++) {
    const history = createTerminalOutputHistoryPreview();
    history.append(input.slice(0, split));
    history.append(input.slice(split));
    assert.deepEqual(history.getLines(), ['SMOKE-VIM-002', 'SMOKE-VIM-003', 'SMOKE-VIM-004']);
  }
});

test("same-row cursor-home redraw stays one progress line", () => {
  const history = createTerminalOutputHistoryPreview();
  for (let i = 0; i < 100; i++) history.append(`\x1b[1;1Hprogress ${i}\x1b[K`);
  assert.deepEqual(history.getLines(), ['progress 99']);
});

test("vertical moves do not insert blank transcript rows or expose control strings", () => {
  const history = createTerminalOutputHistoryPreview();
  history.append('one\r\n\x1b[2;1Htwo\x1b[1Bthree\x9b4;1Hfour');
  history.append('\x1b]titleH\x07\x1b[999999999Bfive');
  assert.deepEqual(history.getLines(), ['one', 'two', 'three', 'four', 'five']);
  history.clear();
  history.append('\x1b[Hnew\x1b[HNEW\x1b[K');
  assert.deepEqual(history.getLines(), ['NEW']);
});
