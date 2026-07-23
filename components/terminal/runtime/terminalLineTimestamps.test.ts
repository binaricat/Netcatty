import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Terminal as XTerm } from "@xterm/xterm";

import {
  MAX_TERMINAL_LINE_TIMESTAMP_ENTRIES,
  createTerminalLineTimestampSegmenter,
  formatTerminalLineTimestamp,
  getTerminalLineTimestampLedgerCount,
  getVisibleTerminalLineTimestampRows,
  isSimpleAsciiControlText,
  onTerminalLineTimestampsChange,
  resolveTerminalLineTimestampCapacity,
  resolveTerminalTimestampGutterRows,
  resolveTerminalTimestampGutterRowsFromLedger,
  tryMeasureVisualRows,
  writeTerminalDataWithLineTimestamps,
} from "./terminalLineTimestamps.ts";

const createFakeTerm = (options: {
  cols?: number;
  wraparoundMode?: boolean;
  scrollback?: number;
  rows?: number;
} = {}) => {
  const writes: string[] = [];
  const markerLines: number[] = [];
  const disposedMarkerLines: number[] = [];
  const liveMarkers: Array<{ line: number; isDisposed: boolean; dispose: () => void }> = [];
  let cursorLine = 0;
  let cursorColumn = 0;
  const cols = options.cols ?? Number.POSITIVE_INFINITY;
  let wraparoundMode = options.wraparoundMode ?? true;
  const scrollback = options.scrollback;
  const rows = options.rows ?? 24;
  const isCombiningMark = (char: string): boolean => {
    const code = char.codePointAt(0);
    return code !== undefined && /\p{Mark}/u.test(String.fromCodePoint(code));
  };
  const cellWidth = (char: string): number => {
    const code = char.codePointAt(0);
    if (code === undefined) return 1;
    if (isCombiningMark(char)) return 0;
    if (
      code === 0x2329
      || code === 0x232a
      || (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0x303e)
      || (code >= 0x3041 && code <= 0x33ff)
      || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0x1f000 && code <= 0x1f02f)
      || (code >= 0x1f300 && code <= 0x1faff)
    ) {
      return 2;
    }
    return 1;
  };
  const readCsiSequence = (data: string, startIndex: number): { sequence: string; endIndex: number } | null => {
    if (data[startIndex] !== "\x1b" || data[startIndex + 1] !== "[") return null;
    for (let index = startIndex + 2; index < data.length; index += 1) {
      const char = data[index];
      if (char >= "@" && char <= "~") {
        return { sequence: data.slice(startIndex, index + 1), endIndex: index };
      }
    }
    return null;
  };
  const applyCsiSequence = (sequence: string): void => {
    const final = sequence.at(-1);
    const firstParam = Number.parseInt(sequence.slice(2, -1).split(";")[0] || "1", 10);
    const count = Number.isFinite(firstParam) && firstParam > 0 ? firstParam : 1;
    if (sequence === "\x1b[?7h") {
      wraparoundMode = true;
    } else if (sequence === "\x1b[?7l") {
      wraparoundMode = false;
    } else if (final === "A") {
      cursorLine = Math.max(0, cursorLine - count);
    } else if (final === "B") {
      cursorLine += count;
    }
  };
  const unicodeService = {
    wcwidth(codePoint: number) {
      if (this !== unicodeService) {
        throw new Error("wcwidth must be called with its unicode service receiver");
      }
      return cellWidth(String.fromCodePoint(codePoint));
    },
  };
  const trimMarkersToScrollback = () => {
    if (!Number.isFinite(scrollback) || scrollback === undefined || scrollback < 0) return;
    // Approximate xterm: keep the newest (scrollback + rows) buffer lines.
    const keepFromLine = Math.max(0, cursorLine - (scrollback + rows) + 1);
    for (const marker of liveMarkers) {
      if (!marker.isDisposed && marker.line < keepFromLine) {
        marker.dispose();
      }
    }
  };

  const activeBuffer = {
    type: "normal" as string,
    viewportY: 0,
    get baseY() {
      return 0;
    },
    get cursorY() {
      return cursorLine;
    },
    get cursorX() {
      return cursorColumn;
    },
    get length() {
      return cursorLine + 1;
    },
    getLine: () => ({ isWrapped: false }),
  };
  const term = {
    _core: {
      unicodeService,
    },
    buffer: {
      active: activeBuffer,
    },
    cols,
    options: Number.isFinite(scrollback) ? { scrollback } : {},
    get modes() {
      return { wraparoundMode };
    },
    rows,
    write(data: string, callback?: () => void) {
      writes.push(data);
      for (let index = 0; index < data.length; index += 1) {
        const sequence = readCsiSequence(data, index);
        if (sequence) {
          applyCsiSequence(sequence.sequence);
          index = sequence.endIndex;
          continue;
        }
        const char = data[index];
        if (char === "\n") {
          cursorLine += 1;
          if (Number.isFinite(cols) && cursorColumn >= cols) {
            cursorColumn = cols - 1;
          }
        } else if (char === "\r") {
          cursorColumn = 0;
        } else if (char === "\b") {
          cursorColumn = Math.max(0, cursorColumn - 1);
        } else if (char === "\t") {
          if (cursorColumn < cols) {
            const nextTabStop = cursorColumn + (8 - (cursorColumn % 8));
            cursorColumn = Math.min(nextTabStop, cols - 1);
          }
        } else if (isCombiningMark(char)) {
          continue;
        } else if (char < " " || char === "\u007f") {
          continue;
        } else {
          const code = data.codePointAt(index);
          const isEmojiVariationSequence = code === 0x2764 && data.codePointAt(index + 1) === 0xfe0f;
          const width = isEmojiVariationSequence ? 2 : cellWidth(char);
          if (isEmojiVariationSequence) {
            index += 1;
          }
          if (wraparoundMode && cursorColumn + width > cols) {
            cursorLine += 1;
            cursorColumn = 0;
          }
          cursorColumn = Number.isFinite(cols)
            ? Math.min(cols, cursorColumn + width)
            : cursorColumn + width;
        }
      }
      trimMarkersToScrollback();
      callback?.();
    },
    registerMarker(offset: number) {
      const line = cursorLine + offset;
      markerLines.push(line);
      const marker = {
        line,
        isDisposed: false,
        dispose() {
          if (marker.isDisposed) return;
          marker.isDisposed = true;
          disposedMarkerLines.push(line);
        },
      };
      liveMarkers.push(marker);
      return marker;
    },
  };

  return { term, writes, markerLines, disposedMarkerLines, liveMarkers };
};

