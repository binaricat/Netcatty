import test from "node:test";
import assert from "node:assert/strict";

import {
  createPromptLineBreakState,
  insertPromptLineBreakBeforePrompt,
  prepareTerminalDataForPromptLineBreak,
  syncPromptLineBreakState,
} from "./promptLineBreak";

function createFakeTerm(lineText = "", cursorX = lineText.length) {
  return {
    buffer: {
      active: {
        cursorX,
        cursorY: 0,
        baseY: 0,
        getLine(line: number) {
          if (line !== 0) return undefined;
          return {
            isWrapped: false,
            translateToString() {
              return lineText;
            },
          };
        },
      },
    },
  };
}

test("does not insert before prompt-like suffixes in a larger output chunk", () => {
  assert.equal(
    insertPromptLineBreakBeforePrompt("hello$ ", "$ ", 0),
    "hello$ ",
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
    insertPromptLineBreakBeforePrompt("\x1b[32m$ \x1b[0m", "$ ", 5),
    "\r\n\x1b[32m$ \x1b[0m",
  );
});

test("does not insert for non-prompt output", () => {
  assert.equal(
    insertPromptLineBreakBeforePrompt("hello> ", "$ ", 0),
    "hello> ",
  );
});

test("does not insert for output chunks that only end with the cached prompt text", () => {
  assert.equal(
    insertPromptLineBreakBeforePrompt("total $ ", "$ ", 0),
    "total $ ",
  );
});

test("does not insert before an ambiguous prompt suffix inside output", () => {
  assert.equal(
    insertPromptLineBreakBeforePrompt("world$ ", "$ ", 5),
    "world$ ",
  );
});

test("does not insert before prompt-like output after a line break", () => {
  assert.equal(
    insertPromptLineBreakBeforePrompt("\r\nhello$ ", "$ ", 0),
    "\r\nhello$ ",
  );
});

test("inserts before a distinct root prompt in the same output chunk", () => {
  const prompt = "[root@iZwz9ftrhzy4b3hduolf6yZ ~]# ";

  assert.equal(
    insertPromptLineBreakBeforePrompt(`file tail${prompt}`, prompt, 0),
    `file tail\r\n${prompt}`,
  );
});

test("inserts before a distinct conda prompt in the same output chunk", () => {
  const prompt = "(base) rynn@aiserver:~$ ";

  assert.equal(
    insertPromptLineBreakBeforePrompt(`file tail${prompt}`, prompt, 0),
    `file tail\r\n${prompt}`,
  );
});

test("does not insert before an already separated distinct prompt", () => {
  const prompt = "(base) rynn@aiserver:~$ ";

  assert.equal(
    insertPromptLineBreakBeforePrompt(`file tail\r\n${prompt}`, prompt, 0),
    `file tail\r\n${prompt}`,
  );
});

test("does not refresh cached prompt from output that only ends with the prompt text", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "$ ";
  state.pendingCommand = true;

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("", 0) as never,
      "total $ ",
      state,
      true,
    ),
    "total $ ",
  );
  assert.equal(state.suppressNextPromptCache, true);

  syncPromptLineBreakState(createFakeTerm("total $ ") as never, state);

  assert.equal(state.lastPromptText, "$ ");
  assert.equal(state.pendingCommand, true);
  assert.equal(state.suppressNextPromptCache, false);
});

test("keeps waiting for the real prompt after an output suffix matches the prompt text", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "$ ";
  state.pendingCommand = true;

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("", 0) as never,
      "total $ ",
      state,
      true,
    ),
    "total $ ",
  );

  syncPromptLineBreakState(createFakeTerm("total $ ") as never, state);

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("total $ ", 8) as never,
      "$ ",
      state,
      true,
    ),
    "\r\n$ ",
  );
});

test("keeps waiting after prompt-like output on a fresh line", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "$ ";
  state.pendingCommand = true;

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("", 0) as never,
      "\r\nhello$ ",
      state,
      true,
    ),
    "\r\nhello$ ",
  );

  syncPromptLineBreakState(createFakeTerm("hello$ ") as never, state);

  assert.equal(state.lastPromptText, "$ ");
  assert.equal(state.pendingCommand, true);

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("hello$ ", 7) as never,
      "$ ",
      state,
      true,
    ),
    "\r\n$ ",
  );
});

test("prepares a same-chunk cat output break for a distinct prompt", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "(base) rynn@aiserver:~$ ";
  state.pendingCommand = true;

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("", 0) as never,
      "without trailing newline(base) rynn@aiserver:~$ ",
      state,
      true,
    ),
    "without trailing newline\r\n(base) rynn@aiserver:~$ ",
  );
  assert.equal(state.suppressNextPromptCache, false);
});

test("refreshes cached prompt when a changed prompt arrives after a line break in the same chunk", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "old$ ";
  state.pendingCommand = true;
  const termBeforeWrite = createFakeTerm("old$ cd /tmp", 12);

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      termBeforeWrite as never,
      "\r\nnew$ ",
      state,
      true,
    ),
    "\r\nnew$ ",
  );
  assert.equal(state.suppressNextPromptCache, false);

  syncPromptLineBreakState(createFakeTerm("new$ ") as never, state);

  assert.equal(state.lastPromptText, "new$ ");
  assert.equal(state.pendingCommand, false);
});

test("caches the first valid prompt even when a command is already pending", () => {
  const state = createPromptLineBreakState();
  state.pendingCommand = true;

  syncPromptLineBreakState(createFakeTerm("$ ") as never, state);

  assert.equal(state.lastPromptText, "$ ");
  assert.equal(state.pendingCommand, false);
  assert.equal(state.suppressNextPromptCache, false);
});

test("does not refresh cached prompt from an unchanged mid-line write without a line reset", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "old$ ";
  state.pendingCommand = true;
  const termBeforeWrite = createFakeTerm("old$ run", 8);

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      termBeforeWrite as never,
      "outputnew$ ",
      state,
      true,
    ),
    "outputnew$ ",
  );
  assert.equal(state.suppressNextPromptCache, true);

  syncPromptLineBreakState(createFakeTerm("outputnew$ ") as never, state);

  assert.equal(state.lastPromptText, "old$ ");
  assert.equal(state.pendingCommand, true);
  assert.equal(state.suppressNextPromptCache, false);
});
