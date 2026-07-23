import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Terminal as XTerm } from "@xterm/xterm";

import {
  MAX_TERMINAL_LINE_TIMESTAMP_ENTRIES,
  applyAltScreenAction,
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
  type StampCursorEstimate,
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
  // Approximate xterm: dual buffers (normal + alternate). Active switches on
  // 1049h/l; buffer.normal always exposes the saved normal-buffer cursor so
  // stamp placement can restore correctly when a write starts already on alt.
  const maxBufferLines = Number.isFinite(scrollback) && scrollback !== undefined && scrollback >= 0
    ? scrollback + rows
    : Number.POSITIVE_INFINITY;
  type BufferState = {
    absoluteCursorLine: number;
    baseY: number;
    column: number;
    lineText: Map<number, string>;
  };
  const normalState: BufferState = {
    absoluteCursorLine: 0,
    baseY: 0,
    column: 0,
    lineText: new Map(),
  };
  const altState: BufferState = {
    absoluteCursorLine: 0,
    baseY: 0,
    column: 0,
    lineText: new Map(),
  };
  let screen: "normal" | "alternate" = "normal";
  const currentState = (): BufferState => (screen === "alternate" ? altState : normalState);
  /** When null, viewport follows bottom (baseY). Tests may pin a scroll-up offset. */
  let viewportYOverride: number | null = null;

  // When not yet full, length grows with content but never below viewport.
  // When full, length stays at maxBufferLines and baseY tracks the trim offset.
  const resolveLength = (state: BufferState): number => {
    if (!Number.isFinite(maxBufferLines)) {
      return Math.max(rows, state.absoluteCursorLine + 1);
    }
    return Math.min(
      maxBufferLines,
      Math.max(rows, state.absoluteCursorLine - state.baseY + 1),
    );
  };

  const trimScrollbackIfNeeded = (state: BufferState) => {
    if (!Number.isFinite(maxBufferLines)) return;
    while (state.absoluteCursorLine - state.baseY + 1 > maxBufferLines) {
      state.baseY += 1;
    }
    if (screen !== "normal") return;
    const keepFromAbsolute = state.baseY;
    for (const marker of liveMarkers) {
      if (!marker.isDisposed && marker.line < keepFromAbsolute) {
        marker.dispose();
      }
    }
    for (const key of [...state.lineText.keys()]) {
      if (key < keepFromAbsolute) state.lineText.delete(key);
    }
  };

  // buffer.normal: always the primary buffer (xterm keeps this while alt is active).
  const normalBuffer = {
    type: "normal" as const,
    get viewportY() {
      return viewportYOverride ?? normalState.baseY;
    },
    get baseY() {
      return normalState.baseY;
    },
    get cursorY() {
      return Math.max(0, normalState.absoluteCursorLine - normalState.baseY);
    },
    get cursorX() {
      return normalState.column;
    },
    get length() {
      return resolveLength(normalState);
    },
    getLine: (line?: number) => {
      const absolute = typeof line === "number" ? line : normalState.absoluteCursorLine;
      const text = normalState.lineText.get(absolute) ?? "";
      return {
        isWrapped: false,
        translateToString: (_trimRight?: boolean) => text,
      };
    },
  };

  // active.type must reflect the current screen for alt-screen gates.
  const activeBuffer = {
    get type() {
      return screen;
    },
    set type(value: string) {
      screen = value === "alternate" ? "alternate" : "normal";
    },
    get viewportY() {
      return viewportYOverride ?? currentState().baseY;
    },
    set viewportY(value: number) {
      viewportYOverride = Math.max(0, value);
    },
    get baseY() {
      return currentState().baseY;
    },
    set baseY(value: number) {
      currentState().baseY = Math.max(0, value);
    },
    get cursorY() {
      const state = currentState();
      return Math.max(0, state.absoluteCursorLine - state.baseY);
    },
    set cursorY(value: number) {
      const state = currentState();
      state.absoluteCursorLine = state.baseY + Math.max(0, value);
      cursorLine = state.absoluteCursorLine;
    },
    get cursorX() {
      return currentState().column;
    },
    set cursorX(value: number) {
      currentState().column = Math.max(0, value);
      cursorColumn = currentState().column;
    },
    get length() {
      return resolveLength(currentState());
    },
    getLine: (line?: number) => {
      const state = currentState();
      const absolute = typeof line === "number" ? line : state.absoluteCursorLine;
      const text = state.lineText.get(absolute) ?? "";
      return {
        isWrapped: false,
        translateToString: (_trimRight?: boolean) => text,
      };
    },
  };

  const enterAlternate = () => {
    if (screen === "alternate") return;
    // Save normal cursor (already in normalState); reset alt surface.
    altState.absoluteCursorLine = 0;
    altState.baseY = 0;
    altState.column = 0;
    altState.lineText.clear();
    screen = "alternate";
    cursorLine = 0;
    cursorColumn = 0;
  };

  const leaveAlternate = () => {
    if (screen !== "alternate") return;
    screen = "normal";
    cursorLine = normalState.absoluteCursorLine;
    cursorColumn = normalState.column;
  };

  const term = {
    _core: {
      unicodeService,
    },
    buffer: {
      active: activeBuffer,
      normal: normalBuffer,
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
          if (
            sequence.sequence === "\x1b[?1049h"
            || sequence.sequence === "\x1b[?47h"
            || sequence.sequence === "\x1b[?1047h"
          ) {
            enterAlternate();
            index = sequence.endIndex;
            continue;
          }
          if (
            sequence.sequence === "\x1b[?1049l"
            || sequence.sequence === "\x1b[?47l"
            || sequence.sequence === "\x1b[?1047l"
          ) {
            leaveAlternate();
            index = sequence.endIndex;
            continue;
          }
          applyCsiSequence(sequence.sequence);
          currentState().absoluteCursorLine = cursorLine;
          index = sequence.endIndex;
          continue;
        }
        const state = currentState();
        const char = data[index];
        if (char === "\n") {
          state.absoluteCursorLine += 1;
          cursorLine = state.absoluteCursorLine;
          state.column = Number.isFinite(cols) && state.column >= cols
            ? cols - 1
            : 0;
          cursorColumn = state.column;
          trimScrollbackIfNeeded(state);
        } else if (char === "\r") {
          state.column = 0;
          cursorColumn = 0;
        } else if (char === "\b") {
          state.column = Math.max(0, state.column - 1);
          cursorColumn = state.column;
        } else if (char === "\t") {
          if (state.column < cols) {
            const nextTabStop = state.column + (8 - (state.column % 8));
            state.column = Math.min(nextTabStop, cols - 1);
            cursorColumn = state.column;
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
          if (wraparoundMode && state.column + width > cols) {
            state.absoluteCursorLine += 1;
            cursorLine = state.absoluteCursorLine;
            state.column = 0;
            cursorColumn = 0;
            trimScrollbackIfNeeded(state);
          }
          const existing = state.lineText.get(state.absoluteCursorLine) ?? "";
          state.lineText.set(
            state.absoluteCursorLine,
            existing + (isEmojiVariationSequence ? "❤️" : char),
          );
          state.column = Number.isFinite(cols)
            ? Math.min(cols, state.column + width)
            : state.column + width;
          cursorColumn = state.column;
        }
      }
      cursorLine = currentState().absoluteCursorLine;
      cursorColumn = currentState().column;
      trimScrollbackIfNeeded(currentState());
      callback?.();
    },
    registerMarker(offset: number) {
      // Markers attach to the normal buffer in production for our ledger path
      // after leave; while on alt, offset is still relative to active cursor.
      const state = currentState();
      const line = state.absoluteCursorLine + offset;
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

  return {
    term,
    writes,
    markerLines,
    disposedMarkerLines,
    liveMarkers,
    /** Test helper: inspect / force xterm-like baseY growth on the normal buffer. */
    getBaseY: () => normalState.baseY,
    setBaseY: (value: number) => {
      normalState.baseY = Math.max(0, value);
    },
    setViewportY: (value: number) => {
      viewportYOverride = Math.max(0, value);
    },
    getAbsoluteCursorLine: () => currentState().absoluteCursorLine,
    /** Force already-on-alt with a saved normal cursor (skeptic multi-write path). */
    enterAlternateWithSavedNormal: (savedNormalLine: number, savedNormalColumn = 0) => {
      normalState.absoluteCursorLine = Math.max(0, savedNormalLine);
      normalState.column = Math.max(0, savedNormalColumn);
      normalState.lineText.set(normalState.absoluteCursorLine, "shell-prompt");
      enterAlternate();
      // Simulate a tall TUI: alt cursor deep in the alternate buffer.
      altState.absoluteCursorLine = 40;
      altState.column = 0;
      cursorLine = 40;
      cursorColumn = 0;
    },
    getNormalAbsoluteLine: () => normalState.absoluteCursorLine,
  };
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


test("gutter off records a per-second ledger with a sparse reflow anchor", () => {
  const { term, writes, markerLines } = createFakeTerm();
  const t0 = new Date(2026, 5, 6, 12, 0, 0);
  writeTerminalDataWithLineTimestamps(term as never, "before\r\nnext\r\nthird", () => {}, {
    enabled: false,
    timestampDate: t0,
  });

  assert.equal(writes.join(""), "before\r\nnext\r\nthird");
  // One wall-clock second → one sparse anchor (not per-line markers).
  assert.equal(markerLines.length, 1);
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

  // Sparse anchors only: one registerMarker per stamped second.
  assert.equal(markerLines.length, 2);
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 2);
});

test("gutter paint fills blank rows with the previous stamp time", () => {
  const { term } = createFakeTerm();
  writeTerminalDataWithLineTimestamps(term as never, "a\r\nb\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  writeTerminalDataWithLineTimestamps(term as never, "c\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 1),
  });

  const rows = getVisibleTerminalLineTimestampRows(term as never);
  // line0 stamp 12:00:00 fills line1; line2 stamp 12:00:01.
  assert.deepEqual(
    rows.filter((row) => row.row <= 2).map((row) => ({ row: row.row, label: row.label })),
    [
      { row: 0, label: "12:00:00" },
      { row: 1, label: "12:00:00" },
      { row: 2, label: "12:00:01" },
    ],
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
  assert.equal(markerLines.length, 1);
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 1);
});

