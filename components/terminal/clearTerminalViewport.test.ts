import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/xterm";

import {
  appendEraseScrollbackAfterFullErases,
  clearTerminalViewport,
  clearTerminalViewportAndSyncPty,
  installEraseInDisplayHandlers,
  isDec2026SyncModeParams,
  isEraseBelowSequence,
  preserveTerminalViewportInScrollback,
  shouldPreserveViewportBeforeEraseBelow,
  shouldPreserveViewportBeforeFullErase,
  shouldScrollOnEraseInDisplay,
  shouldWipeScrollbackAfterFullErase,
} from "./clearTerminalViewport.ts";

const { Terminal } = xterm;

const createMockTerm = (
  bufferType: "normal" | "alternate",
  cursor: { cursorX?: number; cursorY?: number } = {},
): { buffer: { active: { type: "normal" | "alternate"; cursorX: number; cursorY: number } } } => ({
  buffer: {
    active: {
      type: bufferType,
      cursorX: cursor.cursorX ?? 0,
      cursorY: cursor.cursorY ?? 0,
    },
  },
});

type RegisteredCsiHandler = {
  id: { prefix?: string; final: string };
  callback: (params: Array<number | number[]>) => boolean | Promise<boolean>;
  disposed: boolean;
};

const createEraseHandlerHarness = (
  options: {
    bufferType?: "normal" | "alternate";
    clearWipesScrollback?: boolean;
    cursorX?: number;
    cursorY?: number;
    inDec2026SyncBlock?: boolean;
    scrollTop?: number;
    scrollBottom?: number;
  } = {},
) => {
  const handlers: RegisteredCsiHandler[] = [];
  const microtasks: Array<() => void> = [];
  const trimStartCalls: number[] = [];
  const onScrollPositions: number[] = [];
  const scrollRegion = {
    lines: {
      length: options.clearWipesScrollback ? 9 : 5,
      trimStart: (count: number) => {
        trimStartCalls.push(count);
        scrollRegion.lines.length -= count;
      },
    },
    scrollTop: options.scrollTop ?? 0,
    scrollBottom: options.scrollBottom ?? 4,
    ybase: options.clearWipesScrollback ? 4 : 0,
    ydisp: options.clearWipesScrollback ? 4 : 0,
  };
  const observedScrollRegions: Array<[number, number]> = [];
  const term = {
    rows: 5,
    options: {
      scrollOnEraseInDisplay: false,
    },
    parser: {
      registerCsiHandler: (id: { prefix?: string; final: string }, callback: RegisteredCsiHandler["callback"]) => {
        const handler = {
          id,
          callback,
          disposed: false,
        };
        handlers.push(handler);
        return {
          dispose: () => {
            handler.disposed = true;
          },
        };
      },
    },
    buffer: {
      active: {
        type: options.bufferType ?? "normal",
        baseY: 0,
        cursorX: options.cursorX ?? 0,
        cursorY: options.cursorY ?? 0,
        getLine: (line: number) => {
          if (line < 0 || line >= 5) {
            return undefined;
          }
          return {
            translateToString: () => `row-${line}`,
          };
        },
      },
    },
    _core: {
      buffer: scrollRegion,
      scroll: () => {
        observedScrollRegions.push([scrollRegion.scrollTop, scrollRegion.scrollBottom]);
      },
      _inputHandler: {
        _onScroll: {
          fire: (position: number) => {
            onScrollPositions.push(position);
          },
        },
        _eraseAttrData: () => ({}),
      },
    },
  };
  const disposable = installEraseInDisplayHandlers(term as never, {
    getClearWipesScrollback: () => options.clearWipesScrollback ?? false,
    isInDec2026SyncBlock: () => options.inDec2026SyncBlock ?? false,
    scheduleMicrotask: (callback) => {
      microtasks.push(callback);
    },
  });
  const erase = handlers.find((handler) => handler.id.final === "J" && handler.id.prefix === undefined);
  const selectiveErase = handlers.find((handler) => handler.id.final === "J" && handler.id.prefix === "?");
  if (!erase || !selectiveErase) {
    throw new Error("erase handlers were not registered");
  }

  return {
    disposable,
    erase: erase.callback,
    flushMicrotasks: () => {
      while (microtasks.length > 0) {
        microtasks.shift()?.();
      }
    },
    handlers,
    observedScrollRegions,
    onScrollPositions,
    scrollRegion,
    selectiveErase: selectiveErase.callback,
    term,
    trimStartCalls,
  };
};

