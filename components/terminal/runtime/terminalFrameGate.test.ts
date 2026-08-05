import assert from "node:assert/strict";
import test from "node:test";

import {
  apportionFrameGateIngress,
  collapseAndSplit,
  endsWithSyncOpenerPrefix,
  isDroppableVisualPayload,
  makesFullRepaint,
  payloadContainsSgr,
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
  assert.equal(isDroppableVisualPayload("\r\tplain text"), true);
  assert.equal(isDroppableVisualPayload("\nrepaint"), false, "LF can scroll scrollback");
  assert.equal(isDroppableVisualPayload("\r\n\tplain text"), false, "LF not droppable");
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
  assert.equal(isDroppableVisualPayload("\x1b[1S"), false, "SU scrolls buffer");
  assert.equal(isDroppableVisualPayload("\x1b[1T"), false, "SD scrolls buffer");
});

// ---- viewportRepaintCoverage / makesFullRepaint ---------------------------

test("coverage counts distinct written cells, with wrap", () => {
  // Paints only count after an origin reset (CUP/home — not ED2 alone).
  assert.equal(viewportRepaintCoverage(`${HOME}abcd`, 4, 1), 4);
  assert.equal(viewportRepaintCoverage(`${HOME}abcd`, 2, 2), 4); // wraps to second row
  assert.equal(viewportRepaintCoverage(`${HOME}ab`, 4, 1), 2);
  assert.equal(viewportRepaintCoverage("abcd", 4, 1), 0, "no origin → no coverage");
});