test("soft-wrapped long line places the next-second stamp after visual rows", () => {
  // cols=10: "abcdefghij" is one full row; "klmnopqrst" wraps to a second row, then \n.
  const { term, liveMarkers } = createFakeTerm({ cols: 10, rows: 24 });
  writeTerminalDataWithLineTimestamps(term as never, `${"x".repeat(25)}\r\n`, () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  writeTerminalDataWithLineTimestamps(term as never, "next\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 1),
  });

  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 2);
  // 25 chars @ width 10 → rows 0,1,2 for first logical line; "next" on line 3.
  // Second stamp must not share line 0 with the first (hard-\n-only bug).
  const lines = liveMarkers.map((marker) => marker.line).sort((a, b) => a - b);
  assert.equal(lines[0], 0);
  assert.ok(
    lines[1]! >= 3,
    `expected second stamp at or after line 3 after soft-wrap, got ${JSON.stringify(lines)}`,
  );

  const painted = getVisibleTerminalLineTimestampRows(term as never);
  assert.ok(painted.some((row) => row.label === "12:00:00"));
  assert.ok(painted.some((row) => row.label === "12:00:01"));
});

test("reflow updates painted rows from sparse anchor marker.line", () => {
  const { term, liveMarkers } = createFakeTerm({ cols: 80, rows: 24, scrollback: 1000 });
  writeTerminalDataWithLineTimestamps(term as never, "early\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  writeTerminalDataWithLineTimestamps(term as never, "late\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 1),
  });
  assert.equal(liveMarkers.length, 2);

  // Simulate xterm reflow: markers move to new absolute lines.
  liveMarkers[0]!.line = 5;
  liveMarkers[1]!.line = 12;

  const painted = getVisibleTerminalLineTimestampRows(term as never);
  const byRow = new Map(painted.map((row) => [row.row, row.label]));
  // viewportY=0 → buffer line === row for these anchors.
  assert.equal(byRow.get(5), "12:00:00");
  assert.equal(byRow.get(12), "12:00:01");
  // Fill-forward between anchors.
  assert.equal(byRow.get(8), "12:00:00");
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

