import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureTerminalReflowScrollAnchor,
  resolveTerminalReflowScrollAnchor,
} from "./terminalHelpers";

type FakeRow = { isWrapped?: boolean; text: string };

const fakeBuffer = (
  rows: FakeRow[],
  extra: { viewportY: number; baseY?: number; cursorY?: number },
) => ({
  length: rows.length,
  baseY: extra.baseY ?? rows.length - 1,
  viewportY: extra.viewportY,
  cursorY: extra.cursorY,
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
 * Final row whose canonical trimmed translation is served from a cached
 * untrimmed value with `trimEnd()`: typed trailing spaces are dropped, while
 * a fresh translation with explicit columns keeps them (typed spaces are
 * content; a fresh trim cuts only trailing null cells).
 */
const cacheTrimmedFinalRow = (text: string) => ({
  isWrapped: false,
  length: text.length,
  translateToString: (trimRight?: boolean, startCol?: number, endCol?: number) => {
    if (startCol === undefined && endCol === undefined) {
      return trimRight ? text.replace(/\s+$/, "") : text;
    }
    return text;
  },
});

/** Row mirroring xterm's fresh translation: typed trailing spaces survive. */
const xtermFreshRow = (text: string, isWrapped?: boolean) => ({
  isWrapped,
  length: text.length,
  translateToString: () => text,
});

/**
 * Row mimicking an xterm buffer line: `text` is the written content (typed
 * spaces included), followed by `nullPad` structural null cells (e.g. the
 * padding xterm leaves when a wide character wraps to the next row).
 * `translateToString(false)` renders null cells as spaces.
 */
const xtermRow = (text: string, isWrapped?: boolean, nullPad = 0, firstCellWidth = 1) => {
  const length = text.length + nullPad;
  return {
    isWrapped,
    length,
    translateToString: (trimRight?: boolean) =>
      trimRight ? text : text + " ".repeat(length - text.length),
    getCell: (x: number) =>
      x < length
        ? {
            getCode: () => (x < text.length ? 32 : 0),
            // Real xterm cells always report a width: wide-character wrap
            // padding and ordinary blank cells have width 1; `firstCellWidth`
            // models a row whose first column holds a double-width glyph.
            getWidth: () => (x === 0 ? firstCellWidth : 1),
          }
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

/**
 * Row mimicking an xterm buffer line holding double-width glyphs: each glyph
 * occupies two cells (a width-2 first cell carrying the character, plus a
 * width-0 null continuation), followed by `nullPad` trailing null cells that
 * render as spaces. Exercises the cell-to-character mapping the grow-padding
 * check relies on: one glyph is one JavaScript character but two cell
 * columns.
 */
const wideCharRow = (text: string, isWrapped?: boolean, nullPad = 0) => {
  const length = text.length * 2 + nullPad;
  return {
    isWrapped,
    length,
    translateToString: () => text + " ".repeat(nullPad),
    getCell: (x: number) => {
      if (x >= length) return undefined;
      if (x < text.length * 2) {
        return {
          getCode: () => (x % 2 === 0 ? text.codePointAt(x / 2) ?? 0 : 0),
          getWidth: () => (x % 2 === 0 ? 2 : 0),
          getString: () => (x % 2 === 0 ? text[x / 2] : ""),
        };
      }
      return { getCode: () => 0, getWidth: () => 1, getString: () => "" };
    },
  };
};

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
    xtermRow("中Z", true, 0, 2),
  ], 2);
  const anchor = captureTerminalReflowScrollAnchor(before as never);
  assert.ok(anchor);
  assert.equal(anchor!.textPrefix, "abc中Z");
  assert.equal(anchor!.charOffset, 3);

  // The rewrapped row holds "abc中" with no trailing null: the glyph ends
  // exactly at the new column count, and a null ahead of the normal-width
  // "Z" continuation would be a real blank, not padding.
  const after = manualBuffer([
    xtermRow("head"),
    xtermRow("abc中", false),
    xtermRow("Z", true),
  ], 0);
  const resolvedRow = resolveTerminalReflowScrollAnchor(after as never, anchor!);
  assert.equal(resolvedRow, 1);
});