test("coverage honors cursor positioning and erases", () => {
  // ED2 is not coverage — may be stripped later when scrolled up.
  assert.equal(viewportRepaintCoverage("\x1b[2J", 4, 2), 0, "ED2 grants no coverage credit");
  // ED2 does not home the cursor; paints after ED2 without CUP stay uncounted.
  assert.equal(
    viewportRepaintCoverage(`\x1b[2J${"z".repeat(8)}`, 4, 2),
    0,
    "ED2 alone is not a known origin",
  );
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

test("makesFullRepaint rejects partial paints even when well above 40% coverage", () => {
  const cols = 10;
  const rows = 10;
  // 60% of cells — previously accepted under the 0.4 bar, must now fail.
  const partial = `${HOME}${"z".repeat(Math.floor(cols * rows * 0.6))}`;
  assert.equal(makesFullRepaint(partial, cols, rows), false);
  // 98% is still short of the 0.99 bar (must not drop prior frames).
  const almost = `${HOME}${"z".repeat(98)}`;
  assert.equal(makesFullRepaint(almost, cols, rows), false);
  // ED2 alone is not a full repaint (may be stripped when scrolled up).
  assert.equal(makesFullRepaint("\x1b[2J", cols, rows), false);
  // Near-full (>= 99%) is accepted: 99 of 100 cells.
  const nearFull = `${HOME}${"z".repeat(99)}`;
  assert.equal(makesFullRepaint(nearFull, cols, rows), true);
  // Exact full coverage is accepted.
  const full = `${HOME}${"z".repeat(100)}`;
  assert.equal(makesFullRepaint(full, cols, rows), true);
});

test("collapse keeps SGR-bearing frames when the successor has no SGR", () => {
  const sgrOnly = `${ON}${HOME}\x1b[31m${OFF}`;
  // Full-viewport successor without SGR would otherwise drop the SGR frame and
  // leave xterm on the previous color/style for the plain paint.
  const plainFull = `${ON}${HOME}${"x".repeat(8)}${OFF}`;
  const buffer = sgrOnly + plainFull;
  const result = collapseAndSplit(buffer, (content) => makesFullRepaint(content, 4, 2));
  assert.equal(result.dropped, 0, "must not drop SGR when successor omits SGR");
  assert.ok(result.complete.includes("\x1b[31m"));
  assert.equal(payloadContainsSgr("\x1b[1;1H\x1b[31mtext"), true);
  assert.equal(payloadContainsSgr("\x1b[1;1Hplain"), false);
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
  // Mid-coverage successor (~50%) must not drop the predecessor.
  const halfNext = frame("z".repeat(Math.floor((cols * rows) / 2)));
  assert.equal(collapseAndSplit(stale + halfNext, pred).dropped, 0);
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

test("ED3 does not count as viewport coverage for full-repaint drops", () => {
  const cols = 4;
  const rows = 2;
  // ED3 alone must not mark any viewport cells.
  assert.equal(viewportRepaintCoverage("\x1b[3J", cols, rows), 0, "ED3 covers zero viewport cells");
  assert.equal(makesFullRepaint("\x1b[3J", cols, rows), false, "ED3 is not a full viewport repaint");
  // ED2 also grants no coverage (may be stripped when scrolled up).
  assert.equal(viewportRepaintCoverage("\x1b[2J", cols, rows), 0, "ED2 grants no coverage credit");
  // A successor that only does ED3 must not justify dropping a prior visual frame.
  const stale = frame("AAAAAAAA");
  const ed3Only = frame("\x1b[3J");
  const pred = (c: string) => makesFullRepaint(c, cols, rows);
  assert.equal(collapseAndSplit(stale + ed3Only, pred).dropped, 0, "ED3 successor must not drop prior frame");
});

test("8-bit C1 controls make a frame un-droppable", () => {
  // C1 CSI (0x9B) and OSC (0x9D) would otherwise fall through as printable text.
  assert.equal(isDroppableVisualPayload("\x9b1;1Hplain"), false, "C1 CSI");
  assert.equal(isDroppableVisualPayload("\x9d0;title\x07"), false, "C1 OSC");
  assert.equal(isDroppableVisualPayload("hello\x90data\x9c"), false, "C1 DCS");
  // Unicode cell text above the C1 range remains droppable.
  assert.equal(isDroppableVisualPayload("café中文"), true, "printable Unicode cell text");
});

test("coverage ignores OSC/DCS control-string payloads (not cell paints)", () => {
  const cols = 4;
  const rows = 2;
  // Long OSC title would falsely fill the viewport if payload bytes were counted.
  const oscBel = "\x1b]0;" + "T".repeat(cols * rows * 2) + "\x07";
  const oscSt = "\x1b]0;" + "T".repeat(cols * rows * 2) + "\x1b\\";
  assert.equal(viewportRepaintCoverage(oscBel, cols, rows), 0, "OSC … BEL covers zero cells");
  assert.equal(viewportRepaintCoverage(oscSt, cols, rows), 0, "OSC … ST covers zero cells");
  assert.equal(makesFullRepaint(oscBel, cols, rows), false, "OSC-only is not a full repaint");
  // DCS / APC / PM / SOS payloads are likewise not paints.
  assert.equal(viewportRepaintCoverage("\x1bP1$r\x1b\\", cols, rows), 0, "DCS");
  assert.equal(viewportRepaintCoverage("\x1b_payload\x1b\\", cols, rows), 0, "APC");
  assert.equal(viewportRepaintCoverage("\x1b^payload\x1b\\", cols, rows), 0, "PM");
  assert.equal(viewportRepaintCoverage("\x1bXpayload\x1b\\", cols, rows), 0, "SOS");
  // C1 forms: OSC (0x9D) + BEL, DCS (0x90) + C1 ST (0x9C).
  assert.equal(viewportRepaintCoverage("\x9d0;title\x07", cols, rows), 0, "C1 OSC");
  assert.equal(viewportRepaintCoverage("\x90data\x9c", cols, rows), 0, "C1 DCS");
  // Real cell writes after origin + OSC still count; OSC itself does not inflate.
  assert.equal(viewportRepaintCoverage(`${HOME}${oscBel}ab`, cols, rows), 2, "cells after OSC still count");
  // A short paint padded with OSC must not pass the full-repaint bar.
  const shortPlusOsc = `${HOME}z${oscBel}`;
  assert.equal(makesFullRepaint(shortPlusOsc, cols, rows), false, "OSC must not inflate partial paint");
  // Predecessor must not drop when successor is only OSC noise.
  const stale = frame("AAAAAAAA");
  const oscOnly = frame(oscBel);
  const pred = (c: string) => makesFullRepaint(c, cols, rows);
  assert.equal(collapseAndSplit(stale + oscOnly, pred).dropped, 0, "OSC successor must not drop prior frame");
  // CSI H only after paints must not retroactively validate those paints.
  assert.equal(
    viewportRepaintCoverage(`ab${HOME}`, cols, rows),
    0,
    "origin at end does not count preceding cells",
  );
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