test("applyAltScreenAction never rewinds normal-buffer line or column", () => {
  // Pure truth table: enter/leave × altActive; line/col immutable.
  const base: StampCursorEstimate = {
    absoluteLine: 7,
    column: 3,
    wraparoundMode: true,
    altActive: false,
  };
  const cases: Array<{
    name: string;
    start: StampCursorEstimate;
    action: "enter" | "leave";
    expectAlt: boolean;
  }> = [
    {
      name: "enter while normal",
      start: { ...base, altActive: false },
      action: "enter",
      expectAlt: true,
    },
    {
      name: "enter while already alt",
      start: { ...base, altActive: true },
      action: "enter",
      expectAlt: true,
    },
    {
      name: "leave while alt",
      start: { ...base, altActive: true },
      action: "leave",
      expectAlt: false,
    },
    {
      name: "spurious leave while already normal",
      start: { ...base, altActive: false, absoluteLine: 7, column: 3 },
      action: "leave",
      expectAlt: false,
    },
  ];
  for (const row of cases) {
    const next = applyAltScreenAction(row.start, row.action);
    assert.equal(next.absoluteLine, row.start.absoluteLine, row.name);
    assert.equal(next.column, row.start.column, row.name);
    assert.equal(next.wraparoundMode, row.start.wraparoundMode, row.name);
    assert.equal(next.altActive, row.expectAlt, row.name);
  }
  // enter then leave preserves line/col from mid-walk freeze point.
  const afterEnter = applyAltScreenAction({ ...base, absoluteLine: 1 }, "enter");
  const afterLeave = applyAltScreenAction(afterEnter, "leave");
  assert.equal(afterLeave.absoluteLine, 1);
  assert.equal(afterLeave.altActive, false);
});

