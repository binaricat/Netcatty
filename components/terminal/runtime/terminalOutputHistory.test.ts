import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

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

test("preview rows flag lines committed by automatic wraps as soft-wrapped", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(5);
  // "abcde" fills the viewport and "f" wraps; the transcript commits both
  // lines, but the preview must keep the soft-wrapped join between them.
  history.append("abcdef\n");
  assert.deepEqual([...history.getLines()], ["abcde", "f"]);
  assert.deepEqual(
    history.getPreviewRows({ cols: 5, rows: 2, top: 0 }).rows.map((row) => row.isWrapped),
    [false, true],
  );
});

test("preview reflows adjacent soft-wrapped lines together when widened", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(5);
  // Captured at five columns, the transcript holds two wrap segments; a
  // ten-column preview must rejoin them into the single row xterm shows
  // after its resize reflow.
  history.append("abcdef\n");
  assert.deepEqual(
    history.getPreviewRows({ cols: 10, rows: 1, top: 0 }).rows.map((row) => row.text),
    ["abcdef"],
  );
  // A narrower preview keeps splitting the rejoined run, flagging the
  // continuation rows.
  assert.deepEqual(
    history.getPreviewRows({ cols: 3, rows: 2, top: 0 }).rows.map((row) => row.text),
    ["abc", "def"],
  );
  assert.deepEqual(
    history.getPreviewRows({ cols: 3, rows: 2, top: 0 }).rows.map((row) => row.isWrapped),
    [false, true],
  );
});

