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
    onData: () => noopDisposable,
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

function createFakeTerminalFromLargeWrappedBlock({
  lineCount,
  lineText,
  viewportY,
  rows,
}: {
  lineCount: number;
  lineText: string;
  viewportY: number;
  rows: number;
}) {
  let getLineCount = 0;
  const decorations: Array<{ x: number; width: number; foregroundColor: string }> = [];
  const noopDisposable = { dispose() {} };
  const handlers: {
    scroll?: () => void;
    data?: (data: string) => void;
    writeParsed?: () => void;
    resize?: () => void;
    render?: () => void;
  } = {};
  const term = {
    rows,
    cols: lineText.length,
    buffer: {
      active: {
        type: "normal",
        viewportY,
        baseY: 0,
        cursorY: viewportY,
        length: lineCount,
        getLine: (lineY: number) => {
          getLineCount += 1;
          if (lineY < 0 || lineY >= lineCount) return undefined;
          return createFakeWrappedLine(lineText, lineY > 0);
        },
      },
    },
    onScroll(handler: () => void) {
      handlers.scroll = handler;
      return noopDisposable;
    },
    onData(handler: (data: string) => void) {
      handlers.data = handler;
      return noopDisposable;
    },
    onWriteParsed(handler: () => void) {
      handlers.writeParsed = handler;
      return noopDisposable;
    },
    onResize(handler: () => void) {
      handlers.resize = handler;
      return noopDisposable;
    },
    onRender(handler: () => void) {
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
    getLineCount: () => getLineCount,
    resetGetLineCount: () => {
      getLineCount = 0;
    },
  };
}

function createFakeTerminal(lineText: string, options: { lineCount?: number } = {}) {
  const lineCount = options.lineCount ?? 1;
  let translateCount = 0;
  const translatedLineIndexes: number[] = [];
  const lines = Array.from({ length: lineCount }, (_, index) =>
    createFakeLine(`${lineText} ${index}`, () => {
      translateCount += 1;
      translatedLineIndexes.push(index);
    })
  );
  const decorations: Array<{ x: number; width: number; foregroundColor: string }> = [];
  const decorationStates: Array<{ isDisposed: boolean; dispose: () => void }> = [];
  const markers: Array<{ line: number; isDisposed: boolean; dispose: () => void }> = [];
  const noopDisposable = { dispose() {} };
  const handlers: {
    scroll?: () => void;
    data?: (data: string) => void;
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
    onScroll: (handler: (viewportY: number) => void) => {
      handlers.scroll = () => handler(term.buffer.active.viewportY);
      return noopDisposable;
    },
    onData: (handler: (data: string) => void) => {
      handlers.data = handler;
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
      const marker = {
        line: term.buffer.active.baseY + term.buffer.active.cursorY + offset,
        isDisposed: false,
        dispose() {
          this.isDisposed = true;
        },
      };
      markers.push(marker);
      return marker;
    },
    registerDecoration(options: { x: number; width: number; foregroundColor: string }) {
      decorations.push(options);
      const decoration = {
        isDisposed: false,
        dispose() {
          this.isDisposed = true;
        },
      };
      decorationStates.push(decoration);
      return decoration;
    },
    refresh() {},
  };

  return {
    term,
    decorations,
    handlers,
    getTranslateCount: () => translateCount,
    getTranslatedLineIndexes: () => [...translatedLineIndexes],
    getActiveDecorationCount: () => decorationStates.filter((state) => !state.isDisposed).length,
    markers,
    resetTranslateCount: () => {
      translateCount = 0;
      translatedLineIndexes.length = 0;
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

test("user scroll reuses persistent prehighlighted lines without delayed scans", async () => {
  const raf = installAnimationFrameQueue();
  try {
    const { term, handlers, getTranslateCount, resetTranslateCount } = createFakeTerminal("hello DEPLOY world", {
      lineCount: 80,
    });
    term.rows = 30;
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

    term.buffer.active.viewportY = 10;
    handlers.scroll?.();
    handlers.render?.();

    assert.equal(getTranslateCount(), 0);

    await new Promise((resolve) => { setTimeout(resolve, 130); });
    assert.equal(getTranslateCount(), 0);
    highlighter.dispose();
  } finally {
    raf.restore();
  }
});

test("distant user scroll synchronously highlights only the target viewport", async () => {
  const raf = installAnimationFrameQueue();
  try {
    const {
      term,
      handlers,
      getTranslatedLineIndexes,
      resetTranslateCount,
    } = createFakeTerminal("hello DEPLOY world", { lineCount: 220 });
    term.rows = 30;
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

    term.buffer.active.baseY = 190;
    term.buffer.active.viewportY = 120;
    handlers.scroll?.();

    assert.deepEqual(
      getTranslatedLineIndexes(),
      Array.from({ length: term.rows }, (_, index) => 120 + index),
      "the destination viewport should be indexed before the scroll event returns",
    );

    await new Promise((resolve) => { setTimeout(resolve, 130); });
    assert.equal(getTranslatedLineIndexes().length, term.rows);
    highlighter.dispose();
  } finally {
    raf.restore();
  }
});

test("user scrollback browsing stays synchronous during a write burst", () => {
  const raf = installAnimationFrameQueue();
  try {
    const {
      term,
      handlers,
      getTranslatedLineIndexes,
      resetTranslateCount,
    } = createFakeTerminal("hello DEPLOY world", { lineCount: 220 });
    term.rows = 30;
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

    for (let index = 0; index < 6; index += 1) {
      handlers.writeParsed?.();
    }
    resetTranslateCount();
    term.buffer.active.baseY = 190;
    term.buffer.active.viewportY = 120;
    handlers.scroll?.();

    assert.deepEqual(
      getTranslatedLineIndexes(),
      Array.from({ length: term.rows }, (_, index) => 120 + index),
    );
    highlighter.dispose();
  } finally {
    raf.restore();
  }
});

test("continuous distant scrolls do not scan skipped viewport ranges", () => {
  const raf = installAnimationFrameQueue();
  try {
    const {
      term,
      handlers,
      getTranslatedLineIndexes,
      resetTranslateCount,
    } = createFakeTerminal("hello DEPLOY world", { lineCount: 260 });
    term.rows = 30;
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

    term.buffer.active.baseY = 230;
    term.buffer.active.viewportY = 120;
    handlers.scroll?.();
    term.buffer.active.viewportY = 180;
    handlers.scroll?.();

    assert.deepEqual(
      getTranslatedLineIndexes(),
      [
        ...Array.from({ length: term.rows }, (_, index) => 120 + index),
        ...Array.from({ length: term.rows }, (_, index) => 180 + index),
      ],
    );
    highlighter.dispose();
  } finally {
    raf.restore();
  }
});

test("persistent highlights remain until xterm disposes their markers", () => {
  const raf = installAnimationFrameQueue();
  try {
    const {
      term,
      handlers,
      getActiveDecorationCount,
      markers,
    } = createFakeTerminal("hello DEPLOY world", { lineCount: 200 });
    term.rows = 3;
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
    assert.equal(getActiveDecorationCount(), 9);

    term.buffer.active.baseY = 170;
    term.buffer.active.viewportY = 120;
    handlers.scroll?.();
    assert.equal(getActiveDecorationCount(), 12);

    markers[0].isDisposed = true;
    handlers.scroll?.();
    assert.equal(getActiveDecorationCount(), 11);
    highlighter.dispose();
  } finally {
    raf.restore();
  }
});

test("large output delays keyword highlight scans until output quiets", async () => {
  const raf = installAnimationFrameQueue();
  try {
    const { term, handlers, getTranslateCount, resetTranslateCount } = createFakeTerminal("hello DEPLOY world", {
      lineCount: 40,
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

    noteTerminalOutputPressureData(
      term as never,
      "x\n".repeat(Math.ceil(TERMINAL_LONG_LINE_PRESSURE_BYTES / 2)),
    );
    handlers.writeParsed?.();
    raf.flush();

    assert.equal(getTranslateCount(), 0);

    // Bulk path no longer schedules per-write scans (Tabby has no keyword work).
    // A single quiet-window catch-up applies decorations after largeOutput ends.
    await new Promise((resolve) => { setTimeout(resolve, 700); });
    raf.flush();
    assert.ok(getTranslateCount() > 0);
    highlighter.dispose();
    resetTerminalOutputPressure(term as never);
  } finally {
    raf.restore();
  }
});

test("recent user input delays keyword highlight scans until typing is quiet", async () => {
  const raf = installAnimationFrameQueue();
  try {
    const { term, handlers, getTranslateCount, resetTranslateCount } = createFakeTerminal("hello DEPLOY world", {
      lineCount: 40,
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

    handlers.data?.("a");
    handlers.writeParsed?.();
    raf.flush();

    assert.equal(getTranslateCount(), 0);

    await new Promise((resolve) => { setTimeout(resolve, 120); });
    assert.equal(getTranslateCount(), 0);

    await new Promise((resolve) => { setTimeout(resolve, 100); });
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

test("wrapped highlight scanning stops before walking an oversized soft-wrapped line", () => {
  const raf = installAnimationFrameQueue();
  try {
    const lineText = "a".repeat(80);
    const { term, decorations, getLineCount } = createFakeTerminalFromLargeWrappedBlock({
      lineCount: 30_000,
      lineText,
      viewportY: 29_990,
      rows: 3,
    });
    const highlighter = new KeywordHighlighter(term as never);
    const rules: KeywordHighlightRule[] = [
      {
        id: "wrapped",
        label: "Wrapped",
        patterns: [`${lineText}${lineText}`],
        color: "#F87171",
        enabled: true,
      },
    ];

    highlighter.setRules(rules, true);
    raf.flush();
    highlighter.dispose();
    resetTerminalOutputPressure(term as never);

    assert.deepEqual(decorations, []);
    assert.ok(
      getLineCount() < 3_000,
      `expected capped wrapped scan, got ${getLineCount()} getLine calls`,
    );
  } finally {
    raf.restore();
  }
});

test("scroll refresh reuses wrapped scan misses across visible rows", () => {
  const raf = installAnimationFrameQueue();
  try {
    const lineText = "a".repeat(80);
    const {
      term,
      handlers,
      getLineCount,
      resetGetLineCount,
    } = createFakeTerminalFromLargeWrappedBlock({
      lineCount: 30_000,
      lineText,
      viewportY: 29_000,
      rows: 30,
    });
    const highlighter = new KeywordHighlighter(term as never);
    const rules: KeywordHighlightRule[] = [
      {
        id: "wrapped",
        label: "Wrapped",
        patterns: [`${lineText}${lineText}`],
        color: "#F87171",
        enabled: true,
      },
    ];

    highlighter.setRules(rules, true);
    raf.flush();
    resetGetLineCount();

    term.buffer.active.viewportY = 29_500;
    handlers.scroll?.();

    assert.ok(
      getLineCount() < 1_000,
      `expected scroll chunk to share wrapped scan cache, got ${getLineCount()} getLine calls`,
    );
    highlighter.dispose();
    resetTerminalOutputPressure(term as never);
  } finally {
    raf.restore();
  }
});
