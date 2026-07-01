import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { Terminal as XTerm } from "@xterm/xterm";

import {
  filterTerminalSessionData,
  resetTerminalSyncBlockFilter,
  SYNC_BLOCK_TIMEOUT_MS,
} from "./terminalSyncBlockFilter.ts";

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const CLEAR = "\x1b[2J";
const CURSOR_HOME = "\x1b[H";

const createMockTerm = (): XTerm => ({
  rows: 24,
  buffer: {
    active: {
      type: "normal",
      viewportY: 0,
      baseY: 5,
    },
  },
} as XTerm);

test("abandoned sync blocks stop stripping full redraw clears after timeout", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const term = createMockTerm();

  try {
    resetTerminalSyncBlockFilter(term);
    assert.equal(filterTerminalSessionData(term, SYNC_START), SYNC_START);
    assert.equal(filterTerminalSessionData(term, CURSOR_HOME), "");
    assert.equal(filterTerminalSessionData(term, CLEAR), "");

    mock.timers.tick(SYNC_BLOCK_TIMEOUT_MS);
    assert.equal(filterTerminalSessionData(term, CLEAR), CLEAR);
  } finally {
    resetTerminalSyncBlockFilter(term);
    mock.timers.reset();
  }
});

test("completed sync blocks clear the timeout without waiting", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const term = createMockTerm();

  try {
    resetTerminalSyncBlockFilter(term);
    assert.equal(
      filterTerminalSessionData(term, `${SYNC_START}${CURSOR_HOME}${CLEAR}frame${SYNC_END}`),
      `${SYNC_START}frame${SYNC_END}`,
    );

    mock.timers.tick(SYNC_BLOCK_TIMEOUT_MS);
    assert.equal(filterTerminalSessionData(term, CLEAR), CLEAR);
  } finally {
    resetTerminalSyncBlockFilter(term);
    mock.timers.reset();
  }
});

test("passes incremental sync blocks through unchanged", () => {
  const term = createMockTerm();
  resetTerminalSyncBlockFilter(term);

  assert.equal(
    filterTerminalSessionData(term, `${SYNC_START}\x1b[5;1Hframe${SYNC_END}`),
    `${SYNC_START}\x1b[5;1Hframe${SYNC_END}`,
  );
});

test("sync block timeout preserves pending partial marker bytes", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const term = createMockTerm();

  try {
    resetTerminalSyncBlockFilter(term);
    assert.equal(filterTerminalSessionData(term, SYNC_START), SYNC_START);
    assert.equal(filterTerminalSessionData(term, "color\x1b"), "color");

    mock.timers.tick(SYNC_BLOCK_TIMEOUT_MS);
    assert.equal(filterTerminalSessionData(term, "[31mtext"), "\x1b[31mtext");
  } finally {
    resetTerminalSyncBlockFilter(term);
    mock.timers.reset();
  }
});