test("capture/resolve keep a null cell ahead of a normal-width continuation", () => {
  // "abc " plus a null cell (erased or skipped — not wide-character padding,
  // since the continuation "Z" is normal-width) renders as "abc Z". Stripping
  // the null would read the anchor as "abcZ" while a wider rewrap joins the
  // same content as "abc Z", so the resolver could not re-locate it.
  const before = manualBuffer([
    xtermRow("head"),
    xtermRow("abc", false, 1),
    xtermRow("Z", true),
  ], 2);
  const anchor = captureTerminalReflowScrollAnchor(before as never);
  assert.ok(anchor);
  assert.equal(anchor!.textPrefix, "abc Z");

  const after = manualBuffer([
    xtermRow("head"),
    xtermRow("abc Z"),
  ], 0);
  const resolvedRow = resolveTerminalReflowScrollAnchor(after as never, anchor!);
  assert.equal(resolvedRow, 1);
});

test("capture/resolve strip only the structural wide-wrap padding cell", () => {
  // A tab or cursor-forward move can leave additional null cells before a wide
  // glyph is written at the final column. Only the last null is xterm's
  // structural wrap padding — the earlier nulls are real blanks that xterm
  // preserves during reflow — so the anchor must read "abc 中Z", not "abc中Z".
  const before = manualBuffer([
    xtermRow("head"),
    xtermRow("abc", false, 2),
    xtermRow("中Z", true, 0, 2),
  ], 2);
  const anchor = captureTerminalReflowScrollAnchor(before as never);
  assert.ok(anchor);
  assert.equal(anchor!.textPrefix, "abc 中Z");
  assert.equal(anchor!.charOffset, 4);

  // After widening, the same content joins as "abc 中" + "Z".
  const after = manualBuffer([
    xtermRow("head"),
    xtermRow("abc 中"),
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

test("resolve adjusts a repeating viewed window by the derived trim delta", () => {
  // The viewed window is a long run of one character, so it repeats
  // throughout the line: content alone re-matches it at the stale pre-trim
  // offset. The captured line length must supply the trim delta.
  const longLine = "prompt " + "A".repeat(950);
  const before = wrapToRows([longLine], 40);
  const viewportRow = 5;
  const captureBuffer = fakeBuffer(before, { viewportY: viewportRow });
  const anchor = captureTerminalReflowScrollAnchor(captureBuffer as never);
  assert.ok(anchor);
  assert.equal(anchor!.charOffset, 200);
  assert.equal(anchor!.lineLength, longLine.length);

  const after = wrapToRows([longLine], 30);
  const trimRows = 2; // 60 leading characters trimmed with the first rows
  const trimmed = after.slice(trimRows).map((row, i) =>
    i === 0 ? { text: row.text, isWrapped: true } : row);
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(trimmed, { viewportY: 0 }) as never,
    anchor!,
  );
  // The viewed characters moved back by the trimmed 60: char 200 now sits at
  // surviving offset 140, inside row 4 of the 30-column rewrap. A stale
  // pre-trim offset would land in row 6.
  assert.equal(resolvedRow, 4);
});

test("capture skips the whole-line measurement when no trim can reach the line", () => {
  // A scrollback with ample headroom below its row capacity: even the
  // worst-case row growth of a 40→30 column shrink cannot overflow past the
  // rows above the anchored line, so the trim delta can never be needed and
  // the expensive whole-line measurement is skipped.
  const lines = ["head ".repeat(8).trim(), ("body-" + "A".repeat(700) + "-tail")];
  const before = wrapToRows(lines, 40);
  const viewportRow = before.findIndex((row) => row.text.includes("tail"));
  assert.ok(viewportRow > 1);
  const captureBuffer = fakeBuffer(before, { viewportY: viewportRow });

  const unlimited = captureTerminalReflowScrollAnchor(captureBuffer as never);
  assert.ok(unlimited);
  assert.equal(unlimited!.lineLength, lines[1]!.length);

  // Capacity 250 rows vs a 19-row buffer: worst overflow 19 + 19*40/30 - 250 < 0,
  // so no trim can occur at all and the anchored line is never reached.
  const limited = captureTerminalReflowScrollAnchor(captureBuffer as never, {
    maxRows: 250,
    oldCols: 40,
    newCols: 30,
  });
  assert.ok(limited);
  assert.equal(limited!.startRow, unlimited!.startRow);
  assert.equal(limited!.charOffset, unlimited!.charOffset);
  assert.equal(limited!.lineLength, undefined);

  // Resolution is unchanged: the untrimmed line keeps the plain offset.
  const after = wrapToRows(lines, 30);
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(after, { viewportY: 0 }) as never,
    limited!,
  );
  const unlimitedResolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(after, { viewportY: 0 }) as never,
    unlimited!,
  );
  assert.equal(resolvedRow, unlimitedResolvedRow);
  assert.ok(resolvedRow !== null);
});

test("capture still measures the whole line when a trim can reach it", () => {
  // Buffer at its row capacity with a wide shrink: trim can eat into the
  // anchored line, so the exact line length must still be captured.
  const longLine = "prompt " + "A".repeat(950);
  const before = wrapToRows([longLine], 40);
  const captureBuffer = fakeBuffer(before, { viewportY: 5 });
  const anchor = captureTerminalReflowScrollAnchor(captureBuffer as never, {
    maxRows: before.length, // full scrollback
    oldCols: 40,
    newCols: 30,
  });
  assert.ok(anchor);
  assert.equal(anchor!.lineLength, longLine.length);

  // The derived trim delta still disambiguates the repeating viewed window.
  const after = wrapToRows([longLine], 30);
  const trimRows = 2;
  const trimmed = after.slice(trimRows).map((row, i) =>
    i === 0 ? { text: row.text, isWrapped: true } : row);
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(trimmed, { viewportY: 0 }) as never,
    anchor!,
  );
  assert.equal(resolvedRow, 4);
});

