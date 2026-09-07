import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureTerminalReflowScrollAnchor,
  resolveTerminalReflowScrollAnchor,
} from "./terminalHelpers";

type FakeRow = { isWrapped?: boolean; text: string };

const fakeBuffer = (rows: FakeRow[], extra: { viewportY: number; baseY?: number }) => ({
  length: rows.length,
  baseY: extra.baseY ?? rows.length - 1,
  viewportY: extra.viewportY,
  getLine: (y: number) => {
    const row = rows[y];
    return row
      ? { isWrapped: row.isWrapped, translateToString: () => row.text }
      : undefined;
  },
});

/**
 * Row whose `translateToString(true)` mirrors xterm's trimmed-cache behavior:
 * real trailing spaces are dropped, while `translateToString(false)` keeps the
 * full row content.
 */
const cacheTrimmingRow = (text: string, isWrapped?: boolean) => ({
  isWrapped,
  translateToString: (trimRight?: boolean) =>
    trimRight ? text.replace(/\s+$/, "") : text,
});

const manualBuffer = (
  rows: Array<ReturnType<typeof cacheTrimmingRow> | ReturnType<typeof xtermRow>>,
  viewportY: number,
) => ({
  length: rows.length,
  baseY: rows.length - 1,
  viewportY,
  getLine: (y: number) => rows[y],
});

/**
 * Row mimicking an xterm buffer line: `text` is the written content (typed
 * spaces included), followed by `nullPad` structural null cells (e.g. the
 * padding xterm leaves when a wide character wraps to the next row).
 * `translateToString(false)` renders null cells as spaces.
 */
const xtermRow = (text: string, isWrapped?: boolean, nullPad = 0) => {
  const length = text.length + nullPad;
  return {
    isWrapped,
    length,
    translateToString: (trimRight?: boolean) =>
      trimRight ? text : text + " ".repeat(length - text.length),
    getCell: (x: number) =>
      x < length
        ? { getCode: () => (x < text.length ? 32 : 0) }
        : undefined,
  };
};

/**
 * Row mimicking an xterm buffer line whose final columns are exactly filled by
 * a double-width glyph: the glyph cell has width 2 and the trailing cell is its
 * width-0 continuation (codepoint 0, renders as nothing — xterm's forward
 * iteration skips it, so `translateToString` yields just `text`).
 */
const wideEndingRow = (text: string, isWrapped?: boolean) => ({
  isWrapped,
  length: text.length + 1,
  translateToString: () => text,
  getCell: (x: number) =>
    x < text.length
      ? { getCode: () => text.codePointAt(x) ?? 0, getWidth: () => (x === text.length - 1 ? 2 : 1) }
      : { getCode: () => 0, getWidth: () => 0 },
});

/** Hard-wrap logical text into fake buffer rows of the given cell width. */
const wrapToRows = (logicalLines: string[], cols: number): FakeRow[] => {
  const rows: FakeRow[] = [];
  for (const line of logicalLines) {
    if (line.length === 0) {
      rows.push({ text: "" });
      continue;
    }
    for (let offset = 0; offset < line.length; offset += cols) {
      rows.push({
        text: line.slice(offset, offset + cols),
        isWrapped: offset > 0,
      });
    }
  }
  return rows;
};

test("captureTerminalReflowScrollAnchor returns null at the top of the buffer", () => {
  const buffer = fakeBuffer([{ text: "line 0" }, { text: "line 1" }], { viewportY: 0 });
  assert.equal(captureTerminalReflowScrollAnchor(buffer as never), null);
});

test("captureTerminalReflowScrollAnchor returns null when the viewport is pinned below baseY", () => {
  const rows = [{ text: "a" }, { text: "b" }, { text: "c" }];
  const buffer = fakeBuffer(rows, { viewportY: 3, baseY: 2 });
  assert.equal(captureTerminalReflowScrollAnchor(buffer as never), null);
});

