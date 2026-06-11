import test from "node:test";
import assert from "node:assert/strict";

import {
  createTerminalLineTimestampSegmenter,
  formatTerminalLineTimestamp,
  resolveTerminalTimestampGutterRows,
  writeTerminalDataWithLineTimestamps,
} from "./terminalLineTimestamps.ts";

const createFakeTerm = () => {
  const writes: string[] = [];
  const markerLines: number[] = [];
  const disposedMarkerLines: number[] = [];
  let cursorLine = 0;
  const term = {
    buffer: {
      active: { type: "normal", viewportY: 0 },
    },
    rows: 24,
    write(data: string, callback?: () => void) {
      writes.push(data);
      for (const char of data) {
        if (char === "\n") {
          cursorLine += 1;
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

test("keeps recording and preserves existing timestamps when the gutter is hidden", () => {
  const { term, markerLines, disposedMarkerLines } = createFakeTerm();

  writeTerminalDataWithLineTimestamps(term as never, "shown\r\n", () => {});
  writeTerminalDataWithLineTimestamps(term as never, "hidden\r\n", () => {});
  writeTerminalDataWithLineTimestamps(term as never, "shown again", () => {});

  assert.deepEqual(markerLines, [0, 1, 2]);
  assert.deepEqual(disposedMarkerLines, []);
});