test("resolve adjusts a repeating viewed window on a line beyond the old length cap", () => {
  // A 9,000-character single logical line: the exact line length must still
  // be captured so the trim delta stays exact — content matching alone
  // cannot find the window in the repetitive run, and a stale pre-trim
  // offset would land the viewport below the surviving position.
  const longLine = "prompt " + "A".repeat(8993);
  const before = wrapToRows([longLine], 40);
  const captureBuffer = fakeBuffer(before, { viewportY: 200 }); // charOffset 8000
  const anchor = captureTerminalReflowScrollAnchor(captureBuffer as never);
  assert.ok(anchor);
  assert.equal(anchor!.charOffset, 8000);
  assert.equal(anchor!.lineLength, longLine.length);

  const after = wrapToRows([longLine], 30);
  const trimRows = 2; // 60 leading characters trimmed with the first rows
  const trimmed = after.slice(trimRows).map((row, i) =>
    i === 0 ? { text: row.text, isWrapped: true } : row);
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(trimmed, { viewportY: 0 }) as never,
    anchor!,
  );
  // The viewed characters moved back by the trimmed 60: char 8000 now sits
  // at surviving offset 7940, in row 264 of the 30-column rewrap. A stale
  // pre-trim offset would land in row 266.
  assert.equal(resolvedRow, 264);
});

test("resolve adjusts a self-repeating textPrefix match on a trimmed line", () => {
  // The captured textPrefix is itself a run of one character, so it
  // coincidentally re-matches the trimmed suffix at row 0 and the primary
  // path must shrink its offset by the trim delta too.
  const longLine = "A".repeat(1000);
  const before = wrapToRows([longLine], 40);
  const captureBuffer = fakeBuffer(before, { viewportY: 5 });
  const anchor = captureTerminalReflowScrollAnchor(captureBuffer as never);
  assert.ok(anchor);
  assert.equal(anchor!.charOffset, 200);

  const after = wrapToRows([longLine], 30);
  const trimRows = 2;
  const trimmed = after.slice(trimRows).map((row, i) =>
    i === 0 ? { text: row.text, isWrapped: true } : row);
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(trimmed, { viewportY: 0 }) as never,
    anchor!,
  );
  // Char 200 survives at surviving offset 140, in row 4 — not row 6, where
  // the stale pre-trim offset would place it.
  assert.equal(resolvedRow, 4);
});

