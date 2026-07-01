import test from "node:test";
import assert from "node:assert/strict";

import { KeywordHighlighter } from "./keywordHighlight.ts";
import type { KeywordHighlightRule } from "../../types.ts";
import {
  noteTerminalOutputPressureData,
  resetTerminalOutputPressure,
} from "./runtime/terminalOutputPressure.ts";
import {
  TERMINAL_AUX_LONG_LINE_SCAN_LIMIT_CHARS,
  TERMINAL_LONG_LINE_PRESSURE_BYTES,
} from "./runtime/terminalFlowConstants.ts";

type RafCallback = (time: number) => void;

function installAnimationFrameQueue() {
  const callbacks: RafCallback[] = [];
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;

  globalThis.requestAnimationFrame = ((callback: RafCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;

  return {
    flush() {
      while (callbacks.length > 0) {
        callbacks.shift()?.(performance.now());
      }
    },
    restore() {
      globalThis.requestAnimationFrame = previousRequestAnimationFrame;
      globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
    },
  };
}

function createFakeLine(text: string, onTranslate?: () => void) {
  return {
    isWrapped: false,
    length: text.length,
    translateToString() {
      onTranslate?.();
      return text;
    },
    getCell(index: number) {
      if (index < 0 || index >= text.length) return undefined;
      return {
        getChars: () => text[index],
        getWidth: () => 1,
      };
    },
  };
}

function createFakeWrappedLine(text: string, isWrapped: boolean) {
  return {
    ...createFakeLine(text),
    isWrapped,
  };
}

function createFakeTerminalFromLines(lines: Array<{ text: string; isWrapped: boolean }>) {
  const fakeLines = lines.map((line) => createFakeWrappedLine(line.text, line.isWrapped));
  const decorations: Array<{ x: number; width: number; foregroundColor: string }> = [];
  const noopDisposable = { dispose() {} };
  const term = {
    rows: fakeLines.length,
    cols: 80,
    buffer: {
      active: {
        type: "normal",
        viewportY: 0,
        baseY: 0,
        cursorY: 0,
        length: fakeLines.length,
        getLine: (lineY: number) => fakeLines[lineY],
      },
    },
    onScroll: () => noopDisposable,
    onWriteParsed: () => noopDisposable,
    onResize: () => noopDisposable,
    onRender: () => noopDisposable,
    registerMarker(offset: number) {
      return {
        line: offset,
        isDisposed: false,
        dispose() {
          this.isDisposed = true;
        },
      };
    },
    registerDecoration(options: { x: number; width: number; foregroundColor: string }) {
      decorations.push(options);
      return {
        isDisposed: false,
        dispose() {
          this.isDisposed = true;
        },
      };
    },
    refresh() {},
  };
  return { term, decorations };
}

function createFakeTerminal(lineText: string, options: { lineCount?: number } = {}) {
  const lineCount = options.lineCount ?? 1;
  let translateCount = 0;
  const lines = Array.from({ length: lineCount }, (_, index) =>
    createFakeLine(`${lineText} ${index}`, () => {
      translateCount += 1;
    })
  );
  const decorations: Array<{ x: number; width: number; foregroundColor: string }> = [];
  const noopDisposable = { dispose() {} };
  const handlers: {
    scroll?: () => void;
    writeParsed?: () => void;
    resize?: () => void;
    render?: () => void;
  } = {};
  const term = {
    rows: 3,
    cols: 80,
    buffer: {
      active: {
        type: "normal",
        viewportY: 0,
        baseY: 0,
        cursorY: 0,
        length: lineCount,
        getLine: (lineY: number) => lines[lineY],
      },
    },
    onScroll: (handler: () => void) => {
      handlers.scroll = handler;
      return noopDisposable;
    },
    onWriteParsed: (handler: () => void) => {
      handlers.writeParsed = handler;
      return noopDisposable;
    },
    onResize: (handler: () => void) => {
      handlers.resize = handler;
      return noopDisposable;
    },
    onRender: (handler: () => void) => {
      handlers.render = handler;
      return noopDisposable;
    },
    registerMarker(offset: number) {
      return {
        line: offset,
        isDisposed: false,
        dispose() {
          this.isDisposed = true;
        },
      };
    },
    registerDecoration(options: { x: number; width: number; foregroundColor: string }) {
      decorations.push(options);
      return {
        isDisposed: false,
        dispose() {
          this.isDisposed = true;
        },
      };
    },
    refresh() {},
  };

  return {
    term,
    decorations,
    handlers,
    getTranslateCount: () => translateCount,
    resetTranslateCount: () => {
      translateCount = 0;
    },
  };
}

test("setRules immediately highlights a newly added rule against visible terminal text", () => {
  const raf = installAnimationFrameQueue();
  try {
    const { term, decorations } = createFakeTerminal("hello DEPLOY world");
    const highlighter = new KeywordHighlighter(term as never);
    const rules: KeywordHighlightRule[] = [
      {
        id: "deploy",
        label: "Deploy",
        patterns: ["DEPLOY"],
        color: "#F87171",
        enabled: true,
      },
    ];

    highlighter.setRules(rules, true);
    raf.flush();
    highlighter.dispose();

    assert.deepEqual(decorations.map(({ x, width, foregroundColor }) => ({ x, width, foregroundColor })), [
      { x: 6, width: 6, foregroundColor: "#F87171" },
    ]);
  } finally {
    raf.restore();
  }
});

test("output-driven viewport changes defer keyword highlight scans", async () => {
  const raf = installAnimationFrameQueue();
  try {
    const { term, handlers, getTranslateCount, resetTranslateCount } = createFakeTerminal("hello DEPLOY world", {
      lineCount: 20,
    });
    const highlighter = new KeywordHighlighter(term as never);
    const rules: KeywordHighlightRule[] = [
      {
        id: "deploy",
        label: "Deploy",
        patterns: ["DEPLOY"],
        color: "#F87171",
        enabled: true,
      },
    ];

    highlighter.setRules(rules, true);
    raf.flush();
    resetTranslateCount();

    term.buffer.active.length = 40;
    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 20;
    term.buffer.active.cursorY = 2;
    handlers.writeParsed?.();
    handlers.render?.();

    assert.equal(getTranslateCount(), 0);

    await new Promise((resolve) => { setTimeout(resolve, 220); });
    assert.ok(getTranslateCount() > 0);
    highlighter.dispose();
  } finally {
    raf.restore();
  }
});

test("long-line pressure avoids scanning across a whole soft-wrapped logical line", () => {
  const raf = installAnimationFrameQueue();
  try {
    const { term, decorations } = createFakeTerminalFromLines([
      { text: "abc", isWrapped: false },
      { text: "XYZ", isWrapped: true },
    ]);
    noteTerminalOutputPressureData(
      term as never,
      "x".repeat(TERMINAL_LONG_LINE_PRESSURE_BYTES),
    );
    const highlighter = new KeywordHighlighter(term as never);
    const rules: KeywordHighlightRule[] = [
      {
        id: "wrapped",
        label: "Wrapped",
        patterns: ["abcXYZ"],
        color: "#F87171",
        enabled: true,
      },
    ];

    highlighter.setRules(rules, true);
    raf.flush();
    highlighter.dispose();
    resetTerminalOutputPressure(term as never);

    assert.deepEqual(decorations, []);
  } finally {
    raf.restore();
  }
});

test("wrapped highlight scanning falls back when the logical line exceeds the scan cap", () => {
  const raf = installAnimationFrameQueue();
  try {
    const { term, decorations } = createFakeTerminalFromLines([
      { text: `${"a".repeat(TERMINAL_AUX_LONG_LINE_SCAN_LIMIT_CHARS)}ZZ`, isWrapped: false },
      { text: "tail", isWrapped: true },
    ]);
    const highlighter = new KeywordHighlighter(term as never);
    const rules: KeywordHighlightRule[] = [
      {
        id: "capped-wrapped",
        label: "Capped wrapped",
        patterns: ["ZZtail"],
        color: "#F87171",
        enabled: true,
      },
    ];

    highlighter.setRules(rules, true);
    raf.flush();
    highlighter.dispose();
    resetTerminalOutputPressure(term as never);

    assert.deepEqual(decorations, []);
  } finally {
    raf.restore();
  }
});
