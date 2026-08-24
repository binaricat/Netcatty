import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { Terminal as XTermType } from "@xterm/xterm";
import {
  getNormalizedTerminalSelection,
  getTerminalSelectionForClipboard,
  joinSoftWrappedRows,
  trimWrittenPadding,
  type SelectionBufferLine,
  type SelectionTerminal,
} from "./normalizeTerminalSelection.ts";

const require = createRequire(import.meta.url);
const { Terminal: XTerm } = require("@xterm/xterm") as {
  Terminal: typeof XTermType;
};

/**
 * Fake line that matches real xterm translateToString(true) semantics:
 * trimRight only drops *empty* cells (trailing chars that were never written),
 * not written ASCII spaces used as display padding.
 */
function makeLine(
  text: string,
  options: {
    isWrapped?: boolean;
    emptyCells?: number;
    cellWidths?: number[];
    /**
     * Model xterm.js 6 string-cache: a no-endColumn translateToString(true)
     * drops written trailing spaces via String.trimEnd().
     */
    canonicalTrimEnd?: boolean;
  } = {},
): SelectionBufferLine {
  const emptyCells = options.emptyCells ?? 0;
  // Optional per-character terminal widths (default 1). Used to model CJK.
  const widths = options.cellWidths ?? Array.from(text, () => 1);
  let colLength = 0;
  for (let i = 0; i < text.length; i += 1) {
    colLength += widths[i] ?? 1;
  }
  const fullCols = colLength + emptyCells;
  // Map each terminal column to a char (wide chars occupy two cols; second is spacer).
  const cols: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const w = widths[i] ?? 1;
    cols.push(ch);
    for (let extra = 1; extra < w; extra += 1) {
      cols.push(""); // wide-char continuation column
    }
  }
  while (cols.length < fullCols) {
    cols.push("\0");
  }
  return {
    isWrapped: options.isWrapped ?? false,
    length: fullCols,
    getCell(x: number) {
      if (x < 0 || x >= cols.length) return undefined;
      const cell = cols[x];
      if (cell === "\0" || cell === undefined) {
        return { getChars: () => "", getCode: () => 0, getWidth: () => 1 };
      }
      if (cell === "") {
        // Wide-character continuation column.
        return { getChars: () => "", getCode: () => 0, getWidth: () => 0 };
      }
      const width = cell === "中" || /[\u3400-\u9fff]/u.test(cell) ? 2 : 1;
      return {
        getChars: () => cell,
        getCode: () => cell.codePointAt(0) ?? 0,
        getWidth: () => width,
      };
    },
    translateToString(trimRight = false, startColumn = 0, endColumn?: number) {
      const endSpecified = arguments.length >= 3;
      let end = Math.max(startColumn, Math.min(endColumn ?? fullCols, fullCols));
      if (trimRight) {
        while (end > startColumn && (cols[end - 1] === "\0" || cols[end - 1] === "")) {
          end -= 1;
        }
      }
      let result = "";
      for (let c = Math.max(0, startColumn); c < end; c += 1) {
        const cell = cols[c];
        if (cell && cell !== "\0") result += cell;
      }
      if (trimRight && options.canonicalTrimEnd && !endSpecified) {
        return result.trimEnd();
      }
      return result;
    },
  };
}

function makeTerm(
  lines: Array<{
    text: string;
    isWrapped?: boolean;
    emptyCells?: number;
    cellWidths?: number[];
    canonicalTrimEnd?: boolean;
  }>,
  range: { start: { x: number; y: number }; end: { x: number; y: number } } | null,
  options: {
    rawSelection?: string;
    columnSelect?: boolean;
  } = {},
): SelectionTerminal {
  const bufferLines = lines.map((line) =>
    makeLine(line.text, {
      isWrapped: line.isWrapped,
      emptyCells: line.emptyCells,
      cellWidths: line.cellWidths,
      canonicalTrimEnd: line.canonicalTrimEnd,
    }),
  );
  return {
    getSelection: () => options.rawSelection ?? "",
    getSelectionPosition: () => range,
    buffer: {
      active: {
        getLine: (y) => bufferLines[y],
      },
    },
    _core: options.columnSelect
      ? { _selectionService: { _activeSelectionMode: 3 } }
      : { _selectionService: { _activeSelectionMode: 0 } },
  };
}