test("resolve constrains the seeded scan to the marker's containing line on a continuation", () => {
  // The viewport starts deep inside a long wrapped line whose identical copy
  // follows shortly after: the marker row (the viewed continuation) is
  // closer to the duplicate's start than to the original line's start, so a
  // proximity scan seeded from the marker would jump into the duplicate. The
  // seeded scan must only claim the marker's own logical line.
  const lineText = "line-start-unique-" + "A".repeat(300);
  const follower = "follower tail beta";
  const logicalLines = [lineText, follower, "gap filler row", lineText, follower];
  const before = wrapToRows(logicalLines, 40);
  const viewportRow = 7; // deep inside the original line's wrapped rows
  const anchor = captureTerminalReflowScrollAnchor(
    fakeBuffer(before, { viewportY: viewportRow }) as never,
  );
  assert.ok(anchor);
  assert.ok(anchor!.charOffset > 0);

  const after = wrapToRows(logicalLines, 30);
  // xterm tracked the viewed row (chars 280..) to row 9 of the rewrap; the
  // duplicate's start (row 13) is 4 rows from it, the original's start
  // (row 0) is 9 rows away.
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(after, { viewportY: 0 }) as never,
    anchor!,
    9,
  );
  assert.equal(resolvedRow, 9);
  assert.equal(after[resolvedRow!]!.text, lineText.slice(280, 310));
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

test("resolve keeps the surviving marker when the truncated cursor line is the anchor", () => {
  // The viewport starts partway into the cursor's own long wrapped line.
  // Narrowing with the pinned `reflowCursorLine: false` default does not
  // rewrap that line: it truncates every physical row in place, keeping the
  // row indices while changing the row lengths the captured char offset maps
  // through. The repetitive text keeps the primary match alive, and the
  // stale offset then overrides the exact surviving viewport-row marker —
  // the resolver must retain the marker instead.
  const cursorLine = "prompt " + "A".repeat(400);
  const before = wrapToRows(["header unique alpha", cursorLine], 40);
  const viewportRow = 5; // partway into the cursor line (rows 1..11)
  const captureBuffer = fakeBuffer(before, {
    viewportY: viewportRow,
    baseY: before.length - 1,
    cursorY: 0,
  });
  const anchor = captureTerminalReflowScrollAnchor(captureBuffer as never);
  assert.ok(anchor);
  assert.ok(anchor!.charOffset > 0);

  // After the 40→30 shrink the header keeps its single row and the cursor
  // line keeps every physical row, each truncated to the new column count.
  const afterRows: FakeRow[] = before.map((row, i) =>
    i === 0 ? row : { text: row.text.slice(0, 30), isWrapped: row.isWrapped });
  // The marker tracks the viewed row, whose index the truncation leaves at 5.
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(afterRows, { viewportY: 0, baseY: afterRows.length - 1, cursorY: 0 }) as never,
    anchor!,
    viewportRow,
  );
  // The stale offset would map char 160 through the truncated 30-column rows
  // to row 6; the marker row is exact.
  assert.equal(resolvedRow, viewportRow);
});

test("follower bound counts the anchored line's first physical row", () => {
  // The follower bound must cover the whole logical line: excluding the
  // line's first row leaves the count reflow-variable, because that row's
  // length changes with the column count. A line just past the bound then
  // captures a follower at a wide first row that the resolver drops at a
  // narrow one, rejecting the otherwise unchanged anchor.
  const longLine = "head " + "A".repeat(262_200);
  const follower = "follower tail beta";
  const before = wrapToRows([longLine, follower], 200);
  const captureBuffer = fakeBuffer(before, { viewportY: 1 });
  const anchor = captureTerminalReflowScrollAnchor(captureBuffer as never);
  assert.ok(anchor);
  // The whole line (262,305 characters) sits past the bound at either
  // column count, so the follower identity is dropped on both sides and the
  // anchor degrades to its own text instead of failing to resolve after a
  // rewrap that changes the first row's length.
  assert.equal(anchor!.contextSuffix, null);

  const after = wrapToRows([longLine, follower], 100);
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(after, { viewportY: 0 }) as never,
    anchor!,
  );
  // The plain charOffset rewraps exactly (the line itself is not the cursor
  // line): captured char 200 sits at row 2 of the 100-column rewrap.
  assert.equal(resolvedRow, 2);
});

test("captureTerminalReflowScrollAnchor returns null for a blank line with no following identity", () => {
  // Only blank lines follow the anchored one: no non-blank context exists to
  // identify it, so every blank line would match and capture must decline.
  const rows = [{ text: "a" }, { text: "" }, { text: "" }];
  const buffer = fakeBuffer(rows, { viewportY: 1 });
  assert.equal(captureTerminalReflowScrollAnchor(buffer as never), null);
});