const writeTerminal = (term: InstanceType<typeof Terminal>, data: string): Promise<void> =>
  new Promise((resolve) => term.write(data, resolve));

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

test("native erase-in-display scrollback preservation follows the clear history setting", () => {
  assert.equal(shouldScrollOnEraseInDisplay(createMockTerm("normal") as never, false, false), true);
  assert.equal(shouldScrollOnEraseInDisplay(createMockTerm("normal") as never, false, true), false);
  assert.equal(shouldScrollOnEraseInDisplay(createMockTerm("normal") as never, true, false), false);
  assert.equal(shouldScrollOnEraseInDisplay(createMockTerm("alternate") as never, false, false), false);
});

test("native erase-in-display scrollback preservation is skipped with active scroll margins", () => {
  const term = {
    rows: 5,
    buffer: {
      active: {
        type: "normal",
        cursorX: 0,
        cursorY: 0,
      },
    },
    _core: {
      buffer: {
        scrollTop: 1,
        scrollBottom: 3,
      },
    },
  };

  assert.equal(shouldScrollOnEraseInDisplay(term as never, false, false), false);
  assert.equal(shouldPreserveViewportBeforeFullErase(term as never, false, false), true);
  assert.equal(shouldPreserveViewportBeforeEraseBelow(term as never, false, false), true);
});

test("erase-below is treated as viewport clear only from the home position", () => {
  assert.equal(isEraseBelowSequence([]), true);
  assert.equal(isEraseBelowSequence([0]), true);
  assert.equal(isEraseBelowSequence([2]), false);
  assert.equal(shouldPreserveViewportBeforeEraseBelow(createMockTerm("normal") as never, false, false), true);
  assert.equal(
    shouldPreserveViewportBeforeEraseBelow(createMockTerm("normal", { cursorX: 1 }) as never, false, false),
    false,
  );
  assert.equal(
    shouldPreserveViewportBeforeEraseBelow(createMockTerm("normal", { cursorY: 1 }) as never, false, false),
    false,
  );
  assert.equal(shouldPreserveViewportBeforeEraseBelow(createMockTerm("alternate") as never, false, false), false);
});

test("viewport preservation temporarily uses the full scroll region", () => {
  const scrollRegion = {
    scrollTop: 1,
    scrollBottom: 3,
  };
  const observedScrollRegions: Array<[number, number]> = [];
  const term = {
    rows: 5,
    buffer: {
      active: {
        type: "normal",
        baseY: 0,
        getLine: (line: number) => {
          if (line < 0 || line >= 5) {
            return undefined;
          }
          return {
            translateToString: () => `row-${line}`,
          };
        },
      },
    },
    _core: {
      buffer: scrollRegion,
      scroll: () => {
        observedScrollRegions.push([scrollRegion.scrollTop, scrollRegion.scrollBottom]);
      },
      _inputHandler: {
        _eraseAttrData: () => ({}),
      },
    },
  };

  preserveTerminalViewportInScrollback(term as never);

  assert.equal(observedScrollRegions.length, 5);
  assert.deepEqual(observedScrollRegions, [
    [0, 4],
    [0, 4],
    [0, 4],
    [0, 4],
    [0, 4],
  ]);
  assert.deepEqual(scrollRegion, {
    scrollTop: 1,
    scrollBottom: 3,
  });
});