test("CUB moves from the displayed last column while a wrap is deferred", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(5);
  // "abcde" fills the row and defers the wrap; xterm displays the cursor on
  // the last column, so CUB 1 targets it minus one and X overwrites "e".
  history.append("abcde\x1b[DX");
  assert.deepEqual([...history.getLines()], ["abcXe"]);
  history.clear();
  // CUF from the same deferred state still clamps to the last column.
  history.append("abcde\x1b[CX");
  assert.deepEqual([...history.getLines()], ["abcdX"]);
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

test("wrap decisions measure with the live terminal's Unicode width provider", () => {
  // The configured `15-graphemes` runtime counts `🖥` as one xterm cell while
  // the local fallback counts two, so without the injected provider the
  // tracker commits `abcd` and puts `🖥X` on the continuation row while xterm
  // renders `abcd🖥` with `X` wrapped. The preview must match the terminal.
  const widthTerm = {
    _core: {
      unicodeService: { getStringCellWidth: (s: string) => [...s].length },
    },
  } as never;
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(5);
  history.setWidthTerminal(widthTerm);
  history.append("abcd🖥X");
  assert.deepEqual(history.getLines(), ["abcd🖥", "X"]);

  const preview = createTerminalOutputHistoryPreview();
  preview.setWidthTerminal(widthTerm);
  preview.append("abcd🖥X\n");
  assert.deepEqual(
    preview.getPreviewRows({ cols: 5, rows: 2, top: 0 }).rows.map((row) => row.text),
    ["abcd🖥", "X"],
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
  assert.deepEqual(history.getLines(), ['one', 'two', '   three', 'four', '    five']);
  history.clear();
  history.append('\x1b[Hnew\x1b[HNEW\x1b[K');
  assert.deepEqual(history.getLines(), ['NEW']);
});

test("row controls retain requested and inherited terminal columns", () => {
  const history = createTerminalOutputHistoryPreview();
  history.append('\x1b[2;10Htext\x1b[1Bnext\x1b[6dlast\x1b[1Eleft');
  assert.deepEqual(history.getLines(), ['         text', '             next', '                 last', 'left']);
  history.clear();
  history.append('\x9b2;3fAB\x1b[2;3HXY');
  assert.deepEqual(history.getLines(), ['  XY']);
});

test("positioned output respects wide-cell boundaries and retained size limits", () => {
  const history = createTerminalOutputHistoryPreview({ maxChars: 64 });
  history.append('\x1b[2;3H中文\x1b[2;5HX\x1b[K');
  assert.deepEqual(history.getLines(), ['  中X']);
  history.clear();
  history.append('\x1b[2;999999999Hend');
  assert.ok(history.getLines().join('').length <= 128);
  assert.ok(history.getLines().join('').endsWith('end'));
});

test("CHA and relative horizontal moves stay on the tracked row", () => {
  const history = createTerminalOutputHistoryPreview();
  history.append('abcde\x1b[1GX');
  assert.deepEqual(history.getLines(), ['Xbcde']);
  history.clear();
  history.append('ab\x1b[3CX');
  assert.deepEqual(history.getLines(), ['ab   X']);
  history.clear();
  history.append('abcde\x1b[2DX');
  assert.deepEqual(history.getLines(), ['abcXe']);
});

test("NEL and IND advance the row; RI moves back up", () => {
  const history = createTerminalOutputHistoryPreview();
  history.append('foo\x1bEbar');
  assert.deepEqual(history.getLines(), ['foo', 'bar']);
  history.clear();
  history.append('foo\x1bDbar');
  assert.deepEqual(history.getLines(), ['foo', '   bar']);
  history.clear();
  history.append('\x1b[r\x1b[3;1Hfoo\x1bMbar');
  assert.deepEqual(history.getLines(), ['foo', '   bar']);
  history.clear();
  history.append('\x1b[2;3r\x1b[2;1Hfoo\x1bMbar');
  assert.deepEqual(history.getLines(), ['foo', '   bar']);
});


test("cursor placement alone does not append blank history rows", () => {
  const history = createTerminalOutputHistoryPreview();
  history.append('abc\x1b[2;4H\x1b[1B\x1b[1B');
  assert.deepEqual(history.getLines(), ['abc']);
  history.append('X');
  assert.deepEqual(history.getLines(), ['abc', '   X']);
});

test("positioned overwrites replace whole graphemes and preserve cell spacing", () => {
  for (const glyph of ['😀', '👩‍💻', '中']) {
    const history = createTerminalOutputHistoryPreview();
    history.append(`A${glyph}B\x1b[1;2HX`);
    assert.deepEqual(history.getLines(), ['AX B']);
    history.clear();
    history.append(`A${glyph}B\x1b[1;3HX`);
    assert.deepEqual(history.getLines(), ['A XB']);
  }
  const history = createTerminalOutputHistoryPreview();
  history.append('AéB\x1b[1;2HX');
  assert.deepEqual(history.getLines(), ['AXB']);
});

test("EL 1 erases a wide glyph intersected by the erase boundary", () => {
  // The cursor lands on the wide glyph's first cell: xterm blanks both cells
  // and keeps the suffix at its columns.
  const history = createTerminalOutputHistoryPreview();
  history.append('中A\x1b[1G\x1b[1K');
  assert.deepEqual(history.getLines(), ['  A']);
  history.clear();
  // The cursor lands on the wide glyph's second cell: the glyph is erased too.
  history.append('A中B\x1b[1;3H\x1b[1K');
  assert.deepEqual(history.getLines(), ['   B']);
});

test("cursor-row moves clamp to the reported terminal viewport", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  // Bottom-row address + a down move past the viewport: the terminal keeps
  // the cursor on row 24, so the status redraw must not split history lines.
  history.append("\x1b[24;1Hstatus\x1b[1BNEW");
  assert.deepEqual(history.getLines(), ["statusNEW"]);
  history.clear();
  // Absolute rows beyond the viewport clamp to the bottom row too: the redraw
  // overwrites the bottom row in place instead of adding a history line.
  history.append("\x1b[24;1Hrow24\x1b[999;1Hredraw");
  assert.deepEqual(history.getLines(), ["redraw"]);
  history.clear();
  // Without a reported viewport the legacy behavior applies (columns are
  // retained across row moves).
  const unclamped = createTerminalOutputHistoryPreview();
  unclamped.append("\x1b[24;1Hstatus\x1b[1BNEW");
  assert.deepEqual(unclamped.getLines(), ["status", "      NEW"]);
});

test("absolute cursor columns clamp to the reported viewport width", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(80);
  // CUP past the last column clamps to it on screen; without the clamp the
  // preview would pad 998 spaces and fabricate wrapped rows.
  history.append("\x1b[1;999HX");
  assert.deepEqual(history.getLines(), [" ".repeat(79) + "X"]);
});