// --- Three write-path integrations for alt/seed/leave (shipped entry) ---

test("alt-screen newlines do not inflate post-exit stamp anchor lines", () => {
  const { term, liveMarkers } = createFakeTerm({ rows: 24, scrollback: 1000 });
  // Many hard newlines inside the alt screen must not push the restored
  // normal-buffer stamp down (would mis-pin sparse reflow anchors).
  const payload = `\x1b[?1049h${"frame\n".repeat(30)}\x1b[?1049lprompt\r\n`;
  writeTerminalDataWithLineTimestamps(term as never, payload, () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });

  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 1);
  assert.equal(liveMarkers.length, 1);
  assert.equal(
    liveMarkers[0]?.line,
    0,
    `expected stamp on restored normal buffer line 0, got ${liveMarkers[0]?.line}`,
  );
});

test("same-chunk normal advance before enter is kept after leave for post-TUI stamp", () => {
  // Leading hard newline advances the normal estimate to line 1 with no stamp
  // yet; enter freezes that estimate; leave must not rewind to line 0.
  const { term, liveMarkers } = createFakeTerm({ rows: 24, scrollback: 1000, cols: 80 });
  const payload = `\r\n\x1b[?1049h${"frame\n".repeat(20)}\x1b[?1049lprompt\r\n`;
  writeTerminalDataWithLineTimestamps(term as never, payload, () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });

  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 1);
  assert.equal(liveMarkers.length, 1);
  assert.equal(
    liveMarkers[0]?.line,
    1,
    `expected prompt stamp on advanced normal line 1, got ${liveMarkers[0]?.line}`,
  );
});

test("spurious leave without enter keeps same-chunk normal advance for prompt stamp", () => {
  // Skeptic: '\r\n\x1b[?1049lprompt\r\n' must stamp line 1, not rewind to 0.
  const { term, liveMarkers } = createFakeTerm({ rows: 24, scrollback: 1000, cols: 80 });
  writeTerminalDataWithLineTimestamps(
    term as never,
    "\r\n\x1b[?1049lprompt\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 0) },
  );
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 1);
  assert.equal(liveMarkers.length, 1);
  assert.equal(
    liveMarkers[0]?.line,
    1,
    `expected stamp on line 1 after leading \\n + spurious leave, got ${liveMarkers[0]?.line}`,
  );
});

test("already-on-alt leave stamps on saved normal line not deep alt cursor", () => {
  const fake = createFakeTerm({ rows: 24, scrollback: 1000 });
  const { term, liveMarkers, disposedMarkerLines } = fake;

  // Normal-buffer banner first (saves a real primary-buffer line).
  writeTerminalDataWithLineTimestamps(term as never, "banner\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  const savedNormalLine = fake.getNormalAbsoluteLine();
  assert.ok(savedNormalLine >= 1);

  // Simulate a multi-write TUI session: already on alt with a deep alt cursor
  // while buffer.normal still holds the shell line.
  fake.enterAlternateWithSavedNormal(savedNormalLine, 0);
  assert.equal((term.buffer.active as { type: string }).type, "alternate");
  assert.equal(fake.getAbsoluteCursorLine(), 40);

  // Alt-only output must not add stamps (segmenter suspended).
  writeTerminalDataWithLineTimestamps(term as never, `${"frame\n".repeat(15)}`, () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 1),
  });
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 1);

  // Leave alt + shell prompt — stamp must pin to saved normal line, not alt 40+.
  writeTerminalDataWithLineTimestamps(term as never, "\x1b[?1049lprompt\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 2),
  });

  assert.equal(
    getTerminalLineTimestampLedgerCount(term as never),
    2,
    "post-TUI stamp must remain in the ledger (not dropped as past bufferLength)",
  );
  const live = liveMarkers.filter((marker) => !marker.isDisposed);
  assert.ok(live.length >= 2);
  const promptAnchor = live[live.length - 1]!;
  assert.ok(
    promptAnchor.line < 20,
    `expected normal-buffer stamp, got alt-depth line ${promptAnchor.line}`,
  );
  assert.ok(
    promptAnchor.line >= savedNormalLine - 1 && promptAnchor.line <= savedNormalLine + 2,
    `expected stamp near saved normal line ${savedNormalLine}, got ${promptAnchor.line}`,
  );
  // The deep-alt mis-pin (line ~40) must not be the surviving prompt anchor.
  assert.equal(disposedMarkerLines.includes(40), false);
  assert.notEqual(promptAnchor.line, 40);
});