test("segments terminal output into raw bytes plus timestamp markers", () => {
  const segmenter = createTerminalLineTimestampSegmenter({
    now: () => new Date(2026, 5, 6, 9, 8, 7),
  });

  assert.deepEqual(segmenter.append("hello\r\nnext"), [
    { kind: "timestamp", label: "09:08:07" },
    { kind: "data", data: "hello\r\n" },
    { kind: "timestamp", label: "09:08:07" },
    { kind: "data", data: "next" },
  ]);
});

test("does not create timestamp markers for alternate screen output", () => {
  const segmenter = createTerminalLineTimestampSegmenter({
    now: () => new Date(2026, 5, 6, 9, 8, 7),
  });

  assert.deepEqual(segmenter.append("\x1b[?1049hvim\r\ntext"), [
    { kind: "data", data: "\x1b[?1049hvim\r\ntext" },
  ]);
  assert.deepEqual(segmenter.append("\x1b[?1049lprompt"), [
    { kind: "data", data: "\x1b[?1049l" },
    { kind: "timestamp", label: "09:08:07" },
    { kind: "data", data: "prompt" },
  ]);
});

test("preserves OSC prompt prefixes terminated by C1 string terminator", () => {
  const segmenter = createTerminalLineTimestampSegmenter({
    now: () => new Date(2026, 5, 6, 9, 8, 7),
  });

  assert.deepEqual(segmenter.append("\x1b]0;server\u009calice@server:~$ "), [
    { kind: "data", data: "\x1b]0;server\u009c" },
    { kind: "timestamp", label: "09:08:07" },
    { kind: "data", data: "alice@server:~$ " },
  ]);
});