test("line feeds on the bottom row stay clamped to it", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.append("\x1b[24;1Hstatus\r\nnew\x1b[24;1HNEW");
  assert.deepEqual(history.getLines(), ["status", "NEW"]);
});

test("shrinking the viewport clamps the tracked cursor row", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.append("\x1b[24;1Hbottom");
  history.setViewportRows(10);
  // The terminal moved the cursor to the new bottom row, so a relative move
  // from there must stay a same-row redraw instead of committing a line.
  history.append("\x1b[1BX");
  assert.deepEqual(history.getLines(), ["bottomX"]);
});

test("relative row moves stop at the scroll region's bottom margin", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.append("\x1b[1;20r\x1b[20;1Hstatus\x1b[1BNEW");
  assert.deepEqual(history.getLines(), ["statusNEW"]);
});

test("invalid DECSTBM ranges are ignored", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  // Bottom not greater than top: xterm ignores the sequence, so the existing
  // text must stay on its row and later text must not home the cursor.
  history.append("\x1b[5;1Hbefore\x1b[20;10rafter");
  assert.deepEqual(history.getLines(), ["beforeafter"]);
  history.clear();
  // A top past the viewport clamps to it, leaving no valid region either.
  history.append("\x1b[5;1Hbefore\x1b[30;40rafter");
  assert.deepEqual(history.getLines(), ["beforeafter"]);
  history.clear();
  // A bottom past the viewport clamps to it; the valid region still applies.
  history.append("\x1b[1;999r\x1b[24;1Hstatus\x1b[999BNEW");
  assert.deepEqual(history.getLines(), ["statusNEW"]);
});

test("growing the viewport resets the scroll margins", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.append("\x1b[1;24r");
  history.setViewportRows(40);
  // xterm resets the scroll region on resize, so a relative move past row 24
  // reaches row 25 instead of stopping at the stale bottom margin.
  history.append("\x1b[24;1Hrow24\x1b[1Brow25");
  assert.deepEqual(history.getLines(), ["row24", "     row25"]);
});

test("clear resets retained scroll margins between terminal boots", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.append("\x1b[1;20robsolete");
  history.clear();
  // The fresh xterm instance has a full-viewport region; the new session must
  // not inherit the previous boot's bottom margin.
  history.setViewportRows(24);
  history.append("\x1b[20;1Hrow20\x1b[1Brow21");
  assert.deepEqual(history.getLines(), ["row20", "     row21"]);
});

test("narrowing the viewport clamps the tracked cursor column", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(80);
  history.append("\x1b[1;80H");
  history.setViewportCols(10);
  // xterm clamps the cursor to the new last column; the next printable span
  // must be written there, not padded out to the old column 80.
  history.append("X");
  assert.deepEqual(history.getLines(), [" ".repeat(9) + "X"]);
});

test("narrowing the viewport trims the tracked cursor row like xterm", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(10);
  history.append("abcdefgh");
  history.setViewportCols(5);
  // xterm trims the cursor row to the new width on a narrowing resize
  // (`reflowCursorLine` defaults to false, so `fgh` is discarded instead of
  // re-wrapped), so X overwrites the last retained cell rather than leaving
  // a phantom `fgh` tail plus an extra wrapped preview row.
  history.append("X");
  assert.deepEqual(history.getLines(), ["abcdX"]);
  assert.deepEqual(
    history.getPreviewRows({ cols: 5, rows: 1, top: 0 }).rows.map((row) => row.text),
    ["abcdX"],
  );
});

test("narrowing the viewport drops the trimmed wide-glyph tail", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(6);
  history.append("中文");
  history.setViewportCols(3);
  // The second glyph spans cells 2-3 past the new width; xterm discards it
  // whole, so the open row keeps only the glyph that still fits and the next
  // printable span lands on the new last column.
  assert.deepEqual(history.getLines(), ["中"]);
  history.append("X");
  assert.deepEqual(history.getLines(), ["中X"]);
});