test("installed erase handlers preserve scrollback by behavior", () => {
  const fullClear = createEraseHandlerHarness();

  assert.equal(fullClear.erase([2]), false);
  assert.equal(fullClear.term.options.scrollOnEraseInDisplay, true);
  assert.deepEqual(fullClear.observedScrollRegions, []);
  fullClear.flushMicrotasks();
  assert.equal(fullClear.term.options.scrollOnEraseInDisplay, false);

  const marginFullClear = createEraseHandlerHarness({ scrollTop: 1, scrollBottom: 3 });
  assert.equal(marginFullClear.erase([2]), false);
  assert.equal(marginFullClear.term.options.scrollOnEraseInDisplay, false);
  assert.deepEqual(marginFullClear.observedScrollRegions, [
    [0, 4],
    [0, 4],
    [0, 4],
    [0, 4],
    [0, 4],
  ]);
  assert.equal(marginFullClear.scrollRegion.scrollTop, 1);
  assert.equal(marginFullClear.scrollRegion.scrollBottom, 3);

  const eraseBelow = createEraseHandlerHarness();
  assert.equal(eraseBelow.erase([]), false);
  assert.equal(eraseBelow.observedScrollRegions.length, 5);

  const eraseBelowAwayFromHome = createEraseHandlerHarness({ cursorY: 1 });
  assert.equal(eraseBelowAwayFromHome.erase([]), false);
  assert.equal(eraseBelowAwayFromHome.observedScrollRegions.length, 0);

  const wipeEraseBelow = createEraseHandlerHarness({ clearWipesScrollback: true });
  assert.equal(wipeEraseBelow.erase([]), false);
  assert.deepEqual(wipeEraseBelow.trimStartCalls, [4]);
  assert.equal(wipeEraseBelow.scrollRegion.ybase, 0);
  assert.equal(wipeEraseBelow.scrollRegion.ydisp, 0);
  assert.deepEqual(wipeEraseBelow.onScrollPositions, [0]);

  const wipeEraseBelowAwayFromHome = createEraseHandlerHarness({
    clearWipesScrollback: true,
    cursorY: 1,
  });
  assert.equal(wipeEraseBelowAwayFromHome.erase([]), false);
  assert.deepEqual(wipeEraseBelowAwayFromHome.trimStartCalls, []);
});

test("erase-below wipe preserves later output from the same write batch", async () => {
  const term = new Terminal({ cols: 20, rows: 5, scrollback: 100 });
  const disposable = installEraseInDisplayHandlers(term as never, {
    getClearWipesScrollback: () => true,
    isInDec2026SyncBlock: () => false,
  });

  await writeTerminal(term, "old1\r\nold2\r\nold3\r\nold4\r\nold5\r\nold6\r\nold7\r\nold8");
  await writeTerminal(term, "\x1b[H\x1b[Jnew1\r\nnew2\r\nnew3\r\nnew4\r\nnew5\r\nnew6\r\nnew7\r\nnew8");

  const scrollback = Array.from({ length: term.buffer.active.baseY }, (_, row) =>
    term.buffer.active.getLine(row)?.translateToString(true) ?? ""
  );

  assert.equal(scrollback.some((line) => line.startsWith("old")), false);
  assert.equal(scrollback.some((line) => line.startsWith("new")), true);

  disposable.dispose();
  term.dispose();
});

test("installed erase handlers honor wipe, sync, alternate, and selective clears", () => {
  const preserveHistory = createEraseHandlerHarness({ clearWipesScrollback: false });
  assert.equal(preserveHistory.erase([3]), true);

  const wipeHistory = createEraseHandlerHarness({ clearWipesScrollback: true });
  assert.equal(wipeHistory.erase([3]), false);

  const syncBlock = createEraseHandlerHarness({ inDec2026SyncBlock: true });
  assert.equal(syncBlock.erase([2]), false);
  assert.equal(syncBlock.term.options.scrollOnEraseInDisplay, false);
  assert.deepEqual(syncBlock.observedScrollRegions, []);

  const alternateScreen = createEraseHandlerHarness({ bufferType: "alternate" });
  assert.equal(alternateScreen.erase([2]), false);
  assert.equal(alternateScreen.term.options.scrollOnEraseInDisplay, false);
  assert.deepEqual(alternateScreen.observedScrollRegions, []);

  const selectiveClear = createEraseHandlerHarness();
  selectiveClear.term.options.scrollOnEraseInDisplay = true;
  assert.equal(selectiveClear.selectiveErase([2]), false);
  assert.equal(selectiveClear.term.options.scrollOnEraseInDisplay, false);
  selectiveClear.disposable.dispose();
  assert.equal(selectiveClear.handlers.every((handler) => handler.disposed), true);
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

  const didClear = clearTerminalViewport(term as never, { wipeScrollback: true });

  assert.equal(didClear, true);
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

  const didClear = clearTerminalViewport(term as never, { wipeScrollback: false });

  assert.equal(didClear, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].includes("\x1b[3J"), false);
});