test("resolveTerminalTimestampGutterRowsFromLedger fills gaps with previous time", () => {
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
    { row: 1, label: "12:00:00" },
    { row: 2, label: "12:00:00" },
    { row: 3, label: "12:00:01" },
    { row: 4, label: "12:00:01" },
  ]);
});

test("resolveTerminalTimestampGutterRowsFromLedger does not paint past lastPaintLine", () => {
  // Viewport is 10 rows but content only reaches line 2 — empty rows stay blank.
  const rows = resolveTerminalTimestampGutterRowsFromLedger({
    viewportY: 0,
    rows: 10,
    lastPaintLine: 2,
    ledger: [
      { label: "12:00:00", secondKey: 1, line: 0 },
    ],
  });
  assert.deepEqual(rows, [
    { row: 0, label: "12:00:00" },
    { row: 1, label: "12:00:00" },
    { row: 2, label: "12:00:00" },
  ]);
});

test("gutter paint does not fill empty viewport rows past real content", () => {
  // Fake buffer length is always >= rows (like xterm), even with few content lines.
  const { term } = createFakeTerm({ rows: 24 });
  writeTerminalDataWithLineTimestamps(term as never, "motd\r\nlogin\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });

  const painted = getVisibleTerminalLineTimestampRows(term as never);
  // "motd\nlogin\n" → content on lines 0-1; cursor sits empty on line 2.
  assert.ok(painted.length > 0);
  assert.ok(
    painted.every((row) => row.row <= 1),
    `expected paint only on content rows, got rows: ${painted.map((r) => r.row).join(",")}`,
  );
  assert.equal(painted.at(-1)?.row, 1);
});

test("baseY growth while buffer is still growing does not drop early ledger stamps", () => {
  // Large scrollback so a short session is not yet "full"; baseY may still rise
  // as the viewport follows the cursor. Old logic rebased on every baseY delta
  // and wiped MOTD stamps even though nothing was trimmed.
  const fake = createFakeTerm({ rows: 10, scrollback: 1000 });
  const { term } = fake;

  writeTerminalDataWithLineTimestamps(term as never, "banner-line\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  writeTerminalDataWithLineTimestamps(term as never, "later-line\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 5),
  });

  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 2);

  // Simulate mistaken "baseY follows cursor" growth while buffer not full.
  fake.setBaseY(2);
  // Scroll back to the top so paint includes the original banner line.
  fake.setViewportY(0);

  const painted = getVisibleTerminalLineTimestampRows(term as never);
  // Early stamp must still fill-forward (not discarded by rebase).
  assert.ok(
    painted.some((row) => row.label === "12:00:00"),
    `expected early stamp still visible, got ${JSON.stringify(painted)}`,
  );
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 2);
});

test("full-buffer scrollback trim rebases ledger and drops lines past the top", () => {
  const fake = createFakeTerm({ rows: 4, scrollback: 4 });
  const { term } = fake;
  // maxLines = 4 + 4 = 8. Write enough distinct seconds to stamp many lines,
  // then overflow so baseY grows while buffer is full.

  for (let second = 0; second < 12; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `line-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second) },
    );
  }

  assert.ok(fake.getBaseY() > 0, "expected scrollback trim to raise baseY");
  const ledgerCount = getTerminalLineTimestampLedgerCount(term as never);
  assert.ok(ledgerCount > 0);
  // Stamps for lines that scrolled off the top must be gone after rebase+filter.
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  assert.ok(painted.length > 0);
  // Every painted label should still be a valid HH:MM:SS from our window.
  for (const row of painted) {
    assert.match(row.label, /^12:00:\d{2}$/);
  }
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