test("printable output past the viewport width wraps the tracked cursor", () => {
  // xterm wraps `f` onto the second row, so `CSI 2;1H` overwrites it there
  // instead of adding a separate line below a stale wrapped row.
  const input = "abcdef\x1b[2;1HXY";
  for (let split = 0; split <= input.length; split++) {
    const history = createTerminalOutputHistoryPreview();
    history.setViewportRows(24);
    history.setViewportCols(5);
    history.append(input.slice(0, split));
    history.append(input.slice(split));
    assert.deepEqual(history.getLines(), ["abcde", "XY"]);
  }
});

test("a carriage return cancels the deferred wrap instead of splitting the row", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(5);
  history.append("abcde\rXYZ");
  assert.deepEqual(history.getLines(), ["XYZde"]);
});

test("wide glyphs wrap whole at the viewport width", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(4);
  history.append("中文中文中文\n");
  assert.deepEqual(history.getLines(), ["中文", "中文", "中文"]);
});

test("origin mode resolves absolute rows against the scroll region", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  // In origin mode both addresses target row 20 (top margin + 15, then the
  // bottom-margin clamp), so the redraw overwrites `status` in place instead
  // of retaining it as a stale separate line.
  history.append("\x1b[5;20r\x1b[?6h\x1b[16;1Hstatus\x1b[99;1HNEW");
  assert.deepEqual(history.getLines(), ["NEWtus"]);
  history.clear();
  // clear() forgets origin mode: rows are absolute again.
  history.setViewportRows(24);
  history.append("\x1b[5;20r\x1b[?6h\x1b[?6l\x1b[5;1Habsolute");
  assert.deepEqual(history.getLines(), ["absolute"]);
});

