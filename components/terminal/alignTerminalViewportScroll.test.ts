import assert from "node:assert/strict";
import { test } from "node:test";
import type { Terminal as XTerm } from "@xterm/xterm";
import { alignTerminalViewportScroll } from "./terminalHelpers";

type ViewportSpy = {
  scrollToLine: (line: number, disableSmoothScroll?: boolean) => void;
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