test("local clear reports that alternate-screen content was left unchanged", () => {
  const writes: string[] = [];
  const term = {
    buffer: {
      active: {
        type: "alternate",
        baseY: 0,
        cursorY: 2,
        cursorX: 4,
      },
    },
    write: (payload: string) => writes.push(payload),
  };

  const didClear = clearTerminalViewport(term as never, { wipeScrollback: true });

  assert.equal(didClear, false);
  assert.deepEqual(writes, []);
});

test("PTY sync runs only when the local viewport was actually cleared", () => {
  const syncCalls: string[] = [];
  const makeTerm = (type: "normal" | "alternate", cursorY: number) => ({
    rows: 5,
    buffer: {
      active: {
        type,
        baseY: 0,
        cursorY,
        cursorX: 4,
      },
    },
    _core: {
      scroll: () => {},
      _inputHandler: {
        _eraseAttrData: () => ({}),
      },
    },
    write: (_payload: string, callback?: () => void) => callback?.(),
    scrollToBottom: () => {},
  });

  assert.equal(clearTerminalViewportAndSyncPty(makeTerm("normal", 2) as never, {
    syncPty: () => syncCalls.push("normal"),
  }), true);
  assert.equal(clearTerminalViewportAndSyncPty(makeTerm("alternate", 2) as never, {
    syncPty: () => syncCalls.push("alternate"),
  }), false);
  assert.equal(clearTerminalViewportAndSyncPty(makeTerm("normal", 0) as never, {
    syncPty: () => syncCalls.push("empty"),
  }), false);

  assert.deepEqual(syncCalls, ["normal"]);
});

test("appendEraseScrollback adds 3J after a normal full clear", () => {
  assert.equal(
    appendEraseScrollbackAfterFullErases("\x1b[H\x1b[2Jframe", {
      wipeScrollback: true,
      normalScreen: true,
    }),
    "\x1b[H\x1b[2J\x1b[3Jframe",
  );
});

test("appendEraseScrollback skips 3J inside an in-chunk DEC 2026 block", () => {
  assert.equal(
    appendEraseScrollbackAfterFullErases("\x1b[?2026h\x1b[H\x1b[2Jframe\x1b[?2026l", {
      wipeScrollback: true,
      normalScreen: true,
    }),
    "\x1b[?2026h\x1b[H\x1b[2Jframe\x1b[?2026l",
  );
});

test("appendEraseScrollback skips 3J for a delayed clear when sync was already open", () => {
  // Prior chunk carried `?2026h`; this chunk is only home+clear+frame.
  assert.equal(
    appendEraseScrollbackAfterFullErases("\x1b[H\x1b[2Jframe\x1b[?2026l", {
      wipeScrollback: true,
      normalScreen: true,
      startInDec2026SyncBlock: true,
    }),
    "\x1b[H\x1b[2Jframe\x1b[?2026l",
  );
});

test("appendEraseScrollback still wipes when delayed clear is outside a sync block", () => {
  assert.equal(
    appendEraseScrollbackAfterFullErases("\x1b[H\x1b[2Jframe", {
      wipeScrollback: true,
      normalScreen: true,
      startInDec2026SyncBlock: false,
    }),
    "\x1b[H\x1b[2J\x1b[3Jframe",
  );
});

test("isDec2026SyncModeParams matches only the 2026 mode param", () => {
  assert.equal(isDec2026SyncModeParams([2026]), true);
  assert.equal(isDec2026SyncModeParams([2004]), false);
  assert.equal(isDec2026SyncModeParams([25]), false);
  assert.equal(isDec2026SyncModeParams([1049]), false);
  assert.equal(isDec2026SyncModeParams([]), false);
  assert.equal(isDec2026SyncModeParams([2026, 1]), false);
});

/**
 * Mirror of the `ESC[?…h/l` registration in createXTermRuntime: handlers must
 * be registered without a `params` field (xterm ignores it) and filter on the
 * callback params. This guards against re-introducing the bug that made bash's
 * `ESC[?2004h` set the DEC 2026 sync flag and drop scrollback on Ctrl+L.
 */
