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
  rows: ReturnType<typeof cacheTrimmingRow>[],
  viewportY: number,
) => ({
  length: rows.length,
  baseY: rows.length - 1,
  viewportY,
  getLine: (y: number) => rows[y],
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