test("trimWrittenPadding removes written trailing spaces but keeps internal ones", () => {
  assert.equal(trimWrittenPadding("hello   "), "hello");
  assert.equal(trimWrittenPadding("  hello  world  "), "  hello  world");
});

test("joinSoftWrappedRows keeps a single trailing space as a word separator", () => {
  assert.equal(joinSoftWrappedRows("hello ", "world"), "hello world");
});

test("joinSoftWrappedRows concatenates mid-word wraps tightly", () => {
  assert.equal(joinSoftWrappedRows("hel", "lo world"), "hello world");
});

test("joinSoftWrappedRows does not invent spaces inside URL/path tokens", () => {
  assert.equal(
    joinSoftWrappedRows("https://example.com/very/long/   ", "path"),
    "https://example.com/very/long/path",
  );
});

test("joinSoftWrappedRows does not invent spaces before CJK punctuation", () => {
  assert.equal(joinSoftWrappedRows("你好   ", "，世界"), "你好，世界");
});

test("joinSoftWrappedRows collapses multi-space prose padding to one space", () => {
  // Pi/TUI word-wrapped prose: padding between words must not glue them.
  assert.equal(joinSoftWrappedRows("the most   ", "reliable"), "the most reliable");
  assert.equal(joinSoftWrappedRows("shifts   ", "across"), "shifts across");
});

test("joinSoftWrappedRows does not invent spaces between CJK characters", () => {
  assert.equal(joinSoftWrappedRows("最   ", "稳"), "最稳");
  // Single pad cell must not bypass the CJK check.
  assert.equal(joinSoftWrappedRows("最 ", "稳"), "最稳");
  assert.equal(joinSoftWrappedRows("한   ", "글"), "한글");
  assert.equal(joinSoftWrappedRows("你好。   ", "世界"), "你好。世界");
});

test("joinSoftWrappedRows keeps a space after sentence-ending punctuation", () => {
  assert.equal(
    joinSoftWrappedRows("First sentence.   ", "Next sentence"),
    "First sentence. Next sentence",
  );
});

test("joinSoftWrappedRows only uses the trailing token for URL detection", () => {
  assert.equal(
    joinSoftWrappedRows("See https://x.test for more   ", "details"),
    "See https://x.test for more details",
  );
  // Single trailing space after a URL is a real word separator.
  assert.equal(
    joinSoftWrappedRows("See https://example.com ", "today"),
    "See https://example.com today",
  );
});

test("joinSoftWrappedRows keeps path separators attached across wraps", () => {
  assert.equal(
    joinSoftWrappedRows("https://example.com/very/long/   ", "path"),
    "https://example.com/very/long/path",
  );
  // Complete URL + padding + next word stays two words (not mid-token glue).
  assert.equal(
    joinSoftWrappedRows("See https://example.com   ", "today"),
    "See https://example.com today",
  );
});

test("joinSoftWrappedRows preserves Windows paths and URL query delimiters", () => {
  assert.equal(
    joinSoftWrappedRows("C:\\Users\\alice\\   ", "file.txt"),
    "C:\\Users\\alice\\file.txt",
  );
  assert.equal(
    joinSoftWrappedRows("https://example.com/path   ", "?q=netcatty"),
    "https://example.com/path?q=netcatty",
  );
  assert.equal(
    joinSoftWrappedRows("https://example.com/search?   ", "q=netcatty"),
    "https://example.com/search?q=netcatty",
  );
});

