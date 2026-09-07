import assert from "node:assert/strict";
import { test } from "node:test";
import type { Terminal as XTerm } from "@xterm/xterm";
import { alignTerminalViewportScroll } from "./terminalHelpers";

type ViewportSpy = {
  scrollToLine: (line: number, disableSmoothScroll?: boolean) => void;
  _sync?: () => void;
  calls: Array<{ line: number; disableSmoothScroll?: boolean }>;
};

const createTerm = (
  viewportY: number,
  viewport?: ViewportSpy | null,
): XTerm => ({
  buffer: { active: { viewportY } },
  _core: viewport === null ? undefined : { _viewport: viewport },
}) as unknown as XTerm;

test("alignTerminalViewportScroll snaps the viewport back to the buffer row without smooth scrolling", () => {
  const calls: Array<{ line: number; disableSmoothScroll?: boolean }> = [];
  const viewport: ViewportSpy = {
    scrollToLine: (line, disableSmoothScroll) => {
      calls.push({ line, disableSmoothScroll });
    },
    calls,
  };
  const term = createTerm(247, viewport);

  alignTerminalViewportScroll(term);

  assert.deepEqual(calls, [{ line: 247, disableSmoothScroll: true }]);
});

test("alignTerminalViewportScroll syncs viewport dimensions before setting the position", () => {
  const calls: Array<{ line: number; disableSmoothScroll?: boolean }> = [];
  const order: string[] = [];
  const viewport: ViewportSpy = {
    _sync: () => {
      order.push("sync");
    },
    scrollToLine: (line, disableSmoothScroll) => {
      order.push("scrollToLine");
      calls.push({ line, disableSmoothScroll });
    },
    calls,
  };
  const term = createTerm(247, viewport);

  alignTerminalViewportScroll(term);

  assert.deepEqual(order, ["sync", "scrollToLine"]);
  assert.deepEqual(calls, [{ line: 247, disableSmoothScroll: true }]);
});

test("alignTerminalViewportScroll survives a failing dimension sync", () => {
  const calls: Array<{ line: number; disableSmoothScroll?: boolean }> = [];
  const viewport: ViewportSpy = {
    _sync: () => {
      throw new Error("boom");
    },
    scrollToLine: (line, disableSmoothScroll) => {
      calls.push({ line, disableSmoothScroll });
    },
    calls,
  };

  assert.doesNotThrow(() => alignTerminalViewportScroll(createTerm(5, viewport)));
  assert.deepEqual(calls, [{ line: 5, disableSmoothScroll: true }]);
});

test("alignTerminalViewportScroll is a no-op when the private viewport is unavailable", () => {
  const term = createTerm(10, null);

  assert.doesNotThrow(() => alignTerminalViewportScroll(term));
});

test("alignTerminalViewportScroll survives a viewport without scrollToLine", () => {
  const term = {
    buffer: { active: { viewportY: 5 } },
    _core: { _viewport: {} },
  } as unknown as XTerm;

  assert.doesNotThrow(() => alignTerminalViewportScroll(term));
});

test("alignTerminalViewportScroll swallows viewport errors instead of breaking the fit", () => {
  const term = {
    buffer: { active: { viewportY: 5 } },
    _core: {
      _viewport: {
        scrollToLine: () => {
          throw new Error("boom");
        },
      },
    },
  } as unknown as XTerm;

  assert.doesNotThrow(() => alignTerminalViewportScroll(term));
});
