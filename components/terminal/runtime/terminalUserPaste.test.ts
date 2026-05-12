import assert from "node:assert/strict";
import test from "node:test";

import {
  clearPasteResidualAfterTerminalWrite,
  pasteTextIntoTerminal,
  prepareTerminalDataForUserPasteDisplay,
  shouldSuppressTerminalInputScrollForUserPaste,
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

test("user paste with scroll disabled suppresses input auto-scroll for raw paste data", () => {
  const term = {
    paste: () => {},
    scrollToBottom: () => {},
  };

  pasteTextIntoTerminal(term, "line one\nline two", {
    scrollOnPaste: false,
  });

  assert.equal(shouldSuppressTerminalInputScrollForUserPaste(term, "line one\rline two"), true);
  assert.equal(shouldSuppressTerminalInputScrollForUserPaste(term, "x"), false);
});

test("user paste with scroll disabled suppresses input auto-scroll for bracketed paste data", () => {
  const term = {
    paste: () => {},
    scrollToBottom: () => {},
  };

  pasteTextIntoTerminal(term, "line one\nline two", {
    scrollOnPaste: false,
  });

  assert.equal(
    shouldSuppressTerminalInputScrollForUserPaste(term, "\x1b[200~line one\rline two\x1b[201~"),
    true,
  );
});

test("user paste with scroll enabled keeps input auto-scroll available", () => {
  const term = {
    paste: () => {},
    scrollToBottom: () => {},
  };

  pasteTextIntoTerminal(term, "line one\nline two", {
    scrollOnPaste: true,
    requestAnimationFrame: () => {},
  });

  assert.equal(shouldSuppressTerminalInputScrollForUserPaste(term, "line one\rline two"), false);
});

test("user paste with scroll disabled suppresses split input chunks", () => {
  const term = {
    paste: () => {},
    scrollToBottom: () => {},
  };

  pasteTextIntoTerminal(term, "line one\nline two", {
    scrollOnPaste: false,
  });

  assert.equal(shouldSuppressTerminalInputScrollForUserPaste(term, "line one\r"), true);
  assert.equal(shouldSuppressTerminalInputScrollForUserPaste(term, "line two"), true);
  assert.equal(shouldSuppressTerminalInputScrollForUserPaste(term, "line two"), false);
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
    prepareTerminalDataForUserPasteDisplay(term, "\x1b[7mline 3 with enough content\x1b[27m"),
    "line 3 with enough content",
  );
});

test("long multi-line paste preserves unrelated reverse-video output", () => {
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
    prepareTerminalDataForUserPasteDisplay(term, "\x1b[7munrelated ncurses status\x1b[27m"),
    "\x1b[7munrelated ncurses status\x1b[27m",
  );
});

test("long multi-line paste strips only matched paste echo segments in mixed output", () => {
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
    prepareTerminalDataForUserPasteDisplay(
      term,
      "mode \x1b[7mINSERT\x1b[27m \x1b[7mline 3 with enough content\x1b[27m done",
    ),
    "mode \x1b[7mINSERT\x1b[27m line 3 with enough content done",
  );
});

test("long multi-line paste strips matched paste echo when active-region spans chunks", () => {
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
    prepareTerminalDataForUserPasteDisplay(term, "\x1b[7mline 3 with enough"),
    "line 3 with enough",
  );
  assert.equal(
    prepareTerminalDataForUserPasteDisplay(term, " content\x1b[27m"),
    " content",
  );
});

test("long multi-line paste does not clear cursor-right residue before terminal echo", () => {
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

  assert.deepEqual(writes, []);
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
  prepareTerminalDataForUserPasteDisplay(term, "\x1b[7mline 3 with enough content\x1b[27m");

  clearPasteResidualAfterTerminalWrite(term);

  assert.deepEqual(writes, ["\x1b[K"]);
});