test("joinSoftWrappedRows keeps sentence break after a URL", () => {
  assert.equal(
    joinSoftWrappedRows("See https://example.com.   ", "Next sentence"),
    "See https://example.com. Next sentence",
  );
});

test("joinSoftWrappedRows keeps hyphenated words intact at the hyphen", () => {
  assert.equal(joinSoftWrappedRows("state-   ", "of-the-art"), "state-of-the-art");
  // Complete flag + next word keeps a boundary.
  assert.equal(joinSoftWrappedRows("Use --verbose   ", "to inspect"), "Use --verbose to inspect");
});

test("preserves partial trailing spaces after wide characters using column ends", () => {
  // "中  X" with 中 width 2 → columns: [中][ ][ ][ ][X] roughly.
  // Select through the spaces after 中 but before X.
  const term = makeTerm(
    [{ text: "中  X", cellWidths: [2, 1, 1, 1] }],
    { start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
  );
  // end.x=4 is before content end column of X; keep selected spaces.
  assert.equal(getNormalizedTerminalSelection(term), "中  ");
});

test("joins soft-wrapped rows and collapses prose padding to one space", () => {
  const term = makeTerm(
    [
      { text: "Pi: use /copy is the most   " },
      { text: "reliable option             ", isWrapped: true },
      { text: "next hard line              " },
    ],
    { start: { x: 0, y: 0 }, end: { x: 28, y: 2 } },
  );

  assert.equal(
    getNormalizedTerminalSelection(term),
    "Pi: use /copy is the most reliable option\nnext hard line",
  );
});

test("keeps a single trailing space as a word-boundary soft wrap", () => {
  const term = makeTerm(
    [
      { text: "hello " },
      { text: "world   ", isWrapped: true },
    ],
    { start: { x: 0, y: 0 }, end: { x: 8, y: 1 } },
  );
  assert.equal(getNormalizedTerminalSelection(term), "hello world");
});

test("preserves hard line breaks between non-wrapped rows while trimming padding", () => {
  const term = makeTerm(
    [
      { text: "line one   " },
      { text: "line two   " },
      { text: "line three " },
    ],
    { start: { x: 0, y: 0 }, end: { x: 11, y: 2 } },
  );

  assert.equal(getNormalizedTerminalSelection(term), "line one\nline two\nline three");
});

test("preserves explicitly selected trailing spaces on a partial last row", () => {
  // "abc  def" — select columns 0..5 → "abc  " must keep the spaces.
  const term = makeTerm(
    [{ text: "abc  def" }],
    { start: { x: 0, y: 0 }, end: { x: 5, y: 0 } },
  );
  assert.equal(getNormalizedTerminalSelection(term), "abc  ");
});

test("empty-cell trim from xterm still applies before written-space trim", () => {
  const term = makeTerm(
    [{ text: "hello", emptyCells: 10 }],
    { start: { x: 0, y: 0 }, end: { x: 15, y: 0 } },
  );
  assert.equal(getNormalizedTerminalSelection(term), "hello");
});

test("respects partial column selection on first and last rows", () => {
  const term = makeTerm(
    [
      { text: "xxhello worldyy" },
      { text: "continued here!", isWrapped: true },
    ],
    { start: { x: 2, y: 0 }, end: { x: 10, y: 1 } },
  );

  // Last-row end.x=10 selects "continued " (including the space); keep it.
  assert.equal(getNormalizedTerminalSelection(term), "hello worldyycontinued ");
});

test("falls back to getSelection when position is unavailable", () => {
  const term = makeTerm([{ text: "abc" }], null, { rawSelection: "fallback text" });
  assert.equal(getNormalizedTerminalSelection(term), "fallback text");
});

test("getTerminalSelectionForClipboard respects normalize flag", () => {
  const term = makeTerm(
    [
      { text: "hello   " },
      { text: "world   ", isWrapped: true },
    ],
    { start: { x: 0, y: 0 }, end: { x: 8, y: 1 } },
    { rawSelection: "hello   \nworld   " },
  );
  assert.equal(getTerminalSelectionForClipboard(term, true), "hello world");
  assert.equal(getTerminalSelectionForClipboard(term, false), "hello   \nworld   ");
});

test("returns empty string for empty range and normalizes inverted ranges", () => {
  const empty = makeTerm([{ text: "abc" }], { start: { x: 1, y: 0 }, end: { x: 1, y: 0 } });
  assert.equal(getNormalizedTerminalSelection(empty), "");

  const inverted = makeTerm(
    [
      { text: "alpha " },
      { text: "beta  " },
    ],
    { start: { x: 6, y: 1 }, end: { x: 0, y: 0 } },
  );
  assert.equal(getNormalizedTerminalSelection(inverted), "alpha\nbeta");
});

test("handles multi-row soft wrap chains", () => {
  const term = makeTerm(
    [
      { text: "aaa" },
      { text: "bbb", isWrapped: true },
      { text: "ccc", isWrapped: true },
      { text: "ddd" },
    ],
    { start: { x: 0, y: 0 }, end: { x: 3, y: 3 } },
  );

  assert.equal(getNormalizedTerminalSelection(term), "aaabbbccc\nddd");
});

test("preserves rectangular column selection including right-edge spaces", () => {
  const term = makeTerm(
    [
      { text: "ab  efghij" },
      { text: "01  56789x" },
      { text: "AB  EFGHIJ" },
    ],
    { start: { x: 2, y: 0 }, end: { x: 5, y: 2 } },
    { columnSelect: true },
  );

  // Columns 2..5 include the intentional spaces.
  assert.equal(getNormalizedTerminalSelection(term), "  e\n  5\n  E");
});

test("converts non-breaking spaces to regular spaces", () => {
  const term = makeTerm(
    [{ text: "hello\u00a0world  " }],
    { start: { x: 0, y: 0 }, end: { x: 13, y: 0 } },
  );
  assert.equal(getNormalizedTerminalSelection(term), "hello world");
});

test("soft-wrapped CJK with padding joins without inserted spaces", () => {
  const term = makeTerm(
    [
      { text: "Pi: 用 /copy 最   " },
      { text: "稳                ", isWrapped: true },
    ],
    { start: { x: 0, y: 0 }, end: { x: 18, y: 1 } },
  );
  assert.equal(getNormalizedTerminalSelection(term), "Pi: 用 /copy 最稳");
});

test("keeps a wrap-boundary space that canonical translateToString trimEnd would drop", () => {
  const term = makeTerm(
    [
      { text: "|hbase ", canonicalTrimEnd: true },
      { text: "shell", isWrapped: true, canonicalTrimEnd: true },
    ],
    { start: { x: 0, y: 0 }, end: { x: 5, y: 1 } },
  );
  assert.equal(getNormalizedTerminalSelection(term), "|hbase shell");
});

test("real xterm keeps a wrap-boundary space after an untrimmed string-cache prime", async () => {
  const xterm = new XTerm({ cols: 20, rows: 8, scrollback: 20, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => {
      xterm.write("12345678901234hbase shell\r\n", resolve);
    });
    // Prompt detector / autocomplete / keyword highlight all call this first.
    xterm.buffer.active.getLine(0)?.translateToString(false);

    const wrapped: SelectionTerminal = {
      getSelection: () => xterm.getSelection(),
      getSelectionPosition: () => ({ start: { x: 0, y: 0 }, end: { x: 5, y: 1 } }),
      buffer: xterm.buffer,
    };

    assert.equal(
      xterm.buffer.active.getLine(0)?.translateToString(true),
      "12345678901234hbase",
    );
    assert.equal(getNormalizedTerminalSelection(wrapped), "12345678901234hbase shell");
  } finally {
    xterm.dispose();
  }
});