test("blank anchor line inside a blank run re-locates via the next non-blank line", () => {
  // The viewport starts on the first of two consecutive blank lines, so the
  // immediate follower is blank too: the context must skip the blank run to
  // borrow the identity of the unique output after it.
  const logicalLines = [
    "header before the blank region",
    "",
    "",
    "target line unique beta tail",
    "filler one",
    "",
    "decoy tail gamma",
  ];
  const before = wrapToRows(logicalLines, 80);
  const captureBuffer = fakeBuffer(before, { viewportY: 1 });
  const anchor = captureTerminalReflowScrollAnchor(captureBuffer as never);
  assert.ok(anchor);
  assert.equal(anchor!.textPrefix, "");
  assert.ok(anchor!.contextSuffix!.startsWith("target line unique beta"));

  // Rewrap at a narrower width: the anchored blank line drifts away from its
  // pre-reflow row while the decoy blank line ends up elsewhere in the run.
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

test("capture keeps typed trailing spaces when the final row's trim hits the string cache", () => {
  // The anchored logical line ends with typed spaces on its final row: the
  // canonical trimmed translation is served from a cached untrimmed value via
  // trimEnd() and drops them, while a column shrink rewraps the line and
  // moves those spaces onto a wrapped row the resolver reads untrimmed.
  const before = manualBuffer([
    cacheTrimmingRow("head"),
    cacheTrimmedFinalRow("AB   "),
    cacheTrimmingRow("tail"),
  ], 1);
  const anchor = captureTerminalReflowScrollAnchor(before as never);
  assert.ok(anchor);
  assert.equal(anchor!.textPrefix, "AB   ");
  assert.equal(anchor!.charOffset, 0);

  // Narrower rewrap: the trailing spaces move onto a wrapped row, which the
  // resolver reads untrimmed — the capture must have kept them.
  const after = manualBuffer([
    cacheTrimmingRow("head"),
    xtermFreshRow("AB "),
    xtermFreshRow("  ", true),
    cacheTrimmingRow("tail"),
  ], 0);
  const resolvedRow = resolveTerminalReflowScrollAnchor(after as never, anchor!);
  assert.equal(resolvedRow, 1);
});

test("resolve keeps the anchored line when the following cursor line is truncated", () => {
  // The anchored line sits directly above the cursor's prompt line. Narrowing
  // with the pinned `reflowCursorLine: false` default skips rewrapping the
  // cursor line and truncates its rows, so the captured follower text no
  // longer matches even though the anchored line survived.
  const before = fakeBuffer([
    { text: "header" },
    { text: "anchored unique alpha" },
    { text: "cursor prompt tail" },
  ], { viewportY: 1, baseY: 2, cursorY: 0 });
  const anchor = captureTerminalReflowScrollAnchor(before as never);
  assert.ok(anchor);
  assert.equal(anchor!.contextSuffix, "cursor prompt tail");

  // After the shrink the anchored line rewraps into two rows while the cursor
  // line keeps its old row structure truncated to the new column count.
  const after = fakeBuffer([
    { text: "header" },
    { text: "anchored uni" },
    { text: "que alpha", isWrapped: true },
    { text: "cursor promp" },
  ], { viewportY: 0, baseY: 3, cursorY: 0 });
  const resolvedRow = resolveTerminalReflowScrollAnchor(after as never, anchor!);
  assert.equal(resolvedRow, 1);
});

test("resolve still rejects the anchored line when a non-cursor follower changes", () => {
  // Without cursor information the follower identity must stay strict: a
  // changed follower means the anchored content cannot be validated.
  const rows = [
    { text: "header" },
    { text: "anchored unique alpha" },
    { text: "cursor promp" },
  ];
  const anchor = {
    startRow: 1,
    charOffset: 0,
    textPrefix: "anchored unique alpha",
    contextSuffix: "cursor prompt tail",
  };
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(rows, { viewportY: 0 }) as never,
    anchor,
  );
  assert.equal(resolvedRow, null);
});

test("resolve re-locates the viewed continuation past a truncated cursor follower", () => {
  // Viewport partway into a long wrapped line; the following line is the
  // cursor line, which a narrowing resize truncates instead of rewrapping.
  // The continuation fallback must not reject the surviving line just because
  // its follower text changed.
  const before = fakeBuffer([
    { text: "M".repeat(10), isWrapped: false },
    { text: "M".repeat(10), isWrapped: true },
    { text: "M".repeat(10), isWrapped: true },
    { text: "cursor line tail" },
  ], { viewportY: 1, baseY: 3, cursorY: 0 });
  const anchor = captureTerminalReflowScrollAnchor(before as never);
  assert.ok(anchor);
  assert.equal(anchor!.charOffset, 10);

  // Column shrink to 8 with a scrollback trim of the first 8 characters; the
  // cursor line keeps its old structure truncated to 10 columns.
  const after = fakeBuffer([
    { text: "M".repeat(8), isWrapped: true },
    { text: "M".repeat(8), isWrapped: true },
    { text: "M".repeat(6), isWrapped: true },
    { text: "cursor lin" },
  ], { viewportY: 0, baseY: 3, cursorY: 0 });
  const resolvedRow = resolveTerminalReflowScrollAnchor(after as never, anchor!);
  // Original char 10 (the viewport top) is surviving char 2, in row 0.
  assert.equal(resolvedRow, 0);
});

test("resolve keeps the anchored line when a multi-row cursor follower is truncated", () => {
  // The cursor line spans two physical rows. A narrowing resize truncates each
  // of its rows separately, so the joined surviving follower text (`ABCDEFGH`
  // + `KLMNOPQR`) is not a prefix of the captured one (`ABCDEFGHIJ` +
  // `KLMNOPQRST`); the row-wise tolerance must still validate the anchor.
  const before = fakeBuffer([
    { text: "header" },
    { text: "anchored unique alpha" },
    { text: "ABCDEFGHIJ" },
    { text: "KLMNOPQRST", isWrapped: true },
  ], { viewportY: 1, baseY: 3, cursorY: 0 });
  const anchor = captureTerminalReflowScrollAnchor(before as never);
  assert.ok(anchor);
  assert.equal(anchor!.contextSuffix, "ABCDEFGHIJKLMNOPQRST");

  // After the shrink the anchored line rewraps into two rows while each row of
  // the multi-row cursor line keeps its leading characters only.
  const after = fakeBuffer([
    { text: "header" },
    { text: "anchored uni" },
    { text: "que alpha", isWrapped: true },
    { text: "ABCDEFGH" },
    { text: "KLMNOPQR", isWrapped: true },
  ], { viewportY: 0, baseY: 4, cursorY: 0 });
  const resolvedRow = resolveTerminalReflowScrollAnchor(after as never, anchor!);
  assert.equal(resolvedRow, 1);
});

test("resolve re-locates the viewed continuation past a multi-row truncated cursor follower", () => {
  // Viewport partway into a long wrapped line; the following line is the
  // multi-row cursor line, whose rows a narrowing resize truncates separately.
  // The row-wise follower identity must not reject the surviving line.
  const before = fakeBuffer([
    { text: "M".repeat(10), isWrapped: false },
    { text: "M".repeat(10), isWrapped: true },
    { text: "M".repeat(10), isWrapped: true },
    { text: "ABCDEFGHIJ" },
    { text: "KLMNOPQRST", isWrapped: true },
  ], { viewportY: 1, baseY: 4, cursorY: 0 });
  const anchor = captureTerminalReflowScrollAnchor(before as never);
  assert.ok(anchor);
  assert.equal(anchor!.charOffset, 10);

  // Column shrink to 8: the anchored line rewraps normally while the cursor
  // line keeps its old row structure truncated row by row.
  const after = fakeBuffer([
    { text: "M".repeat(8), isWrapped: false },
    { text: "M".repeat(8), isWrapped: true },
    { text: "M".repeat(8), isWrapped: true },
    { text: "M".repeat(6), isWrapped: true },
    { text: "ABCDEFGH" },
    { text: "KLMNOPQR", isWrapped: true },
  ], { viewportY: 0, baseY: 5, cursorY: 0 });
  const resolvedRow = resolveTerminalReflowScrollAnchor(after as never, anchor!);
  // Original char 10 (the viewport top) is surviving char 10, in row 1.
  assert.equal(resolvedRow, 1);
});

test("resolve still rejects a multi-row follower that does not continue the captured text", () => {
  // The row-wise cursor-line tolerance must not accept a follower whose rows
  // cannot be placed in the captured follower text.
  const rows = [
    { text: "header" },
    { text: "anchored unique alpha" },
    { text: "ZZZZZZZZ" },
    { text: "YYYYYYYY", isWrapped: true },
  ];
  const anchor = {
    startRow: 1,
    charOffset: 0,
    textPrefix: "anchored unique alpha",
    contextSuffix: "ABCDEFGHIJKLMNOPQRST",
  };
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(rows, { viewportY: 0, cursorY: 0 }) as never,
    anchor,
  );
  assert.equal(resolvedRow, null);
});

