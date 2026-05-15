import test from "node:test";
import assert from "node:assert/strict";

import { insertPromptLineBreakBeforePrompt } from "./promptLineBreak";

test("inserts a visual line break before a prompt after an unterminated final output line", () => {
  assert.equal(
    insertPromptLineBreakBeforePrompt("hello$ ", "$ ", 0),
    "hello\r\n$ ",
  );
});

test("inserts at the start of a prompt chunk when previous output left the cursor mid-line", () => {
  assert.equal(
    insertPromptLineBreakBeforePrompt("$ ", "$ ", 5),
    "\r\n$ ",
  );
});

test("does not insert when the output already ends with a line break", () => {
  assert.equal(
    insertPromptLineBreakBeforePrompt("hello\r\n$ ", "$ ", 0),
    "hello\r\n$ ",
  );
});

test("keeps prompt ANSI styling on the prompt side of the inserted line break", () => {
  assert.equal(
    insertPromptLineBreakBeforePrompt("hello\x1b[32m$ \x1b[0m", "$ ", 0),
    "hello\r\n\x1b[32m$ \x1b[0m",
  );
});

test("does not insert for non-prompt output", () => {
  assert.equal(
    insertPromptLineBreakBeforePrompt("hello> ", "$ ", 0),
    "hello> ",
  );
});
