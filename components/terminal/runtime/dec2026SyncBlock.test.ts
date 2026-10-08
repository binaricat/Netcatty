import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/xterm";

import { installEraseInDisplayHandlers } from "../clearTerminalViewport.ts";
import {
  installDec2026SyncBlockTracker,
  isDec2026SyncModeSequence,
} from "./dec2026SyncBlock.ts";

const { Terminal } = xterm;

const writeTerminal = (term: InstanceType<typeof Terminal>, data: string): Promise<void> =>
  new Promise((resolve) => term.write(data, resolve));

const scrollbackLines = (term: InstanceType<typeof Terminal>): string[] => {
  const buffer = term.buffer.active;
  return Array.from(
    { length: buffer.baseY },
    (_, row) => buffer.getLine(row)?.translateToString(true) ?? "",
  );
};

test("isDec2026SyncModeSequence matches only mode 2026", () => {
  assert.equal(isDec2026SyncModeSequence([2026]), true);
  assert.equal(isDec2026SyncModeSequence([2004]), false);
  assert.equal(isDec2026SyncModeSequence([25]), false);
  assert.equal(isDec2026SyncModeSequence([1049]), false);
  assert.equal(isDec2026SyncModeSequence([]), false);
  // DECSET/DECRST accept several private modes in one sequence.
  assert.equal(isDec2026SyncModeSequence([2004, 2026]), true);
  assert.equal(isDec2026SyncModeSequence([2027, 2026]), true);
  assert.equal(isDec2026SyncModeSequence([[2026]]), true);
  assert.equal(isDec2026SyncModeSequence([2004, 2027]), false);
});

test("tracker follows DEC 2026 and ignores other private modes", async () => {
  const term = new Terminal({ cols: 40, rows: 5, scrollback: 100 });
  const tracker = installDec2026SyncBlockTracker(term.parser);

  assert.equal(tracker.isInSyncBlock(), false);

  // bash enables bracketed paste while readline owns the prompt, and cursor
  // visibility / alternate screen are toggled by ordinary programs.
  await writeTerminal(term, "\x1b[?2004h");
  assert.equal(tracker.isInSyncBlock(), false, "?2004h must not open a sync block");
  await writeTerminal(term, "\x1b[?25l");
  await writeTerminal(term, "\x1b[?1049h");
  assert.equal(tracker.isInSyncBlock(), false, "unrelated private modes must not open a sync block");

  await writeTerminal(term, "\x1b[?2026h");
  assert.equal(tracker.isInSyncBlock(), true);

  // Unrelated resets must not close a real sync block either.
  await writeTerminal(term, "\x1b[?2004l");
  await writeTerminal(term, "\x1b[?25h");
  assert.equal(tracker.isInSyncBlock(), true, "unrelated private modes must not close a sync block");

  await writeTerminal(term, "\x1b[?2026l");
  assert.equal(tracker.isInSyncBlock(), false);

  tracker.dispose();
  term.dispose();
});

test("tracker dispose stops tracking", async () => {
  const term = new Terminal({ cols: 40, rows: 5, scrollback: 100 });
  const tracker = installDec2026SyncBlockTracker(term.parser);
  tracker.dispose();

  await writeTerminal(term, "\x1b[?2026h");
  assert.equal(tracker.isInSyncBlock(), false);

  term.dispose();
});

test("Ctrl+L keeps visible rows in scrollback while bash has bracketed paste enabled", async () => {
  const term = new Terminal({ cols: 40, rows: 5, scrollback: 100 });
  const tracker = installDec2026SyncBlockTracker(term.parser);
  const eraseHandlers = installEraseInDisplayHandlers(term, {
    getClearWipesScrollback: () => false,
    isInDec2026SyncBlock: () => tracker.isInSyncBlock(),
  });

  await writeTerminal(
    term,
    "old1\r\nold2\r\nold3\r\nold4\r\nold5\r\nold6\r\nold7\r\nold8\r\n",
  );

  // bash hands the terminal to readline for the prompt, then the user presses
  // Ctrl+L: readline emits only ESC[H ESC[2J (no erase-scrollback sequence).
  await writeTerminal(term, "\x1b[?2004h");
  await writeTerminal(term, "root@host:/# ");
  await writeTerminal(term, "\x1b[H\x1b[2Jroot@host:/# ");

  const lines = scrollbackLines(term);
  for (const expected of ["old1", "old2", "old3", "old4", "old5", "old6", "old7", "old8"]) {
    assert.ok(
      lines.some((line) => line.startsWith(expected)),
      `${expected} should still be reachable in the scrollback after Ctrl+L; got ${JSON.stringify(lines)}`,
    );
  }

  eraseHandlers.dispose();
  tracker.dispose();
  term.dispose();
});

test("erases stay in place inside a real DEC 2026 block", async () => {
  const term = new Terminal({ cols: 40, rows: 5, scrollback: 100 });
  const tracker = installDec2026SyncBlockTracker(term.parser);
  const eraseHandlers = installEraseInDisplayHandlers(term, {
    getClearWipesScrollback: () => false,
    isInDec2026SyncBlock: () => tracker.isInSyncBlock(),
  });

  await writeTerminal(term, "frame1\r\nframe2\r\nframe3\r\nframe4\r\nframe5\r\nframe6\r\n");
  const before = term.buffer.active.baseY;

  await writeTerminal(term, "\x1b[?2026h\x1b[H\x1b[2Jframe9\x1b[?2026l");
  assert.equal(
    term.buffer.active.baseY,
    before,
    "a TUI full redraw inside a sync block must not push the viewport into scrollback",
  );

  eraseHandlers.dispose();
  tracker.dispose();
  term.dispose();
});
