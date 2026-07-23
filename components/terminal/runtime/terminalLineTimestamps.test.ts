import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Terminal as XTerm } from "@xterm/xterm";

import {
  MAX_TERMINAL_LINE_TIMESTAMP_ENTRIES,
  createTerminalLineTimestampSegmenter,
  formatTerminalLineTimestamp,
  getTerminalLineTimestampEntryCount,
  getVisibleTerminalLineTimestampRows,
  isSimpleAsciiControlText,
  onTerminalLineTimestampsChange,
  resolveTerminalLineTimestampCapacity,
  resolveTerminalTimestampGutterRows,
  tryMeasureVisualRows,
  type TerminalLineTimestampPerfStep,
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

  const term = {
    _core: {
      unicodeService,
    },
    buffer: {
      active: { type: "normal", viewportY: 0 },
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

test("records line timestamps even while the gutter is hidden", () => {
  const { term, writes, markerLines } = createFakeTerm();
  writeTerminalDataWithLineTimestamps(term as never, "before\r\nnext", () => {});

  assert.equal(writes.join(""), "before\r\nnext");
  assert.deepEqual(markerLines, [0, 1]);
});

test("coalesces timestamp change notifications per write", () => {
  const { term, markerLines } = createFakeTerm();
  let notifications = 0;
  const unsubscribe = onTerminalLineTimestampsChange(term as never, () => {
    notifications += 1;
  });

  writeTerminalDataWithLineTimestamps(term as never, "one\r\ntwo\r\nthree", () => {});
  writeTerminalDataWithLineTimestamps(term as never, " continued", () => {});
  unsubscribe();

  assert.deepEqual(markerLines, [0, 1, 2]);
  assert.equal(notifications, 1);
});

test("writes large timestamped output in one batch while preserving marker lines", () => {
  const { term, writes, markerLines } = createFakeTerm();
  const lines = Array.from({ length: 80 }, (_, index) => `line-${index}`).join("\r\n");

  writeTerminalDataWithLineTimestamps(term as never, lines, () => {});

  assert.deepEqual(writes, [lines]);
  assert.deepEqual(markerLines, Array.from({ length: 80 }, (_, index) => index));
});

test("accounts for soft-wrapped rows when batching timestamp markers", () => {
  const { term, writes, markerLines } = createFakeTerm({ cols: 5 });
  const lines = Array.from({ length: 80 }, (_, index) => `line-${index}`).join("\r\n");

  writeTerminalDataWithLineTimestamps(term as never, lines, () => {});

  assert.deepEqual(writes, [lines]);
  assert.deepEqual(markerLines, Array.from({ length: 80 }, (_, index) => index * 2));
});

test("does not soft-wrap exact-width rows when batching timestamp markers", () => {
  const { term, writes, markerLines } = createFakeTerm({ cols: 5 });
  const lines = Array.from({ length: 80 }, () => "abcde").join("\r\n");

  writeTerminalDataWithLineTimestamps(term as never, lines, () => {});

  assert.deepEqual(writes, [lines]);
  assert.deepEqual(markerLines, Array.from({ length: 80 }, (_, index) => index));
});

test("preserves bare line feed cursor columns when batching timestamp markers", () => {
  const { term, writes, markerLines } = createFakeTerm({ cols: 5 });
  const lines = Array.from({ length: 80 }, () => "abcde").join("\n");

  writeTerminalDataWithLineTimestamps(term as never, lines, () => {});

  assert.deepEqual(writes, [lines]);
  assert.deepEqual(markerLines, [
    0,
    ...Array.from({ length: 79 }, (_, index) => (index * 2) + 1),
  ]);
});

test("respects disabled autowrap when batching timestamp markers", () => {
  const { term, writes, markerLines } = createFakeTerm({ cols: 5 });
  const lines = `\x1b[?7l${Array.from({ length: 80 }, () => "abcdef").join("\r\n")}`;

  writeTerminalDataWithLineTimestamps(term as never, lines, () => {});

  assert.deepEqual(writes, [lines]);
  assert.deepEqual(markerLines, Array.from({ length: 80 }, (_, index) => index));
});

test("falls back from batched timestamp markers for cursor-moving escape sequences", () => {
  const { term, writes, markerLines } = createFakeTerm();
  const steps: string[] = [];
  const lines = [
    "line-0",
    "line-1",
    "\x1b[Aline-1-again",
    ...Array.from({ length: 77 }, (_, index) => `line-${index + 3}`),
  ].join("\r\n");

  writeTerminalDataWithLineTimestamps(
    term as never,
    lines,
    () => {},
    { onStep: (step) => steps.push(step.kind) },
  );

  assert.notDeepEqual(writes, [lines]);
  assert.equal(steps.includes("batched-write"), false);
  assert.equal(steps.includes("segmented-write"), true);
  assert.deepEqual(markerLines, [
    0,
    1,
    1,
    ...Array.from({ length: 77 }, (_, index) => index + 2),
  ]);
});

test("falls back from batched timestamp markers for combined alternate-screen sequences", () => {
  const { term, writes, markerLines } = createFakeTerm();
  const steps: string[] = [];
  const lines = [
    "line-0",
    `\x1b[?7;1049h${"vim".repeat(1400)}`,
    "\x1b[?1049lline-1",
  ].join("\r\n");

  writeTerminalDataWithLineTimestamps(
    term as never,
    lines,
    () => {},
    { onStep: (step) => steps.push(step.kind) },
  );

  assert.notDeepEqual(writes, [lines]);
  assert.equal(steps.includes("batched-write"), false);
  assert.equal(steps.includes("segmented-write"), true);
  assert.deepEqual(markerLines, [0, 2]);
});

test("accounts for backspace cursor movement when batching timestamp markers", () => {
  const { term, writes, markerLines } = createFakeTerm({ cols: 5 });
  const lines = Array.from({ length: 80 }, () => "abc\b\b\bdef").join("\r\n");

  writeTerminalDataWithLineTimestamps(term as never, lines, () => {});

  assert.deepEqual(writes, [lines]);
  assert.deepEqual(markerLines, Array.from({ length: 80 }, (_, index) => index));
});

test("keeps tabbed writes on the segmented path so xterm owns tab stops", () => {
  const { term, writes, markerLines } = createFakeTerm({ cols: 5 });
  const steps: string[] = [];
  const lines = Array.from({ length: 80 }, () => "\t").join("\r\n");

  writeTerminalDataWithLineTimestamps(
    term as never,
    lines,
    () => {},
    { onStep: (step) => steps.push(step.kind) },
  );

  assert.equal(writes.join(""), lines);
  assert.equal(steps.includes("batched-write"), false);
  assert.equal(steps.includes("segmented-write"), true);
  assert.deepEqual(markerLines, Array.from({ length: 80 }, (_, index) => index));
});

test("uses changed xterm tab stops when placing timestamps", async () => {
  const require = createRequire(import.meta.url);
  const { Terminal } = require("@xterm/xterm") as {
    Terminal: new (options: Record<string, unknown>) => XTerm;
  };
  const term = new Terminal({ cols: 10, rows: 5, scrollback: 20, allowProposedApi: true });
  const rawWrite = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  const timestampedWrite = (data: string) => new Promise<void>((resolve) => {
    writeTerminalDataWithLineTimestamps(term, data, resolve);
  });

  try {
    // Clear all tab stops. xterm then treats TAB differently from the default
    // eight-column model used by the fast-path estimator.
    await rawWrite("\x1b[3g");
    await timestampedWrite("aa\tXY\r\nb");

    const rows = getVisibleTerminalLineTimestampRows(term);
    assert.deepEqual(rows.map(({ row }) => row), [0, 1, 2]);
    assert.ok(rows.every(({ label }) => /^\d{2}:\d{2}:\d{2}$/.test(label)));
  } finally {
    term.dispose();
  }
});

test("falls back from batched timestamp markers for combining characters", () => {
  const { term, writes, markerLines } = createFakeTerm({ cols: 5 });
  const steps: string[] = [];
  const lines = Array.from({ length: 80 }, () => "e\u0301e\u0301e\u0301").join("\r\n");

  writeTerminalDataWithLineTimestamps(
    term as never,
    lines,
    () => {},
    { onStep: (step) => steps.push(step.kind) },
  );

  assert.equal(writes.join(""), lines);
  assert.equal(steps.includes("batched-write"), false);
  assert.equal(steps.includes("segmented-write"), true);
  assert.deepEqual(markerLines, Array.from({ length: 80 }, (_, index) => index));
});

test("accounts for wide character soft wraps when batching timestamp markers", () => {
  const { term, writes, markerLines } = createFakeTerm({ cols: 5 });
  const lines = Array.from({ length: 80 }, () => "界界界").join("\r\n");

  writeTerminalDataWithLineTimestamps(term as never, lines, () => {});

  assert.deepEqual(writes, [lines]);
  assert.deepEqual(markerLines, Array.from({ length: 80 }, (_, index) => index * 2));
});

test("uses xterm unicode widths for less common wide characters", () => {
  const { term, writes, markerLines } = createFakeTerm({ cols: 5 });
  const steps: string[] = [];
  const lines = Array.from({ length: 80 }, () => "🀄〈🀄").join("\r\n");

  writeTerminalDataWithLineTimestamps(
    term as never,
    lines,
    () => {},
    { onStep: (step) => steps.push(step.kind) },
  );

  assert.deepEqual(writes, [lines]);
  assert.equal(steps.includes("batched-write"), true);
  assert.deepEqual(markerLines, Array.from({ length: 80 }, (_, index) => index * 2));
});

test("falls back from batched timestamp markers for non-Latin combining marks", () => {
  const { term, writes, markerLines } = createFakeTerm({ cols: 5 });
  const steps: string[] = [];
  const lines = Array.from({ length: 80 }, () => "س\u0651س\u0651س\u0651").join("\r\n");

  writeTerminalDataWithLineTimestamps(
    term as never,
    lines,
    () => {},
    { onStep: (step) => steps.push(step.kind) },
  );

  assert.equal(writes.join(""), lines);
  assert.equal(steps.includes("batched-write"), false);
  assert.equal(steps.includes("segmented-write"), true);
  assert.deepEqual(markerLines, Array.from({ length: 80 }, (_, index) => index));
});

test("falls back from batched timestamp markers for Hangul jamo joins", () => {
  const { term, writes, markerLines } = createFakeTerm({ cols: 5 });
  const steps: string[] = [];
  const lines = Array.from({ length: 80 }, () => "\u1100\u1161\u1100\u1161").join("\r\n");

  writeTerminalDataWithLineTimestamps(
    term as never,
    lines,
    () => {},
    { onStep: (step) => steps.push(step.kind) },
  );

  assert.equal(writes.join(""), lines);
  assert.equal(steps.includes("batched-write"), false);
  assert.equal(steps.includes("segmented-write"), true);
  assert.deepEqual(markerLines, Array.from({ length: 80 }, (_, index) => index * 2));
});

test("falls back from batched timestamp markers for zero-width format characters", () => {
  const { term, writes, markerLines } = createFakeTerm({ cols: 5 });
  const steps: string[] = [];
  const lines = Array.from({ length: 80 }, () => "xx\u200bxx").join("\r\n");

  writeTerminalDataWithLineTimestamps(
    term as never,
    lines,
    () => {},
    { onStep: (step) => steps.push(step.kind) },
  );

  assert.equal(writes.join(""), lines);
  assert.equal(steps.includes("batched-write"), false);
  assert.equal(steps.includes("segmented-write"), true);
  assert.deepEqual(markerLines, Array.from({ length: 80 }, (_, index) => index));
});

test("falls back from batched timestamp markers for emoji variation sequences", () => {
  const { term, writes, markerLines } = createFakeTerm({ cols: 5 });
  const steps: string[] = [];
  const lines = Array.from({ length: 80 }, () => "❤️❤️❤️").join("\r\n");

  writeTerminalDataWithLineTimestamps(
    term as never,
    lines,
    () => {},
    { onStep: (step) => steps.push(step.kind) },
  );

  assert.equal(writes.join(""), lines);
  assert.equal(steps.includes("batched-write"), false);
  assert.equal(steps.includes("segmented-write"), true);
  assert.deepEqual(markerLines, Array.from({ length: 80 }, (_, index) => index * 2));
});

test("keeps recording and preserves existing timestamps when the gutter is hidden", () => {
  const { term, markerLines, disposedMarkerLines } = createFakeTerm();

  writeTerminalDataWithLineTimestamps(term as never, "shown\r\n", () => {});
  writeTerminalDataWithLineTimestamps(term as never, "hidden\r\n", () => {});
  writeTerminalDataWithLineTimestamps(term as never, "shown again", () => {});

  assert.deepEqual(markerLines, [0, 1, 2]);
  assert.deepEqual(disposedMarkerLines, []);
});

test("does not withhold output when an OSC sequence is split across chunks", () => {
  const { term, writes, markerLines } = createFakeTerm();
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

  assert.equal(writes.join(""), "\x1b]7;file://server/home/alice\u009calice@server:~$ ");
  assert.deepEqual(callbacks, ["first", "second"]);
  assert.deepEqual(markerLines, [0]);
});

test("keeps timestamps for visible text before a split OSC sequence", () => {
  const { term, writes, markerLines } = createFakeTerm();
  const steps: TerminalLineTimestampPerfStep[] = [];
  const tail = "\x1b]7;file://server/home/alice";

  writeTerminalDataWithLineTimestamps(
    term as never,
    `hello ${tail}`,
    () => {},
    { onStep: (step) => steps.push(step) },
  );

  assert.equal(writes.join(""), `hello ${tail}`);
  assert.deepEqual(markerLines, [0]);
  assert.equal(
    steps.some((step) => (
      step.kind === "segmented-write"
      && step.writeCalls === 1
      && step.writeChars === "hello ".length
    )),
    true,
  );
  assert.equal(
    steps.some((step) => step.kind === "fallback-write" && step.dataChars === tail.length),
    true,
  );
});

test("keeps fallback timestamps on the matching multiline rows", () => {
  const { term, writes, markerLines } = createFakeTerm();

  writeTerminalDataWithLineTimestamps(
    term as never,
    "one\r\ntwo \x1b]7;file://server/home/alice",
    () => {},
  );

  assert.equal(writes.join(""), "one\r\ntwo \x1b]7;file://server/home/alice");
  assert.deepEqual(markerLines, [0, 1]);
});

test("does not duplicate a line timestamp after a split OSC fallback", () => {
  const { term, writes, markerLines } = createFakeTerm();

  writeTerminalDataWithLineTimestamps(
    term as never,
    "hello \x1b]7;file://server/home/alice",
    () => {},
  );
  writeTerminalDataWithLineTimestamps(
    term as never,
    "\u009cworld",
    () => {},
  );

  assert.equal(writes.join(""), "hello \x1b]7;file://server/home/alice\u009cworld");
  assert.deepEqual(markerLines, [0]);
});

test("does not timestamp the next chunk after a split alternate-screen sequence", () => {
  const { term, writes, markerLines } = createFakeTerm();

  writeTerminalDataWithLineTimestamps(term as never, "\x1b[?1049", () => {});
  writeTerminalDataWithLineTimestamps(term as never, "hvim screen", () => {});

  assert.equal(writes.join(""), "\x1b[?1049hvim screen");
  assert.deepEqual(markerLines, []);
});

test("timestamps a prompt after split alternate-screen enter and leave in one chunk", () => {
  const { term, writes, markerLines } = createFakeTerm();

  writeTerminalDataWithLineTimestamps(term as never, "\x1b[?1049", () => {});
  writeTerminalDataWithLineTimestamps(
    term as never,
    "hvim screen\x1b[?1049lprompt",
    () => {},
  );

  assert.equal(writes.join(""), "\x1b[?1049hvim screen\x1b[?1049lprompt");
  assert.deepEqual(markerLines, [0]);
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

test("real xterm keeps live timestamp markers bounded while scrollback trims", async () => {
  const require = createRequire(import.meta.url);
  const { Terminal } = require("@xterm/xterm") as {
    Terminal: new (options: Record<string, unknown>) => XTerm;
  };
  const term = new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
  const write = (data: string) => new Promise<void>((resolve) => {
    writeTerminalDataWithLineTimestamps(term, data, resolve);
  });

  try {
    await write(Array.from({ length: 6000 }, (_, index) => `seed-${index}`).join("\r\n"));
    for (let batch = 0; batch < 300; batch += 1) {
      await write(`a-${batch}\r\nb-${batch}\r\n`);
    }

    const capacity = resolveTerminalLineTimestampCapacity(term);
    const liveMarkers = (term as XTerm & { markers: readonly unknown[] }).markers.length;
    assert.ok(liveMarkers <= capacity + 512, `expected bounded markers, got ${liveMarkers}`);
    assert.ok(getTerminalLineTimestampEntryCount(term) <= capacity);
  } finally {
    term.dispose();
  }
});

test("always records timestamps without a gutter listener so expanding later still has history", () => {
  const { term, markerLines } = createFakeTerm();

  // No onTerminalLineTimestampsChange subscription — gutter is hidden.
  writeTerminalDataWithLineTimestamps(term as never, "a\r\nb\r\nc", () => {});

  assert.deepEqual(markerLines, [0, 1, 2]);
  assert.equal(getTerminalLineTimestampEntryCount(term as never), 3);

  let notifications = 0;
  const unsubscribe = onTerminalLineTimestampsChange(term as never, () => {
    notifications += 1;
  });
  // Late subscriber must still see the already-recorded markers.
  assert.equal(getTerminalLineTimestampEntryCount(term as never), 3);
  writeTerminalDataWithLineTimestamps(term as never, "\r\nd", () => {});
  unsubscribe();
  assert.equal(notifications, 1);
  assert.equal(getTerminalLineTimestampEntryCount(term as never), 4);
});

test("prunes disposed markers in bulk under scrollback pressure without retaining all flood lines", () => {
  const scrollback = 200;
  const rows = 24;
  const { term } = createFakeTerm({ scrollback, rows });
  const lineCount = 5000;
  const lines = Array.from({ length: lineCount }, (_, index) => `line-${index}`).join("\r\n");

  writeTerminalDataWithLineTimestamps(term as never, lines, () => {});

  const live = getTerminalLineTimestampEntryCount(term as never);
  const capacity = resolveTerminalLineTimestampCapacity(term as never);
  assert.ok(live <= capacity, `expected <= ${capacity} live entries, got ${live}`);
  // Must not retain near the full flood (old O(n) store grew with every line).
  assert.ok(live < lineCount / 2, `expected aggressive prune, got ${live} of ${lineCount}`);
});

test("large multi-chunk flood stays within capacity across writes", () => {
  const scrollback = 500;
  const { term } = createFakeTerm({ scrollback, rows: 24 });

  for (let chunk = 0; chunk < 40; chunk += 1) {
    const lines = Array.from(
      { length: 200 },
      (_, index) => `c${chunk}-l${index}`,
    ).join("\r\n");
    writeTerminalDataWithLineTimestamps(term as never, `${lines}\r\n`, () => {});
  }

  const live = getTerminalLineTimestampEntryCount(term as never);
  const capacity = resolveTerminalLineTimestampCapacity(term as never);
  assert.ok(live <= capacity, `expected <= ${capacity} live entries, got ${live}`);
});

test("small batched writes amortize full timestamp-store pruning", () => {
  const { term } = createFakeTerm({ scrollback: 1000, rows: 24 });
  (term as unknown as { registerMarker: (offset: number) => unknown }).registerMarker = () => ({
    line: 0,
    isDisposed: false,
    dispose() {
      this.isDisposed = true;
    },
  });

  writeTerminalDataWithLineTimestamps(term as never, "seed\r\n", () => {});
  writeTerminalDataWithLineTimestamps(term as never, "a\r\nb", () => {});

  assert.equal(getTerminalLineTimestampEntryCount(term as never, { prune: false }), 3);
  assert.equal(getTerminalLineTimestampEntryCount(term as never), 1);
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

test("gutter row resolution finds viewport labels across a large entry list", () => {
  const entries = Array.from({ length: 1000 }, (_, index) => ({
    marker: { line: index },
    label: `t-${index}`,
  }));
  assert.deepEqual(
    resolveTerminalTimestampGutterRows({
      viewportY: 500,
      rows: 4,
      entries,
    }),
    [
      { row: 0, label: "t-500" },
      { row: 1, label: "t-501" },
      { row: 2, label: "t-502" },
      { row: 3, label: "t-503" },
    ],
  );
});

test("gutter prefers the latest label when a later marker rewrites an earlier line", () => {
  // Cursor-up / reposition can append a newer marker on a lower line index.
  assert.deepEqual(
    resolveTerminalTimestampGutterRows({
      viewportY: 0,
      rows: 2,
      entries: [
        { marker: { line: 0 }, label: "10:00:00" },
        { marker: { line: 1 }, label: "10:00:01" },
        { marker: { line: 0 }, label: "10:00:02" },
      ],
    }),
    [
      { row: 0, label: "10:00:02" },
      { row: 1, label: "10:00:01" },
    ],
  );
});

test("bulk timestamp batching is disabled inside a partial scrolling region", () => {
  const { term, writes } = createFakeTerm({ cols: 80, rows: 24 });
  (term as { _core?: { buffer?: { scrollTop: number; scrollBottom: number } } })._core = {
    buffer: { scrollTop: 1, scrollBottom: 10 },
  };
  const steps: string[] = [];
  const lines = Array.from({ length: 80 }, (_, index) => `line-${index}`).join("\r\n");

  writeTerminalDataWithLineTimestamps(
    term as never,
    lines,
    () => {},
    { onStep: (step) => steps.push(step.kind) },
  );

  assert.equal(steps.includes("batched-write"), false);
  assert.equal(steps.includes("segmented-write"), true);
  // Segmented path still emits the original bytes.
  assert.equal(writes.join(""), lines);
});

test("capacity prune dedupes rewritten lines so unique history is not dropped", () => {
  const scrollback = 100;
  const rows = 1;
  const { term } = createFakeTerm({ scrollback, rows, cols: 80 });

  // Fill unique lines up to roughly the capacity window.
  const seed = Array.from({ length: scrollback + rows }, (_, index) => `line-${index}`).join("\r\n");
  writeTerminalDataWithLineTimestamps(term as never, seed, () => {});

  // Rewrite the same line many times via cursor-up (segmented path).
  for (let index = 0; index < 200; index += 1) {
    writeTerminalDataWithLineTimestamps(term as never, "\x1b[Ax\r\n", () => {});
  }

  const live = getTerminalLineTimestampEntryCount(term as never);
  const capacity = resolveTerminalLineTimestampCapacity(term as never);
  assert.ok(live <= capacity, `expected <= ${capacity} live entries, got ${live}`);
  // Unique-line history should still fit under capacity; rewrite noise must not
  // push older unique lines out purely by duplicate count.
  assert.ok(live >= Math.min(capacity, 20), `expected meaningful unique history, got ${live}`);
});