test("non-wrapping wide glyph at the right edge cannot block terminal capture", () => {
  const moduleUrl = new URL("./terminalOutputHistory.ts", import.meta.url).href;
  const script = `
    import { createTerminalOutputHistoryPreview } from ${JSON.stringify(moduleUrl)};
    const results = [];
    for (const glyph of ["中", "👩‍💻", "界界"]) {
      const history = createTerminalOutputHistoryPreview();
      history.setViewportRows(24);
      history.setViewportCols(5);
      history.append(String.fromCharCode(27) + "[?7labcd" + glyph + "Z");
      results.push(history.getLines());
    }
    console.log(JSON.stringify(results));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [["abcdZ"], ["abcdZ"], ["abcdZ"]]);
});

test("unchanged viewport reports preserve pending wrap across display chunks", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(5);
  history.append("abcde");
  history.setViewportRows(24);
  history.setViewportCols(5);
  history.append("f");
  assert.deepEqual(history.getLines(), ["abcde", "f"]);
});

test("a zero-width mark arriving after the wrap column joins the final cell", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(5);
  // The base character fills the last column; its combining mark arrives in
  // the next chunk. xterm attaches the mark to that cell without wrapping.
  history.append("abcde");
  history.append("́Z\n");
  assert.deepEqual([...history.getLines()], ["abcdé", "Z"]);
});

test("a standalone zero-width mark after a control starts the wrapped row", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(5);
  // The SGR control xterm parses resets its preceding-join state, so the
  // combining mark that follows is a standalone grapheme: it must not attach
  // to the previous row's final cell; the pending wrap happens and the mark
  // begins the next row (like xterm's `15-graphemes` runtime).
  history.append("abcde\x1b[31m");
  history.append("́Z\n");
  assert.deepEqual([...history.getLines()], ["abcde", "́Z"]);
  // The same holds when the control rides inside one display chunk.
  history.clear();
  history.setViewportRows(24);
  history.setViewportCols(5);
  history.append("abcde\x1b[31ḿZ\n");
  assert.deepEqual([...history.getLines()], ["abcde", "́Z"]);
});

test("combined private-mode controls apply every parameter", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(5);
  // `CSI ?6;7l` resets both origin mode and DECAWM in one control; dropping
  // the control whole would leave autowrap on and wrap the overflow into a
  // second row (xterm keeps `abcdef` on one row as `abcdf`).
  history.append("\x1b[5;20r\x1b[?6;7l\x1b[5;1Habcdef");
  assert.deepEqual(history.getLines(), ["abcdf"]);
  // `CSI ?6;7h` re-enables both: absolute rows clamp to the margins again and
  // printable output wraps once more.
  history.append("\x1b[?6;7h\x1b[99;1HNEW");
  assert.deepEqual(history.getLines(), ["abcdf", "NEW"]);
  // Unrelated parameters ride along: xterm applies both `CSI ?6;25h` params
  // (25 is DECTCEM, untracked here), so dropping the control whole would
  // resolve the later CUP row absolutely instead of against the top margin.
  const combined = createTerminalOutputHistoryPreview();
  combined.setViewportRows(24);
  combined.append("\x1b[5;20r\x1b[?6;25h\x1b[16;1Hstatus\x1b[99;1HOLD");
  assert.deepEqual(combined.getLines(), ["OLDtus"]);
});

test("a grapheme longer than the per-row piece cap is not dropped", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(5);
  // One base character trailed by more combining marks than the piece cap
  // holds: cutting at a grapheme boundary yields an empty slice for it, and
  // returning early would silently drop this grapheme and everything after.
  const mark = "́";
  history.append("abcd" + "e" + mark.repeat(80) + "Z");
  assert.deepEqual(history.getLines(), ["abcde" + mark.repeat(80), "Z"]);
});

test("discarding a non-fitting wide glyph does not re-pad the deferred gap", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(5);
  // Cursor on the last column, DECAWM off: the wide glyph is discarded and the
  // next narrow character overwrites the last cell without padding it again.
  history.append("\x1b[?7l\x1b[1;5H中Z");
  assert.deepEqual(history.getLines(), ["    Z"]);
});

test("restoring a cursor saved above a shrunken viewport clamps to the bottom row", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.append("\x1b[24;1Hsaved\x1b7");
  history.setViewportRows(10);
  history.append("\x1b8X");
  // The saved row 24 no longer exists; the restore lands on the bottom row so
  // the later bottom-row address writes `Y` on the same line as `X` instead of
  // keeping an obsolete extra line (the saved column is preserved).
  history.append("\x1b[10;1HY");
  assert.deepEqual(history.getLines(), ["saved", "Y    X"]);
});

test("RIS resets the tracked modes, margins, and cursor", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(5);
  // DECAWM off, then RIS: xterm re-enables autowrap and homes the cursor, so
  // `abcdef` wraps to `abcde`/`f` exactly like a fresh terminal.
  history.append("\x1b[?7l\x1bcabcdef");
  assert.deepEqual(history.getLines(), ["abcde", "f"]);

  // RIS also clears the scroll region, DECOM, and the saved cursor.
  const reset = createTerminalOutputHistoryPreview();
  reset.setViewportRows(24);
  reset.append("\x1b[5;20r\x1b[?6h\x1b7\x1bc\x1b[99;1HOLD");
  // Without the reset, the CUP row would be relative to the top margin and
  // clamp to its bottom (row 20), rewriting the same tracked line as before.
  assert.deepEqual(reset.getLines(), ["OLD"]);
});

test("RIS commits the open row even when the cursor is already homed", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(20);
  // xterm clears the display before homing the cursor, so output after RIS
  // must not overwrite a stale suffix of the cleared screen row.
  history.append("LONG\x1bcX");
  assert.deepEqual(history.getLines(), ["LONG", "X"]);
});

test("a grapheme split across display chunks is rejoined", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(5);
  history.setViewportCols(4);
  // The backend delivered the ZWJ sequence's base in one chunk and its
  // continuation in the next; xterm's grapheme provider joins them across
  // writes, so the preview must measure the joined cluster, not the chunks.
  history.append("👩");
  history.append("‍💻Z");
  assert.deepEqual(history.getLines(), ["👩‍💻Z"]);

  // The unsplit input is the reference behavior.
  const joined = createTerminalOutputHistoryPreview();
  joined.setViewportRows(5);
  joined.setViewportCols(4);
  joined.append("👩‍💻Z");
  assert.deepEqual(joined.getLines(), ["👩‍💻Z"]);
});

test("a control between chunks resets the split-grapheme join", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(5);
  history.setViewportCols(5);
  // xterm resets its preceding-join state at every control it parses, so an
  // SGR between the base chunk and the continuation leaves two graphemes:
  // 👩 (2 cells) + ‍💻 (2 cells) + Z fill the row before Q wraps.
  history.append("👩");
  history.append("\x1b[31m");
  history.append("‍💻ZQ");
  assert.deepEqual(history.getLines(), ["👩‍💻Z", "Q"]);

  // The unsplit input with the same control is the reference behavior.
  const joined = createTerminalOutputHistoryPreview();
  joined.setViewportRows(5);
  joined.setViewportCols(5);
  joined.append("👩\x1b[31m‍💻ZQ");
  assert.deepEqual(joined.getLines(), ["👩‍💻Z", "Q"]);
});

test("a width-only resize resets the tracked scroll margins", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(80);
  history.append("\x1b[1;20r");
  history.append("row20content");
  // xterm resets its scroll region on any buffer resize; a width-only resize
  // must clear the old DECSTBM margins so relative moves clamp to the live
  // bottom row instead of the region's stale one.
  history.setViewportRows(24);
  history.setViewportCols(40);
  history.append("\x1b[20;1HX\x1b[BY");
  assert.deepEqual(history.getLines(), ["row20content", "X", " Y"]);
});


test("preview reflow retains leading, consecutive and trailing blank hard lines", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportCols(5);
  history.append("\nabcdef\n\n\nend\n\n");
  assert.deepEqual([...history.getLines()], ["", "abcde", "f", "", "", "end", ""]);
  const preview = history.getPreviewRows({ cols: 10, rows: 6, top: 0 });
  assert.equal(preview.totalRows, 6);
  assert.deepEqual(preview.rows.map((row) => row.text), ["", "abcdef", "", "", "end", ""]);
});

test("blank-only history remains distinct from empty history", () => {
  const history = createTerminalOutputHistoryPreview();
  assert.equal(history.getPreviewRowCount(10), 0);
  history.append("\n\n");
  assert.equal(history.getPreviewRowCount(10), 2);
});

test("reflow keeps an erase-blanked wrapped predecessor as its own row", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(5);
  // At five columns `abcde` fills row one and defers the wrap; `CSI 2K`
  // blanks it and `X` wraps to row two, so xterm shows a blank first row and
  // a wrapped `X` on the second. The preview must keep both rows instead of
  // joining the erased predecessor into its continuation.
  history.append("abcde\x1b[2KX");
  assert.deepEqual([...history.getLines()], ["", "X"]);
  const preview = history.getPreviewRows({ cols: 5, rows: 2, top: 0 });
  assert.equal(preview.totalRows, 2);
  assert.deepEqual(preview.rows.map((row) => row.text), ["", "X"]);
  assert.deepEqual(preview.rows.map((row) => row.isWrapped), [false, true]);
});

test("a grapheme wider than the viewport wraps the following characters", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(1);
  // xterm renders the wide glyph on the first row and wraps `X` to the
  // second; retaining the whole tail as one row would shift every later
  // cursor-row transition one row behind the terminal.
  history.append("中X");
  assert.deepEqual([...history.getLines()], ["中", "X"]);
});


test("resizing invalidates cached preview text even when returning to its old width", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(10);
  history.append("abcdefgh");
  assert.deepEqual(history.getPreviewRows({ cols: 10, rows: 1, top: 0 }).rows,
    [{ text: "abcdefgh", isWrapped: false }]);
  // A hidden preview is not read between these resizes. Returning to the
  // cached width must not resurrect characters trimmed from the live row.
  history.setViewportCols(5);
  history.setViewportCols(10);
  assert.deepEqual(history.getLines(), ["abcde"]);
  assert.deepEqual(history.getPreviewRows({ cols: 10, rows: 1, top: 0 }).rows,
    [{ text: "abcde", isWrapped: false }]);
});

test("resizing invalidates cached preview row counts after trimming a wide line", () => {
  const history = createTerminalOutputHistoryPreview();
  history.setViewportRows(24);
  history.setViewportCols(10);
  history.append("abcdefgh");
  assert.equal(history.getPreviewRowCount(4), 2);
  history.setViewportCols(3);
  assert.equal(history.getPreviewRowCount(4), 1);
  assert.deepEqual(history.getPreviewRows({ cols: 4, rows: 1, top: 0 }).rows,
    [{ text: "abc", isWrapped: false }]);
});
