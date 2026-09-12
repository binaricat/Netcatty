import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { JSDOM } from "jsdom";
import type { Terminal as XTermType } from "@xterm/xterm";

import { dispatchWin32InputModeEvent } from "./win32InputMode";

const require = createRequire(import.meta.url);
const { Terminal: XTerm } = require("@xterm/xterm") as {
  Terminal: typeof XTermType;
};

const write = (term: XTermType, data: string): Promise<void> => new Promise((resolve) => {
  term.write(data, resolve);
});

test("xterm ignores ConPTY's Win32 input request unless the extension is enabled", async () => {
  const term = new XTerm({ allowProposedApi: true });

  await write(term, "\u001b[?9001h");

  assert.equal(term.modes.win32InputMode, false);
  term.dispose();
});

test("xterm preserves modified Enter keys as Win32 input records for ConPTY", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=terminal></div><div id=source></div></body></html>",
    {
    pretendToBeVisual: true,
    },
  );
  const window = dom.window;
  window.matchMedia = () => ({
    matches: true,
    media: "",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  });
  window.HTMLCanvasElement.prototype.getContext = (() => ({
    createLinearGradient: () => ({}),
    measureText: () => ({
      width: 10,
      actualBoundingBoxDescent: 2,
      actualBoundingBoxAscent: 8,
    }),
    fillRect() {},
    clearRect() {},
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
  })) as typeof window.HTMLCanvasElement.prototype.getContext;

  const globals = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLCanvasElement",
    "KeyboardEvent",
    "Event",
    "MouseEvent",
    "CompositionEvent",
    "InputEvent",
  ] as const;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const name of globals) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value: window[name],
      configurable: true,
    });
  }
  previous.set("devicePixelRatio", Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio"));
  Object.defineProperty(globalThis, "devicePixelRatio", { value: 1, configurable: true });
  previous.set("ResizeObserver", Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver"));
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: class {
      observe() {}
      disconnect() {}
    },
    configurable: true,
  });

  const term = new XTerm({
    allowProposedApi: true,
    cols: 80,
    rows: 24,
    vtExtensions: { kittyKeyboard: true, win32InputMode: true },
  });
  try {
    term.open(window.document.getElementById("terminal") as HTMLElement);
    const sent: string[] = [];
    term.onData((data) => sent.push(data));

    await write(term, "\u001b[?9001h");
    await write(term, "\u001b[>2u");
    assert.equal(term.modes.win32InputMode, true);

    for (const modifiers of [
      {},
      { shiftKey: true },
      { ctrlKey: true },
      { altKey: true },
    ]) {
      term.textarea?.dispatchEvent(new window.KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        bubbles: true,
        cancelable: true,
        ...modifiers,
      }));
    }
    term.textarea?.dispatchEvent(new window.KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));

    assert.deepEqual(sent, [
      "\u001b[13;28;13;1;0;1_",
      "\u001b[13;28;13;1;16;1_",
      "\u001b[13;28;10;1;8;1_",
      "\u001b[13;28;13;1;2;1_",
      "\u001b[13;28;13;0;16;1_",
    ]);

    const sourceTerm = new XTerm({ allowProposedApi: true, cols: 80, rows: 24 });
    try {
      sourceTerm.open(window.document.getElementById("source") as HTMLElement);
      sourceTerm.focus();
      assert.equal(window.document.activeElement, sourceTerm.textarea);
      sent.length = 0;
      const shiftEnter = {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        shiftKey: true,
      };
      dispatchWin32InputModeEvent(term, { type: "keydown", ...shiftEnter });
      dispatchWin32InputModeEvent(term, { type: "keyup", ...shiftEnter });
      assert.equal(window.document.activeElement, sourceTerm.textarea);
      assert.deepEqual(sent, [
        "\u001b[13;28;13;1;16;1_",
        "\u001b[13;28;13;0;16;1_",
      ]);
    } finally {
      sourceTerm.dispose();
    }

    // Netcatty consumes shortcuts and local controls before xterm. Their
    // releases must be consumed too, otherwise ConPTY receives an orphaned
    // native key-up after a Ctrl+C interrupt or sudo/autocomplete Enter.
    sent.length = 0;
    const forwardedKeys = new Set<string>();
    let pendingKeyDownIdentity: string | null = null;
    term.onData((data) => {
      if (
        pendingKeyDownIdentity &&
        data.startsWith("\u001b[") &&
        data.endsWith("_")
      ) {
        forwardedKeys.add(pendingKeyDownIdentity);
        pendingKeyDownIdentity = null;
      }
    });
    term.attachCustomKeyEventHandler((event) => {
      const identity = event.code || event.key;
      if (event.type === "keyup") {
        pendingKeyDownIdentity = null;
        return forwardedKeys.delete(identity);
      }
      if (event.type !== "keydown") return true;
      const consumed =
        (event.ctrlKey && event.key.toLowerCase() === "c") ||
        (event.key === "Enter" && !event.shiftKey);
      if (consumed) return false;
      pendingKeyDownIdentity = identity;
      return true;
    });

    for (const event of [
      new window.KeyboardEvent("keydown", {
        key: "c", code: "KeyC", keyCode: 67, ctrlKey: true, bubbles: true, cancelable: true,
      }),
      new window.KeyboardEvent("keyup", {
        key: "c", code: "KeyC", keyCode: 67, ctrlKey: true, bubbles: true, cancelable: true,
      }),
      new window.KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true,
      }),
      new window.KeyboardEvent("keyup", {
        key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true,
      }),
      new window.KeyboardEvent("keydown", {
        key: "Process", code: "KeyA", keyCode: 229, bubbles: true, cancelable: true,
      }),
      new window.KeyboardEvent("keyup", {
        key: "Process", code: "KeyA", keyCode: 229, bubbles: true, cancelable: true,
      }),
    ]) {
      term.textarea?.dispatchEvent(event);
    }
    assert.deepEqual(sent, []);
  } finally {
    term.dispose();
    dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
