import assert from "node:assert/strict";
import test from "node:test";

import {
  createSyncBlockFilterState,
  filterSyncBlockClears,
  isTerminalViewportScrolledUp,
  SYNC_BLOCK_SCROLLBACK_STRIP_MIN_ROWS,
} from "./filterSyncBlockClears.ts";

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const CLEAR = "\x1b[2J";
const CURSOR_HOME = "\x1b[H";

const scrolledUpTerm = {
  rows: 24,
  buffer: { active: { type: "normal" as const, viewportY: 0, baseY: 5 } },
};

const liveBottomTerm = {
  rows: 24,
  buffer: { active: { type: "normal" as const, viewportY: 10, baseY: 10 } },
};

/** One row behind bottom — sticky lag / trackpad jitter, must not strip (#2291). */
const nearBottomLagTerm = {
  rows: 24,
  buffer: { active: { type: "normal" as const, viewportY: 9, baseY: 10 } },
};

/** Exact strip threshold: baseY - viewportY === SYNC_BLOCK_SCROLLBACK_STRIP_MIN_ROWS. */
const thresholdScrollTerm = {
  rows: 24,
  buffer: { active: { type: "normal" as const, viewportY: 8, baseY: 10 } },
};

const alternateScreenTerm = {
  rows: 24,
  buffer: { active: { type: "alternate" as const, viewportY: 0, baseY: 5 } },
};

test("passes through data with no synchronized-output sequences", () => {
  const state = createSyncBlockFilterState();
  const input = "hello\r\n\x1b[2Jworld\r\n";

  assert.equal(filterSyncBlockClears(input, state), input);
  assert.equal(state.inSyncBlock, false);
});

test("keeps cursor-home and strips clear for full-screen redraw while scrolled up", () => {
  const state = createSyncBlockFilterState();
  const input = `${SYNC_START}${CURSOR_HOME}${CLEAR}frame${SYNC_END}`;

  assert.equal(
    filterSyncBlockClears(input, state, scrolledUpTerm as never),
    `${SYNC_START}${CURSOR_HOME}frame${SYNC_END}`,
  );
  assert.equal(state.inSyncBlock, false);
});

test("passes full-screen redraw clears through at the live bottom", () => {
  const state = createSyncBlockFilterState();
  const input = `${SYNC_START}${CURSOR_HOME}${CLEAR}frame${SYNC_END}`;

  assert.equal(filterSyncBlockClears(input, state, liveBottomTerm as never), input);
});

test("does not strip full redraw when only one row behind the live bottom (#2291)", () => {
  const state = createSyncBlockFilterState();
  const input = `${SYNC_START}${CURSOR_HOME}${CLEAR}frame${SYNC_END}`;

  assert.equal(filterSyncBlockClears(input, state, nearBottomLagTerm as never), input);
});

test("strips clear at exactly the scrollback threshold boundary", () => {
  const state = createSyncBlockFilterState();
  const input = `${SYNC_START}${CURSOR_HOME}${CLEAR}frame${SYNC_END}`;

  assert.equal(isTerminalViewportScrolledUp(thresholdScrollTerm as never), true);
  assert.equal(
    filterSyncBlockClears(input, state, thresholdScrollTerm as never),
    `${SYNC_START}${CURSOR_HOME}frame${SYNC_END}`,
  );
});

test("re-checks scroll when clear arrives after held home (return to bottom)", () => {
  const mutableTerm = {
    rows: 24,
    buffer: { active: { type: "normal" as const, viewportY: 0, baseY: 5 } },
  };
  const state = createSyncBlockFilterState();

  assert.equal(filterSyncBlockClears(SYNC_START, state, mutableTerm as never), SYNC_START);
  assert.equal(filterSyncBlockClears(CURSOR_HOME, state, mutableTerm as never), "");
  assert.equal(state.pendingCursorHome, CURSOR_HOME);

  // User returns to the live bottom before the clear chunk arrives.
  mutableTerm.buffer.active.viewportY = 5;
  mutableTerm.buffer.active.baseY = 5;

  assert.equal(
    filterSyncBlockClears(`${CLEAR}frame${SYNC_END}`, state, mutableTerm as never),
    `${CURSOR_HOME}${CLEAR}frame${SYNC_END}`,
  );
});