test("resolve rejects a cursor follower whose rows sit inside the captured text with gaps", () => {
  // The row-wise cursor-line tolerance compares each surviving row against
  // the row captured at the same position. Rows that merely occur as ordered
  // substrings of the captured follower text — with gaps between them that
  // are not the truncated tails of the corresponding original rows — must
  // not validate a duplicate of the anchored line.
  const rows = [
    { text: "header" },
    { text: "anchored unique alpha" },
    { text: "ABCDE" },
    { text: "JKLMNOP", isWrapped: true },
  ];
  const anchor = {
    startRow: 1,
    charOffset: 0,
    textPrefix: "anchored unique alpha",
    contextSuffix: "ABCDEFGHIJKLMNOPQRST",
    contextRowTexts: ["ABCDEFGHIJ", "KLMNOPQRST"],
  };
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(rows, { viewportY: 0, cursorY: 0 }) as never,
    anchor,
  );
  assert.equal(resolvedRow, null);
});

test("resolve declines the row-wise tolerance for an anchor without captured row boundaries", () => {
  // Without the captured row boundaries the per-row identity cannot be
  // verified, so the tolerance declines even for rows that appear as ordered
  // substrings of the captured text.
  const rows = [
    { text: "header" },
    { text: "anchored unique alpha" },
    { text: "ABCDE" },
    { text: "JKLMNOP", isWrapped: true },
  ];
  const anchor = {
    startRow: 1,
    charOffset: 0,
    textPrefix: "anchored unique alpha",
    contextSuffix: "ABCDEFGHIJKLMNOPQRST",
  };
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(rows, { viewportY: 0, cursorY: 0 }) as never,
    anchor,
  );
  assert.equal(resolvedRow, null);
});