test("captureTerminalReflowScrollAnchor records the wrapped group start and char offset", () => {
  const rows: FakeRow[] = [
    { text: "head" },
    { text: "long line part one continues here!!", isWrapped: false },
    { text: "and keeps going wrap two", isWrapped: true },
    { text: "wrap three tail", isWrapped: true },
    { text: "tail row", isWrapped: false },
  ];
  const buffer = fakeBuffer(rows, { viewportY: 3 });
  const anchor = captureTerminalReflowScrollAnchor(buffer as never);
  assert.ok(anchor);
  assert.equal(anchor!.startRow, 1);
  assert.equal(anchor!.charOffset, rows[1]!.text.length + rows[2]!.text.length);
  assert.ok(anchor!.textPrefix.startsWith("long line part one"));
});

test("capture/resolve preserve real trailing spaces on wrapped rows across rewrap", () => {
  // "AB   CD" wrapped at width 4 puts the real (typed) spaces at the end of a
  // non-final wrapped row; at width 5 they end up mid-row before "CD".
  const before = manualBuffer([
    cacheTrimmingRow("head"),
    cacheTrimmingRow("AB  "),
    cacheTrimmingRow(" CD", true),
    cacheTrimmingRow("tail"),
  ], 2);
  const anchor = captureTerminalReflowScrollAnchor(before as never);
  assert.ok(anchor);
  assert.equal(anchor!.textPrefix, "AB   CD");
  assert.equal(anchor!.charOffset, 4);

  const after = manualBuffer([
    cacheTrimmingRow("head"),
    cacheTrimmingRow("AB   "),
    cacheTrimmingRow("CD", true),
    cacheTrimmingRow("tail"),
  ], 0);
  const resolvedRow = resolveTerminalReflowScrollAnchor(after as never, anchor!);
  assert.equal(resolvedRow, 1);
});

test("capture/resolve exclude wide-character wrap padding from wrapped rows", () => {
  // "abc中Z" at width 4 renders as "abc " plus a structural null cell on the
  // wrapped row and "中Z" on the next one. Rewrap at width 5 produces
  // "abc中" + "Z", so the padding cell must not take part in the anchor text.
  const before = manualBuffer([
    xtermRow("head"),
    xtermRow("abc", false, 1),
    xtermRow("中Z", true),
  ], 2);
  const anchor = captureTerminalReflowScrollAnchor(before as never);
  assert.ok(anchor);
  assert.equal(anchor!.textPrefix, "abc中Z");
  assert.equal(anchor!.charOffset, 3);

  const after = manualBuffer([
    xtermRow("head"),
    xtermRow("abc中", false, 1),
    xtermRow("Z", true),
  ], 0);
  const resolvedRow = resolveTerminalReflowScrollAnchor(after as never, anchor!);
  assert.equal(resolvedRow, 1);
});

test("capture/resolve keep a wide glyph that exactly ends a wrapped row", () => {
  // "ab中Z" at width 4: the glyph fills the row's final two columns and the
  // trailing cell is its width-0 continuation (codepoint 0) — content, not the
  // structural wrap padding of a glyph that did not fit. Slicing it off would
  // drop the glyph from the anchor text, so a rewrap at width 6 ("ab中" then
  // "Z" vs. "ab中Z" on one row) could no longer match.
  const before = manualBuffer([
    wideEndingRow("head"),
    wideEndingRow("ab中", false),
    cacheTrimmingRow("Z", true),
    cacheTrimmingRow("tail"),
  ], 2);
  const anchor = captureTerminalReflowScrollAnchor(before as never);
  assert.ok(anchor);
  assert.equal(anchor!.textPrefix, "ab中Z");
  assert.equal(anchor!.charOffset, 3);

  const after = manualBuffer([
    wideEndingRow("head"),
    cacheTrimmingRow("ab中Z"),
    cacheTrimmingRow("tail"),
  ], 0);
  const resolvedRow = resolveTerminalReflowScrollAnchor(after as never, anchor!);
  assert.equal(resolvedRow, 1);
});

test("resolveTerminalReflowScrollAnchor re-locates the same content after a column rewrap", () => {
  const logicalLines = Array.from({ length: 60 }, (_, i) =>
    "line " + String(i).padStart(3, "0") + " " + "A    B repeated ".repeat(9));
  const before = wrapToRows(logicalLines, 80);
  const viewportRow = before.findIndex((row) => row.text.startsWith("line 040"));
  const captureBuffer = fakeBuffer(before, { viewportY: viewportRow });
  const anchor = captureTerminalReflowScrollAnchor(captureBuffer as never);
  assert.ok(anchor);

  const after = wrapToRows(logicalLines, 50);
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(after, { viewportY: 0 }) as never,
    anchor!,
  );
  assert.ok(resolvedRow !== null);
  const joinedAfter = after.slice(resolvedRow!).map((r) => r.text).join("");
  const joinedBefore = before.slice(viewportRow).map((r) => r.text).join("");
  assert.equal(joinedAfter.slice(0, 40), joinedBefore.slice(0, 40));
});

