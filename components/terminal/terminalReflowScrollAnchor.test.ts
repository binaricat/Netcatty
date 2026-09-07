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
  const anchor = { startRow: 7, charOffset: 0, textPrefix: rowText };
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(rows, { viewportY: 0 }) as never,
    anchor,
  );
  assert.equal(resolvedRow, 7);
});

test("resolveTerminalReflowScrollAnchor returns null when the anchored content is trimmed away", () => {
  const rows = [{ text: "other" }, { text: "content" }];
  const anchor = { startRow: 10, charOffset: 0, textPrefix: "vanished" };
  const resolvedRow = resolveTerminalReflowScrollAnchor(
    fakeBuffer(rows, { viewportY: 0 }) as never,
    anchor,
  );
  assert.equal(resolvedRow, null);
});

test("resolveTerminalReflowScrollAnchor clamps the restored row to baseY", () => {
  const rows = [{ text: "content" }, { text: "more" }];
  const anchor = { startRow: 0, charOffset: 0, textPrefix: "content" };
  const buffer = fakeBuffer(rows, { viewportY: 0, baseY: 0 });
  const resolvedRow = resolveTerminalReflowScrollAnchor(buffer as never, anchor);
  assert.equal(resolvedRow, 0);
});
