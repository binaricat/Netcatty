import assert from "node:assert/strict";
import test from "node:test";

import {
  apportionFrameGateIngress,
  collapseAndSplit,
  endsWithSyncOpenerPrefix,
  isDroppableVisualPayload,
  makesFullRepaint,
  viewportRepaintCoverage,
} from "./terminalFrameGate.ts";

const ON = "\x1b[?2026h";
const OFF = "\x1b[?2026l";
const HOME = "\x1b[1;1H";
const frame = (paint: string) => `${ON}${HOME}${paint}${OFF}`;
// Most collapse tests isolate the frame-boundary logic; a permissive predicate
// treats every homing successor as a full repaint.
const always = () => true;

test("no frames: everything is complete, nothing held", () => {
  assert.deepEqual(collapseAndSplit("plain text", always), {
    complete: "plain text",
    partial: "",
    dropped: 0,
  });
});

test("a trailing unterminated frame is held as partial", () => {
  const a = frame("A");
  const partialFrame = `${ON}${HOME}half`;
  assert.deepEqual(collapseAndSplit(a + partialFrame, always), {
    complete: a,
    partial: partialFrame,
    dropped: 0,
  });
});

test("collapses a run of full-repaint frames to the last", () => {
  const a = frame("A");
  const b = frame("B");
  const c = frame("C");
  const r = collapseAndSplit(a + b + c, always);
  assert.equal(r.complete, c);
  assert.equal(r.dropped, a.length + b.length);
});

test("collapses complete frames but still holds a trailing partial", () => {
  const a = frame("A");
  const b = frame("B");
  const partialFrame = `${ON}${HOME}new`;
  const r = collapseAndSplit(a + b + partialFrame, always);
  assert.equal(r.complete, b);
  assert.equal(r.partial, partialFrame);
  assert.equal(r.dropped, a.length);
});

test("does not drop across a non-empty gap between frames", () => {
  const a = frame("A");
  const b = frame("B");
  const input = a + "\r\n" + b;
  assert.deepEqual(collapseAndSplit(input, always), { complete: input, partial: "", dropped: 0 });
});

test("does not drop when the successor is not a full repaint", () => {
  const a = frame("AAAA");
  const b = frame("B");
  const input = a + b;
  // Predicate rejects the successor → nothing collapses.
  assert.deepEqual(collapseAndSplit(input, () => false), { complete: input, partial: "", dropped: 0 });
});

test("does not drop a frame whose payload is not purely visual", () => {
  const bell = `${ON}${HOME}ping\x07${OFF}`; // carries a BEL
  const b = frame("B");
  const input = bell + b;
  assert.deepEqual(collapseAndSplit(input, always), { complete: input, partial: "", dropped: 0 });
});

// ---- isDroppableVisualPayload ---------------------------------------------

test("droppable payload: cursor moves, SGR, erase and text are allowed", () => {
  assert.equal(isDroppableVisualPayload("\x1b[1;1H\x1b[38;5;5mabc\x1b[K"), true);
  assert.equal(isDroppableVisualPayload("\r\n\tplain text"), true);
  assert.equal(isDroppableVisualPayload("\x1b[2Jfull"), true);
});

test("un-droppable payload: side-effecting sequences are rejected", () => {
  assert.equal(isDroppableVisualPayload("bell\x07"), false, "BEL");
  assert.equal(isDroppableVisualPayload("\x1b]0;title\x07"), false, "OSC");
  assert.equal(isDroppableVisualPayload("\x1b[6n"), false, "device status report query");
  assert.equal(isDroppableVisualPayload("\x1b[?25l"), false, "private mode");
  assert.equal(isDroppableVisualPayload("\x1b[?1049h"), false, "alt-screen");
  assert.equal(isDroppableVisualPayload("\x1bP1;2q\x1b\\"), false, "DCS");
  assert.equal(isDroppableVisualPayload("\x1b[c"), false, "device attributes");
});

// ---- viewportRepaintCoverage / makesFullRepaint ---------------------------

test("coverage counts distinct written cells, with wrap", () => {
  assert.equal(viewportRepaintCoverage("abcd", 4, 1), 4);
  assert.equal(viewportRepaintCoverage("abcd", 2, 2), 4); // wraps to second row
  assert.equal(viewportRepaintCoverage("ab", 4, 1), 2);
});