test("resolveTerminalReflowScrollAnchor keeps the in-line offset across rewrap", () => {
  const before = wrapToRows(["X".repeat(300)], 80);
  const captureBuffer = fakeBuffer(before, { viewportY: 1 });
  const anchor = captureTerminalReflowScrollAnchor(captureBuffer as never);
  assert.ok(anchor);
  assert.equal(anchor!.charOffset, 80);

  const after = wrapToRows(["X".repeat(300)], 50);
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(after, { viewportY: 0 }) as never,
    anchor!,
  );
  assert.equal(resolvedRow, 1); // 50 chars per row: char 80 lives in row 1
});

test("resolveTerminalReflowScrollAnchor picks the duplicate nearest the original position", () => {
  const rowText = "identical output";
  const rows = Array.from({ length: 10 }, () => ({ text: rowText }));
  const anchor = { startRow: 7, charOffset: 0, textPrefix: rowText, contextSuffix: rowText };
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(rows, { viewportY: 0 }) as never,
    anchor,
  );
  assert.equal(resolvedRow, 7);
});

test("resolveTerminalReflowScrollAnchor returns null when the anchored content is trimmed away", () => {
  const rows = [{ text: "other" }, { text: "content" }];
  const anchor = { startRow: 10, charOffset: 0, textPrefix: "vanished", contextSuffix: null };
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(rows, { viewportY: 0 }) as never,
    anchor,
  );
  assert.equal(resolvedRow, null);
});

test("resolveTerminalReflowScrollAnchor clamps the restored row to baseY", () => {
  const rows = [{ text: "content" }, { text: "more" }];
  const anchor = { startRow: 0, charOffset: 0, textPrefix: "content", contextSuffix: "more" };
  const buffer = fakeBuffer(rows, { viewportY: 0, baseY: 0 });
  const resolvedRow = resolveTerminalReflowScrollAnchor(buffer as never, anchor);
  assert.equal(resolvedRow, 0);
});

test("resolve re-locates the viewed continuation when trim removes the line's first rows", () => {
  // Viewport partway through a long wrapped line; a column shrink on a full
  // scrollback trims the wrapped line's leading rows, so the line's start (and
  // its captured textPrefix) is gone while the viewed characters survive.
  const longLine = "prefix " + "A".repeat(120) + " MARKER-unique-anchor " + "B".repeat(120);
  const before = wrapToRows([longLine], 40);
  const viewportRow = before.findIndex((row) => row.text.includes("MARKER"));
  const captureBuffer = fakeBuffer(before, { viewportY: viewportRow });
  const anchor = captureTerminalReflowScrollAnchor(captureBuffer as never);
  assert.ok(anchor);
  assert.equal(anchor!.startRow, 0);
  assert.ok(anchor!.charOffset > 0);

  // Narrower rewrap, then scrollback trim drops the wrapped line's first two
  // physical rows. xterm keeps the original BufferLine objects, so the first
  // surviving row stays flagged as a wrapped continuation.
  const after = wrapToRows([longLine], 30);
  const trimRows = 2;
  const trimmed = after.slice(trimRows).map((row, i) =>
    i === 0 ? { text: row.text, isWrapped: true } : row);
  // The viewed row (original char 120) lands at surviving row 2.
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(trimmed, { viewportY: 0 }) as never,
    anchor!,
  );
  assert.equal(resolvedRow, 2);
  assert.equal(trimmed[2]!.text, before[3]!.text.slice(0, 30));
});