test("does not strip full redraw on the alternate screen", () => {
  const state = createSyncBlockFilterState();
  const input = `${SYNC_START}${CURSOR_HOME}${CLEAR}frame${SYNC_END}`;

  assert.equal(filterSyncBlockClears(input, state, alternateScreenTerm as never), input);
});

test("stacked agent frames keep home so the second frame cannot append under the first (#2291)", () => {
  const state = createSyncBlockFilterState();
  const frameA = `${SYNC_START}${CURSOR_HOME}${CLEAR}AAA${SYNC_END}`;
  const frameB = `${SYNC_START}${CURSOR_HOME}${CLEAR}BBB${SYNC_END}`;

  assert.equal(
    filterSyncBlockClears(frameA, state, scrolledUpTerm as never),
    `${SYNC_START}${CURSOR_HOME}AAA${SYNC_END}`,
  );
  assert.equal(
    filterSyncBlockClears(frameB, state, scrolledUpTerm as never),
    `${SYNC_START}${CURSOR_HOME}BBB${SYNC_END}`,
  );
});

test("passes incremental sync blocks through unchanged", () => {
  const state = createSyncBlockFilterState();
  const rowMove = "\x1b[5;1H";
  const input = `${SYNC_START}${rowMove}partial${SYNC_END}`;

  assert.equal(filterSyncBlockClears(input, state), input);
});

test("passes clear-screen outside synchronized-output blocks", () => {
  const state = createSyncBlockFilterState();

  assert.equal(filterSyncBlockClears(CLEAR, state), CLEAR);
});

test("passes standalone clear inside sync blocks that are not full redraws", () => {
  const state = createSyncBlockFilterState();
  const input = `${SYNC_START}${CLEAR}frame${SYNC_END}`;

  assert.equal(filterSyncBlockClears(input, state), input);
});

test("tracks full redraw state across chunks", () => {
  const state = createSyncBlockFilterState();

  assert.equal(filterSyncBlockClears(SYNC_START, state, scrolledUpTerm as never), SYNC_START);
  assert.equal(filterSyncBlockClears(CURSOR_HOME, state, scrolledUpTerm as never), "");
  assert.equal(state.pendingCursorHome, CURSOR_HOME);

  assert.equal(filterSyncBlockClears(CLEAR, state, scrolledUpTerm as never), CURSOR_HOME);
  assert.equal(
    filterSyncBlockClears(`frame${SYNC_END}`, state, scrolledUpTerm as never),
    `frame${SYNC_END}`,
  );
});

test("releases held cursor-home when sync block ends without clear", () => {
  const state = createSyncBlockFilterState();

  assert.equal(filterSyncBlockClears(SYNC_START, state, scrolledUpTerm as never), SYNC_START);
  assert.equal(filterSyncBlockClears(CURSOR_HOME, state, scrolledUpTerm as never), "");
  assert.equal(
    filterSyncBlockClears(`partial${SYNC_END}`, state, scrolledUpTerm as never),
    `${CURSOR_HOME}partial${SYNC_END}`,
  );
});

test("handles sync markers split across chunks", () => {
  const state = createSyncBlockFilterState();
  const startPrefix = SYNC_START.slice(0, -1);
  const startSuffix = SYNC_START.slice(-1);

  assert.equal(filterSyncBlockClears(startPrefix, state, scrolledUpTerm as never), "");
  assert.equal(
    filterSyncBlockClears(
      `${startSuffix}${CURSOR_HOME}${CLEAR}frame${SYNC_END}`,
      state,
      scrolledUpTerm as never,
    ),
    `${SYNC_START}${CURSOR_HOME}frame${SYNC_END}`,
  );
});

test("handles clear-screen marker split across chunks inside full redraw block", () => {
  const state = createSyncBlockFilterState();
  const clearPrefix = CLEAR.slice(0, -1);
  const clearSuffix = CLEAR.slice(-1);

  assert.equal(filterSyncBlockClears(SYNC_START, state, scrolledUpTerm as never), SYNC_START);
  assert.equal(filterSyncBlockClears(CURSOR_HOME, state, scrolledUpTerm as never), "");
  assert.equal(filterSyncBlockClears(clearPrefix, state, scrolledUpTerm as never), "");
  assert.equal(
    filterSyncBlockClears(`${clearSuffix}frame${SYNC_END}`, state, scrolledUpTerm as never),
    `${CURSOR_HOME}frame${SYNC_END}`,
  );
});