const installDec2026SyncTracking = (
  term: InstanceType<typeof Terminal>,
): { isInDec2026SyncBlock: () => boolean } => {
  let inDec2026SyncBlock = false;
  term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    if (isDec2026SyncModeParams(params)) {
      inDec2026SyncBlock = true;
    }
    return false;
  });
  term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    if (isDec2026SyncModeParams(params)) {
      inDec2026SyncBlock = false;
    }
    return false;
  });
  return { isInDec2026SyncBlock: () => inDec2026SyncBlock };
};

const getScrollbackLines = (term: InstanceType<typeof Terminal>): string[] =>
  Array.from({ length: term.buffer.active.baseY }, (_, row) =>
    term.buffer.active.getLine(row)?.translateToString(true) ?? ""
  );

test("private-mode handlers set the 2026 flag only for 2026", async () => {
  const term = new Terminal({ cols: 20, rows: 5, scrollback: 100 });
  const sync = installDec2026SyncTracking(term);

  await writeTerminal(term, "\x1b[?2004h");
  assert.equal(sync.isInDec2026SyncBlock(), false, "bracketed paste 2004 must not open a sync block");

  await writeTerminal(term, "\x1b[?25h\x1b[?1049h");
  assert.equal(sync.isInDec2026SyncBlock(), false, "cursor/alt-screen modes must not open a sync block");

  await writeTerminal(term, "\x1b[?2026h");
  assert.equal(sync.isInDec2026SyncBlock(), true);

  await writeTerminal(term, "\x1b[?2004l");
  assert.equal(sync.isInDec2026SyncBlock(), true, "closing 2004 must not close the 2026 block");

  await writeTerminal(term, "\x1b[?2026l");
  assert.equal(sync.isInDec2026SyncBlock(), false);

  term.dispose();
});

test("Ctrl+L clear survives a bash prompt (2004 open, 2026 closed)", async () => {
  const term = new Terminal({ cols: 20, rows: 5, scrollback: 100 });
  const sync = installDec2026SyncTracking(term);
  const erase = installEraseInDisplayHandlers(term as never, {
    getClearWipesScrollback: () => false,
    isInDec2026SyncBlock: sync.isInDec2026SyncBlock,
  });

  // Exactly two rows already in scrollback, then a full screen of visible rows.
  await writeTerminal(term, "old1\r\nold2\r\nvis1\r\nvis2\r\nvis3\r\nvis4\r\nvis5");
  assert.equal(term.buffer.active.baseY, 2);

  // bash 5.1 at a prompt holds bracketed paste open; Ctrl+L only sends CSI 2 J.
  await writeTerminal(term, "\x1b[?2004h");
  await writeTerminal(term, "\x1b[H\x1b[2Jnew1");

  const scrollback = getScrollbackLines(term);
  assert.equal(scrollback.some((line) => line.startsWith("vis")), true, "visible rows preserved in scrollback");
  assert.equal(scrollback.some((line) => line.startsWith("old")), true, "earlier history not trimmed");

  erase.dispose();
  term.dispose();
});

test("clears inside a DEC 2026 sync block still erase in place", async () => {
  const term = new Terminal({ cols: 20, rows: 5, scrollback: 100 });
  const sync = installDec2026SyncTracking(term);
  const erase = installEraseInDisplayHandlers(term as never, {
    getClearWipesScrollback: () => false,
    isInDec2026SyncBlock: sync.isInDec2026SyncBlock,
  });

  await writeTerminal(term, "old1\r\nold2\r\nvis1\r\nvis2\r\nvis3\r\nvis4\r\nvis5");
  assert.equal(term.buffer.active.baseY, 2);
  await writeTerminal(term, "\x1b[?2026h\x1b[H\x1b[2Jnew1\x1b[?2026l");

  const scrollback = getScrollbackLines(term);
  assert.equal(scrollback.some((line) => line.startsWith("vis")), false, "sync-block erase stays in place");
  assert.equal(scrollback.some((line) => line.startsWith("old")), true, "only pre-existing scrollback remains");

  erase.dispose();
  term.dispose();
});
