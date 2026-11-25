import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import xterm from "@xterm/xterm";

import {
  TERMINAL_TIMESTAMP_GUTTER_HORIZONTAL_PADDING,
  TERMINAL_TIMESTAMP_GUTTER_MIN_WIDTH,
  TerminalTimestampGutter,
  getTerminalTimestampTypography,
  resolveTerminalTimestampGutterRenderSignature,
  resolveTerminalTimestampGutterColor,
  resolveTerminalTimestampGutterWidth,
  syncTerminalTimestampGutterRows,
} from "./TerminalTimestampGutter.tsx";
import { writeTerminalDataWithLineTimestamps } from "./runtime/terminalLineTimestamps.ts";
import { createDomRenderer, installDomEnvironment, runWithAct } from "../test-support/renderReactDom.tsx";

test("timestamp gutter uses a bright color from the active terminal theme", () => {
  assert.equal(
    resolveTerminalTimestampGutterColor({
      brightCyan: "#66e8ff",
      brightYellow: "#ffe066",
      foreground: "#dddddd",
    }),
    "#66e8ff",
  );
});

test("timestamp gutter falls back within the terminal theme palette", () => {
  assert.equal(
    resolveTerminalTimestampGutterColor({
      brightYellow: "#ffe066",
      foreground: "#dddddd",
    }),
    "#ffe066",
  );
  assert.equal(
    resolveTerminalTimestampGutterColor({
      foreground: "#dddddd",
    }),
    "#dddddd",
  );
});

test("timestamp gutter width follows measured timestamp text width", () => {
  assert.equal(
    resolveTerminalTimestampGutterWidth({ measuredTextWidth: 84, fontSize: 14 }),
    84 + TERMINAL_TIMESTAMP_GUTTER_HORIZONTAL_PADDING,
  );
  assert.equal(
    resolveTerminalTimestampGutterWidth({ measuredTextWidth: 1, fontSize: 14 }),
    TERMINAL_TIMESTAMP_GUTTER_MIN_WIDTH,
  );
});

test("timestamp gutter typography follows terminal typography", () => {
  assert.deepEqual(
    getTerminalTimestampTypography({
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 15,
      fontWeight: 500,
    }),
    {
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 15,
      fontWeight: 500,
    },
  );
});

test("timestamp gutter uses the terminal background", () => {
  const source = readFileSync(new URL("./TerminalTimestampGutter.tsx", import.meta.url), "utf8");

  assert.match(source, /backgroundColor: "var\(--terminal-ui-bg\)"/);
  assert.doesNotMatch(source, /bg-black\/10/);
  assert.match(source, /boxShadow: "inset -0\.5px 0 0 color-mix\(in srgb, var\(--terminal-ui-fg\) 8%, transparent\)"/);
  assert.doesNotMatch(source, /border-r/);
});

test("timestamp gutter render signature is stable and changes only for visible inputs", () => {
  const base = resolveTerminalTimestampGutterRenderSignature({
    screenTop: 8,
    cellHeight: 17,
    color: "#66e8ff",
    fontFamily: "JetBrains Mono",
    fontSize: 14,
    fontWeight: 500,
    rows: [
      { row: 0, label: "10:00:00" },
      { row: 2, label: "10:00:02" },
    ],
  });

  assert.equal(
    resolveTerminalTimestampGutterRenderSignature({
      screenTop: 8,
      cellHeight: 17,
      color: "#66e8ff",
      fontFamily: "JetBrains Mono",
      fontSize: 14,
      fontWeight: 500,
      rows: [
        { row: 0, label: "10:00:00" },
        { row: 2, label: "10:00:02" },
      ],
    }),
    base,
  );
  assert.notEqual(
    resolveTerminalTimestampGutterRenderSignature({
      screenTop: 8,
      cellHeight: 17,
      color: "#66e8ff",
      fontFamily: "JetBrains Mono",
      fontSize: 14,
      fontWeight: 500,
      rows: [
        { row: 0, label: "10:00:00" },
        { row: 3, label: "10:00:02" },
      ],
    }),
    base,
  );
});

test("timestamp gutter flood throttle advances even when the paint signature is unchanged", () => {
  const source = readFileSync(new URL("./TerminalTimestampGutter.tsx", import.meta.url), "utf8");
  // lastFloodRenderAt must move on every render attempt, before the signature early-return.
  const renderStart = source.indexOf("const render = () => {");
  const signatureReturn = source.indexOf("if (signature === lastRenderSignature) return;", renderStart);
  const floodAdvance = source.indexOf("lastFloodRenderAt = performance.now();", renderStart);
  assert.notEqual(renderStart, -1);
  assert.notEqual(signatureReturn, -1);
  assert.notEqual(floodAdvance, -1);
  assert.ok(
    floodAdvance < signatureReturn,
    "flood throttle clock must advance before the unchanged-signature early return",
  );
});

