import test from "node:test";
import assert from "node:assert/strict";

import { stringCellWidth, sliceStringByCellColumns } from "./autocomplete/terminalStringCellWidth.ts";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("stringCellWidth counts ASCII as one cell each", () => {
  assert.equal(stringCellWidth("docker"), 6);
});

test("stringCellWidth counts CJK ideographs as two cells each", () => {
  assert.equal(stringCellWidth("部署"), 4);
});

test("sliceStringByCellColumns respects wide CJK cells", () => {
  const prompt = String.raw`C:\Users\用户>`;
  const line = `${prompt}部署`;
  const promptCells = stringCellWidth(prompt);
  assert.equal(sliceStringByCellColumns(line, 0, promptCells), prompt);
  assert.equal(sliceStringByCellColumns(line, promptCells), "部署");
  // Padding spaces after the content must not leak into the cursor prefix.
  const padded = line + " ".repeat(20);
  assert.equal(
    sliceStringByCellColumns(padded, 0, stringCellWidth(line)),
    line,
  );
});

test("stringCellWidth collapses ZWJ emoji to one wide grapheme", () => {
  assert.equal(stringCellWidth("👨‍💻"), 2);
});

test("stringCellWidth ignores combining marks inside a grapheme", () => {
  // e + combining acute accent
  assert.equal(stringCellWidth("e\u0301"), 1);
});

test("stringCellWidth fallback returns 2 for VS16 emoji-presentation grapheme", () => {
  // Without xterm, the fallback must detect VS16 (U+FE0F) and return 2
  // even when the base character is outside the standard emoji range.
  // U+2764 (text heart, not in 0x1F300-0x1FAFF) + U+FE0F → emoji (2 cells)
  assert.equal(stringCellWidth("\u2764\uFE0F"), 2);
  // U+00A9 (copyright) + U+FE0F → emoji (2 cells)
  assert.equal(stringCellWidth("\u00A9\uFE0F"), 2);
});

test("stringCellWidth fallback returns 2 for VS16 keycap grapheme", () => {
  // digit + VS16 + combining keycap → emoji-presentation keycap (2 cells)
  assert.equal(stringCellWidth("1\uFE0F\u20E3"), 2);
});

test("stringCellWidth fallback returns 1 for text heart without VS16", () => {
  // U+2764 alone is text presentation, not emoji
  assert.equal(stringCellWidth("\u2764"), 1);
});

test("stringCellWidth matches xterm 15-graphemes for common emoji clusters", () => {
  class El {
    tagName: string;
    style: Record<string, string> = {};
    children: El[] = [];
    classList = { add() {}, remove() {}, contains() { return false; } };
    constructor(tag: string) { this.tagName = tag; }
    appendChild(c: El) { this.children.push(c); return c; }
    removeChild(c: El) { return c; }
    addEventListener() {}
    removeEventListener() {}
    setAttribute() {}
    getAttribute() { return null; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
    remove() {}
  }
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    DocumentFragment: globalThis.DocumentFragment,
    getComputedStyle: globalThis.getComputedStyle,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  // Minimal DOM so @xterm/xterm can construct a Terminal in node tests.
  (globalThis as { document?: unknown }).document = {
    createElement: (t: string) => new El(t),
    createDocumentFragment: () => new El("frag"),
    addEventListener() {},
    removeEventListener() {},
  };
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { HTMLElement?: unknown }).HTMLElement = El;
  (globalThis as { Element?: unknown }).Element = El;
  (globalThis as { DocumentFragment?: unknown }).DocumentFragment = El;
  (globalThis as { getComputedStyle?: unknown }).getComputedStyle = () => ({
    getPropertyValue: () => "",
  });
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (
    cb: (t: number) => void,
  ) => setTimeout(() => cb(0), 0);
  (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = (
    id: number,
  ) => clearTimeout(id);

  try {
    const xterm = require("@xterm/xterm") as typeof import("@xterm/xterm");
    const graphemes = require("@xterm/addon-unicode-graphemes") as typeof import("@xterm/addon-unicode-graphemes");
    const term = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    term.loadAddon(new graphemes.UnicodeGraphemesAddon());
    term.unicode.activeVersion = "15-graphemes";

    const samples = ["🇨🇳", "1️⃣", "©️", "🖥", "👨‍💻", "部署", "docker"];
    for (const s of samples) {
      const expected = (
        term as unknown as {
          _core: { unicodeService: { getStringCellWidth: (v: string) => number } };
        }
      )._core.unicodeService.getStringCellWidth(s);
      assert.equal(
        stringCellWidth(s, term),
        expected,
        `${JSON.stringify(s)} should match xterm width ${expected}`,
      );
    }
    // These disagree with the hand-rolled fallback; the term path must win.
    assert.equal(stringCellWidth("🇨🇳", term), 2);
    assert.equal(stringCellWidth("1️⃣", term), 2);
    assert.equal(stringCellWidth("©️", term), 2);
    assert.equal(stringCellWidth("🖥", term), 1);
  } finally {
    Object.assign(globalThis, previous);
  }
});
