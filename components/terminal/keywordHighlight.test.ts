import test from "node:test";
import assert from "node:assert/strict";

import {
  KeywordHighlighter,
  MAX_PLUGIN_DECORATION_MATCHES_PER_LOGICAL_LINE,
} from "./keywordHighlight.ts";
import type { KeywordHighlightRule } from "../../types.ts";
import {
  noteTerminalOutputPressureData,
  resetTerminalOutputPressure,
} from "./runtime/terminalOutputPressure.ts";
import {
  TERMINAL_AUX_LONG_LINE_SCAN_LIMIT_CHARS,
  TERMINAL_LONG_LINE_PRESSURE_BYTES,
} from "./runtime/terminalFlowConstants.ts";
import { XTERM_PERFORMANCE_CONFIG } from "../../infrastructure/config/xtermPerformance.ts";

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

let nextFakeMarkerId = 1;
let fakeMarkerLineReadCount = 0;

function createFakeMarker(line: number) {
  const listeners = new Set<() => void>();
  let currentLine = line;
  return {
    id: nextFakeMarkerId++,
    get line() {
      fakeMarkerLineReadCount += 1;
      return currentLine;
    },
    set line(value: number) {
      currentLine = value;
    },
    isDisposed: false,
    onDispose(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose() {
      if (this.isDisposed) return;
      this.isDisposed = true;
      this.line = -1;
      for (const listener of listeners) listener();
      listeners.clear();
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
      return createFakeMarker(offset);
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
      return createFakeMarker(offset);
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
  const lineTexts = Array.from({ length: lineCount }, (_, index) => `${lineText} ${index}`);
  const lines = lineTexts.map((_, index) => ({
    isWrapped: false,
    get length() {
      return lineTexts[index].length;
    },
    translateToString() {
      translateCount += 1;
      translatedLineIndexes.push(index);
      return lineTexts[index];
    },
    getCell(cellIndex: number) {
      const text = lineTexts[index];
      if (cellIndex < 0 || cellIndex >= text.length) return undefined;
      return {
        getChars: () => text[cellIndex],
        getWidth: () => 1,
      };
    },
  }));
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
      const marker = createFakeMarker(
        term.buffer.active.baseY + term.buffer.active.cursorY + offset,
      );
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
    setLineText: (index: number, text: string) => {
      lineTexts[index] = text;
    },
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

test("plugin rules use the RE2 matcher while saved user rules retain JavaScript regex behavior", () => {
  const raf = installAnimationFrameQueue();
  const originalError = console.error;
  console.error = () => {};
  try {
    const userTerminal = createFakeTerminal("aa");
    const userHighlighter = new KeywordHighlighter(userTerminal.term as never);
    userHighlighter.setRules([{
      id: "user",
      label: "User",
      patterns: ["(a)\\1"],
      color: "#F87171",
      enabled: true,
    }], true);
    raf.flush();
    userHighlighter.dispose();
    assert.equal(userTerminal.decorations.length, 1);

    const pluginTerminal = createFakeTerminal("aa");
    const pluginHighlighter = new KeywordHighlighter(pluginTerminal.term as never);
    pluginHighlighter.setRules([{
      id: "plugin:rule",
      label: "Plugin",
      patterns: ["(a)\\1"],
      color: "#F87171",
      enabled: true,
      providerId: "plugin",
    }], true);
    raf.flush();
    pluginHighlighter.dispose();
    assert.equal(pluginTerminal.decorations.length, 0);
  } finally {
    console.error = originalError;
    raf.restore();
  }
});

test("plugin patterns retain independent overlapping match semantics", () => {
  const raf = installAnimationFrameQueue();
  try {
    const { term, decorations } = createFakeTerminal("error code");
    const highlighter = new KeywordHighlighter(term as never);
    highlighter.setRules([{
      id: "plugin:overlap",
      label: "Overlap",
      patterns: ["error", "error code"],
      color: "#F87171",
      enabled: true,
      providerId: "plugin",
    }], true);
    raf.flush();
    highlighter.dispose();
    assert.deepEqual(decorations.map(({ x, width }) => ({ x, width })), [{ x: 0, width: 10 }]);

    const shifted = createFakeTerminal("abab");
    const shiftedHighlighter = new KeywordHighlighter(shifted.term as never);
    shiftedHighlighter.setRules([{
      id: "plugin:shifted-overlap",
      label: "Shifted overlap",
      patterns: ["aba", "bab"],
      color: "#F87171",
      enabled: true,
      providerId: "plugin",
    }], true);
    raf.flush();
    shiftedHighlighter.dispose();
    assert.deepEqual(shifted.decorations.map(({ x, width }) => ({ x, width })), [{ x: 0, width: 4 }]);
  } finally {
    raf.restore();
  }
});

test("plugin highlight work stays bounded at the maximum active rule budget", () => {
  const raf = installAnimationFrameQueue();
  try {
    const { term } = createFakeTerminalFromLines(Array.from({ length: 51 }, (_, index) => ({
      text: "x".repeat(80),
      isWrapped: index > 0,
    })));
    const highlighter = new KeywordHighlighter(term as never);
    const rules = Array.from({ length: 16 }, (_, rule) => ({
      id: `plugin:${rule}`,
      label: `Plugin ${rule}`,
      patterns: [`missing-${rule}-a`, `missing-${rule}-b`],
      color: "#F87171",
      enabled: true,
      providerId: "plugin",
    }));
    const startedAt = performance.now();
    highlighter.setRules(rules, true);
    const compiledRules = (highlighter as unknown as {
      compiledRules: Array<{ forEachMatch: (text: string, onMatch: (start: number, length: number) => boolean | void) => void }>;
    }).compiledRules;
    let matcherCalls = 0;
    for (const compiledRule of compiledRules) {
      const match = compiledRule.forEachMatch;
      compiledRule.forEachMatch = (text, onMatch) => {
        matcherCalls += 1;
        match(text, onMatch);
      };
    }
    raf.flush();
    const elapsedMs = performance.now() - startedAt;
    assert.equal(compiledRules.length, 32);
    assert.equal(matcherCalls, 32);
    assert.ok(elapsedMs < 1_000, `maximum plugin highlight workload took ${elapsedMs.toFixed(1)}ms`);
    highlighter.dispose();
  } finally {
    raf.restore();
  }
});

test("plugin match output is capped for a high-frequency wrapped logical line", () => {
  const raf = installAnimationFrameQueue();
  try {
    const { term } = createFakeTerminalFromLines(Array.from({ length: 51 }, (_, index) => ({
      text: "x".repeat(80),
      isWrapped: index > 0,
    })));
    const highlighter = new KeywordHighlighter(term as never);
    highlighter.setRules(Array.from({ length: 16 }, (_, rule) => ({
      id: `plugin:dense-${rule}`,
      label: `Dense ${rule}`,
      patterns: [".", "x"],
      color: "#F87171",
      enabled: true,
      providerId: "plugin",
    })), true);
    const compiledRules = (highlighter as unknown as {
      compiledRules: Array<{ forEachMatch: (text: string, onMatch: (start: number, length: number) => boolean | void) => void }>;
    }).compiledRules;
    let deliveredMatches = 0;
    for (const compiledRule of compiledRules) {
      const match = compiledRule.forEachMatch;
      compiledRule.forEachMatch = (text, onMatch) => match(text, (start, length) => {
        deliveredMatches += 1;
        return onMatch(start, length);
      });
    }
    const startedAt = performance.now();
    raf.flush();
    const elapsedMs = performance.now() - startedAt;
    assert.equal(deliveredMatches, MAX_PLUGIN_DECORATION_MATCHES_PER_LOGICAL_LINE);
    assert.ok(elapsedMs < 1_000, `dense plugin highlight workload took ${elapsedMs.toFixed(1)}ms`);
    highlighter.dispose();
  } finally {
    raf.restore();
  }
});

test("plugin rules reject empty-match patterns before viewport scanning", () => {
  const raf = installAnimationFrameQueue();
  try {
    const { term } = createFakeTerminalFromLines(Array.from({ length: 51 }, (_, index) => ({
      text: "x".repeat(80),
      isWrapped: index > 0,
    })));
    const highlighter = new KeywordHighlighter(term as never);
    highlighter.setRules([{
      id: "plugin:empty",
      label: "Empty",
      patterns: ["a*", "a?", "^$"],
      color: "#F87171",
      enabled: true,
      providerId: "plugin",
    }], true);
    assert.equal((highlighter as unknown as { compiledRules: unknown[] }).compiledRules.length, 0);
    raf.flush();
    highlighter.dispose();
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

    markers[0].dispose();
    handlers.scroll?.();
    assert.equal(getActiveDecorationCount(), 11);
    highlighter.dispose();
  } finally {
    raf.restore();
  }
});

test("persistent highlight lookup follows uniform scrollback marker shifts", () => {
  const raf = installAnimationFrameQueue();
  try {
    const {
      term,
      handlers,
      getActiveDecorationCount,
      getTranslateCount,
      markers,
      resetTranslateCount,
    } = createFakeTerminal("hello DEPLOY world", { lineCount: 30 });
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
    markers[0].dispose();
    for (const marker of markers) {
      if (!marker.isDisposed) marker.line -= 1;
    }
    resetTranslateCount();

    term.buffer.active.baseY = 27;
    term.buffer.active.viewportY = 0;
    handlers.scroll?.();

    assert.equal(getTranslateCount(), term.rows);
    assert.equal(getActiveDecorationCount(), 8);
    highlighter.dispose();
  } finally {
    raf.restore();
  }
});

test("persistent marker index synchronization stays constant-time", () => {
  const raf = installAnimationFrameQueue();
  try {
    const { term, handlers } = createFakeTerminal("hello DEPLOY world", { lineCount: 400 });
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
    term.buffer.active.baseY = 370;
    for (const viewportY of [120, 180, 240, 300]) {
      term.buffer.active.viewportY = viewportY;
      handlers.scroll?.();
    }

    fakeMarkerLineReadCount = 0;
    handlers.scroll?.();

    assert.ok(
      fakeMarkerLineReadCount < 10,
      `expected constant marker reads, got ${fakeMarkerLineReadCount}`,
    );
    highlighter.dispose();
  } finally {
    raf.restore();
  }
});

test("persistent highlights stay bounded for broad matching rules", () => {
  const raf = installAnimationFrameQueue();
  try {
    const {
      term,
      handlers,
      getActiveDecorationCount,
    } = createFakeTerminal("hello DEPLOY world", { lineCount: 2_000 });
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
    term.buffer.active.baseY = 1_970;
    for (let viewportY = 120; viewportY <= 1_800; viewportY += term.rows) {
      term.buffer.active.viewportY = viewportY;
      handlers.scroll?.();
    }

    const expectedLimit = Math.min(
      XTERM_PERFORMANCE_CONFIG.highlighting.maxPersistentDecorationLines,
      Math.max(
        XTERM_PERFORMANCE_CONFIG.highlighting.minPersistentDecorationLines,
        term.rows * XTERM_PERFORMANCE_CONFIG.highlighting.persistentDecorationViewports,
      ),
    );
    assert.equal(getActiveDecorationCount(), expectedLimit);
    highlighter.dispose();
  } finally {
    raf.restore();
  }
});

test("external marker reset invalidates persistent highlight coverage", () => {
  const raf = installAnimationFrameQueue();
  try {
    const {
      term,
      handlers,
      getActiveDecorationCount,
      getTranslateCount,
      markers,
      resetTranslateCount,
    } = createFakeTerminal("hello DEPLOY world", { lineCount: 9 });
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
    for (const marker of [...markers]) marker.dispose();
    resetTranslateCount();

    handlers.scroll?.();

    assert.equal(getTranslateCount(), term.rows);
    assert.equal(getActiveDecorationCount(), term.rows);
    highlighter.dispose();
  } finally {
    raf.restore();
  }
});

test("in-place redraw removes a persistent highlight when text stops matching", async () => {
  const raf = installAnimationFrameQueue();
  try {
    const {
      term,
      handlers,
      getActiveDecorationCount,
      setLineText,
    } = createFakeTerminal("hello DEPLOY world", { lineCount: 9 });
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

    setLineText(1, "hello SAFE world 1");
    handlers.writeParsed?.();
    await new Promise((resolve) => { setTimeout(resolve, 120); });
    raf.flush();

    assert.equal(getActiveDecorationCount(), 8);
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

test("oversized wrapped blocks skip plugin rules instead of resetting their per-line budget", () => {
  const raf = installAnimationFrameQueue();
  try {
    const { term, decorations } = createFakeTerminalFromLines([
      { text: "a".repeat(TERMINAL_AUX_LONG_LINE_SCAN_LIMIT_CHARS), isWrapped: false },
      { text: "PLUGIN", isWrapped: true },
    ]);
    const highlighter = new KeywordHighlighter(term as never);
    highlighter.setRules([{
      id: "plugin:oversized",
      label: "Oversized",
      patterns: ["PLUGIN"],
      color: "#F87171",
      enabled: true,
      providerId: "plugin",
    }], true);
    raf.flush();
    highlighter.dispose();
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