test("timestamp gutter throttles output-driven scroll events under flood pressure", () => {
  const source = readFileSync(new URL("./TerminalTimestampGutter.tsx", import.meta.url), "utf8");
  assert.match(source, /term\.onScroll\?\.\(\(\) => \{/);
  assert.match(source, /getTerminalOutputPressure\(term\)/);
  // largeOutput only (time-bounded); longLine must not sticky-throttle user scrolls.
  assert.match(source, /scheduleRender\(pressure\.largeOutput \? "normal" : "immediate"\)/);
  assert.doesNotMatch(
    source,
    /onScroll[\s\S]{0,200}pressure\.largeOutput \|\| pressure\.longLine/,
  );
});

test("timestamp gutter reuses row nodes across paints instead of rebuilding the tree", () => {
  const gutter = {
    children: [] as Array<Record<string, unknown>>,
    appendChild(node: Record<string, unknown>) {
      this.children.push(node);
      return node;
    },
  };

  const createElement = (tag: string) => {
    assert.equal(tag, "div");
    return {
      textContent: "",
      className: "",
      style: {} as Record<string, string>,
    };
  };

  const previousCreateElement = globalThis.document?.createElement;
  (globalThis as { document?: { createElement: typeof createElement } }).document = {
    createElement,
  };

  try {
    const layout = {
      screenTop: 0,
      cellHeight: 16,
      color: "#66e8ff",
      fontFamily: "monospace",
      fontSize: 14,
      fontWeight: 400,
    };

    syncTerminalTimestampGutterRows(
      gutter as never,
      [
        { row: 0, label: "10:00:00" },
        { row: 1, label: "10:00:01" },
      ],
      layout,
    );
    assert.equal(gutter.children.length, 2);
    const firstNode = gutter.children[0];
    assert.equal(firstNode.textContent, "10:00:00");

    syncTerminalTimestampGutterRows(
      gutter as never,
      [
        { row: 0, label: "10:00:02" },
        { row: 2, label: "10:00:03" },
      ],
      layout,
    );
    assert.equal(gutter.children.length, 2);
    assert.equal(gutter.children[0], firstNode);
    assert.equal(firstNode.textContent, "10:00:02");
    assert.equal(gutter.children[1].textContent, "10:00:03");

    syncTerminalTimestampGutterRows(
      gutter as never,
      [{ row: 0, label: "10:00:04" }],
      layout,
    );
    assert.equal(gutter.children.length, 2);
    assert.equal((gutter.children[1].style as Record<string, string>).display, "none");
  } finally {
    if (previousCreateElement) {
      (globalThis as { document: { createElement: typeof previousCreateElement } }).document = {
        createElement: previousCreateElement,
      };
    }
  }
});

test("timestamp gutter skips getBoundingClientRect on idle onRender ticks and re-measures on resize", async (t) => {
  const env = installDomEnvironment();
  const renderer = await createDomRenderer(env.document);

  let onRenderCb: (() => void) | null = null;
  let onResizeCb: (() => void) | null = null;
  let resizeObserverCb: (() => void) | null = null;
  const previousResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class MockResizeObserver {
    constructor(cb: ResizeObserverCallback) {
      resizeObserverCb = () => cb([], this as unknown as ResizeObserver);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  const container = env.document.createElement("div");
  const screen = env.document.createElement("div");
  screen.className = "xterm-screen";
  Object.defineProperty(screen, "clientHeight", { configurable: true, value: 80 });
  let rectReads = 0;
  screen.getBoundingClientRect = () => {
    rectReads += 1;
    return new env.window.DOMRect(0, 10, 400, 80);
  };
  container.appendChild(screen);
  env.document.body.appendChild(container);

  const lines = ["hello"];
  const fakeTerm = {
    cols: 80,
    rows: 4,
    options: { scrollback: 100 },
    buffer: {
      active: {
        type: "normal",
        baseY: 0,
        viewportY: 0,
        cursorY: 0,
        cursorX: 5,
        length: 1,
        getLine: (idx: number) => ({
          isWrapped: false,
          translateToString: () => lines[idx] ?? "",
        }),
      },
      normal: {
        baseY: 0,
        viewportY: 0,
        cursorY: 0,
        cursorX: 5,
        length: 1,
      },
    },
    write(_data: string, cb?: () => void) {
      cb?.();
    },
    onScroll: () => ({ dispose() {} }),
    onRender: (cb: () => void) => {
      onRenderCb = cb;
      return { dispose() {} };
    },
    onResize: (cb: () => void) => {
      onResizeCb = cb;
      return { dispose() {} };
    },
  };

  writeTerminalDataWithLineTimestamps(
    fakeTerm as never,
    "hello\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 0) },
  );

  const termRef = { current: fakeTerm as never };
  const containerRef = { current: container };

  t.after(async () => {
    await renderer.unmount();
    globalThis.ResizeObserver = previousResizeObserver;
    env.cleanup();
  });

  await renderer.render(
    React.createElement(TerminalTimestampGutter, {
      termRef,
      containerRef,
      enabled: true,
      top: "0px",
      sessionId: "s1",
      color: "#66e8ff",
      fontFamily: "monospace",
      fontSize: 12,
      fontWeight: 400,
      width: 64,
    }),
  );

  const readsAfterInitialRender = rectReads;
  assert.equal(readsAfterInitialRender, 1, "initial render measures screen rect once");

  // Simulate 10 idle cursor-blink onRender events with unchanged viewport/ledger state.
  await runWithAct(() => {
    for (let i = 0; i < 10; i += 1) {
      onRenderCb?.();
    }
  });
  assert.equal(
    rectReads,
    readsAfterInitialRender,
    "idle onRender cursor-blink ticks must not call getBoundingClientRect",
  );

  // onResize and ResizeObserver must still force a full layout measurement.
  await runWithAct(() => {
    onResizeCb?.();
  });
  assert.equal(rectReads, readsAfterInitialRender + 1, "onResize must force layout check");

  await runWithAct(() => {
    resizeObserverCb?.();
  });
  assert.equal(rectReads, readsAfterInitialRender + 2, "ResizeObserver must force layout check");
});

test("timestamp gutter drops emptied cursor row label after same-second EL erase while idle onRender still skips", async (t) => {
  const env = installDomEnvironment();
  const renderer = await createDomRenderer(env.document);

  const term = new xterm.Terminal({
    cols: 40,
    rows: 6,
    scrollback: 20,
    allowProposedApi: true,
  });

  let onRenderCb: (() => void) | null = null;
  Object.defineProperty(term, "onRender", {
    configurable: true,
    value: (cb: () => void) => {
      onRenderCb = cb;
      return { dispose() {} };
    },
  });
  Object.defineProperty(term, "onScroll", {
    configurable: true,
    value: () => ({ dispose() {} }),
  });
  Object.defineProperty(term, "onResize", {
    configurable: true,
    value: () => ({ dispose() {} }),
  });

  const container = env.document.createElement("div");
  const screen = env.document.createElement("div");
  screen.className = "xterm-screen";
  Object.defineProperty(screen, "clientHeight", { configurable: true, value: 120 });
  let rectReads = 0;
  screen.getBoundingClientRect = () => {
    rectReads += 1;
    return new env.window.DOMRect(0, 10, 400, 120);
  };
  container.appendChild(screen);
  env.document.body.appendChild(container);

  const writeAtSecond = (data: string, second = 0) => new Promise<void>((resolve) => {
    writeTerminalDataWithLineTimestamps(term, data, resolve, {
      timestampDate: new Date(2026, 9, 29, 12, 0, second),
    });
  });

  t.after(async () => {
    await renderer.unmount();
    term.dispose();
    env.cleanup();
  });

  await writeAtSecond("a\r\nb\r", 0);

  await renderer.render(
    React.createElement(TerminalTimestampGutter, {
      termRef: { current: term },
      containerRef: { current: container },
      enabled: true,
      top: "0px",
      sessionId: "s-erase",
      color: "#66e8ff",
      fontFamily: "monospace",
      fontSize: 12,
      fontWeight: 400,
      width: 64,
    }),
  );

  const gutter = env.document.querySelector('[data-section="terminal-timestamp-gutter"]') as HTMLElement | null;
  assert.ok(gutter, "gutter element should be mounted");
  const visibleLabels = () => Array.from(gutter.children)
    .filter((child) => (child as HTMLElement).style.display !== "none")
    .map((child) => child.textContent);

  assert.deepEqual(visibleLabels(), ["12:00:00", "12:00:00"]);
  const readsAfterMount = rectReads;

  // Idle onRender ticks before erase must short-circuit.
  await runWithAct(() => {
    onRenderCb?.();
    onRenderCb?.();
  });
  assert.equal(rectReads, readsAfterMount, "idle onRender must skip layout before erase");

  // Same-second EL erase empties row 1 without moving cursor or anchors.
  await writeAtSecond("\x1b[K", 0);
  assert.equal(term.buffer.active.cursorY, 1);
  assert.equal(term.buffer.active.cursorX, 0);

  await runWithAct(() => {
    onRenderCb?.();
  });

  assert.deepEqual(
    visibleLabels(),
    ["12:00:00"],
    "gutter must drop the emptied cursor row label after same-second EL erase",
  );
  const readsAfterErase = rectReads;
  assert.equal(readsAfterErase, readsAfterMount + 1, "erasing write must trigger one gutter re-measure");

  // Idle onRender ticks after erase must short-circuit again.
  await runWithAct(() => {
    onRenderCb?.();
    onRenderCb?.();
  });
  assert.equal(rectReads, readsAfterErase, "idle onRender must skip layout after erase");
});
