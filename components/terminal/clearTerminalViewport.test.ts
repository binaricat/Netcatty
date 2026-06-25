import assert from "node:assert/strict";
import test from "node:test";

import {
  clearTerminalViewport,
  shouldPreserveViewportBeforeFullErase,
  shouldWipeScrollbackAfterFullErase,
} from "./clearTerminalViewport.ts";

const createMockTerm = (bufferType: "normal" | "alternate"): { buffer: { active: { type: "normal" | "alternate" } } } => ({
  buffer: {
    active: {
      type: bufferType,
    },
  },
});

test("preserves viewport before full erase on the normal screen outside sync blocks", () => {
  const term = createMockTerm("normal");
  assert.equal(shouldPreserveViewportBeforeFullErase(term as never, false), true);
});

test("skips viewport preservation inside DEC 2026 sync blocks", () => {
  const term = createMockTerm("normal");
  assert.equal(shouldPreserveViewportBeforeFullErase(term as never, true), false);
});

test("skips viewport preservation on the alternate screen", () => {
  const term = createMockTerm("alternate");
  assert.equal(shouldPreserveViewportBeforeFullErase(term as never, false), false);
});

test("skips viewport preservation when full erase should wipe scrollback", () => {
  const term = createMockTerm("normal");
  assert.equal(shouldPreserveViewportBeforeFullErase(term as never, false, true), false);
});

test("wipes scrollback after full erase only on the normal screen outside sync blocks", () => {
  assert.equal(shouldWipeScrollbackAfterFullErase(createMockTerm("normal") as never, false, true), true);
  assert.equal(shouldWipeScrollbackAfterFullErase(createMockTerm("normal") as never, true, true), false);
  assert.equal(shouldWipeScrollbackAfterFullErase(createMockTerm("alternate") as never, false, true), false);
  assert.equal(shouldWipeScrollbackAfterFullErase(createMockTerm("normal") as never, false, false), false);
});

test("local clear writes erase-scrollback when requested", () => {
  const writes: string[] = [];
  const term = {
    rows: 5,
    buffer: {
      active: {
        type: "normal",
        baseY: 0,
        cursorY: 2,
        cursorX: 4,
      },
    },
    _core: {
      scroll: () => {},
      _inputHandler: {
        _eraseAttrData: () => ({}),
      },
    },
    write: (payload: string, callback?: () => void) => {
      writes.push(payload);
      callback?.();
    },
    scrollToBottom: () => {},
  };

  clearTerminalViewport(term as never, { wipeScrollback: true });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].includes("\x1b[3J"), true);
});

test("local clear preserves scrollback when erase-scrollback is not requested", () => {
  const writes: string[] = [];
  const term = {
    rows: 5,
    buffer: {
      active: {
        type: "normal",
        baseY: 0,
        cursorY: 2,
        cursorX: 4,
      },
    },
    _core: {
      scroll: () => {},
      _inputHandler: {
        _eraseAttrData: () => ({}),
      },
    },
    write: (payload: string, callback?: () => void) => {
      writes.push(payload);
      callback?.();
    },
    scrollToBottom: () => {},
  };

  clearTerminalViewport(term as never, { wipeScrollback: false });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].includes("\x1b[3J"), false);
});