test("preserves split OSC prompt prefixes terminated by C1 string terminator", () => {
  const segmenter = createTerminalLineTimestampSegmenter({
    now: () => new Date(2026, 5, 6, 9, 8, 7),
  });

  assert.deepEqual(segmenter.append("\x1b]7;file://server/home/alice"), []);
  assert.deepEqual(segmenter.append("\u009calice@server:~$ "), [
    { kind: "data", data: "\x1b]7;file://server/home/alice\u009c" },
    { kind: "timestamp", label: "09:08:07" },
    { kind: "data", data: "alice@server:~$ " },
  ]);
});

test("resolves visible timestamp rows from marker lines", () => {
  assert.deepEqual(
    resolveTerminalTimestampGutterRows({
      viewportY: 10,
      rows: 4,
      entries: [
        { marker: { line: 9 }, label: "before" },
        { marker: { line: 10 }, label: "10:00:00" },
        { marker: { line: 12 }, label: "10:00:02" },
        { marker: { line: 14 }, label: "after" },
      ],
    }),
    [
      { row: 0, label: "10:00:00" },
      { row: 2, label: "10:00:02" },
    ],
  );
});

test("resolves timestamp rows for wrapped continuations", () => {
  assert.deepEqual(
    resolveTerminalTimestampGutterRows({
      viewportY: 11,
      rows: 4,
      entries: [
        { marker: { line: 10 }, label: "10:00:10" },
        { marker: { line: 13 }, label: "10:00:13" },
      ],
      isWrappedLine: (line) => line === 11 || line === 12,
    }),
    [
      { row: 0, label: "10:00:10" },
      { row: 1, label: "10:00:10" },
      { row: 2, label: "10:00:13" },
    ],
  );
});

test("formats timestamp labels without terminal escape codes", () => {
  assert.equal(formatTerminalLineTimestamp(new Date(2026, 5, 6, 1, 2, 3)), "01:02:03");
});


test("gutter off records a per-second ledger without markers", () => {
  const { term, writes, markerLines } = createFakeTerm();
  const t0 = new Date(2026, 5, 6, 12, 0, 0);
  writeTerminalDataWithLineTimestamps(term as never, "before\r\nnext\r\nthird", () => {}, {
    enabled: false,
    timestampDate: t0,
  });

  assert.equal(writes.join(""), "before\r\nnext\r\nthird");
  assert.deepEqual(markerLines, []);
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 1);
});

test("ledger keeps one stamp per wall-clock second whether gutter is on or off", () => {
  const { term, markerLines } = createFakeTerm();
  writeTerminalDataWithLineTimestamps(term as never, "a\r\nb\r\n", () => {}, {
    enabled: true,
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  writeTerminalDataWithLineTimestamps(term as never, "c\r\nd\r\n", () => {}, {
    enabled: false,
    timestampDate: new Date(2026, 5, 6, 12, 0, 1),
  });

  // Record path never registerMarkers.
  assert.deepEqual(markerLines, []);
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 2);
});

test("gutter paint shows ledger labels on stamp lines only", () => {
  const { term } = createFakeTerm();
  writeTerminalDataWithLineTimestamps(term as never, "a\r\nb\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  writeTerminalDataWithLineTimestamps(term as never, "c\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 1),
  });

  const rows = getVisibleTerminalLineTimestampRows(term as never);
  assert.deepEqual(
    rows.map((row) => row.label),
    ["12:00:00", "12:00:01"],
  );
});

test("ledger notifies listeners once when a new second is stamped", () => {
  const { term } = createFakeTerm();
  let notifications = 0;
  const unsubscribe = onTerminalLineTimestampsChange(term as never, () => {
    notifications += 1;
  });

  writeTerminalDataWithLineTimestamps(term as never, "one\r\ntwo\r\nthree", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  writeTerminalDataWithLineTimestamps(term as never, " continued", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  writeTerminalDataWithLineTimestamps(term as never, "\r\nnext-second\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 1),
  });
  unsubscribe();

  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 2);
  assert.equal(notifications, 2);
});

test("large multi-line dump in one second still uses a single ledger stamp", () => {
  const { term, writes, markerLines } = createFakeTerm();
  const lines = Array.from({ length: 80 }, (_, index) => `line-${index}`).join("\r\n");

  writeTerminalDataWithLineTimestamps(term as never, lines, () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });

  assert.deepEqual(writes, [lines]);
  assert.deepEqual(markerLines, []);
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 1);
});

