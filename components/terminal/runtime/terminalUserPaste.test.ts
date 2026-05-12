import assert from "node:assert/strict";
import test from "node:test";

import {
  clearPasteResidualAfterTerminalWrite,
  pasteTextIntoTerminal,
  prepareTerminalDataForUserPasteDisplay,
} from "./terminalUserPaste";

test("user paste delegates raw clipboard text to xterm paste handling", () => {
  const pasted: string[] = [];
  const term = {
    paste: (text: string) => pasted.push(text),
    scrollToBottom: () => {
      throw new Error("scrollToBottom should not run when scrollOnPaste is false");
    },
  };

  const text = "line one\r\nline two\nline three";

  pasteTextIntoTerminal(term, text, { scrollOnPaste: false });

  assert.deepEqual(pasted, [text]);
});

test("user paste preserves the existing scroll-on-paste behavior", () => {
  const calls: string[] = [];
  const term = {
    paste: () => calls.push("paste"),
    scrollToBottom: () => calls.push("scroll"),
  };

  pasteTextIntoTerminal(term, "echo ok", {
    scrollOnPaste: true,
    requestAnimationFrame: (callback) => {
      calls.push("raf");
      callback();
    },
  });

  assert.deepEqual(calls, ["paste", "scroll", "raf", "scroll"]);
});

test("long multi-line paste strips readline active-region highlighting from echo", () => {
  const term = {
    cols: 20,
    rows: 4,
    paste: () => {},
    scrollToBottom: () => {},
    write: () => {},
  };

  const longPaste = Array.from({ length: 20 }, (_, index) => `line ${index} with enough content`).join("\n");
  pasteTextIntoTerminal(term, longPaste, {
    scrollOnPaste: false,
  });

  assert.equal(
    prepareTerminalDataForUserPasteDisplay(term, "\x1b[7mthird line\x1b[27m"),
    "third line",
  );
});

test("long multi-line paste clears cursor-right residue after terminal echo", () => {
  const writes: string[] = [];
  const term = {
    cols: 20,
    rows: 4,
    paste: () => {},
    scrollToBottom: () => {},
    write: (data: string) => writes.push(data),
  };

  const longPaste = Array.from({ length: 20 }, (_, index) => `line ${index} with enough content`).join("\n");
  pasteTextIntoTerminal(term, longPaste, {
    scrollOnPaste: false,
  });

  clearPasteResidualAfterTerminalWrite(term);

  assert.deepEqual(writes, ["\x1b[K"]);
});