test("keeps explicit home and strips clear inside full redraw blocks while scrolled up", () => {
  const state = createSyncBlockFilterState();
  const cursorHome = "\x1b[1;1H";
  const input = `${SYNC_START}${cursorHome}${CLEAR}text${SYNC_END}`;

  assert.equal(
    filterSyncBlockClears(input, state, scrolledUpTerm as never),
    `${SYNC_START}${cursorHome}text${SYNC_END}`,
  );
});

test("isTerminalViewportScrolledUp is false at the live bottom", () => {
  assert.equal(isTerminalViewportScrolledUp(liveBottomTerm as never), false);
});

test("isTerminalViewportScrolledUp is false for a one-row lag (#2291)", () => {
  assert.equal(isTerminalViewportScrolledUp(nearBottomLagTerm as never), false);
});

test("isTerminalViewportScrolledUp becomes true at the configured row threshold", () => {
  assert.equal(
    thresholdScrollTerm.buffer.active.baseY - thresholdScrollTerm.buffer.active.viewportY,
    SYNC_BLOCK_SCROLLBACK_STRIP_MIN_ROWS,
  );
  assert.equal(isTerminalViewportScrolledUp(thresholdScrollTerm as never), true);
  assert.equal(isTerminalViewportScrolledUp(nearBottomLagTerm as never), false);
});

test("isTerminalViewportScrolledUp is true when reading scrollback", () => {
  assert.equal(isTerminalViewportScrolledUp(scrolledUpTerm as never), true);
});

test("isTerminalViewportScrolledUp is false on alternate screen", () => {
  assert.equal(isTerminalViewportScrolledUp(alternateScreenTerm as never), false);
});

test("isTerminalViewportScrolledUp is false when buffer is missing", () => {
  assert.equal(isTerminalViewportScrolledUp({ rows: 24 } as never), false);
});

/**
 * Chunk boundaries that land mid-escape must hold back only the split
 * sequence. Scanning longest-suffix-first held back everything from the
 * chunk's *first* ESC, so escape-dense frames (60fps TUI, per-cell truecolor
 * backgrounds) starved xterm for whole chunks at a time and released ~1MB
 * bursts once a chunk happened to end cleanly.
 */
const escapeDenseFrame = (cells: number): string => {
  let out = SYNC_START + "\x1b[1;1H";
  for (let i = 0; i < cells; i += 1) {
    out += `\x1b[0m\x1b[38;5;245m\x1b[48;2;${i % 256};128;200m#`;
  }
  return out + SYNC_END;
};

test("a mid-escape chunk boundary holds back only the split sequence", () => {
  const state = createSyncBlockFilterState();
  const frame = escapeDenseFrame(4000);
  // Split inside the trailing `\x1b[48;2;...m` of some cell.
  const cut = frame.lastIndexOf("\x1b[48;2;", frame.length - 40) + 6;
  const emitted = filterSyncBlockClears(frame.slice(0, cut), state);

  assert.ok(
    state.pending.length < 32,
    `pending should hold one partial sequence, held ${state.pending.length} bytes`,
  );
  assert.equal(emitted + state.pending, frame.slice(0, cut));
});

test("escape-dense frames stream through without withholding whole chunks", () => {
  const state = createSyncBlockFilterState();
  const stream = escapeDenseFrame(4000) + escapeDenseFrame(4000);
  const CHUNK = 8192;
  let emitted = "";
  let emptyEmits = 0;

  for (let i = 0; i < stream.length; i += CHUNK) {
    const output = filterSyncBlockClears(stream.slice(i, i + CHUNK), state);
    if (output.length === 0) emptyEmits += 1;
    emitted += output;
    assert.ok(
      state.pending.length < CHUNK,
      `pending must not accumulate across chunks, reached ${state.pending.length} bytes`,
    );
  }

  assert.equal(emptyEmits, 0, "every chunk should release data to xterm");
  assert.equal(emitted + state.pending, stream);
});