test("coverage honors cursor positioning and erases", () => {
  assert.equal(viewportRepaintCoverage("\x1b[2J", 4, 2), 8, "erase-all covers the grid");
  assert.equal(viewportRepaintCoverage("\x1b[1;1H\x1b[K", 4, 2), 4, "erase-line covers one row");
  // CUP to row 2 then one char covers a single cell there.
  assert.equal(viewportRepaintCoverage("\x1b[2;3Hx", 4, 2), 1);
});

test("makesFullRepaint accepts a whole-screen paint and rejects a small update", () => {
  const cols = 4;
  const rows = 2;
  const fullPaint = `${HOME}${"z".repeat(cols * rows)}`; // writes every cell
  const smallPaint = `${HOME}z`; // one cell
  assert.equal(makesFullRepaint(fullPaint, cols, rows), true);
  assert.equal(makesFullRepaint(smallPaint, cols, rows), false);
  // SGR-heavy small update must not pass on byte length alone.
  const sgrHeavySmall = `${HOME}\x1b[38;2;1;2;3m\x1b[48;2;4;5;6mz`;
  assert.equal(makesFullRepaint(sgrHeavySmall, cols, rows), false);
});

test("collapse drops only when coverage proves a full repaint", () => {
  const cols = 4;
  const rows = 2;
  const pred = (c: string) => makesFullRepaint(c, cols, rows);
  const stale = frame("AAAAAAAA");
  const fullNext = frame("z".repeat(cols * rows));
  const smallNext = frame("z");
  // Full-repaint successor → predecessor dropped.
  assert.equal(collapseAndSplit(stale + fullNext, pred).dropped, stale.length);
  // Small successor → nothing dropped.
  assert.equal(collapseAndSplit(stale + smallNext, pred).dropped, 0);
});

// ---- ingress apportioning --------------------------------------------------

test("ingress apportioning always sums back to the total", () => {
  const cases: Array<[number, number, number, number, number]> = [
    [1000, 1000, 400, 400, 200],
    [1500, 1000, 400, 400, 200],
    [700, 1000, 400, 400, 200],
    [999, 1000, 333, 333, 334],
    [0, 0, 0, 0, 0],
    [500, 500, 0, 0, 500],
    [500, 500, 500, 0, 0],
    [500, 500, 0, 500, 0],
  ];
  for (const [total, totalChars, fwd, drop, held] of cases) {
    const s = apportionFrameGateIngress(total, totalChars, fwd, drop, held);
    assert.equal(s.forward + s.dropped + s.held, total);
    assert.ok(s.forward >= 0 && s.dropped >= 0 && s.held >= 0);
  }
});

test("ingress apportioning routes bytes to the right bucket in the exact case", () => {
  assert.deepEqual(apportionFrameGateIngress(1000, 1000, 400, 400, 200), {
    forward: 400,
    dropped: 400,
    held: 200,
  });
});

test("ED3 (clear scrollback) makes a frame un-droppable", () => {
  assert.equal(isDroppableVisualPayload("\x1b[1;1H\x1b[2Jrepaint"), true, "ED2 viewport clear is fine");
  assert.equal(isDroppableVisualPayload("\x1b[1;1H\x1b[3Jrepaint"), false, "ED3 clears scrollback");
});

test("holds back a split sync opener as partial", () => {
  // Buffer ends mid-opener (ESC[?20); it must be held, not forwarded.
  const r = collapseAndSplit("hello\x1b[?20", always);
  assert.equal(r.complete, "hello");
  assert.equal(r.partial, "\x1b[?20");
  assert.equal(r.dropped, 0);
});

test("endsWithSyncOpenerPrefix detects a split opener tail", () => {
  assert.equal(endsWithSyncOpenerPrefix("abc\x1b[?2026"), true);
  assert.equal(endsWithSyncOpenerPrefix("abc\x1b"), true);
  assert.equal(endsWithSyncOpenerPrefix("abc\x1b[?2026h"), false, "complete opener is not a prefix hold");
  assert.equal(endsWithSyncOpenerPrefix("plain"), false);
});
