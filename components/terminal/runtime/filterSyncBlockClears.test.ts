import assert from "node:assert/strict";
import test from "node:test";

import {
  createSyncBlockFilterState,
  filterSyncBlockClears,
  isTerminalViewportScrolledUp,
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

test("passes through data with no synchronized-output sequences", () => {
  const state = createSyncBlockFilterState();
  const input = "hello\r\n\x1b[2Jworld\r\n";

  assert.equal(filterSyncBlockClears(input, state), input);
  assert.equal(state.inSyncBlock, false);
});

test("strips home and clear for full-screen redraw sync blocks", () => {
  const state = createSyncBlockFilterState();
  const input = `${SYNC_START}${CURSOR_HOME}${CLEAR}frame${SYNC_END}`;

  assert.equal(
    filterSyncBlockClears(input, state, scrolledUpTerm as never),
    `${SYNC_START}frame${SYNC_END}`,
  );
  assert.equal(state.inSyncBlock, false);
});

test("passes full-screen redraw clears through at the live bottom", () => {
  const state = createSyncBlockFilterState();
  const input = `${SYNC_START}${CURSOR_HOME}${CLEAR}frame${SYNC_END}`;

  assert.equal(filterSyncBlockClears(input, state, liveBottomTerm as never), input);
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

  assert.equal(filterSyncBlockClears(CLEAR, state, scrolledUpTerm as never), "");
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
    `${SYNC_START}frame${SYNC_END}`,
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
    `frame${SYNC_END}`,
  );
});

test("leaves non-home redraw sequences inside full redraw blocks intact", () => {
  const state = createSyncBlockFilterState();
  const cursorHome = "\x1b[1;1H";
  const input = `${SYNC_START}${cursorHome}${CLEAR}text${SYNC_END}`;

  assert.equal(
    filterSyncBlockClears(input, state, scrolledUpTerm as never),
    `${SYNC_START}text${SYNC_END}`,
  );
});

test("isTerminalViewportScrolledUp is false at the live bottom", () => {
  assert.equal(isTerminalViewportScrolledUp(liveBottomTerm as never), false);
});

test("isTerminalViewportScrolledUp is true when reading scrollback", () => {
  assert.equal(isTerminalViewportScrolledUp(scrolledUpTerm as never), true);
});