test("resolve keeps the anchored line when a multi-row cursor follower wider than the context cap is truncated", () => {
  // The captured suffix is a bounded prefix of the follower line, so its cap
  // can fall mid-row: the last captured row is then itself a truncated
  // prefix of the original row, and the surviving row — truncated to the new
  // column count on top of that — must still be verified against it.
  const before = fakeBuffer([
    { text: "header" },
    { text: "anchored unique alpha" },
    { text: "A".repeat(60) },
    { text: "B".repeat(60), isWrapped: true },
  ], { viewportY: 1, baseY: 3, cursorY: 0 });
  const anchor = captureTerminalReflowScrollAnchor(before as never);
  assert.ok(anchor);
  assert.equal(anchor!.contextSuffix, "A".repeat(60) + "B".repeat(36));
  assert.deepEqual(anchor!.contextRowTexts, ["A".repeat(60), "B".repeat(36)]);

  // Column shrink: each cursor-line row keeps its leading characters only.
  const after = fakeBuffer([
    { text: "header" },
    { text: "anchored uni" },
    { text: "que alpha", isWrapped: true },
    { text: "A".repeat(50) },
    { text: "B".repeat(30), isWrapped: true },
  ], { viewportY: 0, baseY: 4, cursorY: 0 });
  const resolvedRow = resolveTerminalReflowScrollAnchor(after as never, anchor!);
  assert.equal(resolvedRow, 1);
});

