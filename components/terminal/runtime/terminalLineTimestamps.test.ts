import test from "node:test";
import assert from "node:assert/strict";

import {
  createTerminalLineTimestampSegmenter,
  formatTerminalLineTimestamp,
  onTerminalLineTimestampsChange,
  resolveTerminalTimestampGutterRows,
  writeTerminalDataWithLineTimestamps,
} from "./terminalLineTimestamps.ts";

const createFakeTerm = (options: { cols?: number; wraparoundMode?: boolean } = {}) => {
  const writes: string[] = [];
  const markerLines: number[] = [];
  const disposedMarkerLines: number[] = [];
  let cursorLine = 0;
  let cursorColumn = 0;
  const cols = options.cols ?? Number.POSITIVE_INFINITY;
  let wraparoundMode = options.wraparoundMode ?? true;
  const isCombiningMark = (char: string): boolean => {
    const code = char.codePointAt(0);
    return code !== undefined && code >= 0x300 && code <= 0x36f;
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
    if (sequence === "\x1b[?7h") {
      wraparoundMode = true;
    } else if (sequence === "\x1b[?7l") {
      wraparoundMode = false;
    }
  };
  const term = {
    buffer: {
      active: { type: "normal", viewportY: 0 },
    },
    cols,
    get modes() {
      return { wraparoundMode };
    },
    rows: 24,
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
          if (wraparoundMode && cursorColumn + 1 > cols) {
            cursorLine += 1;
            cursorColumn = 0;
          }
          cursorColumn = Number.isFinite(cols)
            ? Math.min(cols, cursorColumn + 1)
            : cursorColumn + 1;
        }
      }
      callback?.();
    },
    registerMarker(offset: number) {
      const line = cursorLine + offset;
      markerLines.push(line);
      const marker = {
        line,
        isDisposed: false,
        dispose() {
          marker.isDisposed = true;
          disposedMarkerLines.push(line);
        },
      };
      return marker;
    },
  };

  return { term, writes, markerLines, disposedMarkerLines };
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

test("accounts for backspace cursor movement when batching timestamp markers", () => {
  const { term, writes, markerLines } = createFakeTerm({ cols: 5 });
  const lines = Array.from({ length: 80 }, () => "abc\b\b\bdef").join("\r\n");

  writeTerminalDataWithLineTimestamps(term as never, lines, () => {});

  assert.deepEqual(writes, [lines]);
  assert.deepEqual(markerLines, Array.from({ length: 80 }, (_, index) => index));
});

test("accounts for tab stops without soft wrapping timestamp markers", () => {
  const { term, writes, markerLines } = createFakeTerm({ cols: 5 });
  const lines = Array.from({ length: 80 }, () => "\t").join("\r\n");

  writeTerminalDataWithLineTimestamps(term as never, lines, () => {});

  assert.deepEqual(writes, [lines]);
  assert.deepEqual(markerLines, Array.from({ length: 80 }, (_, index) => index));
});

test("keeps batched timestamp markers aligned for combining characters", () => {
  const { term, writes, markerLines } = createFakeTerm({ cols: 5 });
  const lines = Array.from({ length: 80 }, () => "e\u0301e\u0301e\u0301").join("\r\n");

  writeTerminalDataWithLineTimestamps(term as never, lines, () => {});

  assert.deepEqual(writes, [lines]);
  assert.deepEqual(markerLines, Array.from({ length: 80 }, (_, index) => index));
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

  writeTerminalDataWithLineTimestamps(
    term as never,
    "hello \x1b]7;file://server/home/alice",
    () => {},
  );

  assert.equal(writes.join(""), "hello \x1b]7;file://server/home/alice");
  assert.deepEqual(markerLines, [0]);
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