test("does not withhold output when an OSC sequence is split across chunks", () => {
  const { term, writes } = createFakeTerm();
  const callbacks: string[] = [];

  writeTerminalDataWithLineTimestamps(
    term as never,
    "\x1b]7;file://server/home/alice",
    () => callbacks.push("first"),
  );
  writeTerminalDataWithLineTimestamps(
    term as never,
    "\u009calice@server:~$ ",
    () => callbacks.push("second"),
  );

  assert.deepEqual(callbacks, ["first", "second"]);
  assert.ok(writes.join("").includes("alice@server:~$ "));
});

test("does not timestamp output suspended on the alternate screen", () => {
  const { term } = createFakeTerm();
  writeTerminalDataWithLineTimestamps(term as never, "\x1b[?1049hvim screen", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 0);
});

test("records a ledger stamp after leaving alternate screen", () => {
  const { term } = createFakeTerm();
  // Start as if already on alt screen via segmenter enter then leave in data
  writeTerminalDataWithLineTimestamps(
    term as never,
    "\x1b[?1049hframe\x1b[?1049lprompt line\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 0) },
  );
  assert.ok(getTerminalLineTimestampLedgerCount(term as never) >= 1);
});

test("resolveTerminalTimestampGutterRowsFromLedger paints only stamp lines", () => {
  const rows = resolveTerminalTimestampGutterRowsFromLedger({
    viewportY: 0,
    rows: 5,
    ledger: [
      { label: "12:00:00", secondKey: 1, line: 0 },
      { label: "12:00:01", secondKey: 2, line: 3 },
    ],
  });
  assert.deepEqual(rows, [
    { row: 0, label: "12:00:00" },
    { row: 3, label: "12:00:01" },
  ]);
});


test("simple ASCII control text gate matches seq-style floods", () => {
  assert.equal(isSimpleAsciiControlText("1\n2\n3\n"), true);
  assert.equal(isSimpleAsciiControlText("line-0\r\nline-1\r\n"), true);
  assert.equal(isSimpleAsciiControlText("a\tb\b c"), true);
  assert.equal(isSimpleAsciiControlText("hello\x1b[0m"), false);
  assert.equal(isSimpleAsciiControlText("界"), false);
});
test("tryMeasureVisualRows matches hard-newline accounting for short ASCII lines", () => {
  const { term } = createFakeTerm({ cols: 80 });
  const data = Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\r\n");
  const measured = tryMeasureVisualRows(term as never, data, 0, 80, true);
  assert.ok(measured);
  assert.equal(measured?.rowOffset, 99);
  assert.equal(measured?.column, "line-99".length);
});
test("tryMeasureVisualRows accounts for soft wraps on long ASCII lines", () => {
  const { term } = createFakeTerm({ cols: 5 });
  const measured = tryMeasureVisualRows(term as never, "abcdefghij", 0, 5, true);
  assert.ok(measured);
  assert.equal(measured?.rowOffset, 1);
  assert.equal(measured?.column, 5);
});
test("tryMeasureVisualRows rejects unmeasurable escape sequences", () => {
  const { term } = createFakeTerm({ cols: 80 });
  assert.equal(
    tryMeasureVisualRows(term as never, "\x1b[Aup", 0, 80, true),
    null,
  );
});
test("capacity follows small scrollback and caps large histories", () => {
  assert.equal(
    resolveTerminalLineTimestampCapacity({
      rows: 24,
      options: { scrollback: 1000 },
    } as never),
    1000 + 24 + 64,
  );
  // Large scrollback values must not create a live xterm marker per retained row.
  assert.equal(
    resolveTerminalLineTimestampCapacity({
      rows: 24,
      options: { scrollback: 200000 },
    } as never),
    MAX_TERMINAL_LINE_TIMESTAMP_ENTRIES,
  );
  assert.equal(
    resolveTerminalLineTimestampCapacity({
      rows: 24,
      options: { scrollback: 80000 },
    } as never),
    MAX_TERMINAL_LINE_TIMESTAMP_ENTRIES,
  );
  assert.equal(
    resolveTerminalLineTimestampCapacity({
      rows: 400,
      options: { scrollback: 100000 },
    } as never),
    MAX_TERMINAL_LINE_TIMESTAMP_ENTRIES,
  );
});