test("resolve keeps the anchored line when a multi-row cursor follower is null-padded by a column grow", () => {
  // A column grow does not reflow the cursor line: xterm expands each of its
  // physical rows to the new column count with trailing null cells instead.
  // `reflowAnchorRowText` keeps that padding on non-final wrapped rows, so the
  // surviving row text is longer than the captured one and the one-directional
  // prefix check rejects the valid anchor. The row-wise tolerance must accept
  // the grow padding while still rejecting extra written characters.
  const before = fakeBuffer([
    { text: "header" },
    { text: "anchored unique alpha" },
    { text: "ABCDEFGHIJ" },
    { text: "KLMNOPQRST", isWrapped: true },
  ], { viewportY: 1, baseY: 3, cursorY: 0 });
  const anchor = captureTerminalReflowScrollAnchor(before as never);
  assert.ok(anchor);
  assert.equal(anchor!.contextSuffix, "ABCDEFGHIJKLMNOPQRST");
  assert.deepEqual(anchor!.contextRowTexts, ["ABCDEFGHIJ", "KLMNOPQRST"]);

  // Column grow to 14: the anchored line rewraps into two rows while each
  // cursor-line row keeps its content plus four trailing null cells.
  const after = {
    length: 5,
    baseY: 4,
    viewportY: 0,
    cursorY: 0,
    getLine: (y: number) => [
      { isWrapped: false, length: 6, translateToString: () => "header" },
      xtermRow("anchored uniq"),
      xtermRow("ue alpha", true),
      xtermRow("ABCDEFGHIJ", false, 4),
      xtermRow("KLMNOPQRST", true, 4),
    ][y],
  };
  const resolvedRow = resolveTerminalReflowScrollAnchor(after as never, anchor!);
  assert.equal(resolvedRow, 1);
});

test("resolve keeps a wide-character cursor follower null-padded by a column grow", () => {
  // A captured row's JavaScript length is not its cell column count: a
  // double-width glyph is one character but two cells. The grow-padding check
  // must start at the cell the captured prefix ends on, not at cell index
  // `captured.length` — otherwise it inspects a glyph as padding and rejects
  // the valid anchor, falling back to the stale row.
  const before = fakeBuffer([
    { text: "header" },
    { text: "anchored unique alpha" },
    { text: "中中中中中" },
    { text: "甲乙丙丁戊", isWrapped: true },
  ], { viewportY: 1, baseY: 3, cursorY: 0 });
  const anchor = captureTerminalReflowScrollAnchor(before as never);
  assert.ok(anchor);
  assert.equal(anchor!.contextSuffix, "中中中中中甲乙丙丁戊");
  assert.deepEqual(anchor!.contextRowTexts, ["中中中中中", "甲乙丙丁戊"]);

  // Column grow to 14 columns: each wide-character cursor-line row keeps its
  // content (10 cells) plus four trailing null cells.
  const after = {
    length: 5,
    baseY: 4,
    viewportY: 0,
    cursorY: 0,
    getLine: (y: number) => [
      { isWrapped: false, length: 6, translateToString: () => "header" },
      xtermRow("anchored uniq"),
      xtermRow("ue alpha", true),
      wideCharRow("中中中中中", false, 4),
      wideCharRow("甲乙丙丁戊", true, 4),
    ][y],
  };
  const resolvedRow = resolveTerminalReflowScrollAnchor(after as never, anchor!);
  assert.equal(resolvedRow, 1);
});

test("resolve still rejects a multi-row cursor follower with extra written characters after a grow", () => {
  // Null-cell padding is structural, but written content beyond the captured
  // prefix is not: a row that grew real characters must keep the tolerance
  // rejected even though its text starts with the captured row.
  const rows = [
    { text: "header" },
    { text: "anchored unique alpha" },
    { text: "ABCDEFGHIJKL" },
    { text: "KLMNOPQRST", isWrapped: true },
  ];
  const anchor = {
    startRow: 1,
    charOffset: 0,
    textPrefix: "anchored unique alpha",
    contextSuffix: "ABCDEFGHIJKLMNOPQRST",
    contextRowTexts: ["ABCDEFGHIJ", "KLMNOPQRST"],
  };
  const buffer = {
    length: rows.length,
    baseY: rows.length - 1,
    viewportY: 0,
    cursorY: 0,
    getLine: (y: number) =>
      y >= 0 && y < rows.length
        ? xtermRow(rows[y]!.text, rows[y]!.isWrapped)
        : undefined,
  };
  const resolvedRow = resolveTerminalReflowScrollAnchor(buffer as never, anchor);
  assert.equal(resolvedRow, null);
});