test("resolve uses a surviving viewed-row marker hint after a mid-line trim", () => {
  // The marker tracks the viewed row: it survives a trim that disposes a
  // marker pinned to the logical line's start, and the seeded scan must
  // resolve from it.
  const longLine = "prefix " + "A".repeat(120) + " MARKER-unique-anchor " + "B".repeat(120);
  const before = wrapToRows([longLine], 40);
  const viewportRow = before.findIndex((row) => row.text.includes("MARKER"));
  const captureBuffer = fakeBuffer(before, { viewportY: viewportRow });
  const anchor = captureTerminalReflowScrollAnchor(captureBuffer as never);
  assert.ok(anchor);

  const after = wrapToRows([longLine], 30);
  const trimRows = 2;
  const trimmed = after.slice(trimRows).map((row, i) =>
    i === 0 ? { text: row.text, isWrapped: true } : row);
  // xterm tracked marker: viewport row 3, pushed to 4 by the rewrap, minus the
  // two trimmed rows.
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(trimmed, { viewportY: 0 }) as never,
    anchor!,
    viewportRow + 1 - trimRows,
  );
  assert.equal(resolvedRow, 2);
});

test("captureTerminalReflowScrollAnchor returns null for a blank line with no following identity", () => {
  const rows = [{ text: "a" }, { text: "" }, { text: "" }, { text: "b" }];
  const buffer = fakeBuffer(rows, { viewportY: 1 });
  assert.equal(captureTerminalReflowScrollAnchor(buffer as never), null);
});

test("blank anchor line is re-located by its following line, not proximity", () => {
  const logicalLines = [
    "header before the blank region",
    "",
    "target line unique beta tail",
    "filler one",
    "filler two",
    "",
    "decoy tail gamma",
  ];
  const before = wrapToRows(logicalLines, 80);
  const viewportRow = before.findIndex((row) => row.text === "" && before.indexOf(row) > 0);
  const captureBuffer = fakeBuffer(before, { viewportY: viewportRow });
  const anchor = captureTerminalReflowScrollAnchor(captureBuffer as never);
  assert.ok(anchor);
  assert.equal(anchor!.textPrefix, "");
  assert.ok(anchor!.contextSuffix!.startsWith("target line unique beta"));

  // Rewrap at a narrower width: the anchored blank line drifts away from its
  // pre-reflow row while the decoy blank line ends up nearer to it.
  const after = wrapToRows(logicalLines, 12);
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(after, { viewportY: 0 }) as never,
    anchor!,
  );
  assert.ok(resolvedRow !== null);
  assert.equal(after[resolvedRow!]!.text, "");
  const joinedAfter = after.slice(resolvedRow!).map((r) => r.text).join("");
  assert.ok(joinedAfter.startsWith("target line unique beta"));
});

test("resolveTerminalReflowScrollAnchor requires the following line to match", () => {
  const rows = [{ text: "" }, { text: "first follower" }, { text: "" }, { text: "other follower" }];
  const anchor = { startRow: 0, charOffset: 0, textPrefix: "", contextSuffix: "other follower" };
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(rows, { viewportY: 0 }) as never,
    anchor,
  );
  assert.equal(resolvedRow, 2);
});

test("resolveTerminalReflowScrollAnchor uses a marker hint far from the stale row", () => {
  // Rewrap pushed the anchored line far down; the tracked marker (hint) points
  // at its new row while the stale anchor row is far above. The seeded scan
  // must find the match next to the hint, not traverse from the stale row.
  const rows = Array.from({ length: 300 }, (_, i) => ({
    text: i === 150 ? "line 001" : i === 151 ? "line 002" : "filler " + String(i).padStart(3, "0"),
  }));
  const anchor = { startRow: 1, charOffset: 0, textPrefix: "line 001", contextSuffix: "line 002" };
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(rows, { viewportY: 0 }) as never,
    anchor,
    150,
  );
  assert.equal(resolvedRow, 150);
});

test("resolveTerminalReflowScrollAnchor falls back to a full scan when the hint misses", () => {
  const rows = wrapToRows(["target unique alpha", "filler beta", "filler gamma"], 80);
  const anchor = { startRow: 0, charOffset: 0, textPrefix: "target unique alpha", contextSuffix: "filler beta" };
  // Hint points nowhere near matching content; the stale-row scan must still
  // find the match.
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(rows, { viewportY: 0 }) as never,
    anchor,
    2,
  );
  assert.equal(resolvedRow, 0);
});
